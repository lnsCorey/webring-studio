import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioDatabase } from '../electron/db/database';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { renderTemplatePage, TEMPLATE_CONFIG } from '../electron/services/siteTemplates';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { buildWebringUri, parseWebringUri, ProfileDocumentSchema } from '../src/shared/schema';

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
function newDb(): StudioDatabase {
  const db = new StudioDatabase(path.join(tempDir('webring-now-'), 'studio.db'));
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

describe('profile.json: Now status', () => {
  const base = {
    did: 'did:web:ana.example',
    siteUrl: 'https://ana.example',
    handle: 'ana',
    displayName: 'Ana',
    updatedAt: '2026-11-26T00:00:00.000Z',
  };

  it('keeps valid now status and drops invalid now without rejecting the profile', () => {
    const ok = ProfileDocumentSchema.parse({ ...base, now: { text: 'Building a birdhouse', updatedAt: '2026-11-26T12:00:00.000Z' } });
    expect(ok.now?.text).toBe('Building a birdhouse');

    const bad = ProfileDocumentSchema.parse({ ...base, now: { text: 'x'.repeat(200), updatedAt: '2026-11-26T12:00:00.000Z' } });
    expect(bad.now).toBeUndefined();
    expect(bad.displayName).toBe('Ana');
  });

  it('migrates to schema 9, stores/publishes now status and clears it', () => {
    const db = newDb();
    expect(db.getSchemaVersion()).toBeGreaterThanOrEqual(9);
    const updated = db.setNow('Reading Dune');
    expect(updated.now?.text).toBe('Reading Dune');
    const bundle = db.buildSignedSiteBundle({ publish: true });
    expect(bundle.profile.now?.text).toBe('Reading Dune');

    expect(() => db.setNow('a'.repeat(141))).toThrow(/140/);
    const cleared = db.setNow('');
    expect(cleared.now).toBeUndefined();
  });

  it('MCP webring_set_now sets and clears status', async () => {
    const dir = tempDir('webring-now-mcp-');
    const manager = new PersonaManager(dir);
    try {
      const mcp = new WebringMcpServer(manager, dir);
      const res = await mcp.executeToolCall('webring_set_now', { text: 'Brewing espresso' });
      expect(res.isError).toBeUndefined();
      const p = await manager.withActiveContext(async (ctx) => ctx.db.getProfile());
      expect(p.now?.text).toBe('Brewing espresso');

      const clr = await mcp.executeToolCall('webring_set_now', { text: null });
      expect(clr.isError).toBeUndefined();
      const p2 = await manager.withActiveContext(async (ctx) => ctx.db.getProfile());
      expect(p2.now).toBeUndefined();
    } finally {
      manager.closeAll();
    }
  });

  it('renders Now status in templates and standalone profile', () => {
    const db = newDb();
    db.setNow('Learning Rust');
    const bundle = db.buildSignedSiteBundle({ publish: true });
    const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tplHtml = renderTemplatePage({
      shell: TEMPLATE_CONFIG.facepace.shell,
      profile: bundle.profile,
      albums: [],
      items: [],
      friends: [],
      endorsementCount: 0,
      layout: [],
      blockRenderers: {},
      section: (id: string, title: string, body: string) => `<section id="${id}"><h2>${title}</h2>${body}</section>`,
      emptyNote: (t: string) => `<p>${t}</p>`,
      albumHref: () => './', albumCover: () => '', albumShownExpanded: () => false, albumPhotoTotal: () => 0, albumPhotosLabel: () => '', albumPeek: () => '', renderAlbumPost: () => '',
      timelineEntries: (list: unknown[]) => list,
      esc, safeUrl: (u: string) => esc(u), buildDeepLink: () => 'webring://interact',
      getEndorsementsFor: () => [], getCommentsFor: () => [], renderMarkdown: (s: string) => esc(s), markdownToPlainText: (s: string) => s,
      hasLiveProvider: false, webringBars: '', headerAdHtml: '', inFeedAdHtml: '', footerAdHtml: '', footerHtml: '', olderPostsHtml: '',
    });
    expect(tplHtml).toContain('<strong>Now:</strong> Learning Rust');

    const mainHtml = new StaticSiteGenerator(db).buildStandaloneProfileHtml(bundle);
    expect(mainHtml).toContain('Learning Rust');
  });

  it('parses and builds webring:// post deep links with pre-filled group tags and location', () => {
    const uri = buildWebringUri({
      action: 'post',
      targetUrl: '',
      tags: ['wg-hardware'],
      postLocation: 'Hardware (Group Feed)',
    });
    expect(uri).toBe('webring://interact?action=post&tags=wg-hardware&location=Hardware+%28Group+Feed%29');
    const parsed = parseWebringUri(uri);
    expect(parsed).toEqual({
      action: 'post',
      targetUrl: '',
      tags: ['wg-hardware'],
      postLocation: 'Hardware (Group Feed)',
    });

    // Drops invalid/malicious tags while keeping valid ones
    const filtered = parseWebringUri('webring://interact?action=post&tags=%23wg-hardware,<script>,indieweb');
    expect(filtered?.tags).toEqual(['wg-hardware', 'indieweb']);
  });
});
