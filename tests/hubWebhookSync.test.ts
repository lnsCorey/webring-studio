import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { DatabaseSync } from 'node:sqlite';
import { StudioDatabase, WebringHubRecord } from '../electron/db/database';
import { KeyCipher } from '../electron/security/keyVault';
import { ProxyUnavailableError } from '../electron/security/proxyAgent';
import {
  buildSignedWebhookPing,
  emitWebhookPings,
  verifyWebhookPingSignature,
  WEBHOOK_PING_CONCURRENCY,
  WEBHOOK_PING_TIMEOUT_MS,
} from '../electron/sync/webhookPing';
import { HubFeedService } from '../electron/sync/hubFeed';
import { MAX_WEBRING_HUBS, WebringHubService } from '../electron/services/webringHubService';
import {
  buildDidDocument,
  canonicalizeJson,
  generateIdentityKeyPair,
  ItemsDocument,
  signDocument,
  siteUrlToDidWeb,
  verifyKeyRotationChain,
  WEBRING_SCHEMA_VERSION,
} from '../src/shared/schema';

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-hub-sync-test-'));
  tempDirs.push(dir);
  return dir;
}

function makeTestKeyCipher(available = true): KeyCipher {
  const secretKey = crypto.createHash('sha256').update('unit-test-os-keychain-secret').digest();
  return {
    isAvailable: () => available,
    encrypt: (plainText: string) => {
      const iv = Buffer.alloc(12, 7);
      const cipher = crypto.createCipheriv('aes-256-gcm', secretKey, iv);
      const enc = Buffer.concat([cipher.update(plainText, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return Buffer.concat([iv, tag, enc]);
    },
    decrypt: (cipherText: Buffer) => {
      const iv = cipherText.subarray(0, 12);
      const tag = cipherText.subarray(12, 28);
      const body = cipherText.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', secretKey, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(body), decipher.final()]).toString('utf8');
    },
  };
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      // ignore transient Windows file lock
    }
  }
});

describe('Migration 6 & Webring Hubs SQLite table (250 Hubs)', () => {
  it('migrates legacy webringHubsJson into webring_hubs with ping_enabled=1 default', () => {
    const dir = makeTempDir();
    const dbPath = path.join(dir, 'legacy.sqlite');

    // Simulate a pre-v6 SQLite database holding `webringHubsJson` in `local_settings`
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      CREATE TABLE local_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      PRAGMA user_version = 5;
    `);
    raw
      .prepare('INSERT INTO local_settings (key, value) VALUES (?, ?)')
      .run(
        'webringHubsJson',
        JSON.stringify([
          {
            url: 'https://hub-one.example',
            title: 'Hub One',
            addedAt: '2026-11-20T00:00:00.000Z',
            listMe: true,
            state: 'listed',
            extensions: [{ id: 'webhook-sync', version: '1.0.0', apiVersion: 1 }],
          },
        ])
      );
    raw.close();

    const db = new StudioDatabase(dir, 'legacy.sqlite', { keyCipher: makeTestKeyCipher(true) });
    try {
      expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(6);
      const hubs = db.getWebringHubs();
      expect(hubs).toHaveLength(1);
      expect(hubs[0].url).toBe('https://hub-one.example');
      expect(hubs[0].pingEnabled).toBe(true);
      expect(hubs[0].listMe).toBe(true);

      const toggled = db.setWebringHubPingEnabled('https://hub-one.example', false);
      expect(toggled.pingEnabled).toBe(false);
      expect(MAX_WEBRING_HUBS).toBe(250);
    } finally {
      db.close();
    }
  });
});

describe('Canonical Webhook Ping Signing & Bounded-Concurrency Emission', () => {
  it('generates detached Ed25519 signatures compatible with canonical JSON verification and keyRotations', () => {
    const dir = makeTempDir();
    const db = new StudioDatabase(dir, 'persona.sqlite', {
      keyCipher: makeTestKeyCipher(true),
      initialProfile: { siteUrl: 'https://alice.example', displayName: 'Alice' },
    });
    try {
      const initialKeys = db.getKeys();
      const rotated = db.rotateSigningKeys();
      const newKeys = db.getKeys();
      const rotations = db.getKeyRotations();
      const did = siteUrlToDidWeb('https://alice.example');

      const signedPing = buildSignedWebhookPing({
        did,
        manifestUrl: 'https://alice.example/api/manifest.json',
        timestamp: '2026-11-25T12:00:00.000Z',
        privateKeyPem: newKeys.privateKeyPem,
        publicKeyPem: newKeys.publicKeyPem,
        keyRotations: rotations,
      });

      // Verify detached Ed25519 signature over canonical JSON (excluding `signature` & `proof`)
      expect(verifyWebhookPingSignature(signedPing, newKeys.publicKeyPem)).toBe(true);
      expect(verifyWebhookPingSignature(signedPing, initialKeys.publicKeyPem)).toBe(false);

      // Verify a Hub that pinned Alice's OLD key can validate the rotation chain on the ping
      const chainValid = verifyKeyRotationChain({
        pinnedPublicKeyPem: initialKeys.publicKeyPem,
        targetPublicKeyPem: rotated.publicKeyPem,
        did,
        siteUrl: 'https://alice.example',
        certificates: signedPing.keyRotations,
      });
      expect(chainValid).toBe(true);

      // Tampering with timestamp invalidates the signature
      expect(
        verifyWebhookPingSignature({ ...signedPing, timestamp: '2026-11-25T12:01:00.000Z' }, newKeys.publicKeyPem)
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it('batches 250 Hubs with bounded concurrency <= 10, 5000ms timeout, and non-blocking error logging', async () => {
    const dir = makeTempDir();
    const db = new StudioDatabase(dir, 'scale.sqlite', {
      keyCipher: makeTestKeyCipher(true),
      initialProfile: { siteUrl: 'https://alice.example', displayName: 'Alice' },
    });

    try {
      const hubs: WebringHubRecord[] = [];
      for (let i = 1; i <= 250; i++) {
        hubs.push({
          url: `https://hub-${String(i).padStart(3, '0')}.example`,
          title: `Hub ${i}`,
          addedAt: '2026-11-25T00:00:00.000Z',
          listMe: true,
          state: 'listed',
          // Disable ping on hub 250 to confirm pingEnabled=false is respected
          pingEnabled: i !== 250,
          extensions: [{ id: 'webhook-sync', version: '1.0.0', apiVersion: 1 }],
        });
      }
      db.saveWebringHubs(hubs);

      let inFlight = 0;
      let peakConcurrency = 0;
      const seenTimeouts = new Set<number>();
      let totalCalls = 0;

      const outcomes = await emitWebhookPings(db, {
        now: () => new Date('2026-11-25T12:30:00.000Z'),
        transport: async (url, init) => {
          totalCalls++;
          seenTimeouts.add(init.timeoutMs);
          inFlight++;
          if (inFlight > peakConcurrency) peakConcurrency = inFlight;
          await new Promise((r) => setTimeout(r, 4));
          inFlight--;

          if (url.includes('hub-007.example')) {
            throw new Error('Simulated socket timeout');
          }
          if (url.includes('hub-013.example')) {
            return { status: 503, json: { error: 'unavailable', message: 'Temporarily overloaded' } };
          }
          // Verify every ping payload carries a valid signature from Alice's unlocked keychain key
          const ok = verifyWebhookPingSignature(
            init.body as Record<string, unknown> & { signature?: string },
            db.getKeys().publicKeyPem
          );
          expect(ok).toBe(true);
          return { status: 202, json: { status: 'queued' } };
        },
      });

      expect(totalCalls).toBe(249); // Hub 250 had pingEnabled=false
      expect(outcomes).toHaveLength(249);
      expect(peakConcurrency).toBeLessThanOrEqual(WEBHOOK_PING_CONCURRENCY);
      expect(peakConcurrency).toBeGreaterThan(1);
      expect([...seenTimeouts]).toEqual([WEBHOOK_PING_TIMEOUT_MS]);

      const stored = db.getWebringHubs();
      const hub1 = stored.find((h) => h.url === 'https://hub-001.example')!;
      const hub7 = stored.find((h) => h.url === 'https://hub-007.example')!;
      const hub13 = stored.find((h) => h.url === 'https://hub-013.example')!;
      const hub250 = stored.find((h) => h.url === 'https://hub-250.example')!;

      expect(hub1.lastPingStatus).toBe(202);
      expect(hub1.lastPingAt).toBe('2026-11-25T12:30:00.000Z');
      expect(hub7.lastPingStatus).toBe(0);
      expect(hub7.lastError).toContain('Simulated socket timeout');
      expect(hub13.lastPingStatus).toBe(503);
      expect(hub250.lastPingAt).toBeUndefined();
    } finally {
      db.close();
    }
  });

  it('routes through configured proxy and aborts with ProxyUnavailableError (never direct) when locked', async () => {
    const dir = makeTempDir();
    const unlockedDb = new StudioDatabase(dir, 'proxy.sqlite', {
      keyCipher: makeTestKeyCipher(true),
      initialProfile: { siteUrl: 'https://alice.example', displayName: 'Alice' },
    });
    unlockedDb.setProxySettings({ enabled: true, proxyUrl: 'socks5h://user:secret@127.0.0.1:9050' });
    unlockedDb.saveWebringHubs([
      {
        url: 'https://hub.example',
        title: 'Tor Hub',
        addedAt: '2026-11-25T00:00:00.000Z',
        listMe: true,
        state: 'listed',
        pingEnabled: true,
        extensions: [{ id: 'webhook-sync', version: '1.0.0', apiVersion: 1 }],
      },
    ]);

    let observedProxy: string | undefined;
    await emitWebhookPings(unlockedDb, {
      transport: async (_url, init) => {
        observedProxy = init.proxyUrl;
        return { status: 202, json: { status: 'queued' } };
      },
    });
    expect(observedProxy).toBe('socks5h://user:secret@127.0.0.1:9050');
    unlockedDb.close();

    // Reopen the SAME database with keychain unavailable -> proxy cannot be unlocked!
    const lockedDb = new StudioDatabase(dir, 'proxy.sqlite', {
      keyCipher: makeTestKeyCipher(false),
    });
    try {
      let networkContacted = false;
      await expect(
        emitWebhookPings(lockedDb, {
          transport: async () => {
            networkContacted = true;
            return { status: 202, json: {} };
          },
        })
      ).rejects.toThrow(ProxyUnavailableError);

      const feedSvc = new HubFeedService(lockedDb, {
        request: async () => {
          networkContacted = true;
          return { status: 200, json: { items: [], documents: {}, nextCursor: null } };
        },
      });
      await expect(feedSvc.fetchFeedPage('https://hub.example')).rejects.toThrow(ProxyUnavailableError);
      expect(networkContacted).toBe(false);
    } finally {
      lockedDb.close();
    }
  });
});

describe('Zero-Trust HubFeedService, Signature Rejection, Isolation & 500-Item Pruning', () => {
  it('verifies valid items, drops tampered/forged items, keeps network_feed isolated, and prunes beyond 500', async () => {
    const dir = makeTempDir();
    const db = new StudioDatabase(dir, 'reader.sqlite', {
      keyCipher: makeTestKeyCipher(true),
      initialProfile: { siteUrl: 'https://me.example', displayName: 'Me' },
    });

    try {
      const bobSite = 'https://bob.example';
      const bobDid = siteUrlToDidWeb(bobSite);
      const bobKeys = generateIdentityKeyPair();
      const bobDidDoc = buildDidDocument(bobSite, bobKeys.publicKeyPem, 'bob');

      const mallorySite = 'https://mallory.example';
      const malloryDid = siteUrlToDidWeb(mallorySite);
      const malloryRealKeys = generateIdentityKeyPair();
      const malloryForgedKeys = generateIdentityKeyPair();
      const malloryDidDoc = buildDidDocument(mallorySite, malloryRealKeys.publicKeyPem, 'mallory');

      // Bob publishes 2 legitimate items in a signed items.json envelope
      const bobItem1 = {
        id: 'post-valid',
        canonicalUrl: `${bobSite}/api/items.json#item-post-valid`,
        type: 'post' as const,
        title: 'Authentic Post',
        targetUrl: `${bobSite}/api/items.json#item-post-valid`,
        category: 'general',
        commentary: 'Signed by Bob',
        mediaUrl: '',
        tags: ['indieweb'],
        createdAt: '2026-11-25T12:00:00.000Z',
      };
      const bobItem2 = {
        id: 'post-tampered',
        canonicalUrl: `${bobSite}/api/items.json#item-post-tampered`,
        type: 'post' as const,
        title: 'Original Title',
        targetUrl: `${bobSite}/api/items.json#item-post-tampered`,
        category: 'general',
        commentary: 'Untampered body',
        mediaUrl: '',
        tags: [],
        createdAt: '2026-11-25T11:59:00.000Z',
      };
      const bobSignedItemsDoc = signDocument<ItemsDocument>(
        {
          schemaVersion: WEBRING_SCHEMA_VERSION,
          siteUrl: bobSite,
          did: bobDid,
          updatedAt: '2026-11-25T12:00:00.000Z',
          items: [bobItem1, bobItem2],
        },
        bobDid,
        bobKeys.privateKeyPem,
        '2026-11-25T12:00:00.000Z'
      );

      // Mallory's document is signed with the WRONG private key (does not match mallory.example/.well-known/did.json)
      const malloryItem = {
        id: 'forged-1',
        canonicalUrl: `${mallorySite}/api/items.json#item-forged-1`,
        type: 'post' as const,
        title: 'Forged Post',
        targetUrl: `${mallorySite}/api/items.json#item-forged-1`,
        category: 'general',
        commentary: 'Forged!',
        mediaUrl: '',
        tags: [],
        createdAt: '2026-11-25T12:05:00.000Z',
      };
      const malloryForgedDoc = signDocument<ItemsDocument>(
        {
          schemaVersion: WEBRING_SCHEMA_VERSION,
          siteUrl: mallorySite,
          did: malloryDid,
          updatedAt: '2026-11-25T12:05:00.000Z',
          items: [malloryItem],
        },
        malloryDid,
        malloryForgedKeys.privateKeyPem,
        '2026-11-25T12:05:00.000Z'
      );

      const hubSvc = new HubFeedService(db, {
        fetchAuthorJson: async (url) => {
          if (url === `${bobSite}/.well-known/did.json`) return bobDidDoc;
          if (url === `${mallorySite}/.well-known/did.json`) return malloryDidDoc;
          throw new Error(`404 ${url}`);
        },
        request: async () => ({
          status: 200,
          json: {
            items: [
              // 1. Valid item matching Bob's signed document
              {
                did: bobDid,
                siteUrl: bobSite,
                itemId: bobItem1.id,
                canonicalUrl: bobItem1.canonicalUrl,
                contentType: 'post',
                publishedAt: bobItem1.createdAt,
                item: bobItem1,
              },
              // 2. Hub tampered with `commentary` on Bob's second item -> MUST BE REJECTED!
              {
                did: bobDid,
                siteUrl: bobSite,
                itemId: bobItem2.id,
                canonicalUrl: bobItem2.canonicalUrl,
                contentType: 'post',
                publishedAt: bobItem2.createdAt,
                item: { ...bobItem2, commentary: 'INJECTED BY COMPROMISED HUB!' },
              },
              // 3. Mallory's document signature doesn't match her did:web key -> MUST BE REJECTED!
              {
                did: malloryDid,
                siteUrl: mallorySite,
                itemId: malloryItem.id,
                canonicalUrl: malloryItem.canonicalUrl,
                contentType: 'post',
                publishedAt: malloryItem.createdAt,
                item: malloryItem,
              },
            ],
            documents: {
              [bobDid]: bobSignedItemsDoc,
              [malloryDid]: malloryForgedDoc,
            },
            nextCursor: null,
          },
        }),
      });

      const page = await hubSvc.fetchFeedPage('https://hub.example');
      expect(page.verifiedCount).toBe(1);
      expect(page.rejectedCount).toBe(2);
      expect(page.entries).toHaveLength(1);
      expect(page.entries[0].itemUri).toBe(bobItem1.canonicalUrl);
      expect(page.entries[0].commentary).toBe('Signed by Bob');

      // Direct-friends Neighborhood Feed (`network_feed`) MUST remain 100% empty & isolated!
      expect(db.getNetworkFeed()).toHaveLength(0);

      // Verify automatic 500-item per-Hub cache pruning
      const bulkRows = Array.from({ length: 540 }, (_, i) => {
        const ts = new Date(Date.UTC(2026, 10, 25, 13, 0, i)).toISOString();
        const uri = `${bobSite}/api/items.json#bulk-${String(i).padStart(4, '0')}`;
        return {
          hubId: 'https://hub.example',
          itemUri: uri,
          authorDid: bobDid,
          authorSiteUrl: bobSite,
          publishedAt: ts,
          rawSignedJson: JSON.stringify({
            did: bobDid,
            siteUrl: bobSite,
            item: {
              id: `bulk-${i}`,
              canonicalUrl: uri,
              type: 'post',
              title: `Post ${i}`,
              targetUrl: uri,
              commentary: `Body ${i}`,
              createdAt: ts,
            },
          }),
          verifiedAt: '2026-11-25T13:00:00.000Z',
        };
      });

      db.upsertHubFeedCacheEntries('https://hub.example', bulkRows);
      expect(db.countHubFeedCache('https://hub.example')).toBe(500);
      const cached = db.getHubFeedCache('https://hub.example', { limit: 500 });
      expect(cached).toHaveLength(500);
      // Newest item (`bulk-0539`) kept; oldest (`bulk-0000`..`bulk-0040`) pruned!
      expect(cached[0].itemUri).toContain('bulk-0539');
      expect(cached.some((e) => e.itemUri.includes('bulk-0005'))).toBe(false);

      // Likes/Replies/Shares created from Hub feed write signed entries to user's own `items.json`
      // and emit a signed webhook ping on publish!
      db.updateProfile({ publishSettings: { lastPublishedAt: '2026-11-25T12:00:00.000Z' } });
      db.saveWebringHubs([
        {
          url: 'https://hub.example',
          title: 'Main Hub',
          addedAt: '2026-11-25T00:00:00.000Z',
          listMe: true,
          state: 'listed',
          pingEnabled: true,
          extensions: [{ id: 'webhook-sync', version: '1.0.0', apiVersion: 1 }],
        },
      ]);

      const createdLike = db.createItem({
        type: 'like',
        title: bobItem1.title,
        targetUrl: bobItem1.canonicalUrl,
        targetAuthorName: 'Bob',
        targetAuthorUrl: bobSite,
        category: 'general',
        commentary: '',
        mediaUrl: '',
        tags: [],
      });
      const bundle = db.buildSignedSiteBundle({ publish: true });
      expect(bundle.items.items.some((i) => i.id === createdLike.id && i.targetUrl === bobItem1.canonicalUrl)).toBe(true);
      expect(bundle.items.proof?.signatureValue).toBeTruthy();

      let pingedUrl = '';
      const webringHubSvc = new WebringHubService(db, {
        fetchJson: async () => ({ updatedAt: bundle.manifest.updatedAt }),
        request: async (url, init) => {
          pingedUrl = url;
          const body = init.body as Record<string, unknown> & { signature?: string };
          expect(canonicalizeJson(body).length).toBeGreaterThan(10);
          expect(verifyWebhookPingSignature(body, db.getKeys().publicKeyPem)).toBe(true);
          return { status: 202, json: { status: 'queued' } };
        },
      });
      webringHubSvc.markPublished(bundle.manifest.updatedAt);
      const pingResults = await webringHubSvc.emitPublishPings();
      expect(pingedUrl).toBe('https://hub.example/api/ext/webhook-sync/v1/ping');
      expect(pingResults).toEqual([{ url: 'https://hub.example', outcome: 'pinged' }]);
    } finally {
      db.close();
    }
  });
});
