import React from 'react';
import { FriendConnection, ItemEvent, ItemListing, ItemVouch, ItemVouchKind, SharedItem } from '../shared/schema';

/**
 * A post can be a plain post, an event, an ask/offer listing, or a vouch. They are ordinary posts
 * with optional `event` / `listing` / `vouch` fields, so readers that don't know them still see a
 * post; Webring Hubs index them on their Events, Asks & offers and People pages.
 */
export type PostKind = 'plain' | 'event' | 'ask' | 'offer' | 'vouch';

export interface PostExtrasDraft {
  kind: PostKind;
  /** `datetime-local` value (or a `date` value when allDay). */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string;
  url: string;
  status: 'open' | 'closed';
  vouchSubjectDid: string;
  vouchSubjectSiteUrl: string;
  vouchSubjectName: string;
  vouchKind: ItemVouchKind;
  vouchSkill: string;
}

export const EMPTY_POST_EXTRAS: PostExtrasDraft = {
  kind: 'plain',
  startsAt: '',
  endsAt: '',
  allDay: false,
  location: '',
  url: '',
  status: 'open',
  vouchSubjectDid: '',
  vouchSubjectSiteUrl: '',
  vouchSubjectName: '',
  vouchKind: 'met',
  vouchSkill: '',
};

const pad = (n: number) => String(n).padStart(2, '0');

/** An ISO instant as a local `datetime-local` value. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** A local `datetime-local` value as an ISO instant (UTC). */
function fromLocalInput(value: string): string {
  const d = new Date(value);
  if (!value || Number.isNaN(d.getTime())) throw new Error('Enter a valid start date and time for the event.');
  return d.toISOString();
}

/** The draft for an existing post (for editing). */
export function extrasFromItem(item: SharedItem): PostExtrasDraft {
  if (item.event) {
    const e = item.event;
    return {
      ...EMPTY_POST_EXTRAS,
      kind: 'event',
      allDay: Boolean(e.allDay),
      startsAt: e.allDay ? e.startsAt.slice(0, 10) : toLocalInput(e.startsAt),
      endsAt: e.endsAt ? (e.allDay ? e.endsAt.slice(0, 10) : toLocalInput(e.endsAt)) : '',
      location: e.location || '',
      url: e.url || '',
    };
  }
  if (item.listing) return { ...EMPTY_POST_EXTRAS, kind: item.listing.kind, status: item.listing.status };
  if (item.vouch) {
    return {
      ...EMPTY_POST_EXTRAS,
      kind: 'vouch',
      vouchSubjectDid: item.vouch.subjectDid,
      vouchSubjectSiteUrl: item.vouch.subjectSiteUrl,
      vouchSubjectName: item.vouch.subjectName || '',
      vouchKind: item.vouch.kind,
      vouchSkill: item.vouch.skill || '',
    };
  }
  return { ...EMPTY_POST_EXTRAS };
}

/**
 * Turns the draft into the `event` / `listing` / `vouch` fields to save (null clears them).
 * Throws a readable error when details are incomplete.
 */
export function extrasToFields(d: PostExtrasDraft): {
  event: ItemEvent | null;
  listing: ItemListing | null;
  vouch: ItemVouch | null;
} {
  if (d.kind === 'ask' || d.kind === 'offer') {
    return { event: null, listing: { kind: d.kind, status: d.status }, vouch: null };
  }
  if (d.kind === 'vouch') {
    const subjectDid = d.vouchSubjectDid.trim();
    const subjectSiteUrl = d.vouchSubjectSiteUrl.trim().replace(/\/+$/, '');
    const subjectName = d.vouchSubjectName.trim().slice(0, 120);
    const skill = d.vouchSkill.trim().slice(0, 60);
    if (!/^did:web:[A-Za-z0-9._%:\-]+$/.test(subjectDid)) {
      throw new Error('Pick a friend with a did:web: identifier to vouch for.');
    }
    if (!/^https?:\/\/[^\s]+$/i.test(subjectSiteUrl)) {
      throw new Error('The vouched member needs a valid http(s) site URL.');
    }
    if (d.vouchKind === 'skill' && !skill) {
      throw new Error('Enter the skill you are vouching for (up to 60 characters).');
    }
    return {
      event: null,
      listing: null,
      vouch: {
        subjectDid,
        subjectSiteUrl,
        ...(subjectName ? { subjectName } : {}),
        kind: d.vouchKind,
        ...(d.vouchKind === 'skill' ? { skill } : {}),
      },
    };
  }
  if (d.kind !== 'event') return { event: null, listing: null, vouch: null };
  if (!d.startsAt) throw new Error('An event needs a start date.');
  let startsAt: string;
  let endsAt: string | undefined;
  if (d.allDay) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d.startsAt)) throw new Error('Enter the event date.');
    startsAt = `${d.startsAt}T00:00:00Z`;
    endsAt = d.endsAt ? `${d.endsAt}T00:00:00Z` : undefined;
  } else {
    startsAt = fromLocalInput(d.startsAt);
    endsAt = d.endsAt ? fromLocalInput(d.endsAt) : undefined;
  }
  if (endsAt && Date.parse(endsAt) < Date.parse(startsAt)) throw new Error('The event must end after it starts.');
  const url = d.url.trim();
  if (url && !/^https?:\/\//i.test(url)) throw new Error('The event link must start with http:// or https://');
  return {
    event: {
      startsAt,
      ...(endsAt ? { endsAt } : {}),
      ...(d.allDay ? { allDay: true } : {}),
      ...(d.location.trim() ? { location: d.location.trim().slice(0, 200) } : {}),
      ...(url ? { url } : {}),
    },
    listing: null,
    vouch: null,
  };
}

/** "Sat, Dec 5, 6:00 PM – 8:00 PM", or the date for all-day events. */
export function formatEventWhen(e: ItemEvent): string {
  const start = new Date(e.startsAt);
  const end = e.endsAt ? new Date(e.endsAt) : null;
  if (e.allDay) {
    const opts: Intl.DateTimeFormatOptions = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' };
    const s = start.toLocaleDateString(undefined, opts);
    return end && e.endsAt!.slice(0, 10) !== e.startsAt.slice(0, 10) ? `${s} – ${end.toLocaleDateString(undefined, opts)}` : `${s} (all day)`;
  }
  const s = start.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  if (!end) return s;
  return `${s} – ${end.toDateString() === start.toDateString() ? end.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : end.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
}

/** Human-readable vouch summary: "Vouches for Alice: met" / "skill: Woodworking" / "worked with". */
export function formatVouchSummary(v: ItemVouch, friends?: FriendConnection[]): string {
  const matched = friends?.find((f) => f.did === v.subjectDid || f.siteUrl.replace(/\/+$/, '') === v.subjectSiteUrl.replace(/\/+$/, ''));
  let name = v.subjectName || matched?.displayName || '';
  if (!name) {
    try {
      name = new URL(v.subjectSiteUrl).hostname;
    } catch {
      name = v.subjectDid;
    }
  }
  const detail = v.kind === 'skill' ? `skill: ${v.skill || ''}` : v.kind === 'worked-with' ? 'worked with' : 'met';
  return `Vouches for ${name}: ${detail}`;
}

/** Updates a draft when picking a friend for a vouch; pre-selects `met` if XFN relationship includes `met`. */
export function selectVouchFriend(draft: PostExtrasDraft, friend: FriendConnection): PostExtrasDraft {
  const hasMet = Array.isArray(friend.relationship) && friend.relationship.includes('met');
  return {
    ...draft,
    vouchSubjectDid: friend.did || '',
    vouchSubjectSiteUrl: friend.siteUrl.replace(/\/+$/, ''),
    vouchSubjectName: friend.displayName || '',
    vouchKind: hasMet ? 'met' : draft.vouchKind,
  };
}

const KINDS: Array<{ id: PostKind; label: string }> = [
  { id: 'plain', label: 'Post' },
  { id: 'event', label: '📅 Event' },
  { id: 'ask', label: '🙋 Ask' },
  { id: 'offer', label: '🎁 Offer' },
  { id: 'vouch', label: '🤝 Vouch' },
];

const VOUCH_KINDS: Array<{ id: ItemVouchKind; label: string }> = [
  { id: 'met', label: 'Met in person' },
  { id: 'worked-with', label: 'Worked with' },
  { id: 'skill', label: 'Skill' },
];

/** Kind picker plus the event, ask/offer, or vouch fields, for the compose form and post editor. */
export function PostExtrasFields(props: {
  draft: PostExtrasDraft;
  onChange: (draft: PostExtrasDraft) => void;
  friends?: FriendConnection[];
  fieldClass: string;
  labelClass: string;
}) {
  const { draft, fieldClass, labelClass } = props;
  const set = (patch: Partial<PostExtrasDraft>) => props.onChange({ ...draft, ...patch });
  const didFriends = (props.friends || []).filter((f) => typeof f.did === 'string' && f.did.startsWith('did:web:'));

  return (
    <div className="space-y-3 rounded-xl border border-slate-800 bg-slate-950/40 p-3">
      <div className="flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Kind of post">
        <span className="text-slate-400 mr-1">This post is</span>
        {KINDS.map((k) => (
          <button
            key={k.id}
            type="button"
            aria-pressed={draft.kind === k.id}
            onClick={() => set({ kind: k.id })}
            className={`px-2.5 py-1 rounded-lg font-semibold transition ${
              draft.kind === k.id ? 'bg-indigo-600 text-white shadow' : 'bg-slate-950 text-slate-400 hover:text-white border border-slate-800'
            }`}
          >
            {k.label}
          </button>
        ))}
      </div>

      {draft.kind === 'event' && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="md:col-span-2 flex items-center gap-2 text-xs text-slate-300">
            <input
              type="checkbox"
              checked={draft.allDay}
              onChange={(e) =>
                set({
                  allDay: e.target.checked,
                  startsAt: e.target.checked ? draft.startsAt.slice(0, 10) : draft.startsAt ? `${draft.startsAt.slice(0, 10)}T18:00` : '',
                  endsAt: e.target.checked ? draft.endsAt.slice(0, 10) : '',
                })
              }
            />
            All-day event
          </label>
          <div>
            <label className={labelClass}>Starts *</label>
            <input
              type={draft.allDay ? 'date' : 'datetime-local'}
              required
              value={draft.startsAt}
              onChange={(e) => set({ startsAt: e.target.value })}
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Ends (optional)</label>
            <input
              type={draft.allDay ? 'date' : 'datetime-local'}
              value={draft.endsAt}
              min={draft.startsAt || undefined}
              onChange={(e) => set({ endsAt: e.target.value })}
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Location</label>
            <input
              type="text"
              maxLength={200}
              value={draft.location}
              onChange={(e) => set({ location: e.target.value })}
              placeholder="Library, Room 2 · or Online"
              className={fieldClass}
            />
          </div>
          <div>
            <label className={labelClass}>Event link (optional)</label>
            <input
              type="url"
              value={draft.url}
              onChange={(e) => set({ url: e.target.value })}
              placeholder="https://meet.example/…"
              className={fieldClass}
            />
          </div>
          <p className="md:col-span-2 text-[11px] text-slate-500">
            Use the title for the event name. Webring Hubs you belong to list it on their Events page, where members can RSVP.
          </p>
        </div>
      )}

      {(draft.kind === 'ask' || draft.kind === 'offer') && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-slate-400">Status</span>
            {(['open', 'closed'] as const).map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={draft.status === s}
                onClick={() => set({ status: s })}
                className={`px-2.5 py-1 rounded-lg font-semibold capitalize ${
                  draft.status === s ? 'bg-slate-700 text-white' : 'bg-slate-950 text-slate-400 border border-slate-800'
                }`}
              >
                {s}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            {draft.kind === 'ask' ? 'Say what you need help with.' : 'Say what you can share or help with.'} Add tags (for
            example <em>woodworking, css</em>): Webring Hubs match them with members' interests. Mark it closed when it's sorted.
          </p>
        </div>
      )}

      {draft.kind === 'vouch' && (
        <div className="space-y-3">
          <div>
            <label className={labelClass}>Friend to vouch for *</label>
            {didFriends.length > 0 ? (
              <select
                value={draft.vouchSubjectDid}
                onChange={(e) => {
                  const f = didFriends.find((cand) => cand.did === e.target.value);
                  if (f) props.onChange(selectVouchFriend(draft, f));
                  else set({ vouchSubjectDid: '', vouchSubjectSiteUrl: '', vouchSubjectName: '' });
                }}
                className={fieldClass}
              >
                <option value="">Select a friend with a verified DID…</option>
                {didFriends.map((f) => (
                  <option key={f.id} value={f.did}>
                    {f.displayName} ({f.siteUrl.replace(/^https?:\/\//i, '')})
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-xs text-amber-300/90">
                No friends with a synced DID yet. Sync a friend's site first, or enter their DID and site URL below.
              </p>
            )}
          </div>
          {draft.vouchSubjectDid && !didFriends.some((f) => f.did === draft.vouchSubjectDid) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <div>
                <label className={labelClass}>Subject DID</label>
                <input
                  type="text"
                  value={draft.vouchSubjectDid}
                  onChange={(e) => set({ vouchSubjectDid: e.target.value })}
                  className={fieldClass}
                />
              </div>
              <div>
                <label className={labelClass}>Subject site URL</label>
                <input
                  type="url"
                  value={draft.vouchSubjectSiteUrl}
                  onChange={(e) => set({ vouchSubjectSiteUrl: e.target.value })}
                  className={fieldClass}
                />
              </div>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="text-slate-400">Vouch kind</span>
            {VOUCH_KINDS.map((vk) => (
              <button
                key={vk.id}
                type="button"
                aria-pressed={draft.vouchKind === vk.id}
                onClick={() => set({ vouchKind: vk.id })}
                className={`px-2.5 py-1 rounded-lg font-semibold ${
                  draft.vouchKind === vk.id ? 'bg-slate-700 text-white' : 'bg-slate-950 text-slate-400 border border-slate-800'
                }`}
              >
                {vk.label}
              </button>
            ))}
          </div>
          {draft.vouchKind === 'skill' && (
            <div>
              <label className={labelClass}>Skill *</label>
              <input
                type="text"
                maxLength={60}
                required
                value={draft.vouchSkill}
                onChange={(e) => set({ vouchSkill: e.target.value })}
                placeholder="Woodworking, CSS, electronics repair…"
                className={fieldClass}
              />
            </div>
          )}
          <p className="text-[11px] text-slate-500">
            Signed by your own site key and published in your feed. Deleting the post revokes the vouch on any hub that collected it.
          </p>
        </div>
      )}
    </div>
  );
}
