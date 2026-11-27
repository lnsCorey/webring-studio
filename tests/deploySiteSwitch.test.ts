import { describe, it, expect } from 'vitest';
import { isHostSwitchPending, resolveDeployMethod } from '../electron/db/database';
import { filterSafeManagedPaths } from '../electron/services/publisher';

describe('Deploy Site method resolution & host-switch detection', () => {
  it('defaults to Via GitHub Pages when nothing is configured', () => {
    expect(resolveDeployMethod({})).toBe('github');
    expect(resolveDeployMethod(undefined)).toBe('github');
  });

  it('infers Via Web Host for legacy personas with SFTP/FTP host and no GitHub repo', () => {
    expect(resolveDeployMethod({ host: 'sftp.example.com' })).toBe('remote');
    expect(resolveDeployMethod({ host: 'sftp.example.com', githubRepo: 'site' })).toBe('github');
  });

  it('respects an explicit deployMethod selection', () => {
    expect(resolveDeployMethod({ deployMethod: 'remote', githubRepo: 'site' })).toBe('remote');
    expect(resolveDeployMethod({ deployMethod: 'github', host: 'sftp.example.com' })).toBe('github');
  });

  it('detects host switches symmetrically in both directions', () => {
    expect(isHostSwitchPending({})).toBe(false);
    expect(
      isHostSwitchPending(
        {
          deployMethod: 'github',
          lastDeployedTarget: {
            method: 'github',
            siteUrl: 'https://alice.github.io/site',
            label: 'alice/site (gh-pages)',
            publishedAt: '2026-11-27T00:00:00.000Z',
          },
        },
        'github'
      )
    ).toBe(false);

    // GitHub Pages -> Web Host
    expect(
      isHostSwitchPending(
        {
          deployMethod: 'remote',
          lastDeployedTarget: {
            method: 'github',
            siteUrl: 'https://alice.github.io/site',
            label: 'alice/site (gh-pages)',
            publishedAt: '2026-11-27T00:00:00.000Z',
          },
        },
        'remote'
      )
    ).toBe(true);

    // Web Host -> GitHub Pages
    expect(
      isHostSwitchPending(
        {
          deployMethod: 'github',
          lastDeployedTarget: {
            method: 'remote',
            siteUrl: 'https://alice.example.com',
            label: 'sftp://alice.example.com/public_html',
            publishedAt: '2026-11-27T00:00:00.000Z',
          },
        },
        'github'
      )
    ).toBe(true);
  });

  it('filters remote cleanup paths strictly to safe Studio-managed files', () => {
    const safe = filterSafeManagedPaths([
      'index.html',
      '.well-known/did.json',
      'api/items.json',
      'albums/a1/index.html',
      'media/photo.jpg',
      '../etc/passwd',
      '/var/www/other-app/index.php',
      'wp-config.php',
      'blog/unrelated.html',
    ]);
    expect(safe).toEqual([
      'index.html',
      '.well-known/did.json',
      'api/items.json',
      'albums/a1/index.html',
      'media/photo.jpg',
    ]);
  });
});
