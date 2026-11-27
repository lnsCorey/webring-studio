import { describe, it, expect } from 'vitest';
import { renderMarkdown } from '../src/shared/markdown';
import { formatRelativeTime } from '../src/shared/relativeTime';
import { parseWebringUri } from '../src/shared/schema';

describe('formatRelativeTime', () => {
  it('formats seconds, minutes, hours, days, weeks, months, and years relative to now', () => {
    const now = Date.now();
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(formatRelativeTime(ago(15_000))).toBe('just now');
    expect(formatRelativeTime(ago(5 * 60_000))).toBe('5m ago');
    expect(formatRelativeTime(ago(3 * 3_600_000))).toBe('3h ago');
    expect(formatRelativeTime(ago(4 * 86_400_000))).toBe('4d ago');
    expect(formatRelativeTime(ago(14 * 86_400_000))).toBe('2w ago');
    expect(formatRelativeTime(ago(95 * 86_400_000))).toBe('3mo ago');
    expect(formatRelativeTime(ago(400 * 86_400_000))).toBe('1y ago');
  });
});

describe('parseWebringUri', () => {
  it('allows recommendation and share deep links without a prefilled targetUrl for Library posting', () => {
    const rec = parseWebringUri('webring://interact?action=recommendation&location=Community%20Library&hub=Tech%20Hub');
    expect(rec).toEqual({
      action: 'recommendation',
      targetUrl: '',
      title: undefined,
      authorUrl: undefined,
      authorName: undefined,
      mediaUrl: undefined,
      category: undefined,
      postLocation: 'Community Library',
      hubName: 'Tech Hub',
    });

    const share = parseWebringUri('webring://interact?action=share&location=Community%20Library');
    expect(share?.action).toBe('share');
    expect(share?.targetUrl).toBe('');
    expect(share?.postLocation).toBe('Community Library');

    // Actions that require a target still return null without targetUrl
    expect(parseWebringUri('webring://interact?action=like')).toBeNull();
    expect(parseWebringUri('webring://interact?action=comment')).toBeNull();
  });
});

describe('renderMarkdown', () => {
  it('renders fenced code blocks with language badge and escapes HTML', () => {
    const md = [
      'Here is a snippet:',
      '',
      '```tsx',
      'const el = <script>alert(1)</script>;',
      '```',
    ].join('\n');
    const html = renderMarkdown(md);
    expect(html).toContain('<div class="code-block">');
    expect(html).toContain('<span class="code-lang">tsx</span>');
    expect(html).toContain('<code class="lang-tsx">');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('renders plain fenced code blocks without a language header', () => {
    const html = renderMarkdown('```\nplain code\n```');
    expect(html).toContain('<pre><code>plain code</code></pre>');
    expect(html).not.toContain('code-block-head');
  });

  it('supports inline formatting and safe links', () => {
    const html = renderMarkdown('Use **bold**, *italic*, `inline()`, and [docs](https://example.com).');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<em>italic</em>');
    expect(html).toContain('<code>inline()</code>');
    expect(html).toContain('href="https://example.com"');
  });
});
