import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  CheckCircle2,
  ExternalLink,
  Heart,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  Repeat2,
  Search,
  ShieldCheck,
  Trash2,
  UserPlus,
} from 'lucide-react';
import { normalizeSiteUrl, SharedItemType } from '../shared/schema';
import { friendAvatarSrc } from '../shared/avatar';
import { renderMarkdown } from '../shared/markdown';
import { formatFullLocalTime, formatRelativeTime } from '../shared/relativeTime';
import { HubFeedEntryView, WebringHubApi, WebringHubView } from './WebringHubPanels';

const ESTIMATED_ROW_HEIGHT = 240;
const OVERSCAN_ROWS = 5;

export interface HubFeedViewProps {
  api: WebringHubApi | undefined;
  webringHubs: WebringHubView[];
  selectedHubUrl: string;
  onSelectHubUrl: (url: string) => void;
  ownSiteUrl: string;
  friendSiteUrls: Set<string>;
  myLikedUrls: Set<string>;
  mySharedUrls: Set<string>;
  onCreateSignedInteraction: (input: {
    type: 'like' | 'comment' | 'share';
    title: string;
    targetUrl: string;
    targetAuthorName: string;
    targetAuthorUrl: string;
    mediaUrl?: string;
    commentary?: string;
  }) => Promise<void>;
  onAddFriendFromHub: (author: { siteUrl: string; displayName: string; avatarUrl: string }) => void;
  onModerateAuthor: (siteUrl: string, authorName: string, action: 'mute' | 'block') => Promise<void>;
  onOpenExternal: (url: string) => void;
  onManageHubs: () => void;
  notify: (message: string) => void;
}

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

function hubSupportsFeed(hub: WebringHubView): boolean {
  return Boolean(hub.extensions?.some((e) => e.id === 'webhook-sync' && e.apiVersion === 1));
}

/**
 * Virtualized Zero-Trust Hub Feed Browser (`Friends & Webrings -> Hub Feed`).
 *
 * - Keeps Hub posts strictly isolated in `hub_feed_cache` (never mixed into the direct-friends
 *   Neighborhood Feed).
 * - Verifies every author's Ed25519 signature over `items.json` against `did:web` before display.
 * - Renders variable-height Markdown & media cards inside a virtualized scroll viewport so browsing
 *   up to 500 cached posts per Hub stays smooth at 60fps.
 */
export const HubFeedView: React.FC<HubFeedViewProps> = ({
  api,
  webringHubs,
  selectedHubUrl,
  onSelectHubUrl,
  ownSiteUrl,
  friendSiteUrls,
  myLikedUrls,
  mySharedUrls,
  onCreateSignedInteraction,
  onAddFriendFromHub,
  onModerateAuthor,
  onOpenExternal,
  onManageHubs,
  notify,
}) => {
  const feedCapableHubs = useMemo(() => webringHubs.filter(hubSupportsFeed), [webringHubs]);
  const activeHub = useMemo(
    () =>
      webringHubs.find((h) => h.url === selectedHubUrl) ||
      feedCapableHubs[0] ||
      webringHubs[0] ||
      null,
    [webringHubs, feedCapableHubs, selectedHubUrl]
  );

  const [entries, setEntries] = useState<HubFeedEntryView[]>([]);
  const [cachedTotal, setCachedTotal] = useState(0);
  const [rejectedCount, setRejectedCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState('');
  const [typeFilter, setTypeFilter] = useState<'all' | SharedItemType>('all');
  const [searchQuery, setSearchQuery] = useState('');

  // Inline Reply / Share composer per itemUri
  const [replyOpenUri, setReplyOpenUri] = useState<string | null>(null);
  const [replyText, setReplyText] = useState('');
  const [shareOpenUri, setShareOpenUri] = useState<string | null>(null);
  const [shareText, setShareText] = useState('');
  const [busyActionKey, setBusyActionKey] = useState<string | null>(null);

  // Sync selectedHubUrl when hubs change
  useEffect(() => {
    if (activeHub && activeHub.url !== selectedHubUrl) {
      onSelectHubUrl(activeHub.url);
    }
  }, [activeHub, selectedHubUrl, onSelectHubUrl]);

  const loadFeed = useCallback(
    async (hubUrl: string, resetCursor = true) => {
      if (!api?.fetchHubFeed || !hubUrl) return;
      if (resetCursor) {
        setLoading(true);
        setError('');
        // Paint immediately from isolated local `hub_feed_cache` while fetching fresh verified page
        if (api.getCachedHubFeed) {
          try {
            const cached = await api.getCachedHubFeed(hubUrl, { limit: 500 });
            setEntries(cached.entries);
            setCachedTotal(cached.cachedTotal);
          } catch {
            // ignore cache pre-read errors
          }
        }
      } else {
        setLoadingMore(true);
      }

      try {
        const res = await api.fetchHubFeed(hubUrl, {
          limit: 50,
          before: resetCursor ? undefined : nextCursor || undefined,
        });
        setCachedTotal(res.cachedTotal);
        setNextCursor(res.nextCursor);
        if (resetCursor) {
          setRejectedCount(res.rejectedCount);
        } else {
          setRejectedCount((prev) => prev + res.rejectedCount);
        }
        if (api.getCachedHubFeed) {
          const allCached = await api.getCachedHubFeed(hubUrl, { limit: 500 });
          setEntries(allCached.entries);
          setCachedTotal(allCached.cachedTotal);
        } else {
          setEntries((prev) => {
            if (resetCursor) return res.entries;
            const seen = new Set(prev.map((e) => e.itemUri));
            return [...prev, ...res.entries.filter((e) => !seen.has(e.itemUri))];
          });
        }
      } catch (err) {
        setError(errorText(err));
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [api, nextCursor]
  );

  useEffect(() => {
    if (!activeHub) {
      setEntries([]);
      setNextCursor(null);
      return;
    }
    setNextCursor(null);
    setRejectedCount(0);
    if (hubSupportsFeed(activeHub)) {
      void loadFeed(activeHub.url, true);
    } else if (api?.getCachedHubFeed) {
      void api
        .getCachedHubFeed(activeHub.url, { limit: 500 })
        .then((c) => {
          setEntries(c.entries);
          setCachedTotal(c.cachedTotal);
        })
        .catch(() => setEntries([]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHub?.url]);

  const filteredEntries = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return entries.filter((entry) => {
      if (typeFilter !== 'all' && entry.entryType !== typeFilter) return false;
      if (!q) return true;
      return (
        entry.title.toLowerCase().includes(q) ||
        entry.commentary.toLowerCase().includes(q) ||
        entry.authorName.toLowerCase().includes(q) ||
        entry.authorSiteUrl.toLowerCase().includes(q) ||
        entry.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [entries, typeFilter, searchQuery]);

  // ---------------------------------------------------------------------------
  // Variable-height Virtualized Scroller
  // ---------------------------------------------------------------------------
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const measuredHeights = useRef<Map<string, number>>(new Map());
  const [measureVersion, setMeasureVersion] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(640);

  useEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const updateSize = () => setViewportHeight(el.clientHeight || 640);
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateSize);
      ro.observe(el);
      return () => ro.disconnect();
    }
    return undefined;
  }, []);

  const measureRowRef = useCallback((itemUri: string, node: HTMLDivElement | null) => {
    if (!node) return;
    const height = Math.ceil(node.getBoundingClientRect().height) + 12; // include 12px gap
    if (height > 20 && measuredHeights.current.get(itemUri) !== height) {
      measuredHeights.current.set(itemUri, height);
      setMeasureVersion((v) => v + 1);
    }
  }, []);

  const virtualPlan = useMemo(() => {
    void measureVersion;
    const count = filteredEntries.length;
    const offsets = new Array<number>(count + 1);
    offsets[0] = 0;
    for (let i = 0; i < count; i++) {
      const h = measuredHeights.current.get(filteredEntries[i].itemUri) ?? ESTIMATED_ROW_HEIGHT;
      offsets[i + 1] = offsets[i] + h;
    }
    const totalHeight = offsets[count];

    // Binary search for first visible index
    let lo = 0;
    let hi = count;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (offsets[mid + 1] < scrollTop) lo = mid + 1;
      else hi = mid;
    }
    const startIdx = Math.max(0, lo - OVERSCAN_ROWS);

    const maxBottom = scrollTop + viewportHeight;
    let endIdx = lo;
    while (endIdx < count && offsets[endIdx] < maxBottom) {
      endIdx++;
    }
    endIdx = Math.min(count, endIdx + OVERSCAN_ROWS);

    return {
      totalHeight,
      startIdx,
      endIdx,
      topPad: offsets[startIdx] || 0,
      bottomPad: Math.max(0, totalHeight - (offsets[endIdx] || 0)),
    };
  }, [filteredEntries, scrollTop, viewportHeight, measureVersion]);

  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const target = e.currentTarget;
    setScrollTop(target.scrollTop);
    if (
      activeHub &&
      nextCursor &&
      !loading &&
      !loadingMore &&
      target.scrollHeight - (target.scrollTop + target.clientHeight) < 420
    ) {
      void loadFeed(activeHub.url, false);
    }
  };

  if (!api) return null;

  if (webringHubs.length === 0) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-3">
        <Radio className="w-9 h-9 text-indigo-400 mx-auto" />
        <h3 className="font-bold text-base">No Webring Hubs Configured</h3>
        <p className="text-xs text-slate-400 max-w-md mx-auto">
          Add up to 250 Webring Hubs in the Publish tab to browse zero-trust verified Hub feeds while keeping
          your Neighborhood Feed strictly isolated for direct friends.
        </p>
        <button
          type="button"
          onClick={onManageHubs}
          className="px-4 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold"
        >
          Manage Webring Hubs →
        </button>
      </div>
    );
  }

  const normalizedOwnSite = ownSiteUrl ? normalizeSiteUrl(ownSiteUrl) : '';
  const visibleSlice = filteredEntries.slice(virtualPlan.startIdx, virtualPlan.endIdx);

  return (
    <div className="space-y-4">
      {/* Header & Controls */}
      <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="font-bold text-base flex items-center gap-2">
              <Radio className="w-4 h-4 text-emerald-400" /> Verified Webring Hub Feed
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-300 font-mono">
                Zero-Trust Ed25519 · Isolated Cache
              </span>
            </h3>
            <p className="text-xs text-slate-400 mt-1 max-w-2xl">
              Every item below is cryptographically verified against the author&apos;s own{' '}
              <code>/.well-known/did.json</code> Ed25519 key before caching (capped at 500 items per Hub). Hub
              posts never enter your direct-friends Neighborhood Feed.
            </p>
          </div>
          <button
            type="button"
            onClick={onManageHubs}
            className="text-xs text-indigo-300 hover:underline shrink-0"
          >
            Manage Hubs ({webringHubs.length}/250) →
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={activeHub?.url || ''}
            onChange={(e) => {
              onSelectHubUrl(e.target.value);
              if (viewportRef.current) viewportRef.current.scrollTop = 0;
              setScrollTop(0);
            }}
            aria-label="Select Webring Hub"
            className="px-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs font-medium"
          >
            {webringHubs.map((h) => (
              <option key={h.url} value={h.url}>
                {h.title} {hubSupportsFeed(h) ? '· Feed Ready' : '· Directory Only'}
              </option>
            ))}
          </select>

          <div className="flex rounded-xl bg-slate-950 border border-slate-800 p-0.5 text-xs">
            {(
              [
                ['all', 'All'],
                ['post', 'Posts'],
                ['like', 'Likes'],
                ['share', 'Shares'],
                ['comment', 'Comments'],
                ['recommendation', 'Recs'],
              ] as const
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTypeFilter(id)}
                className={`px-2.5 py-1 rounded-lg font-medium transition ${
                  typeFilter === id ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative flex-1 min-w-[12rem]">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Filter verified Hub posts…"
              className="w-full pl-8 pr-3 py-1.5 rounded-xl bg-slate-950 border border-slate-800 text-xs"
            />
          </div>

          {activeHub && hubSupportsFeed(activeHub) && (
            <button
              type="button"
              disabled={loading}
              onClick={() => void loadFeed(activeHub.url, true)}
              className="px-3 py-1.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold flex items-center gap-1.5"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              {loading ? 'Verifying…' : 'Refresh Feed'}
            </button>
          )}

          {activeHub && api.clearHubFeedCache && cachedTotal > 0 && (
            <button
              type="button"
              disabled={loading}
              onClick={async () => {
                await api.clearHubFeedCache!(activeHub.url);
                setEntries([]);
                setCachedTotal(0);
                setNextCursor(null);
                notify(`Cleared local Hub feed cache for ${activeHub.title}.`);
              }}
              title="Clear locally cached Hub feed items for this Hub"
              className="p-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-rose-300"
            >
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-slate-400">
          <span>
            Showing <strong>{filteredEntries.length}</strong> verified item{filteredEntries.length === 1 ? '' : 's'} ·{' '}
            <strong>{cachedTotal}</strong>/500 cached for {activeHub?.title || 'Hub'}
          </span>
          {rejectedCount > 0 && (
            <span className="text-amber-300 flex items-center gap-1">
              <ShieldCheck className="w-3.5 h-3.5" /> Dropped {rejectedCount} item(s) that failed zero-trust Ed25519
              signature check
            </span>
          )}
        </div>

        {error && <p className="text-xs text-rose-300">⚠ {error}</p>}
      </div>

      {/* Unsupported Hub Notice */}
      {activeHub && !hubSupportsFeed(activeHub) ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-8 text-center space-y-2">
          <p className="text-sm font-semibold text-slate-200">
            {activeHub.title} doesn&apos;t advertise the <code>webhook-sync</code> feed extension
          </p>
          <p className="text-xs text-slate-400 max-w-lg mx-auto">
            You can still search its member directory under <strong>Discover &amp; Privacy</strong>, or choose
            another Webring Hub above that runs <code>webhook-sync v1</code>.
          </p>
        </div>
      ) : loading && filteredEntries.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center space-y-2">
          <Loader2 className="w-7 h-7 animate-spin text-indigo-400 mx-auto" />
          <p className="text-xs text-slate-400">
            Fetching Hub feed and verifying author <code>did:web</code> Ed25519 signatures…
          </p>
        </div>
      ) : filteredEntries.length === 0 ? (
        <div className="bg-slate-900 border border-slate-800 rounded-2xl p-10 text-center space-y-2">
          <Radio className="w-8 h-8 text-slate-500 mx-auto" />
          <p className="text-sm font-semibold text-slate-300">No verified Hub posts yet</p>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Once listed members publish posts and ping {activeHub?.title}, their signed items appear here.
          </p>
        </div>
      ) : (
        <div
          ref={viewportRef}
          onScroll={handleScroll}
          className="max-h-[72vh] overflow-y-auto pr-1 rounded-2xl"
          role="feed"
          aria-label="Verified Hub Feed"
        >
          <div style={{ paddingTop: virtualPlan.topPad, paddingBottom: virtualPlan.bottomPad }}>
            {visibleSlice.map((entry) => {
              const isMine = normalizedOwnSite !== '' && normalizeSiteUrl(entry.authorSiteUrl) === normalizedOwnSite;
              const isFriend = friendSiteUrls.has(normalizeSiteUrl(entry.authorSiteUrl));
              const alreadyLiked = myLikedUrls.has(entry.itemUri);
              const alreadyShared = mySharedUrls.has(entry.targetUrl) || mySharedUrls.has(entry.itemUri);
              const isReplyOpen = replyOpenUri === entry.itemUri;
              const isShareOpen = shareOpenUri === entry.itemUri;

              return (
                <div
                  key={entry.itemUri}
                  ref={(node) => measureRowRef(entry.itemUri, node)}
                  className="mb-3 bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-center gap-2.5 min-w-0">
                      <img
                        src={friendAvatarSrc(entry.authorAvatarUrl, entry.authorSiteUrl)}
                        referrerPolicy="no-referrer"
                        alt={entry.authorName}
                        className="w-9 h-9 rounded-full object-cover bg-slate-800 shrink-0"
                      />
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-bold text-sm truncate">{entry.authorName}</span>
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 font-mono">
                            ✓ Verified DID
                          </span>
                          {isMine && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/20 text-indigo-300 font-semibold">
                              You
                            </span>
                          )}
                          {!isMine && isFriend && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-sky-500/20 text-sky-300">
                              Friend
                            </span>
                          )}
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-400 font-mono">
                          <button
                            type="button"
                            onClick={() => onOpenExternal(entry.authorSiteUrl)}
                            className="hover:text-indigo-300 truncate"
                          >
                            {entry.authorSiteUrl}
                          </button>
                          <span>·</span>
                          <span className="font-sans text-slate-500" title={formatFullLocalTime(entry.publishedAt)}>
                            {formatRelativeTime(entry.publishedAt)}
                          </span>
                        </div>
                      </div>
                    </div>

                    <span
                      className={`text-[11px] uppercase font-bold px-2.5 py-0.5 rounded-full shrink-0 ${
                        entry.entryType === 'post'
                          ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                          : 'bg-indigo-500/20 text-indigo-300'
                      }`}
                    >
                      {entry.entryType === 'post' ? 'Wall Post' : entry.entryType}
                    </span>
                  </div>

                  {entry.mediaUrl && (
                    <img
                      src={entry.mediaUrl}
                      referrerPolicy="no-referrer"
                      alt={entry.title}
                      className="w-full max-h-72 object-cover rounded-xl"
                    />
                  )}

                  {entry.title && <h4 className="font-bold text-base">{entry.title}</h4>}

                  {entry.commentary &&
                    (entry.entryType === 'post' ? (
                      <div
                        className="studio-prose text-sm text-slate-300"
                        dangerouslySetInnerHTML={{ __html: renderMarkdown(entry.commentary) }}
                      />
                    ) : (
                      <p className="text-sm text-slate-300 whitespace-pre-line">{entry.commentary}</p>
                    ))}

                  {entry.targetUrl && entry.targetUrl !== entry.itemUri && (
                    <button
                      type="button"
                      onClick={() => onOpenExternal(entry.targetUrl)}
                      className="text-xs font-mono text-indigo-400 hover:underline flex items-center gap-1 truncate max-w-full"
                    >
                      Target: {entry.targetUrl} <ExternalLink className="w-3 h-3 shrink-0" />
                    </button>
                  )}

                  {entry.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {entry.tags.map((tag) => (
                        <span key={tag} className="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300">
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Actions: Like / Reply / Re-share write signed items to own items.json & trigger Hub ping on publish */}
                  <div className="flex flex-wrap items-center gap-2 pt-2 border-t border-slate-800/80">
                    {!isMine && (
                      <>
                        <button
                          type="button"
                          disabled={alreadyLiked || busyActionKey === `like:${entry.itemUri}`}
                          onClick={async () => {
                            setBusyActionKey(`like:${entry.itemUri}`);
                            try {
                              await onCreateSignedInteraction({
                                type: 'like',
                                title: entry.title || 'Post',
                                targetUrl: entry.itemUri,
                                targetAuthorName: entry.authorName,
                                targetAuthorUrl: entry.authorSiteUrl,
                                mediaUrl: entry.mediaUrl,
                              });
                            } finally {
                              setBusyActionKey(null);
                            }
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ${
                            alreadyLiked
                              ? 'bg-pink-500/30 text-pink-200'
                              : 'bg-pink-500/15 text-pink-300 hover:bg-pink-500/25'
                          }`}
                        >
                          {alreadyLiked ? <CheckCircle2 className="w-3.5 h-3.5" /> : <Heart className="w-3.5 h-3.5" />}
                          {alreadyLiked ? 'Liked' : 'Like'}
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setShareOpenUri(null);
                            setReplyOpenUri(isReplyOpen ? null : entry.itemUri);
                            setReplyText('');
                          }}
                          className="px-3 py-1.5 rounded-lg bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 text-xs font-medium flex items-center gap-1"
                        >
                          <MessageSquare className="w-3.5 h-3.5" /> Reply
                        </button>

                        <button
                          type="button"
                          onClick={() => {
                            setReplyOpenUri(null);
                            setShareOpenUri(isShareOpen ? null : entry.itemUri);
                            setShareText('');
                          }}
                          className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 ${
                            alreadyShared
                              ? 'bg-indigo-500/30 text-indigo-200'
                              : 'bg-indigo-500/15 text-indigo-300 hover:bg-indigo-500/25'
                          }`}
                        >
                          <Repeat2 className="w-3.5 h-3.5" /> {alreadyShared ? 'Shared' : 'Share'}
                        </button>

                        {!isFriend && (
                          <button
                            type="button"
                            onClick={() =>
                              onAddFriendFromHub({
                                siteUrl: entry.authorSiteUrl,
                                displayName: entry.authorName,
                                avatarUrl: entry.authorAvatarUrl,
                              })
                            }
                            className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs flex items-center gap-1"
                          >
                            <UserPlus className="w-3.5 h-3.5" /> Add Friend
                          </button>
                        )}
                      </>
                    )}

                    <button
                      type="button"
                      onClick={() => onOpenExternal(entry.itemUri)}
                      className="px-2.5 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs flex items-center gap-1"
                    >
                      <ExternalLink className="w-3 h-3" /> Source
                    </button>

                    {!isMine && (
                      <div className="ml-auto flex items-center gap-2 text-[11px]">
                        <button
                          type="button"
                          onClick={async () => {
                            await onModerateAuthor(entry.authorSiteUrl, entry.authorName, 'mute');
                            setEntries((prev) =>
                              prev.filter((e) => normalizeSiteUrl(e.authorSiteUrl) !== normalizeSiteUrl(entry.authorSiteUrl))
                            );
                          }}
                          className="text-slate-500 hover:text-amber-300"
                        >
                          Mute
                        </button>
                        <button
                          type="button"
                          onClick={async () => {
                            await onModerateAuthor(entry.authorSiteUrl, entry.authorName, 'block');
                            setEntries((prev) =>
                              prev.filter((e) => normalizeSiteUrl(e.authorSiteUrl) !== normalizeSiteUrl(entry.authorSiteUrl))
                            );
                          }}
                          className="text-slate-500 hover:text-rose-300"
                        >
                          Block
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Inline Signed Reply Composer */}
                  {isReplyOpen && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        if (!replyText.trim()) return;
                        setBusyActionKey(`reply:${entry.itemUri}`);
                        try {
                          await onCreateSignedInteraction({
                            type: 'comment',
                            title: `Re: ${entry.title || 'Post'}`,
                            targetUrl: entry.itemUri,
                            targetAuthorName: entry.authorName,
                            targetAuthorUrl: entry.authorSiteUrl,
                            commentary: replyText.trim(),
                          });
                          setReplyOpenUri(null);
                          setReplyText('');
                        } finally {
                          setBusyActionKey(null);
                        }
                      }}
                      className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
                    >
                      <textarea
                        rows={2}
                        value={replyText}
                        onChange={(e) => setReplyText(e.target.value)}
                        placeholder={`Write a signed reply to ${entry.authorName} (saved to your items.json & pings Hubs on publish)…`}
                        className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setReplyOpenUri(null)}
                          className="px-3 py-1 rounded-lg bg-slate-800 text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={!replyText.trim() || busyActionKey === `reply:${entry.itemUri}`}
                          className="px-3 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white text-xs font-semibold"
                        >
                          Save Signed Reply
                        </button>
                      </div>
                    </form>
                  )}

                  {/* Inline Signed Re-share Composer */}
                  {isShareOpen && (
                    <form
                      onSubmit={async (e) => {
                        e.preventDefault();
                        setBusyActionKey(`share:${entry.itemUri}`);
                        try {
                          await onCreateSignedInteraction({
                            type: 'share',
                            title: entry.title || 'Shared Post',
                            targetUrl: entry.targetUrl || entry.itemUri,
                            targetAuthorName: entry.authorName,
                            targetAuthorUrl: entry.authorSiteUrl,
                            mediaUrl: entry.mediaUrl,
                            commentary: shareText.trim(),
                          });
                          setShareOpenUri(null);
                          setShareText('');
                        } finally {
                          setBusyActionKey(null);
                        }
                      }}
                      className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2"
                    >
                      <input
                        type="text"
                        value={shareText}
                        onChange={(e) => setShareText(e.target.value)}
                        placeholder="Optional commentary for your signed re-share…"
                        className="w-full px-3 py-2 rounded-lg bg-slate-900 border border-slate-800 text-xs"
                      />
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => setShareOpenUri(null)}
                          className="px-3 py-1 rounded-lg bg-slate-800 text-xs"
                        >
                          Cancel
                        </button>
                        <button
                          type="submit"
                          disabled={busyActionKey === `share:${entry.itemUri}`}
                          className="px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white text-xs font-semibold"
                        >
                          Save Signed Share
                        </button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>

          {nextCursor && activeHub && (
            <div className="py-3 text-center">
              <button
                type="button"
                disabled={loadingMore}
                onClick={() => void loadFeed(activeHub.url, false)}
                className="px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-xs font-medium text-slate-200 inline-flex items-center gap-1.5"
              >
                {loadingMore && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                {loadingMore ? 'Verifying older posts…' : 'Load Older Verified Posts'}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
