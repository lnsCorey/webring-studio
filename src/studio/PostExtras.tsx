import React from 'react';
import { ItemEvent, ItemListing, SharedItem } from '../shared/schema';

/**
 * A post can be a plain post, an event, or an ask/offer listing. Events and listings are ordinary
 * posts with optional `event` / `listing` fields, so readers that don't know them still see a post;
 * Webring Hubs list them on their Events and Asks & offers pages.
 */
export type PostKind = 'plain' | 'event' | 'ask' | 'offer';

export interface PostExtrasDraft {
  kind: PostKind;
  /** `datetime-local` value (or a `date` value when allDay). */
  startsAt: string;
  endsAt: string;
  allDay: boolean;
  location: string;
  url: string;
  status: 'open' | 'closed';
}

export const EMPTY_POST_EXTRAS: PostExtrasDraft = {
  kind: 'plain',
  startsAt: '',
  endsAt: '',
  allDay: false,
  location: '',
  url: '',
  status: 'open',
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
  return { ...EMPTY_POST_EXTRAS };
}

/**
 * Turns the draft into the `event` / `listing` fields to save (null clears them). Throws a
 * readable error when the event details are incomplete.
 */
export function extrasToFields(d: PostExtrasDraft): { event: ItemEvent | null; listing: ItemListing | null } {
  if (d.kind === 'ask' || d.kind === 'offer') return { event: null, listing: { kind: d.kind, status: d.status } };
  if (d.kind !== 'event') return { event: null, listing: null };
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

const KINDS: Array<{ id: PostKind; label: string }> = [
  { id: 'plain', label: 'Post' },
  { id: 'event', label: '📅 Event' },
  { id: 'ask', label: '🙋 Ask' },
  { id: 'offer', label: '🎁 Offer' },
];

/** Kind picker plus the event or ask/offer fields, for the compose form and the post editor. */
export function PostExtrasFields(props: {
  draft: PostExtrasDraft;
  onChange: (draft: PostExtrasDraft) => void;
  fieldClass: string;
  labelClass: string;
}) {
  const { draft, fieldClass, labelClass } = props;
  const set = (patch: Partial<PostExtrasDraft>) => props.onChange({ ...draft, ...patch });
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
    </div>
  );
}
