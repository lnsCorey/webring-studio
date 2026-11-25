import {
  HUB_FEED_CACHE_LIMIT,
  HubFeedCacheRow,
  HubFeedEntry,
  StudioDatabase,
} from '../db/database';
import { privatePeersAllowed } from '../security/networkGuard';
import { requireUsableProxy } from '../security/proxyAgent';
import {
  canonicalizeJson,
  DidDocumentSchema,
  isUrlWithinSite,
  ItemsDocumentSchema,
  KeyRotationCertificate,
  normalizeSiteUrl,
  SharedItemType,
  SignatureProof,
  siteUrlToDidWeb,
  verifyDocumentSignature,
} from '../../src/shared/schema';
import {
  defaultJsonFetcher,
  PublicJsonResponse,
  requestPublicJson,
} from '../services/ringCrawler';
import { normalizeWebringHubUrl } from '../services/webringHubService';
import { runWithConcurrency } from './webhookPing';

export const HUB_FEED_DEFAULT_PAGE_SIZE = 50;
const AUTHOR_DID_RESOLVE_CONCURRENCY = 8;
const AUTHOR_DID_TIMEOUT_MS = 8000;

export type HubFeedRequester = (
  url: string,
  init: { method: 'GET'; proxyUrl?: string; timeoutMs?: number }
) => Promise<PublicJsonResponse>;

export type AuthorDidFetcher = (url: string, proxyUrl?: string) => Promise<unknown>;

export interface HubFeedPageResult {
  hubUrl: string;
  entries: HubFeedEntry[];
  cachedTotal: number;
  verifiedCount: number;
  rejectedCount: number;
  nextCursor: string | null;
}

export interface HubFeedServiceDeps {
  request?: HubFeedRequester;
  fetchAuthorJson?: AuthorDidFetcher;
  now?: () => Date;
  maxCacheItemsPerHub?: number;
}

interface VerifiedAuthorBundle {
  did: string;
  siteUrl: string;
  publicKeyPem: string;
  documentUpdatedAt: string;
  proof: SignatureProof;
  itemsByCanonicalUrl: Map<string, Record<string, unknown>>;
  itemsById: Map<string, Record<string, unknown>>;
}

/**
 * Zero-trust reader for `GET /api/ext/webhook-sync/v1/feed`.
 *
 * Security invariants:
 * 1. Routes every Hub and author `did.json` fetch through the persona's configured proxy;
 *    aborts immediately with `ProxyUnavailableError` if a saved proxy cannot be unlocked.
 * 2. Never trusts the Hub's database blindly: resolves/pins each author's `did:web` Ed25519 key
 *    via `/.well-known/did.json` (respecting TOFU key pinning and `KeyRotationCertificate` chains),
 *    verifies the Ed25519 signature over `documents[did]` (`items.json`), and confirms each item
 *    returned by the Hub matches the signed document byte-for-byte.
 * 3. Stores verified items strictly in `hub_feed_cache` (pruned to 500 newest items per Hub),
 *    completely isolated from `network_feed`, `items`, `friends`, and `endorsements`.
 */
export class HubFeedService {
  private request: HubFeedRequester;
  private fetchAuthorJson: AuthorDidFetcher;
  private now: () => Date;
  private maxCacheItemsPerHub: number;

  constructor(private db: StudioDatabase, deps: HubFeedServiceDeps = {}) {
    this.request =
      deps.request ||
      ((url, init) =>
        requestPublicJson(url, {
          method: init.method,
          proxyUrl: init.proxyUrl,
          timeoutMs: init.timeoutMs,
        }));
    this.fetchAuthorJson =
      deps.fetchAuthorJson || ((url, proxyUrl) => defaultJsonFetcher(url, proxyUrl, AUTHOR_DID_TIMEOUT_MS));
    this.now = deps.now || (() => new Date());
    this.maxCacheItemsPerHub = deps.maxCacheItemsPerHub ?? HUB_FEED_CACHE_LIMIT;
  }

  /** Reads already-verified cached Hub items without making network requests. */
  public getCachedFeed(
    rawHubUrl: string,
    options: { before?: string; limit?: number; contentType?: SharedItemType } = {}
  ): { hubUrl: string; entries: HubFeedEntry[]; cachedTotal: number } {
    const hubUrl = normalizeWebringHubUrl(rawHubUrl);
    return {
      hubUrl,
      entries: this.db.getHubFeedCache(hubUrl, options),
      cachedTotal: this.db.countHubFeedCache(hubUrl),
    };
  }

  /**
   * Fetches one cursor-paginated page (`limit=50` default) from the Hub, verifies every item's
   * Ed25519 signature end-to-end against the author's `did:web` public key, caches verified items
   * in `hub_feed_cache` (pruning beyond 500 items), and returns the verified entries.
   */
  public async fetchFeedPage(
    rawHubUrl: string,
    options: { before?: string; limit?: number; contentType?: SharedItemType } = {}
  ): Promise<HubFeedPageResult> {
    // Strict no-direct-fallback proxy check before ANY network socket opens
    const proxyUrl = requireUsableProxy(this.db.getProxySettings());

    const hubUrl = normalizeWebringHubUrl(rawHubUrl);
    const limit = Math.min(Math.max(Math.floor(options.limit || HUB_FEED_DEFAULT_PAGE_SIZE), 1), 100);
    const params = new URLSearchParams({ limit: String(limit) });
    if (options.before && options.before.trim()) {
      params.set('before', options.before.trim());
    }
    if (options.contentType) {
      params.set('type', options.contentType);
    }

    const res = await this.request(`${hubUrl}/api/ext/webhook-sync/v1/feed?${params.toString()}`, {
      method: 'GET',
      proxyUrl,
    });
    if (res.status !== 200 || !res.json || typeof res.json !== 'object') {
      const msg =
        (res.json as { message?: unknown } | undefined)?.message &&
        typeof (res.json as { message?: unknown }).message === 'string'
          ? String((res.json as { message: string }).message)
          : `Hub feed request failed (HTTP ${res.status})`;
      throw new Error(msg);
    }

    const body = res.json as {
      items?: unknown;
      documents?: unknown;
      nextCursor?: unknown;
    };
    const rawRows = Array.isArray(body.items) ? body.items.slice(0, 100) : [];
    const rawDocs =
      body.documents && typeof body.documents === 'object' && !Array.isArray(body.documents)
        ? (body.documents as Record<string, unknown>)
        : {};
    const nextCursor = typeof body.nextCursor === 'string' && body.nextCursor.trim() ? body.nextCursor.trim() : null;

    // Collect distinct valid (did, siteUrl) pairs present on this page
    const moderation = new Map(this.db.getModeration().map((m) => [m.siteUrl, m.action]));
    const authorCandidates = new Map<string, { did: string; siteUrl: string; rawDoc: unknown }>();
    let rejectedCount = 0;

    for (const rawRow of rawRows) {
      if (!rawRow || typeof rawRow !== 'object') {
        rejectedCount++;
        continue;
      }
      const row = rawRow as Record<string, unknown>;
      const did = typeof row.did === 'string' ? row.did.trim() : typeof row.author_did === 'string' ? row.author_did.trim() : '';
      const rawSite =
        typeof row.siteUrl === 'string'
          ? row.siteUrl.trim()
          : typeof row.author_site_url === 'string'
            ? row.author_site_url.trim()
            : '';

      if (!did || !rawSite || !/^https?:\/\//i.test(rawSite)) {
        rejectedCount++;
        continue;
      }
      const siteUrl = normalizeSiteUrl(rawSite);
      if (!siteUrl.startsWith('https://') && !privatePeersAllowed()) {
        rejectedCount++;
        continue;
      }
      if (did !== siteUrlToDidWeb(siteUrl)) {
        rejectedCount++;
        continue;
      }
      if (moderation.get(siteUrl) === 'block') {
        continue;
      }

      if (!authorCandidates.has(did)) {
        let inlineDoc: unknown = rawDocs[did];
        if (!inlineDoc && typeof row.raw_signed_json === 'string') {
          try {
            inlineDoc = JSON.parse(row.raw_signed_json);
          } catch {
            inlineDoc = undefined;
          }
        }
        authorCandidates.set(did, { did, siteUrl, rawDoc: inlineDoc });
      }
    }

    // Verify each distinct author's `items.json` envelope in bounded parallel batches
    const verifiedAuthors = new Map<string, VerifiedAuthorBundle>();
    await runWithConcurrency(
      [...authorCandidates.values()],
      AUTHOR_DID_RESOLVE_CONCURRENCY,
      async (candidate) => {
        const verified = await this.verifyAuthorItemsDocument(
          candidate.did,
          candidate.siteUrl,
          candidate.rawDoc,
          proxyUrl
        );
        if (verified) {
          verifiedAuthors.set(candidate.did, verified);
        }
      }
    );

    const verifiedAt = this.now().toISOString();
    const toCache: HubFeedCacheRow[] = [];
    const friendsByUrl = new Map(this.db.getFriends().map((f) => [normalizeSiteUrl(f.siteUrl), f]));

    for (const rawRow of rawRows) {
      if (!rawRow || typeof rawRow !== 'object') continue;
      const row = rawRow as Record<string, unknown>;
      const did = typeof row.did === 'string' ? row.did.trim() : typeof row.author_did === 'string' ? row.author_did.trim() : '';
      const rawSite =
        typeof row.siteUrl === 'string'
          ? row.siteUrl.trim()
          : typeof row.author_site_url === 'string'
            ? row.author_site_url.trim()
            : '';
      if (!did || !rawSite || !/^https?:\/\//i.test(rawSite)) continue;
      const siteUrl = normalizeSiteUrl(rawSite);
      if (!siteUrl.startsWith('https://') && !privatePeersAllowed()) continue;
      if (did !== siteUrlToDidWeb(siteUrl)) continue;
      if (moderation.get(siteUrl) === 'block') continue;

      const authorBundle = verifiedAuthors.get(did);
      if (!authorBundle) {
        rejectedCount++;
        continue;
      }

      const candidateItem =
        row.item && typeof row.item === 'object' && !Array.isArray(row.item)
          ? (row.item as Record<string, unknown>)
          : null;
      const itemUri =
        typeof row.canonicalUrl === 'string' && row.canonicalUrl.trim()
          ? row.canonicalUrl.trim()
          : typeof candidateItem?.canonicalUrl === 'string'
            ? candidateItem.canonicalUrl.trim()
            : '';
      const itemId =
        typeof row.itemId === 'string' && row.itemId.trim()
          ? row.itemId.trim()
          : typeof candidateItem?.id === 'string'
            ? candidateItem.id.trim()
            : '';

      if (!itemUri || !isUrlWithinSite(itemUri, siteUrl)) {
        rejectedCount++;
        continue;
      }

      const signedDocItem =
        authorBundle.itemsByCanonicalUrl.get(itemUri) || (itemId ? authorBundle.itemsById.get(itemId) : undefined);
      if (!signedDocItem) {
        rejectedCount++;
        continue;
      }

      // If the Hub also supplied an inline `item` object, confirm it has not been altered by 1 byte
      if (candidateItem && canonicalizeJson(candidateItem) !== canonicalizeJson(signedDocItem)) {
        rejectedCount++;
        continue;
      }

      const publishedAtRaw =
        typeof signedDocItem.createdAt === 'string'
          ? signedDocItem.createdAt
          : typeof row.publishedAt === 'string'
            ? row.publishedAt
            : '';
      const parsedPub = Date.parse(publishedAtRaw);
      if (!publishedAtRaw || !Number.isFinite(parsedPub)) {
        rejectedCount++;
        continue;
      }
      const publishedAt = new Date(parsedPub).toISOString();

      const knownFriend = friendsByUrl.get(siteUrl);
      const rawSignedEnvelope = JSON.stringify({
        did,
        siteUrl,
        documentUpdatedAt: authorBundle.documentUpdatedAt,
        proof: authorBundle.proof,
        ...(knownFriend?.displayName ? { authorName: knownFriend.displayName } : {}),
        ...(knownFriend?.handle ? { authorHandle: knownFriend.handle } : {}),
        ...(knownFriend?.avatarUrl ? { authorAvatarUrl: knownFriend.avatarUrl } : {}),
        item: signedDocItem,
      });

      toCache.push({
        hubId: hubUrl,
        itemUri,
        authorDid: did,
        authorSiteUrl: siteUrl,
        publishedAt,
        rawSignedJson: rawSignedEnvelope,
        verifiedAt,
      });
    }

    this.db.upsertHubFeedCacheEntries(hubUrl, toCache, this.maxCacheItemsPerHub);

    const visibleEntries = this.db.getHubFeedCache(hubUrl, {
      before: options.before,
      limit,
      contentType: options.contentType,
    });

    return {
      hubUrl,
      entries: visibleEntries,
      cachedTotal: this.db.countHubFeedCache(hubUrl),
      verifiedCount: toCache.length,
      rejectedCount,
      nextCursor,
    };
  }

  private async verifyAuthorItemsDocument(
    did: string,
    siteUrl: string,
    rawDoc: unknown,
    proxyUrl: string | undefined
  ): Promise<VerifiedAuthorBundle | null> {
    if (!rawDoc || typeof rawDoc !== 'object' || Array.isArray(rawDoc)) return null;

    const parsedDoc = ItemsDocumentSchema.safeParse(rawDoc);
    if (!parsedDoc.success || !parsedDoc.data.proof) return null;
    if (parsedDoc.data.did !== did || normalizeSiteUrl(parsedDoc.data.siteUrl) !== siteUrl) return null;

    const rawRecord = rawDoc as Record<string, unknown> & { proof?: SignatureProof };

    // 1. Fast path: if Studio already pinned a valid key for this site and the signature verifies, no network needed!
    const existingPin = this.db.getSiteKey(siteUrl);
    let verifiedKeyPem = '';
    if (existingPin && existingPin.keyStatus === 'pinned' && existingPin.publicKeyPem.trim()) {
      if (verifyDocumentSignature(rawRecord, existingPin.publicKeyPem)) {
        verifiedKeyPem = existingPin.publicKeyPem;
      }
    }

    // 2. Unknown author or possible key rotation: resolve `/.well-known/did.json` via SSRF-safe + proxy-aware fetcher
    if (!verifiedKeyPem) {
      const resolved = await this.resolveAndPinAuthorKey(did, siteUrl, proxyUrl);
      if (!resolved) return null;
      if (!verifyDocumentSignature(rawRecord, resolved)) return null;
      verifiedKeyPem = resolved;
    }

    const itemsByCanonicalUrl = new Map<string, Record<string, unknown>>();
    const itemsById = new Map<string, Record<string, unknown>>();
    const rawItemsArray = Array.isArray((rawDoc as { items?: unknown }).items)
      ? ((rawDoc as { items: unknown[] }).items)
      : [];

    for (const rawItem of rawItemsArray) {
      if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) continue;
      const rec = rawItem as Record<string, unknown>;
      const cUrl = typeof rec.canonicalUrl === 'string' ? rec.canonicalUrl.trim() : '';
      const id = typeof rec.id === 'string' ? rec.id.trim() : '';
      if (!cUrl || !isUrlWithinSite(cUrl, siteUrl)) continue;
      itemsByCanonicalUrl.set(cUrl, rec);
      if (id) itemsById.set(id, rec);
    }

    return {
      did,
      siteUrl,
      publicKeyPem: verifiedKeyPem,
      documentUpdatedAt: parsedDoc.data.updatedAt,
      proof: parsedDoc.data.proof,
      itemsByCanonicalUrl,
      itemsById,
    };
  }

  private async resolveAndPinAuthorKey(
    did: string,
    siteUrl: string,
    proxyUrl: string | undefined
  ): Promise<string | null> {
    const parsedUrl = new URL(siteUrl);
    const hasSubpath = parsedUrl.pathname && parsedUrl.pathname !== '/';
    const candidateUrls = hasSubpath
      ? [`${siteUrl}/did.json`, `${siteUrl}/.well-known/did.json`]
      : [`${siteUrl}/.well-known/did.json`];

    let rawDidJson: unknown = null;
    for (const url of candidateUrls) {
      try {
        const cached = this.db.getCachedDocument?.(url);
        if (cached?.body) {
          rawDidJson = JSON.parse(cached.body);
        } else {
          rawDidJson = await this.fetchAuthorJson(url, proxyUrl);
          if (rawDidJson && typeof rawDidJson === 'object' && typeof this.db.setFetchValidators === 'function') {
            this.db.setFetchValidators(url, siteUrl, { etag: 'cached' }, JSON.stringify(rawDidJson));
          }
        }
        if (rawDidJson) break;
      } catch {
        // try fallback URL if any
      }
    }

    if (!rawDidJson || typeof rawDidJson !== 'object') return null;
    const didParsed = DidDocumentSchema.safeParse(rawDidJson);
    if (!didParsed.success || didParsed.data.id !== did) return null;

    const method =
      didParsed.data.verificationMethod.find((m) => m.id === `${did}#key-1`) ||
      didParsed.data.verificationMethod[0];
    const pubPem = method?.publicKeyPem?.trim() || '';
    if (!pubPem) return null;

    const rotations: KeyRotationCertificate[] | undefined = didParsed.data.keyRotations;
    const pinOutcome = this.db.pinSiteKey(siteUrl, did, pubPem, rotations);
    if (pinOutcome === 'changed') {
      // Unexpected key change without a valid rotation chain: refuse zero-trust verification!
      return null;
    }
    return pubPem;
  }
}
