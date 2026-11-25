import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioDatabase } from '../electron/db/database';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { renderTemplatePage, TEMPLATE_CONFIG } from '../electron/services/siteTemplates';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { ConnectionsDocumentSchema, ItemsDocumentSchema, SharedItemSchema } from '../src/shared/schema';
import { EMPTY_POST_EXTRAS, extrasFromItem, extrasToFields } from '../src/studio/PostExtras';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function newDb(): StudioDatabase {
  const db = new StudioDatabase(path.join(tempDir('webring-events-'), 'studio.db'));
  db.updateProfile({ displayName: 'Ana', siteUrl: 'https://ana.example' });
  return db;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  }
});

const EVENT = { startsAt: '2026-12-05T18:00:00-04:00', endsAt: '2026-12-05T20:00:00-04:00', location: 'Library, Room 2', url: 'https://meet.example/repair' };

describe('items.json: events, asks/offers and forward compatibility', () => {
  const doc = (items: unknown[]) => ({ siteUrl: 'https://a.example', did: 'did:web:a.example', updatedAt: '2026-11-25T00:00:00.000Z', items });
  const item = (extra: Record<string, unknown>) => ({
    id: 'i1', canonicalUrl: 'https://a.example/api/items.json#i1', type: 'post', title: 'T', targetUrl: 'https://a.example/api/items.json#i1', createdAt: '2026-11-25T00:00:00.000Z', ...extra,
  });

  it('keeps event and listing details on posts', () => {
    const parsed = ItemsDocumentSchema.parse(doc([item({ event: EVENT }), item({ id: 'i2', listing: { kind: 'ask' } })]));
    expect(parsed.items[0].event?.location).toBe('Library, Room 2');
    expect(parsed.items[1].listing).toEqual({ kind: 'ask', status: 'open' });
  });

  it('drops invalid event details instead of rejecting the item', () => {
    const parsed = SharedItemSchema.parse(item({ event: { startsAt: 'next tuesday' } }));
    expect(parsed.event).toBeUndefined();
    expect(parsed.title).toBe('T');
  });

  it('skips items of unknown types instead of rejecting the whole document', () => {
    const parsed = ItemsDocumentSchema.parse(doc([item({ type: 'future-type' }), item({ id: 'i2' })]));
    expect(parsed.items.map((i) => i.id)).toEqual(['i2']);
  });

  it('skips endorsements of unknown types in connections.json', () => {
    const endorsement = (type: string, id: string) => ({
      id, targetCanonicalUrl: 'https://a.example/x', authorSiteUrl: 'https://b.example', authorName: 'B', type, sourceItemUrl: 'https://b.example/y', createdAt: '2026-11-25T00:00:00.000Z',
    });
    const parsed = ConnectionsDocumentSchema.parse({
      siteUrl: 'https://a.example', did: 'did:web:a.example', updatedAt: '2026-11-25T00:00:00.000Z', friends: [], webrings: [],
      endorsements: [endorsement('poll-vote', 'e1'), endorsement('like', 'e2')],
    });
    expect(parsed.endorsements.map((e) => e.id)).toEqual(['e2']);
    expect(ConnectionsDocumentSchema.parse({ siteUrl: 'x', did: 'd', updatedAt: 'u', friends: [], webrings: [] }).endorsements).toEqual([]);
  });
});

describe('database: posts with event or ask/offer details', () => {
  it('migrates to schema 7 and stores an event on a post', () => {
    const db = newDb();
    expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(7);
    const created = db.createItem({ type: 'post', title: 'Repair café', commentary: 'Bring tools', event: EVENT });
    expect(created.event).toEqual(EVENT);
    expect(db.getItems()[0].event?.startsAt).toBe(EVENT.startsAt);
  });

  it('publishes event and listing details in the signed items.json', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Repair café', commentary: 'x', event: { startsAt: '2026-12-05T22:00:00Z', allDay: false } });
    db.createItem({ type: 'post', title: 'Need a ladder', commentary: 'y', listing: { kind: 'ask', status: 'open' }, tags: ['diy'] });
    const bundle = db.buildSignedSiteBundle({ publish: true });
    const byTitle = Object.fromEntries(bundle.items.items.map((i) => [i.title, i]));
    expect(byTitle['Repair café'].event).toEqual({ startsAt: '2026-12-05T22:00:00Z' });
    expect(byTitle['Need a ladder'].listing).toEqual({ kind: 'ask', status: 'open' });
    // Readers re-parse the published document without losing the details
    const reparsed = ItemsDocumentSchema.parse(JSON.parse(JSON.stringify(bundle.items)));
    expect(reparsed.items.find((i) => i.title === 'Need a ladder')?.listing?.kind).toBe('ask');
  });

  it('refuses event details on non-posts and invalid details', () => {
    const db = newDb();
    expect(() => db.createItem({ type: 'comment', targetUrl: 'https://b.example/x', commentary: 'hi', event: EVENT })).toThrow(/Only posts can be events/);
    expect(() => db.createItem({ type: 'post', commentary: 'x', event: { startsAt: '2026-12-05' } as never })).toThrow(/Event details are not valid/);
    expect(() =>
      db.createItem({ type: 'post', commentary: 'x', event: { startsAt: '2026-12-05T20:00:00Z', endsAt: '2026-12-05T18:00:00Z' } })
    ).toThrow(/end after it starts/);
    expect(() => db.createItem({ type: 'post', commentary: 'x', listing: { kind: 'favour' } as never })).toThrow(/ask or offer/);
  });

  it('edits keep, change or clear the details', () => {
    const db = newDb();
    const post = db.createItem({ type: 'post', title: 'Spare seedlings', commentary: 'free', listing: { kind: 'offer', status: 'open' } });
    expect(db.updateItem(post.id, { commentary: 'free, collect Saturday' }).listing).toEqual({ kind: 'offer', status: 'open' });
    expect(db.updateItem(post.id, { listing: { kind: 'offer', status: 'closed' } }).listing?.status).toBe('closed');
    expect(db.updateItem(post.id, { listing: null }).listing).toBeUndefined();
    const ev = db.updateItem(post.id, { event: EVENT });
    expect(ev.event?.location).toBe('Library, Room 2');
    expect(db.updateItem(post.id, { event: null }).event).toBeUndefined();
  });
});

describe('compose form helpers', () => {
  it('turns form input into event fields and back', () => {
    const fields = extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'event', startsAt: '2026-12-05T18:00', endsAt: '2026-12-05T20:00', location: ' Hall ' });
    expect(fields.listing).toBeNull();
    expect(Date.parse(fields.event!.endsAt!) - Date.parse(fields.event!.startsAt)).toBe(2 * 3600 * 1000);
    expect(fields.event!.location).toBe('Hall');
    const back = extrasFromItem({ ...SharedItemSchema.parse({ id: 'i', canonicalUrl: 'c', type: 'post', title: 't', targetUrl: 'c', createdAt: 'x' }), event: fields.event! });
    expect(back.kind).toBe('event');
    expect(back.startsAt).toBe('2026-12-05T18:00');
  });

  it('handles all-day events, asks and validation errors', () => {
    expect(extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'event', allDay: true, startsAt: '2026-12-05' }).event).toEqual({ startsAt: '2026-12-05T00:00:00Z', allDay: true });
    expect(extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'ask' })).toEqual({ event: null, listing: { kind: 'ask', status: 'open' } });
    expect(extrasToFields(EMPTY_POST_EXTRAS)).toEqual({ event: null, listing: null });
    expect(() => extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'event' })).toThrow(/start date/);
    expect(() => extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'event', startsAt: '2026-12-05T18:00', url: 'meet.example' })).toThrow(/http/);
  });
});

describe('MCP: events and asks/offers', () => {
  it('webring_create_post and webring_update_item accept event and listing', async () => {
    const dir = tempDir('webring-events-mcp-');
    const manager = new PersonaManager(dir);
    try {
      const mcp = new WebringMcpServer(manager, dir);
      const created = await mcp.executeToolCall('webring_create_post', { title: 'Garden day', commentary: 'Planting', event: { startsAt: '2026-12-09T00:00:00Z', allDay: true, location: 'Allotments' } });
      expect(created.isError).toBeUndefined();
      const item = await manager.withActiveContext(async (ctx) => ctx.db.getItems().find((i) => i.title === 'Garden day'));
      expect(item?.event).toEqual({ startsAt: '2026-12-09T00:00:00Z', allDay: true, location: 'Allotments' });

      const asked = await mcp.executeToolCall('webring_create_post', { title: 'Help with CSS', commentary: 'grid', listing: { kind: 'ask' }, tags: ['css'] });
      expect(asked.isError).toBeUndefined();
      const ask = await manager.withActiveContext(async (ctx) => ctx.db.getItems().find((i) => i.title === 'Help with CSS'));
      const closed = await mcp.executeToolCall('webring_update_item', { itemId: ask!.id, listing: { kind: 'ask', status: 'closed' } });
      expect(closed.isError).toBeUndefined();
      const after = await manager.withActiveContext(async (ctx) => ctx.db.getItems().find((i) => i.id === ask!.id));
      expect(after?.listing?.status).toBe('closed');

      const bad = await mcp.executeToolCall('webring_create_post', { commentary: 'x', event: { startsAt: 'soon' } });
      expect(bad.isError).toBe(true);
    } finally {
      manager.closeAll();
    }
  });
});

describe('published site shows event details', () => {
  it('templates render when, where and the badge', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Repair café', commentary: 'x', event: EVENT });
    db.createItem({ type: 'post', title: 'Need a ladder', commentary: 'y', listing: { kind: 'ask', status: 'open' } });
    const bundle = db.buildSignedSiteBundle({ publish: true });
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const html = renderTemplatePage({
      shell: TEMPLATE_CONFIG.facepace.shell,
      profile: bundle.profile,
      albums: [],
      items: bundle.items.items,
      friends: [],
      endorsementCount: 0,
      layout: [{ id: 'items', type: 'items', visible: true }],
      blockRenderers: {},
      section: (id: string, title: string, body: string) => `<section id="${id}"><h2>${title}</h2>${body}</section>`,
      emptyNote: (t: string) => `<p>${t}</p>`,
      albumHref: () => './', albumCover: () => '', albumShownExpanded: () => false, albumPhotoTotal: () => 0, albumPhotosLabel: () => '', albumPeek: () => '', renderAlbumPost: () => '',
      timelineEntries: (list: unknown[]) => list,
      esc, safeUrl: (u: string) => esc(u), buildDeepLink: () => 'webring://interact',
      getEndorsementsFor: () => [], getCommentsFor: () => [], renderMarkdown: (s: string) => esc(s), markdownToPlainText: (s: string) => s,
      hasLiveProvider: false, webringBars: '', headerAdHtml: '', inFeedAdHtml: '', footerAdHtml: '', footerHtml: '', olderPostsHtml: '',
    });
    expect(html).toContain('📍 Library, Room 2');
    expect(html).toContain('href="https://meet.example/repair"');
    expect(html).toMatch(/· Ask[ <]/);
    expect(html).toMatch(/· Event[ <]/);
  });

  it('the main template includes the event renderer', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Repair café', commentary: 'x', event: EVENT });
    const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle({ publish: true }));
    expect(html).toContain('function eventBlock(item)');
    expect(html).toContain('"location":"Library, Room 2"');
  });
});
