import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioDatabase } from '../electron/db/database';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { renderTemplatePage, TEMPLATE_CONFIG } from '../electron/services/siteTemplates';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { FriendConnection, ItemsDocumentSchema, SharedItemSchema } from '../src/shared/schema';
import { EMPTY_POST_EXTRAS, extrasFromItem, extrasToFields, selectVouchFriend } from '../src/studio/PostExtras';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function newDb(): StudioDatabase {
  const db = new StudioDatabase(path.join(tempDir('webring-vouches-'), 'studio.db'));
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

const VOUCH_MET = {
  subjectDid: 'did:web:ben.example',
  subjectSiteUrl: 'https://ben.example',
  subjectName: 'Ben',
  kind: 'met' as const,
};

const VOUCH_SKILL = {
  subjectDid: 'did:web:ben.example',
  subjectSiteUrl: 'https://ben.example',
  subjectName: 'Ben',
  kind: 'skill' as const,
  skill: 'Woodworking',
};

describe('items.json: vouches and forward compatibility', () => {
  const doc = (items: unknown[]) => ({ siteUrl: 'https://a.example', did: 'did:web:a.example', updatedAt: '2026-11-25T00:00:00.000Z', items });
  const item = (extra: Record<string, unknown>) => ({
    id: 'i1', canonicalUrl: 'https://a.example/api/items.json#i1', type: 'post', title: 'T', targetUrl: 'https://a.example/api/items.json#i1', createdAt: '2026-11-25T00:00:00.000Z', ...extra,
  });

  it('keeps valid vouch details on posts', () => {
    const parsed = ItemsDocumentSchema.parse(doc([item({ vouch: VOUCH_MET }), item({ id: 'i2', vouch: VOUCH_SKILL })]));
    expect(parsed.items[0].vouch).toEqual(VOUCH_MET);
    expect(parsed.items[1].vouch).toEqual(VOUCH_SKILL);
  });

  it('drops invalid vouch details instead of rejecting the item', () => {
    const badDid = SharedItemSchema.parse(item({ vouch: { subjectDid: 'not-a-did', subjectSiteUrl: 'https://ben.example', kind: 'met' } }));
    expect(badDid.vouch).toBeUndefined();
    expect(badDid.title).toBe('T');

    const missingSkill = SharedItemSchema.parse(item({ vouch: { subjectDid: 'did:web:ben.example', subjectSiteUrl: 'https://ben.example', kind: 'skill' } }));
    expect(missingSkill.vouch).toBeUndefined();
  });
});

describe('database: posts with vouch details', () => {
  it('migrates to schema 8 and stores a vouch on a post', () => {
    const db = newDb();
    expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(8);
    const created = db.createItem({ type: 'post', title: 'Met Ben at the meetup', commentary: 'Great chat', vouch: VOUCH_MET });
    expect(created.vouch).toEqual(VOUCH_MET);
    expect(db.getItems()[0].vouch?.subjectDid).toBe('did:web:ben.example');
  });

  it('publishes vouch details in the signed items.json', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Ben knows woodworking', commentary: 'Built a table', vouch: VOUCH_SKILL });
    const bundle = db.buildSignedSiteBundle({ publish: true });
    const published = bundle.items.items.find((i) => i.title === 'Ben knows woodworking');
    expect(published?.vouch).toEqual(VOUCH_SKILL);
    const reparsed = ItemsDocumentSchema.parse(JSON.parse(JSON.stringify(bundle.items)));
    expect(reparsed.items[0].vouch?.skill).toBe('Woodworking');
  });

  it('refuses vouch details on non-posts and invalid details', () => {
    const db = newDb();
    expect(() => db.createItem({ type: 'comment', targetUrl: 'https://b.example/x', commentary: 'hi', vouch: VOUCH_MET })).toThrow(/Only posts can be vouches/);
    expect(() => db.createItem({ type: 'post', commentary: 'x', vouch: { subjectDid: 'bad', subjectSiteUrl: 'https://b.example', kind: 'met' } })).toThrow(/Vouch details are not valid/);
    expect(() => db.createItem({ type: 'post', commentary: 'x', vouch: { subjectDid: 'did:web:b.example', subjectSiteUrl: 'https://b.example', kind: 'skill', skill: '   ' } })).toThrow(/skill/i);
  });

  it('edits keep, change or clear vouch details', () => {
    const db = newDb();
    const post = db.createItem({ type: 'post', title: 'Vouch for Ben', commentary: 'solid', vouch: VOUCH_MET });
    expect(db.updateItem(post.id, { commentary: 'updated' }).vouch).toEqual(VOUCH_MET);
    expect(db.updateItem(post.id, { vouch: VOUCH_SKILL }).vouch?.skill).toBe('Woodworking');
    expect(db.updateItem(post.id, { vouch: null }).vouch).toBeUndefined();
  });
});

describe('compose form helpers for vouches', () => {
  it('turns vouch input into fields and back, and pre-selects met from XFN relationship', () => {
    const friend: FriendConnection = {
      id: 'f1',
      siteUrl: 'https://ben.example/',
      did: 'did:web:ben.example',
      displayName: 'Ben',
      handle: 'ben',
      avatarUrl: '',
      bio: '',
      relationship: ['friend', 'met'],
      addedAt: '2026-11-25T00:00:00.000Z',
    };
    const drafted = selectVouchFriend({ ...EMPTY_POST_EXTRAS, kind: 'vouch', vouchKind: 'worked-with' }, friend);
    expect(drafted.vouchKind).toBe('met');
    expect(drafted.vouchSubjectDid).toBe('did:web:ben.example');
    expect(drafted.vouchSubjectSiteUrl).toBe('https://ben.example');

    const fields = extrasToFields({ ...drafted, vouchKind: 'skill', vouchSkill: '  Woodworking  ' });
    expect(fields.event).toBeNull();
    expect(fields.listing).toBeNull();
    expect(fields.vouch).toEqual(VOUCH_SKILL);

    const back = extrasFromItem({ ...SharedItemSchema.parse({ id: 'i', canonicalUrl: 'c', type: 'post', title: 't', targetUrl: 'c', createdAt: 'x' }), vouch: fields.vouch! });
    expect(back.kind).toBe('vouch');
    expect(back.vouchSkill).toBe('Woodworking');
  });

  it('rejects incomplete vouch drafts', () => {
    expect(() => extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'vouch' })).toThrow(/did:web:/);
    expect(() => extrasToFields({ ...EMPTY_POST_EXTRAS, kind: 'vouch', vouchSubjectDid: 'did:web:ben.example', vouchSubjectSiteUrl: 'https://ben.example', vouchKind: 'skill', vouchSkill: '' })).toThrow(/skill/i);
  });
});

describe('MCP: vouches', () => {
  it('webring_create_post and webring_update_item accept and clear vouch', async () => {
    const dir = tempDir('webring-vouches-mcp-');
    const manager = new PersonaManager(dir);
    try {
      const mcp = new WebringMcpServer(manager, dir);
      const created = await mcp.executeToolCall('webring_create_post', {
        title: 'Vouching for Ben',
        commentary: 'Worked together on a bike repair.',
        vouch: { subjectDid: 'did:web:ben.example', subjectSiteUrl: 'https://ben.example', kind: 'worked-with' },
      });
      expect(created.isError).toBeUndefined();
      const item = await manager.withActiveContext(async (ctx) => ctx.db.getItems().find((i) => i.title === 'Vouching for Ben'));
      expect(item?.vouch?.kind).toBe('worked-with');

      const cleared = await mcp.executeToolCall('webring_update_item', { itemId: item!.id, vouch: null });
      expect(cleared.isError).toBeUndefined();
      const after = await manager.withActiveContext(async (ctx) => ctx.db.getItems().find((i) => i.id === item!.id));
      expect(after?.vouch).toBeUndefined();

      const bad = await mcp.executeToolCall('webring_create_post', {
        commentary: 'x',
        vouch: { subjectDid: 'did:web:ben.example', subjectSiteUrl: 'https://ben.example', kind: 'skill' },
      });
      expect(bad.isError).toBe(true);
    } finally {
      manager.closeAll();
    }
  });
});

describe('published site renders vouches', () => {
  it('templates render vouch line and Vouch badge', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Great carpenter', commentary: 'Built our bench', vouch: VOUCH_SKILL });
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
    expect(html).toContain('🤝 Vouches for');
    expect(html).toContain('Ben');
    expect(html).toContain('skill: Woodworking');
    expect(html).toMatch(/· Vouch[ <]/);
  });

  it('the main template includes the vouch renderer', () => {
    const db = newDb();
    db.createItem({ type: 'post', title: 'Met Ben', commentary: 'Coffee', vouch: VOUCH_MET });
    const html = new StaticSiteGenerator(db).buildStandaloneProfileHtml(db.buildSignedSiteBundle({ publish: true }));
    expect(html).toContain('function vouchBlock(item)');
    expect(html).toContain('"subjectDid":"did:web:ben.example"');
    // Verify every inline <script> block in the generated HTML is syntactically valid JS
    for (const m of html.matchAll(/<script(?:\s+[^>]*)?>([\s\S]*?)<\/script>/gi)) {
      if (m[1].trim() && !/type\s*=\s*["']application\/json/i.test(m[0])) {
        expect(() => new Function(m[1])).not.toThrow();
      }
    }
  });
});
