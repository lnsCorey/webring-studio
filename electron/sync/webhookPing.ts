import * as crypto from 'crypto';
import { StudioDatabase, WebringHubRecord } from '../db/database';
import { ProxyUnavailableError, requireUsableProxy } from '../security/proxyAgent';
import {
  canonicalizeJson,
  isPlaceholderSiteUrl,
  KeyRotationCertificate,
  normalizeSiteUrl,
  siteUrlToDidWeb,
} from '../../src/shared/schema';
import { PublicJsonResponse, requestPublicJson } from '../services/ringCrawler';

/** Max in-flight Hub webhook pings at once so 250 Hubs finish in ~2-3s without exhausting sockets. */
export const WEBHOOK_PING_CONCURRENCY = 10;
/** Per-request timeout for fast-acknowledge Hub webhook pings (`202 Accepted` target < 50ms). */
export const WEBHOOK_PING_TIMEOUT_MS = 5000;

export interface SignedWebhookPingPayload {
  did: string;
  manifest_url: string;
  timestamp: string;
  publicKeyPem?: string;
  keyRotations?: KeyRotationCertificate[];
  signature: string;
}

export interface WebhookPingOutcome {
  url: string;
  status: number | null;
  outcome: 'pinged' | 'stale' | 'waiting' | 'dropped' | 'not-listed' | 'blocked' | 'key-changed' | 'skipped' | 'error';
  message?: string;
}

export type WebhookPingTransport = (
  url: string,
  init: { method: 'POST'; body?: unknown; proxyUrl?: string; timeoutMs: number }
) => Promise<PublicJsonResponse>;

/**
 * Builds and signs a `POST /api/ext/webhook-sync/v1/ping` payload matching `webring-hub-php` /
 * `webring-hub-node` 1-for-1: detached Ed25519 (`base64url`) over `canonicalizeJson(payload)`
 * (excluding `signature` and `proof`), including `keyRotations` when the persona rotated keys.
 */
export function buildSignedWebhookPing(params: {
  did: string;
  manifestUrl: string;
  timestamp: string;
  privateKeyPem: string;
  publicKeyPem?: string;
  keyRotations?: KeyRotationCertificate[];
}): SignedWebhookPingPayload {
  const hasRotations = Array.isArray(params.keyRotations) && params.keyRotations.length > 0;
  const signable: Record<string, unknown> = {
    did: params.did,
    manifest_url: params.manifestUrl,
    timestamp: params.timestamp,
    ...(hasRotations
      ? {
          ...(params.publicKeyPem ? { publicKeyPem: params.publicKeyPem } : {}),
          keyRotations: params.keyRotations,
        }
      : {}),
  };
  const signature = crypto
    .sign(null, Buffer.from(canonicalizeJson(signable), 'utf8'), params.privateKeyPem)
    .toString('base64url');

  return {
    did: params.did,
    manifest_url: params.manifestUrl,
    timestamp: params.timestamp,
    ...(hasRotations
      ? {
          ...(params.publicKeyPem ? { publicKeyPem: params.publicKeyPem } : {}),
          keyRotations: params.keyRotations,
        }
      : {}),
    signature,
  };
}

/**
 * Verifies a detached Ed25519 webhook ping signature (`base64url` or standard `base64`) against
 * `publicKeyPem`, mirroring `Verify::verifyPayloadSignature` in `webring-hub-php`.
 */
export function verifyWebhookPingSignature(
  payload: Record<string, unknown> & { signature?: string },
  publicKeyPem: string
): boolean {
  try {
    const rawSig = typeof payload.signature === 'string' ? payload.signature.trim() : '';
    if (!rawSig) return false;
    const signable: Record<string, unknown> = { ...payload };
    delete signable.signature;
    delete signable.proof;
    const canonical = canonicalizeJson(signable);
    const normalizedB64 = rawSig.replace(/-/g, '+').replace(/_/g, '/');
    const sigBuf = Buffer.from(normalizedB64, 'base64');
    if (sigBuf.length !== 64) return false;
    return crypto.verify(null, Buffer.from(canonical, 'utf8'), publicKeyPem, sigBuf);
  } catch {
    return false;
  }
}

/**
 * Runs async tasks over `items` with at most `concurrency` workers active simultaneously,
 * preserving result order.
 */
export async function runWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  if (items.length === 0) return [];
  const limit = Math.max(1, Math.min(Math.floor(concurrency) || 1, items.length));
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners = Array.from({ length: limit }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);
  return results;
}

function hubSupportsWebhookSync(hub: WebringHubRecord): boolean {
  if (!hub.extensions || hub.extensions.length === 0) return false;
  return hub.extensions.some((e) => e.id === 'webhook-sync' && e.apiVersion === 1);
}

function responseErrorCode(res: PublicJsonResponse): string {
  const body = res.json as { error?: unknown } | undefined;
  return body && typeof body.error === 'string' ? body.error : '';
}

function responseErrorMessage(res: PublicJsonResponse, fallback: string): string {
  const body = res.json as { message?: unknown } | undefined;
  const msg = body && typeof body.message === 'string' ? body.message.trim().slice(0, 300) : '';
  return msg || `${fallback} (HTTP ${res.status})`;
}

export interface EmitWebhookPingsOptions {
  /** Custom HTTP transport (used in tests or WebringHubService). */
  transport?: WebhookPingTransport;
  /** Optional live-manifest `updatedAt` already observed on the persona's public site. */
  liveManifestUpdatedAt?: string;
  /** Override concurrency (defaults to 10). */
  concurrency?: number;
  /** Override per-request timeout in ms (defaults to 5000). */
  timeoutMs?: number;
  /** Override clock for deterministic testing. */
  now?: () => Date;
  /** When true, only pings hubs that still have `pendingPingFor` set (used by delayed follow-up sweeps). */
  onlyPending?: boolean;
  /** Max wait before dropping a pending follow-up ping (default 24h). */
  maxWaitMs?: number;
}

/**
 * Unlocks the persona's Ed25519 private key from the OS keychain, enforces the persona's
 * outbound proxy (throwing `ProxyUnavailableError` immediately with zero direct fallback if the
 * proxy cannot be unlocked), and sends signed `POST /api/ext/webhook-sync/v1/ping` requests
 * (or legacy `/refresh` when a Hub does not run `webhook-sync`) with bounded concurrency (`10` max,
 * `5000ms` timeout).
 *
 * Individual Hub failures record `last_ping_status` on that Hub without throwing.
 */
export async function emitWebhookPings(
  db: StudioDatabase,
  options: EmitWebhookPingsOptions = {}
): Promise<WebhookPingOutcome[]> {
  // Strict proxy rule: abort BEFORE any socket is opened if a configured proxy cannot be unlocked.
  const proxySettings = typeof db.getProxySettings === 'function' ? db.getProxySettings() : { enabled: false, proxyUrl: '' };
  const proxyUrl = requireUsableProxy(proxySettings);

  const recordStatus = (
    url: string,
    update: Parameters<StudioDatabase['recordWebringHubPingStatus']>[1]
  ) => {
    if (typeof db.recordWebringHubPingStatus === 'function') {
      db.recordWebringHubPingStatus(url, update);
      return;
    }
    const all = db.getWebringHubs();
    const idx = all.findIndex((d) => d.url === url);
    if (idx < 0) return;
    const cur = { ...all[idx] };
    cur.lastPingAt = update.lastPingAt;
    cur.lastPingStatus = update.lastPingStatus;
    if (update.state !== undefined) cur.state = update.state;
    if (update.listMe !== undefined) cur.listMe = update.listMe;
    if (update.lastError !== undefined) {
      if (update.lastError === null) delete cur.lastError;
      else cur.lastError = update.lastError;
    }
    if (update.pendingPingFor !== undefined) {
      if (update.pendingPingFor === null) delete cur.pendingPingFor;
      else cur.pendingPingFor = update.pendingPingFor;
    }
    if (update.pendingSince !== undefined) {
      if (update.pendingSince === null) delete cur.pendingSince;
      else cur.pendingSince = update.pendingSince;
    }
    all[idx] = cur;
    db.saveWebringHubs(all);
  };

  const profile = db.getProfile();
  if (isPlaceholderSiteUrl(profile.siteUrl)) return [];
  const siteUrl = normalizeSiteUrl(profile.siteUrl);
  const did = siteUrlToDidWeb(siteUrl);
  const manifestUrl = `${siteUrl}/api/manifest.json`;

  const allHubs = db.getWebringHubs();
  const targets = allHubs.filter((h) => {
    if (!h.listMe) return false;
    if (h.pingEnabled === false) return false;
    if (options.onlyPending && !h.pendingPingFor) return false;
    return true;
  });
  if (targets.length === 0) return [];

  // Unlock Ed25519 signing key once from the OS keychain (`safeStorage`) for the whole batch.
  const { publicKeyPem, privateKeyPem } = db.getKeys();
  const keyRotations = typeof db.getKeyRotations === 'function' ? db.getKeyRotations() : [];

  const nowFn = options.now || (() => new Date());
  const timeoutMs = options.timeoutMs ?? WEBHOOK_PING_TIMEOUT_MS;
  const concurrency = options.concurrency ?? WEBHOOK_PING_CONCURRENCY;
  const maxWaitMs = options.maxWaitMs ?? 24 * 60 * 60 * 1000;
  const transport: WebhookPingTransport =
    options.transport ||
    ((url, init) =>
      requestPublicJson(url, {
        method: init.method,
        body: init.body,
        proxyUrl: init.proxyUrl,
        timeoutMs: init.timeoutMs,
      }));

  const liveUpdatedAt = options.liveManifestUpdatedAt || '';

  return runWithConcurrency(targets, concurrency, async (hub): Promise<WebhookPingOutcome> => {
    const now = nowFn();
    const nowIso = now.toISOString();
    const supportsWebhook = hubSupportsWebhookSync(hub);
    const pendingTarget = hub.pendingPingFor || '';
    const isLiveReady = Boolean(liveUpdatedAt && (!pendingTarget || liveUpdatedAt >= pendingTarget));

    // Legacy hubs without `webhook-sync` crawl synchronously during `/refresh`, so they must wait
    // until the live site actually serves the newly published manifest.
    if (!supportsWebhook && pendingTarget && !isLiveReady) {
      const since = Date.parse(hub.pendingSince || '') || now.getTime();
      if (now.getTime() - since > maxWaitMs) {
        recordStatus(hub.url, {
          lastPingAt: hub.lastPingAt || nowIso,
          lastPingStatus: hub.lastPingStatus ?? null,
          pendingPingFor: null,
          pendingSince: null,
          lastError:
            "Your live site didn't show the latest publish within a day, so the Webring Hub wasn't asked to re-read it.",
        });
        return { url: hub.url, status: null, outcome: 'dropped' };
      }
      return { url: hub.url, status: null, outcome: 'waiting' };
    }

    // In a delayed follow-up sweep (`onlyPending: true`), wait until the CDN catches up before re-pinging.
    if (options.onlyPending && pendingTarget && !isLiveReady) {
      const since = Date.parse(hub.pendingSince || '') || now.getTime();
      if (now.getTime() - since > maxWaitMs) {
        recordStatus(hub.url, {
          lastPingAt: hub.lastPingAt || nowIso,
          lastPingStatus: hub.lastPingStatus ?? null,
          pendingPingFor: null,
          pendingSince: null,
          lastError:
            "Your live site didn't show the latest publish within a day, so the Webring Hub wasn't asked to re-read it.",
        });
        return { url: hub.url, status: null, outcome: 'dropped' };
      }
      return { url: hub.url, status: null, outcome: 'waiting' };
    }

    try {
      if (supportsWebhook) {
        // Use a strictly current UTC timestamp so monotonic Hub checks always advance cleanly.
        const publishedManifestTs =
          typeof db.getPublishedManifestUpdatedAt === 'function' ? db.getPublishedManifestUpdatedAt() : undefined;
        const pingTimestamp =
          publishedManifestTs && publishedManifestTs > nowIso ? publishedManifestTs : nowIso;

        const signedPayload = buildSignedWebhookPing({
          did,
          manifestUrl,
          timestamp: pingTimestamp,
          privateKeyPem,
          publicKeyPem,
          keyRotations,
        });

        const res = await transport(`${hub.url}/api/ext/webhook-sync/v1/ping`, {
          method: 'POST',
          body: signedPayload,
          proxyUrl,
          timeoutMs,
        });

        const code = responseErrorCode(res);
        if (res.status === 202 || res.status === 200) {
          // Clear pendingPingFor once the live CDN is caught up; keep it armed if GitHub Pages is still deploying.
          const clearPending = !pendingTarget || isLiveReady;
          recordStatus(hub.url, {
            lastPingAt: nowIso,
            lastPingStatus: res.status,
            state: 'listed',
            lastError: null,
            ...(clearPending ? { pendingPingFor: null, pendingSince: null } : {}),
          });
          return { url: hub.url, status: res.status, outcome: 'pinged' };
        }

        if (res.status === 409 && code === 'stale_timestamp') {
          recordStatus(hub.url, {
            lastPingAt: nowIso,
            lastPingStatus: 409,
            state: 'listed',
            lastError: null,
            pendingPingFor: null,
            pendingSince: null,
          });
          return { url: hub.url, status: 409, outcome: 'stale' };
        }

        if (code === 'entry_blocked' || res.status === 403) {
          const message = responseErrorMessage(res, `${hub.title} blocked or deactivated this listing`);
          recordStatus(hub.url, {
            lastPingAt: nowIso,
            lastPingStatus: res.status,
            state: code === 'entry_blocked' ? 'blocked' : 'error',
            listMe: code === 'entry_blocked' ? false : hub.listMe,
            lastError: message,
            pendingPingFor: null,
            pendingSince: null,
          });
          return { url: hub.url, status: res.status, outcome: code === 'entry_blocked' ? 'blocked' : 'error', message };
        }

        if (code === 'key_changed') {
          const message = responseErrorMessage(res, 'The Webring Hub pinned a different key');
          recordStatus(hub.url, {
            lastPingAt: nowIso,
            lastPingStatus: res.status,
            state: 'key-changed',
            lastError: message,
            pendingPingFor: null,
            pendingSince: null,
          });
          return { url: hub.url, status: res.status, outcome: 'key-changed', message };
        }

        if (res.status === 404) {
          const message = `${hub.title} no longer lists your site. List it again if you want to be included.`;
          recordStatus(hub.url, {
            lastPingAt: nowIso,
            lastPingStatus: 404,
            state: 'not-listed',
            listMe: false,
            lastError: message,
            pendingPingFor: null,
            pendingSince: null,
          });
          return { url: hub.url, status: 404, outcome: 'not-listed', message };
        }

        const message = responseErrorMessage(res, `${hub.title} rejected webhook ping`);
        recordStatus(hub.url, {
          lastPingAt: nowIso,
          lastPingStatus: res.status,
          lastError: message,
        });
        return { url: hub.url, status: res.status, outcome: 'error', message };
      }

      // Legacy Hub fallback: `POST /api/entries/{did}/refresh`
      const res = await transport(`${hub.url}/api/entries/${encodeURIComponent(did)}/refresh`, {
        method: 'POST',
        proxyUrl,
        timeoutMs,
      });
      const code = responseErrorCode(res);
      if (res.status === 200 || res.status === 202) {
        recordStatus(hub.url, {
          lastPingAt: nowIso,
          lastPingStatus: res.status,
          state: 'listed',
          lastError: null,
          pendingPingFor: null,
          pendingSince: null,
        });
        return { url: hub.url, status: res.status, outcome: 'pinged' };
      }
      if (res.status === 404) {
        const message = `${hub.title} no longer lists your site. List it again if you want to be included.`;
        recordStatus(hub.url, {
          lastPingAt: nowIso,
          lastPingStatus: 404,
          state: 'not-listed',
          listMe: false,
          lastError: message,
          pendingPingFor: null,
          pendingSince: null,
        });
        return { url: hub.url, status: 404, outcome: 'not-listed', message };
      }
      if (code === 'key_changed') {
        const message = responseErrorMessage(res, 'The Webring Hub pinned a different key');
        recordStatus(hub.url, {
          lastPingAt: nowIso,
          lastPingStatus: res.status,
          state: 'key-changed',
          lastError: message,
          pendingPingFor: null,
          pendingSince: null,
        });
        return { url: hub.url, status: res.status, outcome: 'key-changed', message };
      }
      const message = responseErrorMessage(res, `${hub.title} couldn't re-read your site`);
      recordStatus(hub.url, {
        lastPingAt: nowIso,
        lastPingStatus: res.status,
        lastError: message,
        pendingPingFor: null,
        pendingSince: null,
      });
      return { url: hub.url, status: res.status, outcome: 'error', message };
    } catch (err) {
      if (err instanceof ProxyUnavailableError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      recordStatus(hub.url, {
        lastPingAt: nowIso,
        lastPingStatus: 0,
        lastError: message,
      });
      return { url: hub.url, status: 0, outcome: 'error', message };
    }
  });
}
