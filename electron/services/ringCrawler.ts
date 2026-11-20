import * as fs from 'fs';
import * as path from 'path';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as zlib from 'zlib';
import { StudioDatabase } from '../db/database';
import {
  albumIsPosted,
  AlbumsDocumentSchema,
  ConnectionsDocumentSchema,
  DidDocumentSchema,
  documentFingerprint,
  FriendKeyStatus,
  isUrlWithinSite,
  ItemsDocumentSchema,
  KeyRotationCertificate,
  ManifestDocumentKey,
  normalizeSiteUrl,
  ProfileDocumentSchema,
  siteUrlToDidWeb,
  verifyDocumentSignature,
  WebringManifestSchema,
} from '../../src/shared/schema';
import {
  guardedLookup,
  isPrivateNetworkAddress,
  PrivateNetworkAddressError,
  privatePeersAllowed,
} from '../security/networkGuard';
import { createProxyAgent } from '../security/proxyAgent';

export interface CrawlSiteResult {
  siteUrl: string;
  success: boolean;
  displayName?: string;
  itemsIndexed: number;
  photosIndexed: number;
  endorsementsFound: number;
  /** Entries whose canonical URL pointed outside this friend's site (spoofing attempts). */
  entriesRejected: number;
  /** Feed rows and endorsements removed because the friend no longer publishes them. */
  entriesPruned: number;
  verifiedSignature: boolean;
  keyChangedWarning?: boolean;
  /** Set when the crawl was skipped because the site is blocked. */
  blocked?: boolean;
  /** Documents the host said hadn't changed since the last sync, so they weren't downloaded. */
  unchanged?: string[];
  /** Set when Sync All skipped this friend because recent syncs couldn't reach it. */
  deferred?: boolean;
  /** After a failed sync: when Sync All will try this friend again. */
  retryAfter?: string;
  error?: string;
  /**
   * Documents the crawl couldn't use (a parse error, a rejected write, an HTTP error other than
   * 404). The crawl itself still succeeded. Missing or unchanged documents aren't listed.
   */
  documentErrors?: Array<{ doc: string; message: string }>;
  /** Documents refused because they were older than the newest copy already verified. */
  rollbacksBlocked?: number;
}

/** A document that's absent (404, or no such file in a local folder) is normal, not a sync problem. */
function isMissingDocument(err: unknown): boolean {
  if (err instanceof UnchangedDocument) return true;
  if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return true;
  return err instanceof Error && /^HTTP 404 /.test(err.message);
}

export type JsonFetcher = (url: string) => Promise<unknown>;

export interface FetchValidators {
  etag: string;
  lastModified: string;
}

/** A JSON fetch that can ask the host whether the file changed (ETag / Last-Modified). */
export type ConditionalJsonFetcher = (
  url: string,
  validators: FetchValidators | null
) => Promise<{ notModified: true } | { notModified?: false; json: unknown; etag?: string; lastModified?: string }>;

/** HTTP(S) URLs are asked conditionally; local paths are always read in full. */
export const defaultConditionalJsonFetcher: ConditionalJsonFetcher = async (url, validators) => {
  if (!/^https?:\/\//i.test(url)) return { json: await defaultJsonFetcher(url) };
  const res = await fetchPublic(url, { accept: 'application/json', maxBytes: MAX_JSON_BYTES, validators, compressed: true });
  if (res.status === 'not-modified') return { notModified: true };
  return { json: JSON.parse(res.body.toString('utf8')), etag: res.etag, lastModified: res.lastModified };
};

/** Builds a conditional fetcher that tunnels HTTP(S) requests through an optional SOCKS5/Tor/HTTP proxy. */
export function createConditionalJsonFetcher(getProxyUrl: () => string | undefined): ConditionalJsonFetcher {
  return async (url, validators) => {
    const proxyUrl = getProxyUrl();
    if (!/^https?:\/\//i.test(url)) return { json: await defaultJsonFetcher(url, proxyUrl) };
    const res = await fetchPublic(url, {
      accept: 'application/json',
      maxBytes: MAX_JSON_BYTES,
      validators,
      compressed: true,
      proxyUrl,
    });
    if (res.status === 'not-modified') return { notModified: true };
    return { json: JSON.parse(res.body.toString('utf8')), etag: res.etag, lastModified: res.lastModified };
  };
}

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

/** Downloads an image from the public internet (same guards as the crawler), up to 15 MB. */
export async function fetchPublicImage(url: string, proxyUrl?: string): Promise<{ body: Buffer; contentType: string }> {
  const res = await fetchPublic(url, { accept: 'image/*', maxBytes: MAX_IMAGE_BYTES, validators: null, proxyUrl });
  if (res.status === 'not-modified') throw new Error('Unexpected 304');
  if (!/^image\//i.test(res.contentType)) throw new Error(`Not an image: ${res.contentType || 'unknown type'}`);
  return { body: res.body, contentType: res.contentType };
}

const MAX_JSON_BYTES = 5 * 1024 * 1024; // 5 MB limit per crawled JSON document

/** A JSON API answer: the HTTP status and the parsed body (undefined when empty or not JSON). */
export interface PublicJsonResponse {
  status: number;
  json: unknown;
}

/**
 * Calls a JSON API on the public internet (used for optional services such as a Webring
 * Hub), with the same guards as the crawler: private addresses refused, the persona's
 * proxy, a size limit and a timeout. Any HTTP status is returned rather than thrown, so callers
 * can read the service's error body. POSTs are never retried or redirected.
 */
export async function requestPublicJson(
  url: string,
  init: { method?: 'GET' | 'POST'; body?: unknown; proxyUrl?: string } = {}
): Promise<PublicJsonResponse> {
  if (!/^https?:\/\//i.test(url)) throw new Error(`Not a web address: ${url}`);
  const res = await fetchPublic(url, {
    accept: 'application/json',
    maxBytes: MAX_JSON_BYTES,
    validators: null,
    compressed: true,
    proxyUrl: init.proxyUrl,
    method: init.method || 'GET',
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    anyStatus: true,
  });
  if (res.status === 'not-modified') throw new Error(`Unexpected 304 from ${url}`);
  const text = res.body.toString('utf8').trim();
  let json: unknown;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
  }
  return { status: res.httpStatus, json };
}

/**
 * Default fetcher that supports both HTTP(S) URLs and local `file://` or directory paths
 * (making local multi-site testing and offline ring folders work seamlessly).
 */
export async function defaultJsonFetcher(urlOrPath: string, proxyUrl?: string): Promise<unknown> {
  if (urlOrPath.startsWith('file://')) {
    const filePath = new URL(urlOrPath).pathname.replace(/^\/([A-Za-z]:)/, '$1');
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_JSON_BYTES) {
      throw new Error(`File exceeds 5MB limit: ${filePath}`);
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  }
  if (!/^https?:\/\//i.test(urlOrPath)) {
    // A local folder (offline ring folders, tests): a missing file is "not found", like a 404
    if (!fs.existsSync(urlOrPath)) {
      throw Object.assign(new Error(`No such file: ${urlOrPath}`), { code: 'ENOENT' });
    }
    const stat = fs.statSync(urlOrPath);
    if (stat.size > MAX_JSON_BYTES) {
      throw new Error(`File exceeds 5MB limit: ${urlOrPath}`);
    }
    const raw = fs.readFileSync(urlOrPath, 'utf8');
    return JSON.parse(raw);
  }
  const res = await fetchPublic(urlOrPath, {
    accept: 'application/json',
    maxBytes: MAX_JSON_BYTES,
    validators: null,
    compressed: true,
    proxyUrl,
  });
  if (res.status === 'not-modified') throw new Error(`Unexpected 304 fetching ${urlOrPath}`);
  return JSON.parse(res.body.toString('utf8'));
}

const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 10000;

type PublicFetchResult =
  | { status: 'not-modified' }
  | { status: 'ok'; httpStatus: number; body: Buffer; contentType: string; etag: string; lastModified: string };

interface PublicFetchOptions {
  accept: string;
  /** Limit on the body after unpacking, so a small compressed file can't expand without bound. */
  maxBytes: number;
  validators: FetchValidators | null;
  /** Ask for gzip / brotli (JSON compresses about 5x; images don't, so they don't ask). */
  compressed?: boolean;
  /** Optional per-persona outbound proxy URL (socks5://, socks5h://, or http://). */
  proxyUrl?: string;
  /** Defaults to GET. A POST is never retried and never follows redirects. */
  method?: 'GET' | 'POST';
  /** JSON request body (POST only). */
  body?: string;
  /** Resolve with any HTTP status (and its body) instead of rejecting non-2xx answers. */
  anyStatus?: boolean;
}

/** Errors where the connection dropped (often a reused keep-alive socket the host had closed). */
function isConnectionReset(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ECONNRESET' || code === 'EPIPE';
}

/**
 * GETs a URL on the public internet only (see `electron/security/networkGuard.ts`). Every hop,
 * including redirects, is checked against the address actually connected to. With validators,
 * the host can answer 304 Not Modified instead of sending the file again. A dropped connection
 * is retried once; timeouts aren't, so an unreachable site costs one timeout.
 */
async function fetchPublic(rawUrl: string, options: PublicFetchOptions): Promise<PublicFetchResult> {
  try {
    return await fetchPublicOnce(rawUrl, options);
  } catch (err) {
    // Only GETs are safe to repeat
    if (!isConnectionReset(err) || (options.method && options.method !== 'GET')) throw err;
    return fetchPublicOnce(rawUrl, options);
  }
}

function fetchPublicOnce(
  rawUrl: string,
  options: PublicFetchOptions,
  redirectsLeft = MAX_REDIRECTS
): Promise<PublicFetchResult> {
  return new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      reject(new Error(`Invalid URL: ${rawUrl}`));
      return;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      reject(new Error(`Unsupported protocol in ${rawUrl}`));
      return;
    }
    if (url.protocol === 'http:' && !privatePeersAllowed()) {
      reject(new Error(`Refusing insecure http:// URL outside dev mode: ${rawUrl}`));
      return;
    }
    // Node skips the DNS lookup for IP literals, so check those here
    const literalHost = url.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(literalHost) && !privatePeersAllowed() && isPrivateNetworkAddress(literalHost)) {
      reject(new PrivateNetworkAddressError(url.hostname, literalHost));
      return;
    }

    const client = url.protocol === 'https:' ? https : http;
    let proxyAgent: http.Agent | https.Agent | undefined;
    if (options.proxyUrl) {
      try {
        proxyAgent = createProxyAgent(options.proxyUrl, url.protocol as 'http:' | 'https:', FETCH_TIMEOUT_MS);
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
    }
    const method = options.method || 'GET';
    const requestBody = method === 'POST' && options.body !== undefined ? Buffer.from(options.body, 'utf8') : undefined;
    const req = client.request(
      url,
      {
        method,
        // Some hosts (including api.github.com) refuse requests without a User-Agent
        headers: {
          Accept: options.accept,
          'User-Agent': 'WebringStudio/1.0 (+ring crawler)',
          ...(requestBody
            ? { 'Content-Type': 'application/json', 'Content-Length': String(requestBody.length) }
            : {}),
          ...(options.compressed ? { 'Accept-Encoding': 'gzip, br' } : {}),
          ...(options.validators?.etag ? { 'If-None-Match': options.validators.etag } : {}),
          ...(options.validators?.lastModified ? { 'If-Modified-Since': options.validators.lastModified } : {}),
        },
        ...(proxyAgent ? { agent: proxyAgent } : { lookup: guardedLookup }),
        timeout: FETCH_TIMEOUT_MS,
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status === 304 && options.validators) {
          res.resume();
          resolve({ status: 'not-modified' });
          return;
        }
        if (status >= 300 && status < 400 && res.headers.location) {
          res.resume();
          if (method !== 'GET') {
            reject(new Error(`${rawUrl} answered a ${method} with a redirect, which isn't followed`));
            return;
          }
          if (redirectsLeft <= 0) {
            reject(new Error(`Too many redirects fetching ${rawUrl}`));
            return;
          }
          const nextUrl = new URL(res.headers.location, url);
          if (url.protocol === 'https:' && nextUrl.protocol === 'http:' && !privatePeersAllowed()) {
            reject(new Error(`Refusing HTTPS-to-HTTP downgrade redirect from ${rawUrl}`));
            return;
          }
          fetchPublicOnce(nextUrl.toString(), options, redirectsLeft - 1).then(resolve, reject);
          return;
        }
        if ((status < 200 || status >= 300) && !options.anyStatus) {
          res.resume();
          reject(new Error(`HTTP ${status} fetching ${rawUrl}`));
          return;
        }
        const header = (name: string) => {
          const value = res.headers[name];
          return (Array.isArray(value) ? value[0] : value || '').slice(0, 512);
        };
        const encoding = header('content-encoding').trim().toLowerCase();
        const decoder =
          encoding === 'gzip' || encoding === 'x-gzip'
            ? zlib.createGunzip()
            : encoding === 'br'
              ? zlib.createBrotliDecompress()
              : encoding === 'deflate'
                ? zlib.createInflate()
                : null;
        if (!decoder && encoding && encoding !== 'identity') {
          res.resume();
          reject(new Error(`Unsupported content encoding "${encoding}" fetching ${rawUrl}`));
          return;
        }
        const fail = (err: Error) => {
          decoder?.destroy();
          req.destroy(err);
          reject(err);
        };
        const body = decoder ? res.pipe(decoder) : res;
        const chunks: Buffer[] = [];
        let total = 0;
        body.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > options.maxBytes) {
            fail(new Error(`Response from ${rawUrl} exceeds the ${Math.round(options.maxBytes / 1048576)}MB safety limit`));
            return;
          }
          chunks.push(chunk);
        });
        body.on('end', () =>
          resolve({
            status: 'ok',
            httpStatus: status,
            body: Buffer.concat(chunks),
            contentType: header('content-type'),
            etag: header('etag'),
            lastModified: header('last-modified'),
          })
        );
        res.on('error', reject);
        decoder?.on('error', (err) => fail(new Error(`Couldn't unpack ${rawUrl}: ${err.message}`)));
      }
    );
    // `timeout` only covers idle sockets; also cap the whole request
    const deadline = setTimeout(
      () => req.destroy(new Error(`Timed out fetching ${rawUrl}`)),
      FETCH_TIMEOUT_MS
    );
    req.on('close', () => clearTimeout(deadline));
    req.on('timeout', () => req.destroy(new Error(`Timed out fetching ${rawUrl}`)));
    req.on('error', reject);
    req.end(requestBody);
  });
}

/**
 * Friend sites crawled at once by Sync All. Each site's own documents are still fetched one
 * after another; the local load test (`npm run loadtest:sync`) measures the effect.
 */
export const SYNC_CONCURRENCY = 16;

/** Reported by Sync All after each friend, so the Studio window can show progress. */
export interface SyncProgress {
  done: number;
  total: number;
  result: CrawlSiteResult;
}

/** Thrown inside a document's section to skip it when the host reported it unchanged. */
class UnchangedDocument extends Error {}

export class RingCrawler {
  private conditionalFetcher: ConditionalJsonFetcher;

  /**
   * `customFetcher` replaces the network (tests, offline folders) and always fetches in full;
   * `conditionalFetcher` lets a friend's documents skip downloading when unchanged.
   */
  constructor(private db: StudioDatabase, customFetcher?: JsonFetcher, conditionalFetcher?: ConditionalJsonFetcher) {
    this.conditionalFetcher =
      conditionalFetcher ||
      (customFetcher
        ? async (url: string) => ({ json: await customFetcher(url) })
        : createConditionalJsonFetcher(() => {
            const proxy = this.db.getProxySettings();
            return proxy.enabled && proxy.proxyUrl ? proxy.proxyUrl : undefined;
          }));
  }

  /**
   * Crawls a single friend's static profile site (via its base URL or local directory),
   * validates its JSON schemas, checks Ed25519 signatures against `/.well-known/did.json`
   * on EVERY document, enforces TOFU public key pinning, populates the local `network_feed`,
   * and discovers any likes/shares/comments of OUR items (`endorsements`).
   */
  public async crawlFriendSite(friendSiteUrl: string, localDirOverride?: string): Promise<CrawlSiteResult> {
    return this.crawlAndTrack(friendSiteUrl, localDirOverride, true);
  }

  /** Crawls one site and updates its sync backoff: a failure delays the next Sync All attempt. */
  private async crawlAndTrack(
    friendSiteUrl: string,
    localDirOverride: string | undefined,
    applyFeedWindow: boolean
  ): Promise<CrawlSiteResult> {
    const result = await this.crawlSite(friendSiteUrl, localDirOverride, applyFeedWindow);
    if (localDirOverride || result.blocked) return result;
    if (result.success) {
      this.db.clearSyncFailures(result.siteUrl);
    } else {
      const retryAfter = this.db.recordSyncFailure(result.siteUrl);
      if (retryAfter) result.retryAfter = retryAfter;
    }
    return result;
  }

  private async crawlSite(
    friendSiteUrl: string,
    localDirOverride: string | undefined,
    applyFeedWindow: boolean
  ): Promise<CrawlSiteResult> {
    const normalizedFriendUrl = normalizeSiteUrl(friendSiteUrl);
    if (this.db.getModerationAction(normalizedFriendUrl) === 'block') {
      return {
        siteUrl: normalizedFriendUrl,
        success: false,
        itemsIndexed: 0,
        photosIndexed: 0,
        endorsementsFound: 0,
        entriesRejected: 0,
        entriesPruned: 0,
        verifiedSignature: false,
        blocked: true,
        error: 'Site is blocked; skipped crawl.',
      };
    }
    const myProfile = this.db.getProfile();
    const mySiteUrl = normalizeSiteUrl(myProfile.siteUrl);

    const resolveEndpoint = (relEndpoint: string): string => {
      let cleanPath = relEndpoint.trim();
      if (/^https?:\/\//i.test(cleanPath)) {
        const parsed = new URL(cleanPath);
        const baseOrigin = new URL(normalizedFriendUrl).origin;
        if (parsed.origin !== baseOrigin) {
          throw new Error(`Cross-origin endpoint rejected: ${relEndpoint}`);
        }
        cleanPath = parsed.pathname;
      }
      const cleanRel = cleanPath.replace(/^\/+/, '');
      if (cleanRel.split('/').includes('..') || cleanRel.includes('\\')) {
        throw new Error(`Invalid relative endpoint path: ${relEndpoint}`);
      }
      if (localDirOverride) {
        return path.join(localDirOverride, cleanRel);
      }
      return `${normalizedFriendUrl}/${cleanRel}`;
    };

    const unchanged: string[] = [];
    const documentErrors: Array<{ doc: string; message: string }> = [];
    const noteDocumentError = (doc: string, err: unknown) => {
      if (isMissingDocument(err)) return;
      const message = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim().slice(0, 300);
      documentErrors.push({ doc, message });
    };
    // The manifest, did.json and profile are small and needed in full every time, so when the
    // manifest lists the same fingerprint as the copy saved when they last verified (no request),
    // or the host answers 304, that copy is used and checked again as if just downloaded.
    const fetchWithSavedCopy = async (endpoint: string, fingerprint?: string) => {
      const url = resolveEndpoint(endpoint);
      const remote = /^https?:\/\//i.test(url);
      const saved = remote ? this.db.getCachedDocument(url) : null;
      if (saved && fingerprint && saved.fingerprint === fingerprint) {
        unchanged.push(endpoint);
        return { url, remote, json: JSON.parse(saved.body) as unknown, etag: saved.etag, lastModified: saved.lastModified };
      }
      const validators = saved && (saved.etag || saved.lastModified) ? { etag: saved.etag, lastModified: saved.lastModified } : null;
      const res = await this.conditionalFetcher(url, validators);
      if (res.notModified) {
        if (!saved) throw new Error(`Unexpected 304 fetching ${url}`);
        unchanged.push(endpoint);
        return { url, remote, json: JSON.parse(saved.body) as unknown, etag: saved.etag, lastModified: saved.lastModified };
      }
      return { url, remote, json: res.json, etag: res.etag, lastModified: res.lastModified };
    };
    type SavedCopyFetch = Awaited<ReturnType<typeof fetchWithSavedCopy>>;

    try {
      const expectedDid = siteUrlToDidWeb(normalizedFriendUrl);
      const manifestFetch = await fetchWithSavedCopy('/api/manifest.json');
      const rawManifest = manifestFetch.json;
      const manifest = WebringManifestSchema.parse(rawManifest);
      const manifestIdentityMatches =
        manifest.did === expectedDid && normalizeSiteUrl(manifest.siteUrl) === normalizedFriendUrl;
      // Fingerprints the manifest lists for each document (sites from older versions list none)
      const listedFingerprint = (key: ManifestDocumentKey) => manifest.documents?.[key]?.sha256;

      // Fetch DID document for public key signature verification
      let fetchedPublicKeyPem = '';
      let didKeyRotations: KeyRotationCertificate[] | undefined = manifest.keyRotations;
      let didFetch: SavedCopyFetch | null = null;
      try {
        didFetch = await fetchWithSavedCopy(manifest.endpoints.did, listedFingerprint('did'));
        const didDoc = DidDocumentSchema.parse(didFetch.json);
        if (didDoc.id === expectedDid) {
          fetchedPublicKeyPem = didDoc.verificationMethod[0]?.publicKeyPem || '';
          if (didDoc.keyRotations && didDoc.keyRotations.length > 0) {
            didKeyRotations = didDoc.keyRotations;
          }
        }
      } catch {
        // Optional if DID doc isn't reachable
        didFetch = null;
      }

      // Check Trust-On-First-Use (TOFU) public key pinning against existing friend record
      const existingFriend = this.db.getFriendBySiteUrl(normalizedFriendUrl);
      // One pinned key per site, shared with ring hubs and members (site_keys)
      const existingPinnedKey =
        this.db.getSiteKey(normalizedFriendUrl)?.publicKeyPem || existingFriend?.pinnedPublicKeyPem || '';
      let pinStatus: 'pinned' | 'changed' = 'pinned';
      if (fetchedPublicKeyPem) {
        // Pins on first sight; advances if a signed KeyRotationCertificate chain verifies; marks 'changed' otherwise
        pinStatus = this.db.pinSiteKey(normalizedFriendUrl, manifest.did, fetchedPublicKeyPem, didKeyRotations);
      }

      let keyChangedWarning = false;
      let keyStatus: FriendKeyStatus = existingFriend?.keyStatus || 'unverified';
      let pinnedKeyToSave = existingPinnedKey;
      let effectiveVerifyKeyPem = fetchedPublicKeyPem;

      if (fetchedPublicKeyPem) {
        if (pinStatus === 'changed') {
          // Domain key changed unexpectedly without a valid KeyRotationCertificate!
          this.db.recordFriendCandidateKey(normalizedFriendUrl, fetchedPublicKeyPem);
          keyChangedWarning = true;
          keyStatus = 'changed';
          pinnedKeyToSave = existingPinnedKey;
          effectiveVerifyKeyPem = existingPinnedKey;
        } else {
          keyStatus = 'pinned';
          pinnedKeyToSave = fetchedPublicKeyPem;
          effectiveVerifyKeyPem = fetchedPublicKeyPem;
          // Back on its pinned key (or a signed rotation): any candidate seen before is moot
          this.db.clearFriendCandidateKey(normalizedFriendUrl);
        }
      }

      const profileFetch = await fetchWithSavedCopy(manifest.endpoints.profile, listedFingerprint('profile'));
      const rawProfile = profileFetch.json;
      const profile = ProfileDocumentSchema.parse(rawProfile);

      const profileIdentityMatches =
        profile.did === expectedDid && normalizeSiteUrl(profile.siteUrl) === normalizedFriendUrl;

      const isManifestVerified =
        !keyChangedWarning && effectiveVerifyKeyPem && manifest.proof && manifestIdentityMatches
          ? verifyDocumentSignature(
              rawManifest as Record<string, unknown> & { proof?: typeof manifest.proof },
              effectiveVerifyKeyPem
            )
          : false;

      const isProfileVerified =
        !keyChangedWarning && effectiveVerifyKeyPem && profileIdentityMatches
          ? verifyDocumentSignature(
              rawProfile as Record<string, unknown> & { proof?: typeof profile.proof },
              effectiveVerifyKeyPem
            )
          : false;

      // The newest verified date of each document, read before this crawl records any newer one
      const lastVerified = (url: string) => this.db.getDocumentFreshnessMark(url) || '';
      const manifestMark = lastVerified(manifestFetch.url);
      const profileMark = lastVerified(profileFetch.url);
      const isManifestFresh = isManifestVerified
        ? this.db.checkDocumentFreshness(manifestFetch.url, manifest.updatedAt, true)
        : false;
      const isProfileFresh = isProfileVerified
        ? this.db.checkDocumentFreshness(profileFetch.url, profile.updatedAt, true)
        : false;
      // Rollback protection: nothing is deleted unless the manifest itself is verified and current
      const manifestCurrent = Boolean(isManifestVerified) && isManifestFresh;
      let rollbacksBlocked = 0;
      // A validly signed copy older than one already verified is a replay: refused, and the user told
      const blockRollback = (doc: string, servedUpdatedAt: string | undefined, mark: string) => {
        rollbacksBlocked++;
        this.db.addFriendSyncNotice(normalizedFriendUrl, 'rollback_blocked', {
          doc,
          servedUpdatedAt: servedUpdatedAt || '',
          lastVerifiedUpdatedAt: mark,
        });
      };

      // Update friend profile metadata only when both manifest and profile verify and are not rolled back.
      // On key change, rollback, or unverified fetch, update only keyStatus and lastCrawledAt.
      const crawledAt = new Date().toISOString();
      if (isManifestVerified && isProfileVerified && isManifestFresh && isProfileFresh) {
        this.db.addOrUpdateFriend({
          siteUrl: normalizedFriendUrl,
          displayName: profile.displayName,
          handle: profile.handle,
          avatarUrl: profile.avatarUrl,
          bio: profile.bio,
          did: profile.did,
          pinnedPublicKeyPem: pinnedKeyToSave || undefined,
          keyStatus,
          lastCrawledAt: crawledAt,
        });
        this.db.clearNeedsRecrawl(normalizedFriendUrl);
      } else if (existingFriend) {
        this.db.updateFriendVerificationState(normalizedFriendUrl, {
          keyStatus,
          lastCrawledAt: crawledAt,
          pinnedPublicKeyPem: pinnedKeyToSave || undefined,
        });
      } else {
        this.db.addOrUpdateFriend({
          siteUrl: normalizedFriendUrl,
          displayName: new URL(normalizedFriendUrl).hostname,
          pinnedPublicKeyPem: pinnedKeyToSave || undefined,
          keyStatus,
          lastCrawledAt: crawledAt,
        });
      }

      if (isManifestVerified && !isManifestFresh) blockRollback('manifest.json', manifest.updatedAt, manifestMark);
      if (isProfileVerified && !isProfileFresh) blockRollback('profile.json', profile.updatedAt, profileMark);

      // Save copies only of documents that verified and are current; otherwise forget them so
      // they're downloaded next time
      const keepCopies = manifestCurrent && Boolean(isProfileVerified) && isProfileFresh;
      for (const doc of [manifestFetch, profileFetch, ...(didFetch && fetchedPublicKeyPem ? [didFetch] : [])]) {
        if (!doc.remote) continue;
        if (keepCopies) {
          this.db.setFetchValidators(
            doc.url,
            normalizedFriendUrl,
            { etag: doc.etag, lastModified: doc.lastModified },
            JSON.stringify(doc.json),
            documentFingerprint(doc.json as Record<string, unknown>)
          );
        } else {
          this.db.setFetchValidators(doc.url, normalizedFriendUrl, {});
        }
      }

      let photosIndexed = 0;
      let itemsIndexed = 0;
      let endorsementsFound = 0;
      let entriesRejected = 0;
      let entriesPruned = 0;
      let isAlbumsVerified = true;
      let isItemsVerified = true;
      // Entries older than the feed window aren't added (endorsements of our items still are)
      const feedCutoff = this.db.feedCutoffIso();
      const inWindow = (createdAt: string) => !feedCutoff || createdAt >= feedCutoff;
      // items.json and albums.json are asked for conditionally: an unchanged file isn't downloaded
      // or reprocessed. Validators are kept only for files that verified, so anything else is
      // fetched in full next time.
      // A document whose fingerprint in the verified manifest matches the copy last processed
      // isn't requested at all.
      const fetchDocument = async (endpoint: string, fingerprint?: string) => {
        const url = resolveEndpoint(endpoint);
        const remote = /^https?:\/\//i.test(url);
        const trusted = remote && !keyChangedWarning;
        if (trusted && isManifestVerified && fingerprint && this.db.getFetchedFingerprint(url) === fingerprint) {
          unchanged.push(endpoint);
          return { url, notModified: true as const };
        }
        const validators = trusted ? this.db.getFetchValidators(url) : null;
        const res = await this.conditionalFetcher(url, validators);
        if (res.notModified) {
          unchanged.push(endpoint);
          return { url, notModified: true as const };
        }
        return { url, notModified: false as const, json: res.json, remote, etag: res.etag, lastModified: res.lastModified };
      };
      // The fingerprint is of the copy actually processed: if a host served a stale file, it won't
      // match the manifest, so the next sync fetches it again
      const rememberValidators = (doc: { url: string; remote?: boolean; json: unknown; etag?: string; lastModified?: string }) => {
        if (!doc.remote) return;
        this.db.setFetchValidators(
          doc.url,
          normalizedFriendUrl,
          { etag: doc.etag, lastModified: doc.lastModified },
          '',
          documentFingerprint(doc.json as Record<string, unknown>)
        );
      };
      /**
       * Whether a fetched document may be used at all. Refused when the verified manifest lists a
       * different fingerprint for it (reported as a sync problem), or when it's older than the
       * newest copy already verified (a rollback; if validly signed, the user gets a notice).
       */
      const admitDocument = (
        doc: string,
        key: ManifestDocumentKey,
        url: string,
        raw: unknown,
        updatedAt: string | undefined,
        signatureValid: boolean
      ): boolean => {
        const listed = isManifestVerified ? listedFingerprint(key) : undefined;
        if (listed && documentFingerprint(raw as Record<string, unknown>) !== listed) {
          noteDocumentError(doc, new Error("doesn't match the fingerprint in their signed manifest, so it wasn't used"));
          return false;
        }
        if (!this.db.checkDocumentFreshness(url, updatedAt, false)) {
          if (signatureValid) blockRollback(doc, updatedAt, lastVerified(url));
          return false;
        }
        return true;
      };
      // After a verified, current document has been applied, later copies must be at least this new
      const recordVerifiedDate = (url: string, updatedAt: string) => {
        this.db.checkDocumentFreshness(url, updatedAt, true);
      };

      // Crawl albums.json and independently verify its Ed25519 signature
      try {
        const albumsFetch = await fetchDocument(manifest.endpoints.albums, listedFingerprint('albums'));
        if (albumsFetch.notModified) throw new UnchangedDocument();
        const rawAlbums = albumsFetch.json;
        const albumsDoc = AlbumsDocumentSchema.parse(rawAlbums);
        isAlbumsVerified =
          !keyChangedWarning && effectiveVerifyKeyPem
            ? verifyDocumentSignature(
                rawAlbums as Record<string, unknown> & { proof?: typeof albumsDoc.proof },
                effectiveVerifyKeyPem
              )
            : false;

        if (!admitDocument('albums.json', 'albums', albumsFetch.url, rawAlbums, albumsDoc.updatedAt, Boolean(isAlbumsVerified))) {
          isAlbumsVerified = false;
          throw new UnchangedDocument();
        }

        const photoVerified = Boolean(isManifestVerified && isProfileVerified && isAlbumsVerified);
        const seenPhotoUrls: string[] = [];

        const absoluteUrl = (url: string) =>
          !url ? '' : url.startsWith('http') ? url : `${normalizedFriendUrl}/${url.replace(/^\/+/, '')}`;

        // One transaction per document: far faster than committing every row.
        // Each posted album is one feed card; its photos are stored linked to it for the album view.
        this.db.transaction(() => {
          for (const album of albumsDoc.albums) {
            // An unposted album keeps no rows, so a verified sync prunes any stored before
            if (!albumIsPosted(album)) continue;
            if (!isUrlWithinSite(album.canonicalUrl, normalizedFriendUrl)) {
              entriesRejected++;
              continue;
            }
            const photos = album.photos.filter((photo) => {
              if (isUrlWithinSite(photo.canonicalUrl, normalizedFriendUrl)) return true;
              entriesRejected++;
              return false;
            });
            // The album is in the window if its newest photo is; then every photo of it is kept
            const newest = photos.reduce((max, p) => (p.createdAt > max ? p.createdAt : max), '');
            const albumCreatedAt = newest || album.createdAt;
            if (!inWindow(albumCreatedAt)) continue;

            const before = this.db.getFeedAlbumSyncState(album.canonicalUrl);
            // A card seen for the first time (including the first sync after upgrading) has no new photos
            const added = before.newCount === null ? [] : photos.filter((p) => !before.photoUrls.has(p.canonicalUrl));
            const newCount = before.newCount === null ? 0 : before.newCount + added.length;

            for (const photo of photos) {
              const fullPhotoUrl = absoluteUrl(photo.url);
              this.db.upsertNetworkFeedEntry({
                friendSiteUrl: normalizedFriendUrl,
                friendName: profile.displayName,
                friendAvatarUrl: profile.avatarUrl,
                friendDid: profile.did,
                entryType: 'photo',
                title: photo.caption || `${album.title} Photo`,
                canonicalUrl: photo.canonicalUrl,
                targetUrl: fullPhotoUrl,
                commentary: `Published in album "${album.title}"`,
                mediaUrl: fullPhotoUrl,
                tags: photo.tags.length > 0 ? photo.tags : album.tags,
                createdAt: photo.createdAt,
                verifiedSignature: photoVerified,
                albumUrl: album.canonicalUrl,
              });
              seenPhotoUrls.push(photo.canonicalUrl);
              photosIndexed++;
            }

            const cover = absoluteUrl(album.coverUrl);
            // The card links to the album's page only when it's on the friend's own site
            const pageUrl = album.pageUrl ? absoluteUrl(album.pageUrl) : '';
            const albumTargetUrl = pageUrl && isUrlWithinSite(pageUrl, normalizedFriendUrl) ? pageUrl : normalizedFriendUrl;
            // The card shows the new photos first; otherwise the cover, then the album's order
            const byNewest = (a: { createdAt: string }, b: { createdAt: string }) =>
              a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0;
            const thumbs = newCount > 0
              ? [...photos].sort(byNewest).map((p) => absoluteUrl(p.thumbUrl))
              : [cover, ...photos.map((p) => absoluteUrl(p.thumbUrl))];
            const peekUrls = [...new Set(thumbs.filter(Boolean))].slice(0, 3);
            this.db.upsertNetworkFeedEntry({
              friendSiteUrl: normalizedFriendUrl,
              friendName: profile.displayName,
              friendAvatarUrl: profile.avatarUrl,
              friendDid: profile.did,
              entryType: 'album',
              title: album.title,
              canonicalUrl: album.canonicalUrl,
              targetUrl: albumTargetUrl,
              commentary: album.description,
              mediaUrl: cover,
              tags: album.tags,
              createdAt: albumCreatedAt,
              verifiedSignature: photoVerified,
              photoCount: photos.length,
              newCount,
              peekUrls,
            });
            seenPhotoUrls.push(album.canonicalUrl);
          }
        });

        // Only a verified, current document under a verified, current manifest may delete rows, so a
        // hijacked or tampered site (or an old copy replayed) can't wipe the feed
        if (photoVerified && manifestCurrent) {
          entriesPruned += this.db.pruneFriendFeed(normalizedFriendUrl, 'photos', seenPhotoUrls);
          rememberValidators(albumsFetch);
          recordVerifiedDate(albumsFetch.url, albumsDoc.updatedAt);
        }
      } catch (err) {
        // Missing or unchanged is normal; anything else is reported, and the rest of the crawl goes on
        noteDocumentError('albums.json', err);
      }

      // Crawl items.json (posts, shares, likes, recommendations, comments) and independently verify its Ed25519 signature
      try {
        const itemsFetch = await fetchDocument(manifest.endpoints.items, listedFingerprint('items'));
        if (itemsFetch.notModified) throw new UnchangedDocument();
        const rawItems = itemsFetch.json;
        const itemsDoc = ItemsDocumentSchema.parse(rawItems);
        isItemsVerified =
          !keyChangedWarning && effectiveVerifyKeyPem
            ? verifyDocumentSignature(
                rawItems as Record<string, unknown> & { proof?: typeof itemsDoc.proof },
                effectiveVerifyKeyPem
              )
            : false;

        if (!admitDocument('items.json', 'items', itemsFetch.url, rawItems, itemsDoc.updatedAt, Boolean(isItemsVerified))) {
          isItemsVerified = false;
          throw new UnchangedDocument();
        }

        const itemVerified = Boolean(isManifestVerified && isProfileVerified && isItemsVerified);
        const seenItemUrls: string[] = [];

        this.db.transaction(() => {
          for (const item of itemsDoc.items) {
            if (!isUrlWithinSite(item.canonicalUrl, normalizedFriendUrl)) {
              entriesRejected++;
              continue;
            }
            seenItemUrls.push(item.canonicalUrl);
            if (inWindow(item.createdAt)) this.db.upsertNetworkFeedEntry({
              friendSiteUrl: normalizedFriendUrl,
              friendName: profile.displayName,
              friendAvatarUrl: profile.avatarUrl,
              friendDid: profile.did,
              entryType: item.type,
              title: item.title,
              canonicalUrl: item.canonicalUrl,
              targetUrl: item.targetUrl,
              commentary: item.commentary,
              mediaUrl: item.mediaUrl,
              tags: item.tags,
              createdAt: item.createdAt,
              verifiedSignature: itemVerified,
            });
            itemsIndexed++;

            // Check if this friend liked/shared/recommended/commented on an item or photo belonging to OUR site!
            if (item.targetUrl.startsWith(mySiteUrl)) {
              this.db.upsertEndorsement({
                targetCanonicalUrl: item.targetUrl,
                authorSiteUrl: normalizedFriendUrl,
                authorName: profile.displayName,
                authorAvatarUrl: profile.avatarUrl,
                type: item.type,
                commentary: item.commentary,
                sourceItemUrl: item.canonicalUrl,
                createdAt: item.createdAt,
                verifiedSignature: itemVerified,
              });
              endorsementsFound++;
            }
          }
        });

        if (itemVerified && manifestCurrent) {
          // A friend who publishes only recent items has archived the older ones, not deleted them
          const since = itemsDoc.archive?.since;
          entriesPruned += this.db.pruneFriendFeed(normalizedFriendUrl, 'items', seenItemUrls, since);
          entriesPruned += this.db.pruneEndorsementsFrom(normalizedFriendUrl, seenItemUrls, since);
          rememberValidators(itemsFetch);
          recordVerifiedDate(itemsFetch.url, itemsDoc.updatedAt);
        }
      } catch (err) {
        noteDocumentError('items.json', err);
      }

      // connections.json: does this friend list us back ("Mutual")? Only a verified copy that
      // belongs to this site can set or clear it; it's never re-published.
      try {
        const connectionsFetch = await fetchDocument(manifest.endpoints.connections, listedFingerprint('connections'));
        if (connectionsFetch.notModified) throw new UnchangedDocument();
        const rawConnections = connectionsFetch.json;
        const connections = ConnectionsDocumentSchema.parse(rawConnections);
        const connectionsVerified =
          !keyChangedWarning &&
          Boolean(effectiveVerifyKeyPem) &&
          Boolean(connections.proof) &&
          verifyDocumentSignature(
            rawConnections as Record<string, unknown> & { proof?: typeof connections.proof },
            effectiveVerifyKeyPem
          ) &&
          normalizeSiteUrl(connections.siteUrl) === normalizedFriendUrl &&
          connections.did === manifest.did;
        if (
          !admitDocument('connections.json', 'connections', connectionsFetch.url, rawConnections, connections.updatedAt, connectionsVerified)
        ) {
          throw new UnchangedDocument();
        }
        if (connectionsVerified && manifestCurrent) {
          this.db.setFriendListsMe(
            normalizedFriendUrl,
            connections.friends.some((f) => normalizeSiteUrl(f.siteUrl) === mySiteUrl)
          );
          rememberValidators(connectionsFetch);
          recordVerifiedDate(connectionsFetch.url, connections.updatedAt);
        }
      } catch (err) {
        // Optional: missing, unchanged or unverifiable leaves "Mutual" as it was
        noteDocumentError('connections.json', err);
      }

      // Shown as "Sync problem" in the friends list until a sync uses every document again
      this.db.setFriendSyncError(
        normalizedFriendUrl,
        documentErrors.map((e) => `${e.doc}: ${e.message}`).join(' · ')
      );

      // Sync All does this once at the end instead of once per friend
      if (applyFeedWindow) entriesPruned += this.db.pruneFeedOutsideWindow();

      const allVerified =
        !keyChangedWarning &&
        isManifestVerified &&
        isProfileVerified &&
        isAlbumsVerified &&
        isItemsVerified;

      return {
        siteUrl: normalizedFriendUrl,
        success: true,
        displayName: profile.displayName,
        itemsIndexed,
        photosIndexed,
        endorsementsFound,
        entriesRejected,
        entriesPruned,
        verifiedSignature: allVerified,
        keyChangedWarning,
        ...(unchanged.length ? { unchanged } : {}),
        ...(documentErrors.length ? { documentErrors } : {}),
        ...(rollbacksBlocked ? { rollbacksBlocked } : {}),
      };
    } catch (err: unknown) {
      return {
        siteUrl: normalizedFriendUrl,
        success: false,
        itemsIndexed: 0,
        photosIndexed: 0,
        endorsementsFound: 0,
        entriesRejected: 0,
        entriesPruned: 0,
        verifiedSignature: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Crawls all friends in the user's friend ring, `concurrency` sites at a time, so slow or
   * unreachable sites don't hold up the rest. Results are in the same order as the friends.
   * Friends an upgrade flagged for a re-crawl (their unverified profile was reset) are crawled first.
   */
  public async crawlAllFriends(
    options: { concurrency?: number; onProgress?: (progress: SyncProgress) => void } = {}
  ): Promise<CrawlSiteResult[]> {
    const concurrency = options.concurrency ?? SYNC_CONCURRENCY;
    const friends = this.db.getFriends();
    const recrawlFirst = this.db.getNeedsRecrawlUrls();
    // Indexes into `friends`, flagged ones first; results still go back in the friends' order
    const order = friends
      .map((_, index) => index)
      .sort((a, b) => Number(recrawlFirst.has(friends[b].siteUrl)) - Number(recrawlFirst.has(friends[a].siteUrl)) || a - b);
    // Friends that recent syncs couldn't reach wait out their backoff (a single-friend sync still tries)
    const retryTimes = this.db.getSyncRetryTimes();
    const results: CrawlSiteResult[] = new Array(friends.length);
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < order.length) {
        const index = order[next++];
        const siteUrl = normalizeSiteUrl(friends[index].siteUrl);
        const retryAfter = retryTimes.get(siteUrl);
        results[index] = retryAfter
          ? {
              siteUrl,
              success: false,
              itemsIndexed: 0,
              photosIndexed: 0,
              endorsementsFound: 0,
              entriesRejected: 0,
              entriesPruned: 0,
              verifiedSignature: false,
              deferred: true,
              retryAfter,
              error: `Unreachable on recent syncs; next try after ${retryAfter}.`,
            }
          : await this.crawlAndTrack(siteUrl, undefined, false);
        options.onProgress?.({ done: ++done, total: friends.length, result: results[index] });
      }
    };
    const workers = Math.min(Math.max(1, Math.floor(concurrency)), friends.length);
    await Promise.all(Array.from({ length: workers }, worker));
    this.db.pruneFeedOutsideWindow();
    return results;
  }
}
