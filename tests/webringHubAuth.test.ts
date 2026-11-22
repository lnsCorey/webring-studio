import { describe, it, expect } from 'vitest';
import * as crypto from 'crypto';
import {
  parseHubAuthUri,
  WebringHubService,
  WebringHubRequester,
} from '../electron/services/webringHubService';
import { canonicalizeJson, siteUrlToDidWeb } from '../src/shared/schema';
import type { StudioDatabase, WebringHubRecord } from '../electron/db/database';

function makeEd25519Pair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  };
}

function makeFakeDb(siteUrl: string, privateKeyPem: string, hubs: WebringHubRecord[]): StudioDatabase {
  return {
    getProfile: () => ({
      siteUrl,
      displayName: 'Alice',
      publishSettings: { lastPublishedAt: '2026-11-21T00:00:00Z' },
    }),
    getKeys: () => ({ privateKeyPem, publicKeyPem: '' }),
    getWebringHubs: () => hubs,
    saveWebringHubs: () => {},
  } as unknown as StudioDatabase;
}

describe('parseHubAuthUri', () => {
  it('parses a valid webring://hub-auth URI with optional ext', () => {
    const uri =
      'webring://hub-auth?hub=https%3A%2F%2Fhub.example&challenge=0123456789abcdef0123456789abcdef&nonce=fedcba9876543210fedcba9876543210&ext=arcade';
    const parsed = parseHubAuthUri(uri);
    expect(parsed).toEqual({
      hubUrl: 'https://hub.example',
      challengeId: '0123456789abcdef0123456789abcdef',
      nonce: 'fedcba9876543210fedcba9876543210',
      requestedExt: 'arcade',
    });
  });

  it('rejects non-https hubs, missing challenge/nonce, and wrong protocol', () => {
    expect(parseHubAuthUri('https://hub.example/?challenge=aaa')).toBeNull();
    expect(parseHubAuthUri('webring://hub-auth?hub=http://hub.example&challenge=0123456789abcdef&nonce=0123456789abcdef')).toBeNull();
    expect(parseHubAuthUri('webring://hub-auth?hub=https://hub.example&challenge=short&nonce=0123456789abcdef')).toBeNull();
    expect(parseHubAuthUri('webring://ring-request?token=abc')).toBeNull();
  });
});

describe('WebringHubService DID auth signing', () => {
  it('signs approveAuthChallenge with Ed25519 matching canonical hub_auth payload', async () => {
    const keys = makeEd25519Pair();
    const siteUrl = 'https://alice.example';
    const hubUrl = 'https://hub.example';
    const hubs: WebringHubRecord[] = [
      { url: hubUrl, title: 'Hub', addedAt: '2026-11-21T00:00:00Z', listMe: true, state: 'listed' },
    ];
    let capturedBody: Record<string, unknown> | undefined;
    const requester: WebringHubRequester = async (_url, init) => {
      capturedBody = init.body as Record<string, unknown>;
      return { url: _url, status: 200, headers: {}, json: { ok: true } };
    };

    const svc = new WebringHubService(makeFakeDb(siteUrl, keys.privateKeyPem, hubs), {
      request: requester,
      now: () => new Date('2026-11-21T20:00:00.000Z'),
    });

    const res = await svc.approveAuthChallenge(
      {
        hubUrl,
        challengeId: '0123456789abcdef0123456789abcdef',
        nonce: 'fedcba9876543210fedcba9876543210',
        requestedExt: 'arcade',
      },
      ['arcade']
    );

    expect(res.ok).toBe(true);
    expect(capturedBody).toBeDefined();
    const { signature, ...payload } = capturedBody as Record<string, unknown>;
    expect(payload).toEqual({
      action: 'hub_auth',
      hubUrl,
      did: siteUrlToDidWeb(siteUrl),
      siteUrl,
      nonce: 'fedcba9876543210fedcba9876543210',
      challengeId: '0123456789abcdef0123456789abcdef',
      optInExtensions: ['arcade'],
      createdAt: '2026-11-21T20:00:00.000Z',
    });

    const ok = crypto.verify(
      null,
      Buffer.from(canonicalizeJson(payload), 'utf8'),
      crypto.createPublicKey(keys.publicKeyPem),
      Buffer.from(String(signature), 'base64url')
    );
    expect(ok).toBe(true);
  });

  it('creates a signed direct-launch URL and sends signed opt-out', async () => {
    const keys = makeEd25519Pair();
    const siteUrl = 'https://alice.example';
    const hubUrl = 'https://hub.example';
    const hubs: WebringHubRecord[] = [
      { url: hubUrl, title: 'Hub', addedAt: '2026-11-21T00:00:00Z', listMe: true, state: 'listed' },
    ];
    const requester: WebringHubRequester = async (url) => {
      if (url.endsWith('/api/nonce')) {
        return { url, status: 200, headers: {}, json: { nonce: 'aaaa1111bbbb2222cccc3333dddd4444' } };
      }
      if (url.endsWith('/api/auth/verify')) {
        return { url, status: 200, headers: {}, json: { ok: true, code: 'code123', secret: 'sec456' } };
      }
      if (url.includes('/api/auth/extensions/arcade/opt-out')) {
        return { url, status: 200, headers: {}, json: { extensionId: 'arcade', optedIn: false } };
      }
      return { url, status: 404, headers: {}, json: {} };
    };

    const svc = new WebringHubService(makeFakeDb(siteUrl, keys.privateKeyPem, hubs), {
      request: requester,
      now: () => new Date('2026-11-21T20:00:00.000Z'),
    });

    const launchUrl = await svc.createSignedLaunchUrl(hubUrl, '/ext/arcade/');
    expect(launchUrl).toBe('https://hub.example/auth/claim?code=code123&secret=sec456&next=%2Fext%2Farcade%2F');

    const optOut = await svc.optOutExtension(hubUrl, 'arcade');
    expect(optOut).toEqual({ extensionId: 'arcade', optedIn: false });
  });
});
