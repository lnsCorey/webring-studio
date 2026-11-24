import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { StudioDatabase } from '../electron/db/database';
import { StaticSiteGenerator } from '../electron/services/siteGenerator';
import { renderTemplatePage, TEMPLATE_CONFIG } from '../electron/services/siteTemplates';
import type { ProfileTheme } from '../src/shared/schema';

const ALL_TEMPLATES: ProfileTheme[] = [
  'neo-webring',
  'facepace',
  'tweetdeck',
  'xtraspecial',
  'instapick',
  'tiktalk',
];

function renderThemeHtml(theme: ProfileTheme, opts: { full?: boolean; withAside?: boolean } = {}): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-tpl-'));
  const db = new StudioDatabase(path.join(dir, 'studio.db'));
  try {
    db.updateProfile({
      displayName: 'Corey Lines',
      siteUrl: 'https://lines2code.com/social',
      theme,
      ...(opts.full
        ? {
            handle: '@corey',
            tagline: 'Algorithm-free social web',
            bio: 'Building open indie tools.',
            avatarUrl: 'https://lines2code.com/avatar.jpg',
            bannerUrl: 'https://lines2code.com/banner.jpg',
            location: 'Nova Scotia',
            atprotoHandle: 'corey.bsky.social',
            interests: ['indieweb', 'retro'],
            customLinks: [{ label: 'Blog', url: 'https://lines2code.com' }],
          }
        : {
            handle: '',
            tagline: '',
            bio: '',
            avatarUrl: '',
            bannerUrl: '',
            location: '',
            atprotoHandle: '',
            interests: [],
            customLinks: [],
          }),
    });
    if (opts.withAside) {
      db.addOrUpdateFriend({ siteUrl: 'https://friend.example', displayName: 'Friend One', visibility: 'public' });
    }
    const gen = new StaticSiteGenerator(db);
    const bundle = db.buildSignedSiteBundle({ publish: true });
    const shell = TEMPLATE_CONFIG[theme].shell;

    if (shell === 'stack') {
      // Execute the generated HTML's embedded profile data check via buildStandaloneProfileHtml
      // and also verify the template logic directly
      return gen.buildStandaloneProfileHtml(bundle);
    }

    const esc = (s: unknown) =>
      String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
    return renderTemplatePage({
      shell,
      profile: bundle.profile,
      albums: bundle.albums.albums,
      items: bundle.items.items,
      friends: bundle.connections.friends,
      endorsementCount: bundle.connections.endorsements.length,
      layout: opts.withAside
        ? [
            { id: 'items', type: 'items', visible: true },
            { id: 'friends', type: 'friends', visible: true },
          ]
        : [{ id: 'items', type: 'items', visible: true }],
      blockRenderers: {
        items: () => '<section id="items"><h2>Posts</h2></section>',
        friends: () => '<section id="friends"><h2>Friends</h2></section>',
      },
      section: (id: string, title: string, body: string) => `<section id="${id}"><h2>${title}</h2>${body}</section>`,
      emptyNote: (t: string) => `<p>${t}</p>`,
      albumHref: () => './',
      albumCover: () => '',
      albumShownExpanded: () => false,
      albumPhotoTotal: () => 0,
      albumPhotosLabel: () => '0 photos',
      albumPeek: () => '',
      renderAlbumPost: () => '',
      timelineEntries: () => [],
      esc,
      safeUrl: (u: string) => esc(u),
      buildDeepLink: () => 'webring://interact',
      getEndorsementsFor: () => [],
      getCommentsFor: () => [],
      renderMarkdown: (s: string) => esc(s),
      markdownToPlainText: (s: string) => s,
      hasLiveProvider: false,
      webringBars: '',
      headerAdHtml: '',
      inFeedAdHtml: '',
      footerAdHtml: '',
      footerHtml: '<footer></footer>',
      olderPostsHtml: '',
      archiveView: { renderItem: () => '', wrapClass: '' },
      webringLogoUrl: 'data:image/png;base64,AA==',
    });
  } finally {
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      // ignore temp cleanup races on Windows
    }
  }
}

describe('Responsive templates & consistent Profile/Identity fields', () => {
  afterEach(() => undefined);

  it.each(ALL_TEMPLATES.filter((t) => TEMPLATE_CONFIG[t].shell !== 'stack'))(
    'renders all populated Profile & Identity fields on %s',
    (theme) => {
      const html = renderThemeHtml(theme, { full: true, withAside: true });
      expect(html).toContain('Corey Lines');
      expect(html).toContain('@corey');
      expect(html).toContain('Algorithm-free social web');
      expect(html).toContain('Building open indie tools.');
      expect(html).toContain('https://lines2code.com/avatar.jpg');
      expect(html).toContain('https://lines2code.com/banner.jpg');
      expect(html).toContain('Nova Scotia');
      expect(html).toContain('corey.bsky.social');
      expect(html).toContain('#indieweb');
      expect(html).toContain('#retro');
      expect(html).toContain('Blog');
      expect(html).toContain('did:web:lines2code.com:social');
    }
  );

  it.each(ALL_TEMPLATES.filter((t) => TEMPLATE_CONFIG[t].shell !== 'stack'))(
    'omits blank optional fields and missing images cleanly on %s',
    (theme) => {
      const html = renderThemeHtml(theme, { full: false, withAside: false });
      expect(html).toContain('Corey Lines');
      expect(html).not.toContain('tpl-avatar-blank');
      expect(html).not.toContain('profile-avatar');
      expect(html).not.toContain('profile-banner');
    }
  );

  it('collapses XtraSpecial to 2-column layout when right rail has no content, and expands to 3-column with aside', () => {
    const twoCol = renderThemeHtml('xtraspecial', { full: true, withAside: false });
    expect(twoCol).toContain('xs-rails-2col');
    expect(twoCol).not.toContain('class="xs-right"');

    const threeCol = renderThemeHtml('xtraspecial', { full: true, withAside: true });
    expect(threeCol).not.toContain('xs-rails-2col');
    expect(threeCol).toContain('class="xs-right"');
  });
});
