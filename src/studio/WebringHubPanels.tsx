import React, { useEffect, useState } from 'react';
import { BookOpen, CircleDot, Globe, Loader2, Plus, Radio, Search, ShieldCheck, Trash2, UserPlus, X } from 'lucide-react';
import { normalizeSiteUrl, SharedItemType } from '../shared/schema';

/**
 * Optional Webring Hubs (electron/services/webringHubService.ts,
 * docs/architecture/webring-hub.md). A hub is a third-party index: search results are hints
 * the user can turn into a normal Add Friend, and listing the site is an opt-in per hub.
 */

/** database.ts WebringHubRecord. Local only, never exported. */
export interface WebringHubView {
  url: string;
  title: string;
  addedAt: string;
  listMe: boolean;
  state: 'not-listed' | 'listed' | 'blocked' | 'key-changed' | 'error';
  pingEnabled?: boolean;
  lastListedAt?: string;
  lastPingAt?: string;
  lastPingStatus?: number | null;
  pendingPingFor?: string;
  pendingSince?: string;
  lastError?: string;
  /** Extensions the hub advertises in /api/info. */
  extensions?: Array<{ id: string; version: string; apiVersion: number }>;
  infoCheckedAt?: string;
}

export interface HubFeedEntryView {
  hubId: string;
  itemUri: string;
  itemId: string;
  authorDid: string;
  authorSiteUrl: string;
  authorName: string;
  authorHandle: string;
  authorAvatarUrl: string;
  entryType: SharedItemType;
  title: string;
  targetUrl: string;
  category: string;
  commentary: string;
  mediaUrl: string;
  rating?: number;
  tags: string[];
  publishedAt: string;
  updatedAt?: string;
  verifiedAt: string;
  rawSignedJson: string;
}

export interface HubFeedPageResultView {
  hubUrl: string;
  entries: HubFeedEntryView[];
  cachedTotal: number;
  verifiedCount: number;
  rejectedCount: number;
  nextCursor: string | null;
}

/** webringHubService.ts WebringHubKeyCheck. Shown, never stored. */
export interface WebringHubKeyCheckView {
  siteUrl: string;
  did: string;
  pinnedFingerprint: string;
  results: Array<{
    webringHubUrl: string;
    title: string;
    result: 'match' | 'mismatch' | 'not-listed' | 'error';
    since?: string;
    pinnedKeySeen?: boolean;
    currentOutcome?: string;
    rejectedKeys?: number;
    message?: string;
  }>;
}

/** Extensions Studio has a client for (webringHubService.ts KNOWN_WEBRING_HUB_EXTENSIONS). */
const EXTENSION_LABELS: Record<string, { label: string; apiVersion: number; hint: string }> = {
  'key-witness': {
    label: 'Key witness',
    apiVersion: 1,
    hint: 'Keeps a history of the signing keys it has seen, so Studio can compare a friend\'s key with it.',
  },
  'webhook-sync': {
    label: 'Webhook Sync & Feed',
    apiVersion: 1,
    hint: 'Accepts fast signed webhook pings on publish and serves a zero-trust aggregated Hub feed.',
  },
};

/** webringHubService.ts WebringHubSearchResult. Never stored. */
export interface WebringHubSearchResultView {
  siteUrl: string;
  did: string;
  displayName: string;
  handle: string;
  tagline: string;
  avatarUrl: string;
  interests: string[];
  verifiedAt: string;
  relation: 'self' | 'friend' | 'muted' | 'none';
}

export interface HubAuthRequestView {
  hubUrl: string;
  challengeId: string;
  nonce: string;
  requestedExt?: string;
}

export interface WebringHubApi {
  listWebringHubs: () => Promise<WebringHubView[]>;
  addWebringHub: (url: string) => Promise<WebringHubView>;
  removeWebringHub: (url: string, options?: { force?: boolean }) => Promise<WebringHubView[]>;
  searchWebringHub: (
    url: string,
    query: string,
    options?: { limit?: number; offset?: number }
  ) => Promise<{ webringHubUrl: string; total: number; results: WebringHubSearchResultView[] }>;
  setWebringHubListed: (url: string, listed: boolean) => Promise<WebringHubView>;
  setWebringHubPingEnabled?: (url: string, enabled: boolean) => Promise<WebringHubView>;
  pingWebringHubsNow?: () => Promise<Array<{ url: string; outcome: string; message?: string }>>;
  getCachedHubFeed?: (
    url: string,
    options?: { before?: string; limit?: number; contentType?: string }
  ) => Promise<{ hubUrl: string; entries: HubFeedEntryView[]; cachedTotal: number }>;
  fetchHubFeed?: (
    url: string,
    options?: { before?: string; limit?: number; contentType?: string }
  ) => Promise<HubFeedPageResultView>;
  clearHubFeedCache?: (url?: string) => Promise<{ ok: boolean }>;
  checkKeyWithWebringHubs?: (siteUrl: string) => Promise<WebringHubKeyCheckView>;
  approveWebringHubAuth?: (req: HubAuthRequestView, optInExtensions?: string[]) => Promise<{ ok: boolean; did: string; hubUrl: string }>;
  launchWebringHub?: (url: string, targetPath?: string, optInExtensions?: string[]) => Promise<{ ok: boolean }>;
  optOutWebringHubExtension?: (url: string, extensionId: string) => Promise<{ extensionId: string; optedIn: boolean }>;
}

/** A ring this persona is in, with the member sites Studio knows, for tagging hub search results. */
export interface HubSearchRing {
  id: string;
  name: string;
  memberUrls: Set<string>;
}

/**
 * The rings this persona is in, from Studio's own ring data (never from the hub, which doesn't
 * know about rings): every member of an active ring it hosts, and for a joined ring the members
 * in rotation at the last sync. Members a joined ring has taken out of rotation aren't known.
 */
export function ringsForHubSearch(
  joined: Array<{
    id: string;
    name: string;
    status: string;
    prevSiteUrl?: string;
    nextSiteUrl?: string;
    rotationUrls?: string[];
  }>,
  hosted: Array<{
    id: string;
    name: string;
    status: string;
    maintainerIsMember: boolean;
    members: Array<{ siteUrl: string }>;
  }>,
  ownSiteUrl: string
): HubSearchRing[] {
  const urls = (list: Array<string | undefined>) =>
    new Set(list.filter((u): u is string => !!u && !!u.trim()).map((u) => normalizeSiteUrl(u)));
  const rings: HubSearchRing[] = [];
  for (const ring of hosted) {
    if (ring.status !== 'active') continue;
    const members = ring.members.map((m) => m.siteUrl);
    if (ring.maintainerIsMember) members.push(ownSiteUrl);
    rings.push({ id: ring.id, name: ring.name, memberUrls: urls(members) });
  }
  for (const ring of joined) {
    if (ring.status !== 'member' || rings.some((r) => r.id === ring.id)) continue;
    rings.push({
      id: ring.id,
      name: ring.name,
      memberUrls: urls([...(ring.rotationUrls || []), ring.prevSiteUrl, ring.nextSiteUrl, ownSiteUrl]),
    });
  }
  return rings.sort((a, b) => a.name.localeCompare(b.name));
}

/** With a ring filter on, how many hub results are checked (the hub can't filter by ring). */
const RING_FILTER_SCAN_LIMIT = 200;
const RING_FILTER_PAGE_SIZE = 50;

const errorText = (err: unknown) =>
  (err instanceof Error ? err.message : String(err)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const formatTime = (iso?: string) => {
  if (!iso) return '';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString();
};

const STATE_LABELS: Record<WebringHubView['state'], { label: string; className: string }> = {
  'not-listed': { label: 'Not listed', className: 'bg-slate-800 text-slate-300' },
  listed: { label: 'Listed', className: 'bg-emerald-500/20 text-emerald-300' },
  blocked: { label: 'Blocked by hub', className: 'bg-rose-500/20 text-rose-300' },
  'key-changed': { label: 'Key mismatch', className: 'bg-amber-500/20 text-amber-300' },
  error: { label: 'Error', className: 'bg-rose-500/20 text-rose-300' },
};

/** Shared loader: the persona's hubs, refreshed when the persona changes. */
export function useWebringHubs(api: WebringHubApi | undefined, personaKey: string) {
  const [webringHubs, setWebringHubs] = useState<WebringHubView[]>([]);
  const reload = async () => {
    if (!api) return;
    try {
      setWebringHubs(await api.listWebringHubs());
    } catch {
      setWebringHubs([]);
    }
  };
  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, personaKey]);
  return { webringHubs, setWebringHubs, reload };
}

/**
 * Publish tab: which hubs this persona uses and whether the site is listed in each.
 */
export function WebringHubListingsPanel(props: {
  api: WebringHubApi | undefined;
  webringHubs: WebringHubView[];
  reload: () => Promise<void>;
  hasPublished: boolean;
  notify: (message: string) => void;
  onOpenHubFeed?: (hubUrl: string) => void;
}) {
  const { api, webringHubs, reload, hasPublished, notify, onOpenHubFeed } = props;
  const [newUrl, setNewUrl] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  if (!api) return null;

  const run = async (key: string, fn: () => Promise<void>) => {
    setBusy(key);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
      await reload();
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="font-bold text-base flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-indigo-400" /> Webring Hubs
          </h3>
          <p className="text-xs text-slate-400 mt-1 max-w-2xl">
            Webring Hubs are optional, third-party servers that index Webring sites. Add one to search it from the
            Friends tab. Listing your site is up to you: the hub reads and verifies your published,
            signed files itself, and Studio asks it to re-read them after each publish. Your site never
            depends on a hub.
          </p>
        </div>
        <span className="text-[11px] text-slate-500">Stored locally per persona · never exported</span>
      </div>

      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newUrl.trim()) return;
          void run('add', async () => {
            const added = await api.addWebringHub(newUrl.trim());
            setNewUrl('');
            notify(`Added ${added.title}. Your site isn't listed there until you choose to list it.`);
          });
        }}
      >
        <input
          type="text"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="https://hub.example"
          className="flex-1 min-w-[16rem] px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono"
        />
        <button
          type="submit"
          disabled={busy !== null || !newUrl.trim()}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-xs font-medium flex items-center gap-1.5"
        >
          {busy === 'add' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
          Add Webring Hub
        </button>
      </form>

      {error && <p className="text-xs text-rose-300">{error}</p>}

      {webringHubs.length === 0 ? (
        <p className="text-xs text-slate-500">No Webring Hubs yet.</p>
      ) : (
        <ul className="space-y-2">
          {webringHubs.map((d) => {
            const state = STATE_LABELS[d.state] || STATE_LABELS.error;
            return (
              <li key={d.url} className="p-3 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-sm text-slate-200 flex items-center gap-2">
                      {d.title}
                      <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${state.className}`}>
                        {state.label}
                      </span>
                    </div>
                    <div className="text-[11px] text-slate-500 font-mono truncate">{d.url}</div>
                    {d.extensions && d.extensions.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {d.extensions.map((ext) => {
                          const known = EXTENSION_LABELS[ext.id];
                          const usable = !!known && known.apiVersion === ext.apiVersion;
                          return (
                            <span
                              key={ext.id}
                              className={`text-[10px] px-1.5 py-0.5 rounded font-mono ${
                                usable ? 'bg-indigo-500/15 text-indigo-300' : 'bg-slate-800 text-slate-500'
                              }`}
                              title={
                                usable
                                  ? known.hint
                                  : 'An extension this version of Studio doesn\'t use. It\'s shown for information only.'
                              }
                            >
                              {usable ? known.label : ext.id} {ext.version}
                            </span>
                          );
                        })}
                      </div>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-3">
                    <label
                      className={`flex items-center gap-1.5 text-xs ${hasPublished ? 'text-slate-200' : 'text-slate-500'}`}
                      title={hasPublished ? '' : 'Publish your site first'}
                    >
                      <input
                        type="checkbox"
                        checked={d.listMe}
                        disabled={busy !== null || (!hasPublished && !d.listMe)}
                        onChange={(e) => {
                          const listed = e.target.checked;
                          void run(d.url, async () => {
                            await api.setWebringHubListed(d.url, listed);
                            notify(listed ? `Your site is listed in ${d.title}.` : `Your listing was removed from ${d.title}.`);
                          });
                        }}
                        className="accent-indigo-500"
                      />
                      List my site
                    </label>
                    {api.setWebringHubPingEnabled && (
                      <label
                        className={`flex items-center gap-1.5 text-xs ${d.listMe ? 'text-slate-200' : 'text-slate-400'}`}
                        title="Send a signed Ed25519 webhook ping to this Hub whenever you publish your site"
                      >
                        <input
                          type="checkbox"
                          checked={d.pingEnabled !== false}
                          disabled={busy !== null}
                          onChange={(e) => {
                            const enabled = e.target.checked;
                            void run(`ping:${d.url}`, async () => {
                              await api.setWebringHubPingEnabled!(d.url, enabled);
                              notify(
                                enabled
                                  ? `Enabled webhook pings on publish for ${d.title}.`
                                  : `Paused webhook pings on publish for ${d.title}.`
                              );
                            });
                          }}
                          className="accent-emerald-500"
                        />
                        Ping Hub on Publish
                      </label>
                    )}
                    {(busy === d.url || busy === `ping:${d.url}`) && (
                      <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />
                    )}
                    <button
                      type="button"
                      disabled={busy !== null}
                      title={
                        d.listMe
                          ? 'Unlist your site first. If this hub can no longer be reached, you can forget it anyway.'
                          : 'Remove this Webring Hub'
                      }
                      onClick={() => {
                        // A listed hub that can't be reached can never be unlisted, so offer to forget it
                        // after a warning instead of leaving it stuck in the list.
                        if (
                          d.listMe &&
                          !window.confirm(
                            `Your site is still listed in ${d.title}.\n\n` +
                              `If the hub still works, cancel and untick "List my site" first so your listing is removed.\n\n` +
                              `Only continue if the hub can't be reached any more. Studio will forget it, and any listing ` +
                              `on that server stays there until its operator removes it.`
                          )
                        ) {
                          return;
                        }
                        void run(`remove:${d.url}`, async () => {
                          await api.removeWebringHub(d.url, { force: d.listMe });
                          if (d.listMe) notify(`Forgot ${d.title}. Your listing there wasn't removed.`);
                        });
                      }}
                      className="p-1.5 rounded-lg hover:bg-slate-800 disabled:opacity-40 text-slate-400"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
                <div className="text-[11px] text-slate-500 flex flex-wrap items-center gap-x-4 gap-y-1">
                  {d.lastListedAt && <span>Listed {formatTime(d.lastListedAt)}</span>}
                  {d.lastPingAt && (
                    <span className="flex items-center gap-1.5">
                      Last ping {formatTime(d.lastPingAt)}
                      {d.lastPingStatus !== undefined && d.lastPingStatus !== null && (
                        <span
                          className={`px-1.5 py-0.5 rounded font-mono text-[10px] ${
                            d.lastPingStatus === 202 || d.lastPingStatus === 200
                              ? 'bg-emerald-500/15 text-emerald-300'
                              : d.lastPingStatus === 409
                                ? 'bg-slate-800 text-slate-300'
                                : 'bg-rose-500/15 text-rose-300'
                          }`}
                        >
                          {d.lastPingStatus === 0 ? 'network error' : `HTTP ${d.lastPingStatus}`}
                        </span>
                      )}
                    </span>
                  )}
                  {d.listMe && d.pingEnabled === false && (
                    <span className="text-amber-300">Auto-ping paused</span>
                  )}
                  {d.listMe && d.pingEnabled !== false && d.pendingPingFor && (
                    <span>Waiting for your live site to show the last publish</span>
                  )}
                </div>
                {onOpenHubFeed && d.extensions?.some((ext) => ext.id === 'webhook-sync' && ext.apiVersion === 1) && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      onClick={() => onOpenHubFeed(d.url)}
                      className="px-2.5 py-1 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 text-[11px] font-medium flex items-center gap-1"
                    >
                      <Radio className="w-3 h-3" /> Browse Verified Hub Feed
                    </button>
                    {d.state === 'listed' && api.optOutWebringHubExtension && (
                      <button
                        type="button"
                        disabled={busy !== null}
                        onClick={() => {
                          if (
                            !window.confirm(
                              `Opt out of Webhook Sync & Feed on ${d.title} and purge your cached posts from its feed?`
                            )
                          ) {
                            return;
                          }
                          void run(`optout-feed:${d.url}`, async () => {
                            await api.optOutWebringHubExtension!(d.url, 'webhook-sync');
                            notify(`Opted out of Webhook Sync on ${d.title} and purged your feed items there.`);
                          });
                        }}
                        className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 text-[11px] font-medium disabled:opacity-40"
                      >
                        Purge My Posts on Hub
                      </button>
                    )}
                  </div>
                )}
                {d.state === 'listed' && api?.launchWebringHub && (
                  <div className="flex flex-wrap items-center gap-2 pt-1">
                    <button
                      type="button"
                      disabled={busy !== null}
                      onClick={() => {
                        void run(`launch:${d.url}`, async () => {
                          await api.launchWebringHub!(d.url, '/');
                          notify(`Opened ${d.title} signed in with your DID.`);
                        });
                      }}
                      className="px-2.5 py-1 rounded-lg bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 text-[11px] font-medium disabled:opacity-40"
                    >
                      Open Hub (Signed In)
                    </button>
                    {d.extensions?.some((ext) => ext.id === 'arcade') && (
                      <>
                        <button
                          type="button"
                          disabled={busy !== null}
                          onClick={() => {
                            void run(`launch-arcade:${d.url}`, async () => {
                              await api.launchWebringHub!(d.url, '/ext/arcade/');
                              notify(`Opened ${d.title} Arcade signed in with your DID.`);
                            });
                          }}
                          className="px-2.5 py-1 rounded-lg bg-fuchsia-500/20 hover:bg-fuchsia-500/30 text-fuchsia-200 text-[11px] font-medium disabled:opacity-40"
                        >
                          Open Arcade
                        </button>
                        {api.optOutWebringHubExtension && (
                          <button
                            type="button"
                            disabled={busy !== null}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Opt out of Arcade on ${d.title} and permanently delete all your high scores and play history there?`
                                )
                              ) {
                                return;
                              }
                              void run(`optout:${d.url}`, async () => {
                                await api.optOutWebringHubExtension!(d.url, 'arcade');
                                notify(`Opted out of Arcade on ${d.title} and deleted your scores.`);
                              });
                            }}
                            className="px-2.5 py-1 rounded-lg bg-rose-500/15 hover:bg-rose-500/25 text-rose-200 text-[11px] font-medium disabled:opacity-40"
                          >
                            Opt out &amp; Delete Arcade Data
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                {d.state === 'key-changed' && (
                  <p className="text-[11px] text-amber-300">
                    This Webring Hub pinned a different signing key for your site. If you rotated your key with
                    Rotate Signing Key, publish again so it can follow the rotation; otherwise ask the hub's
                    operator to accept your new key.
                  </p>
                )}
                {d.lastError && <p className="text-[11px] text-rose-300">{d.lastError}</p>}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * Friends tab: search a hub and copy a result into the Add Friend form. Nothing is added
 * or stored until the user submits that form, which crawls and verifies the site itself.
 */
export function WebringHubSearchPanel(props: {
  api: WebringHubApi | undefined;
  webringHubs: WebringHubView[];
  /** Rings this persona is in (see ringsForHubSearch), for the filter and the result tags. */
  webrings?: HubSearchRing[];
  onUse: (result: WebringHubSearchResultView) => void;
  onManage: () => void;
}) {
  const { api, webringHubs, onUse, onManage } = props;
  const webrings = props.webrings || [];
  const [webringHubUrl, setWebringHubUrl] = useState('');
  const [query, setQuery] = useState('');
  const [ringFilter, setRingFilter] = useState('');
  const [results, setResults] = useState<WebringHubSearchResultView[] | null>(null);
  const [total, setTotal] = useState(0);
  const [scanned, setScanned] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!webringHubs.some((d) => d.url === webringHubUrl)) {
      setWebringHubUrl(webringHubs[0]?.url || '');
      setResults(null);
    }
  }, [webringHubs, webringHubUrl]);

  // A ring that's gone (left, closed) can't stay selected
  useEffect(() => {
    if (ringFilter && !webrings.some((r) => r.id === ringFilter)) {
      setRingFilter('');
      setResults(null);
    }
  }, [webrings, ringFilter]);

  if (!api) return null;

  const ringsOf = (siteUrl: string) => webrings.filter((r) => r.memberUrls.has(siteUrl));
  const selectedRing = webrings.find((r) => r.id === ringFilter);
  const shown = results && selectedRing ? results.filter((r) => selectedRing.memberUrls.has(r.siteUrl)) : results;

  const search = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!webringHubUrl) return;
    setBusy(true);
    setError('');
    try {
      if (!ringFilter) {
        const res = await api.searchWebringHub(webringHubUrl, query);
        setResults(res.results);
        setTotal(res.total);
        setScanned(res.results.length);
        return;
      }
      // The hub doesn't know about rings, so read several pages and filter them here
      const seen = new Map<string, WebringHubSearchResultView>();
      let offset = 0;
      let hubTotal = 0;
      while (offset < RING_FILTER_SCAN_LIMIT) {
        const res = await api.searchWebringHub(webringHubUrl, query, { limit: RING_FILTER_PAGE_SIZE, offset });
        hubTotal = res.total;
        for (const r of res.results) seen.set(r.siteUrl, r);
        offset += RING_FILTER_PAGE_SIZE;
        if (res.results.length === 0 || offset >= hubTotal) break;
      }
      setResults([...seen.values()]);
      setTotal(hubTotal);
      setScanned(Math.min(offset, hubTotal));
    } catch (err) {
      setError(errorText(err));
      setResults(null);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="bg-slate-900 border border-slate-800 rounded-2xl p-5 space-y-4">
      <div>
        <h3 className="font-bold text-base flex items-center gap-2">
          <Search className="w-4 h-4 text-indigo-400" /> Find People in a Webring Hub
        </h3>
        <p className="text-xs text-slate-400 mt-1">
          Results come from a third-party Webring Hub and are only suggestions. Choosing one fills in the Add
          Friend form; Studio then reads and verifies that person's own site, exactly as if you'd typed the
          address. Search results aren't saved.
        </p>
      </div>

      {webringHubs.length === 0 ? (
        <p className="text-xs text-slate-500">
          You haven't added a Webring Hub yet.{' '}
          <button type="button" onClick={onManage} className="text-indigo-300 hover:underline">
            Add one in the Publish tab
          </button>
          .
        </p>
      ) : (
        <form onSubmit={search} className="flex flex-wrap gap-2">
          {webringHubs.length > 1 && (
            <select
              value={webringHubUrl}
              onChange={(e) => {
                setWebringHubUrl(e.target.value);
                setResults(null);
              }}
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
            >
              {webringHubs.map((d) => (
                <option key={d.url} value={d.url}>
                  {d.title}
                </option>
              ))}
            </select>
          )}
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Interests, names, places…"
            className="flex-1 min-w-[12rem] px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
          />
          {webrings.length > 0 && (
            <select
              value={ringFilter}
              onChange={(e) => {
                setRingFilter(e.target.value);
                setResults(null);
              }}
              title="Show only members of a webring you're in. Membership comes from your own ring lists, not from the hub."
              className="px-3 py-1.5 rounded-lg bg-slate-950 border border-slate-800 text-xs"
            >
              <option value="">All webrings</option>
              {webrings.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            disabled={busy || !webringHubUrl}
            className="px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium flex items-center gap-1.5"
          >
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
            Search
          </button>
        </form>
      )}

      {error && <p className="text-xs text-rose-300">{error}</p>}

      {results && shown && (
        <div className="space-y-2">
          <p className="text-[11px] text-slate-500">
            {selectedRing
              ? `${shown.length === 0 ? 'No' : shown.length} member${shown.length === 1 ? '' : 's'} of ${selectedRing.name} ` +
                `among ${scanned === total ? `all ${total}` : `the first ${scanned} of ${total}`} matching profiles.` +
                (scanned < total ? ' Narrow the search to check the rest.' : '')
              : results.length === 0
                ? 'No matches.'
                : `Showing ${results.length} of ${total}.`}
          </p>
          <ul className="grid grid-cols-1 md:grid-cols-2 gap-2">
            {shown.map((r) => (
              <li key={r.siteUrl} className="p-3 rounded-xl bg-slate-950 border border-slate-800 flex gap-3">
                {r.avatarUrl ? (
                  <img src={r.avatarUrl} referrerPolicy="no-referrer" alt="" className="w-10 h-10 rounded-full object-cover flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-slate-800 text-slate-300 flex items-center justify-center text-sm font-bold flex-shrink-0">
                    {(r.displayName || '?').slice(0, 1).toUpperCase()}
                  </div>
                )}
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="font-semibold text-sm text-slate-200 truncate">{r.displayName}</div>
                  <div className="text-[11px] text-slate-500 font-mono truncate flex items-center gap-1">
                    <Globe className="w-3 h-3 flex-shrink-0" /> {r.siteUrl}
                  </div>
                  {ringsOf(r.siteUrl).length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {ringsOf(r.siteUrl).map((ring) => (
                        <span
                          key={ring.id}
                          title={`A member of ${ring.name}, a webring you're in`}
                          className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-500/15 text-indigo-300 flex items-center gap-1"
                        >
                          <CircleDot className="w-2.5 h-2.5" /> {ring.name}
                        </span>
                      ))}
                    </div>
                  )}
                  {r.tagline && <p className="text-xs text-slate-400 line-clamp-2">{r.tagline}</p>}
                  {r.interests.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {r.interests.slice(0, 6).map((i) => (
                        <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800 text-slate-400">
                          {i}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="pt-1">
                    {r.relation === 'self' ? (
                      <span className="text-[11px] text-slate-500">This is you</span>
                    ) : r.relation === 'friend' ? (
                      <span className="text-[11px] text-emerald-300">Already a friend</span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => onUse(r)}
                        className="text-[11px] px-2 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-200 flex items-center gap-1"
                      >
                        <UserPlus className="w-3 h-3" /> Use in Add Friend
                        {r.relation === 'muted' && <span className="text-slate-500">(muted)</span>}
                      </button>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Friends tab: compares the key Studio pinned for a friend with what hubs running the
 * key-witness extension have seen. The answer is evidence for the user only. It's cleared when
 * dismissed and never changes the pinned key.
 */
export function KeyWitnessCheck(props: {
  api: WebringHubApi | undefined;
  webringHubs: WebringHubView[];
  siteUrl: string;
  /** The friend's key changed: show the check more prominently. */
  emphasized: boolean;
}) {
  const { api, webringHubs, siteUrl, emphasized } = props;
  const [check, setCheck] = useState<WebringHubKeyCheckView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  if (!api?.checkKeyWithWebringHubs || webringHubs.length === 0) return null;

  const run = async () => {
    setBusy(true);
    setError('');
    try {
      setCheck(await api.checkKeyWithWebringHubs!(siteUrl));
    } catch (err) {
      setCheck(null);
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const describe = (r: WebringHubKeyCheckView['results'][number]) => {
    const since = r.since ? ` since ${formatTime(r.since)}` : '';
    if (r.result === 'match') {
      return { tone: 'text-emerald-300', text: `has seen the same key you pinned${since}.` };
    }
    if (r.result === 'mismatch') {
      const how =
        r.currentOutcome === 'rotated'
          ? ' It accepted that key through a signed rotation from an earlier key.'
          : r.currentOutcome === 'operator-accepted'
          ? ' Its operator accepted that key by hand.'
          : '';
      const seen = r.pinnedKeySeen ? ' It also saw the key you pinned earlier.' : ' It has never seen the key you pinned.';
      return { tone: 'text-amber-300', text: `has a different key${since}.${how}${seen}` };
    }
    if (r.result === 'not-listed') return { tone: 'text-slate-400', text: "doesn't list this site." };
    return { tone: 'text-rose-300', text: `couldn't be asked${r.message ? `: ${r.message}` : '.'}` };
  };

  return (
    <div className={check || error ? 'w-full' : ''}>
      {!check && (
        <button
          type="button"
          onClick={() => void run()}
          disabled={busy}
          className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1 disabled:opacity-50 ${
            emphasized
              ? 'bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200'
              : 'bg-slate-800 hover:bg-slate-700'
          }`}
          title="Ask Webring Hubs that run the key-witness extension which key they have seen for this site. Nothing is stored and your pinned key isn't changed."
        >
          {busy ? <Loader2 className="w-3 h-3 animate-spin" /> : <ShieldCheck className="w-3 h-3" />}
          Check with Webring Hubs
        </button>
      )}
      {error && <p className="text-[11px] text-rose-300 mt-1">{error}</p>}
      {check && (
        <div className="mt-1 p-2.5 rounded-lg bg-slate-950 border border-slate-800 text-[11px] space-y-1">
          <div className="flex items-start justify-between gap-2">
            <span className="text-slate-400">
              Your pinned key: <code className="text-slate-300">{check.pinnedFingerprint.slice(0, 16)}…</code>
            </span>
            <button
              type="button"
              onClick={() => setCheck(null)}
              className="text-slate-500 hover:text-slate-300"
              aria-label="Close"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
          {check.results.length === 0 ? (
            <p className="text-slate-400">
              None of your Webring Hubs run the key-witness extension, so there was no one to ask.
            </p>
          ) : (
            <ul className="space-y-0.5">
              {check.results.map((r) => {
                const d = describe(r);
                return (
                  <li key={r.webringHubUrl} className={d.tone}>
                    <strong className="font-semibold">{r.title}</strong> {d.text}
                    {!!r.rejectedKeys && (
                      <span className="text-slate-400">
                        {' '}
                        It refused {r.rejectedKeys} other key{r.rejectedKeys === 1 ? '' : 's'} for this site.
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
          <p className="text-slate-500">
            A Webring Hub is one more observer, not an authority. Decide for yourself, and confirm with your
            friend another way before trusting a new key.
          </p>
        </div>
      )}
    </div>
  );
}


/**
 * Approval modal shown when a Webring Hub opens `webring://hub-auth?...`.
 * Studio never auto-signs: the user confirms the hub URL, persona DID, and any optional
 * extension opt-in (unchecked by default).
 */
export function HubAuthApprovalModal(props: {
  request: HubAuthRequestView;
  personaName: string;
  personaDid: string;
  onApprove: (optInExtensions: string[]) => Promise<void>;
  onCancel: () => void;
}) {
  const { request, personaName, personaDid, onApprove, onCancel } = props;
  const [optInExt, setOptInExt] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const handleConfirm = async () => {
    setSubmitting(true);
    setError('');
    try {
      const optIns = request.requestedExt && optInExt ? [request.requestedExt] : [];
      await onApprove(optIns);
    } catch (err) {
      setError(errorText(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="hub-auth-modal-title"
        className="w-full max-w-md rounded-2xl bg-slate-900 border border-slate-700 p-5 shadow-2xl space-y-4"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-400 shrink-0" />
            <h2 id="hub-auth-modal-title" className="text-base font-bold text-slate-100">
              Sign in to Webring Hub
            </h2>
          </div>
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="p-1 rounded-lg text-slate-400 hover:bg-slate-800"
            aria-label="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-300 leading-relaxed">
          A browser session is asking to sign in to the Webring Hub below using your persona&apos;s
          Ed25519 key. Your private key never leaves Webring Studio.
        </p>

        <div className="rounded-xl bg-slate-950 border border-slate-800 p-3 space-y-1.5 text-xs">
          <div>
            <span className="text-slate-500">Hub: </span>
            <span className="font-mono text-indigo-300 break-all">{request.hubUrl}</span>
          </div>
          <div>
            <span className="text-slate-500">Persona: </span>
            <span className="font-semibold text-slate-100">{personaName}</span>
          </div>
          <div>
            <span className="text-slate-500">DID: </span>
            <span className="font-mono text-slate-300 break-all">{personaDid}</span>
          </div>
        </div>

        {request.requestedExt && (
          <label className="flex items-start gap-2.5 p-3 rounded-xl bg-slate-950/80 border border-slate-800 text-xs text-slate-200 cursor-pointer">
            <input
              type="checkbox"
              checked={optInExt}
              onChange={(e) => setOptInExt(e.target.checked)}
              disabled={submitting}
              className="mt-0.5 accent-indigo-500"
            />
            <span>
              <strong>Opt in to &ldquo;{request.requestedExt}&rdquo;</strong> — allow this extension
              to record public user-specific data (such as high scores) under my DID. You can opt
              out and delete this data anytime.
            </span>
          </label>
        )}

        {error && <p className="text-xs text-rose-300">{error}</p>}

        <div className="flex items-center justify-end gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-xs text-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleConfirm()}
            disabled={submitting}
            className="px-3.5 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-semibold text-white flex items-center gap-1.5 disabled:opacity-50"
          >
            {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            Approve &amp; Sign In
          </button>
        </div>
      </div>
    </div>
  );
}
