import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sftpAuthMethodOf, StudioDatabase } from '../electron/db/database';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';
import { inlineScriptHashes, loadSiteCss, StaticSiteGenerator } from '../electron/services/siteGenerator';
import {
  ftpAccessOptions,
  FtpTlsError,
  gitBlobSha,
  GITHUB_BRANCH_BUSY_MESSAGE,
  HostKeyMismatchError,
  isFtpTlsFailure,
  resolveSshAgent,
  SitePublisher,
  verifyOrPinSftpHostKey,
  WINDOWS_OPENSSH_AGENT_PIPE,
} from '../electron/services/publisher';

const root = path.join(__dirname, '..');
const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

describe('Security Phase 8: SFTP sign-in and host keys', () => {
  let dir: string;
  let db: StudioDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p8-sftp-'));
    db = new StudioDatabase(dir, 'sftp.sqlite');
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the database file
    }
  });

  it('finds the SSH agent: SSH_AUTH_SOCK, the Windows OpenSSH pipe, or a readable error', () => {
    const exists = (available: string[]) => (p: string) => available.includes(p);
    expect(resolveSshAgent({ platform: 'linux', env: { SSH_AUTH_SOCK: '/tmp/agent.sock' }, exists: exists(['/tmp/agent.sock']) })).toBe(
      '/tmp/agent.sock'
    );
    expect(resolveSshAgent({ platform: 'win32', env: {}, exists: exists([WINDOWS_OPENSSH_AGENT_PIPE]) })).toBe(
      WINDOWS_OPENSSH_AGENT_PIPE
    );
    expect(WINDOWS_OPENSSH_AGENT_PIPE).toBe('\\\\.\\pipe\\openssh-ssh-agent');
    expect(() => resolveSshAgent({ platform: 'win32', env: {}, exists: exists([]) })).toThrow(
      'No SSH agent found. Start the OpenSSH Authentication Agent service or choose another sign-in method.'
    );
    expect(() => resolveSshAgent({ platform: 'linux', env: {}, exists: exists([WINDOWS_OPENSSH_AGENT_PIPE]) })).toThrow(/No SSH agent/);
  });

  it('derives the sign-in method for settings saved before it existed', () => {
    expect(sftpAuthMethodOf({})).toBe('password');
    expect(sftpAuthMethodOf({ sftpPrivateKeyPath: '/home/me/.ssh/id_ed25519' })).toBe('privateKey');
    expect(sftpAuthMethodOf({ sftpUseAgent: true, sftpPrivateKeyPath: '/k' })).toBe('agent');
    expect(sftpAuthMethodOf({ sftpAuthMethod: 'password', sftpUseAgent: true })).toBe('password');
  });

  it('pins on first contact, and a different key is a typed mismatch that is not pinned', () => {
    const first = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    expect(verifyOrPinSftpHostKey(db, 'sftp.example', 22, first)).toEqual({ accepted: true });
    expect(db.getSftpHostKey('sftp.example', 22)).toMatchObject({ fingerprint: first, pinnedAt: expect.any(String) });

    const check = verifyOrPinSftpHostKey(db, 'sftp.example', 22, other);
    expect(check.accepted).toBe(false);
    expect(check.mismatch).toBeInstanceOf(HostKeyMismatchError);
    expect(check.mismatch).toMatchObject({ host: 'sftp.example', port: 22, expectedFingerprint: first, presentedFingerprint: other });
    expect(db.getSftpHostKeyFingerprint('sftp.example', 22)).toBe(first);
    expect(db.getSftpHostKeyMismatch()).toMatchObject({ presentedFingerprint: other });
  });

  it('trusts a changed key only when it is the one the server presented', () => {
    const first = 'a'.repeat(64);
    const presented = 'c'.repeat(64);
    verifyOrPinSftpHostKey(db, 'sftp.example', 22, first);
    verifyOrPinSftpHostKey(db, 'sftp.example', 22, presented);

    expect(() => db.trustSftpHostKey('d'.repeat(64))).toThrow(/isn't the key the server presented/);
    expect(db.getSftpHostKeyFingerprint('sftp.example', 22)).toBe(first);

    // Formatted (uppercase, grouped) is fine
    const formatted = presented.toUpperCase().replace(/(.{4})/g, '$1 ');
    expect(db.trustSftpHostKey(formatted)).toMatchObject({ host: 'sftp.example', fingerprint: presented });
    expect(db.getSftpHostKeyFingerprint('sftp.example', 22)).toBe(presented);
    expect(db.getSftpHostKeyMismatch()).toBeNull();
    // Nothing left to trust
    expect(() => db.trustSftpHostKey(presented)).toThrow();

    db.forgetSftpHostKey('sftp.example', 22);
    expect(db.getSftpHostKey('sftp.example', 22)).toBeNull();
  });

  it('seals the key passphrase like the password, and never returns it from the profile', () => {
    db.updateProfile({ publishSettings: { sftpKeyPassphrase: 'hunter2' } }, { allowPlaintext: true });
    expect(db.getProfile().publishSettings.sftpKeyPassphrase).toBe('••••••••');
    expect(db.getPublishCredentials().sftpKeyPassphrase).toBe('hunter2');
  });

  it('takes the key file path only from the main-process picker', () => {
    const main = read('electron/main.ts');
    expect(main).toContain("ipcMain.handle('studio:pick-sftp-key', async () => {");
    expect(main).toMatch(/delete updates\.publishSettings\.sftpPrivateKeyPath/);
    expect(read('electron/preload.ts')).toContain("pickSftpKey: () => ipcRenderer.invoke('studio:pick-sftp-key'),");
  });
});

describe('Security Phase 8: unencrypted FTP only on request', () => {
  it('connects with FTPS (secure: true) unless the user allowed unencrypted FTP', () => {
    const base = { host: 'ftp.example', username: 'me', password: 'pw' };
    expect(ftpAccessOptions(base, 21).secure).toBe(true);
    expect(ftpAccessOptions({ ...base, ftpAllowInsecure: false }, 21).secure).toBe(true);
    expect(ftpAccessOptions({ ...base, ftpAllowInsecure: true }, 21).secure).toBe(false);
  });

  it('recognises a failed FTPS start and explains what to do', () => {
    expect(isFtpTlsFailure(new Error('534 AUTH TLS not supported'))).toBe(true);
    expect(isFtpTlsFailure(Object.assign(new Error('x'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }))).toBe(true);
    expect(isFtpTlsFailure(new Error('self signed certificate'))).toBe(true);
    expect(isFtpTlsFailure(new Error('530 Login incorrect'))).toBe(false);
    expect(isFtpTlsFailure(new Error('connect ECONNREFUSED 10.0.0.1:5000'))).toBe(false);
    expect(new FtpTlsError('ftp.example', 'detail').message).toMatch(
      /^Couldn't start a secure \(FTPS\) connection to ftp\.example\. Ask your host whether FTPS or SFTP is available\. As a last resort you can allow unencrypted FTP in Publishing settings\./
    );
  });

  it('no MCP tool can allow unencrypted FTP', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p8-ftp-'));
    const manager = new PersonaManager(dir);
    try {
      const mcp = new WebringMcpServer(manager, dir);
      const before = manager.getActiveContext().db.getProfile().publishSettings.ftpAllowInsecure;
      await mcp.executeToolCall('webring_update_profile', { ftpAllowInsecure: true, displayName: 'Still me' });
      expect(manager.getActiveContext().db.getProfile().publishSettings.ftpAllowInsecure).toBe(before);
      const schemas = JSON.stringify(mcp.getTools().map((t) => t.inputSchema));
      expect(schemas).not.toContain('ftpAllowInsecure');
    } finally {
      manager.closeAll();
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Windows may still hold the database file
      }
    }
  });
});

describe('Security Phase 8: GitHub publishing when the branch moves', () => {
  let dir: string;
  let db: StudioDatabase;

  /** A tiny in-memory GitHub. `beforeRefUpdate` runs before each ref PATCH and may return a status. */
  function fakeGitHub(beforeRefUpdate: (n: number) => number | void) {
    const trees = new Map<string, Map<string, string>>();
    const commits = new Map<string, { tree: string; parents: string[] }>();
    const refs = new Map<string, string>();
    const patches: Array<Record<string, unknown>> = [];
    let blobPosts = 0;
    let counter = 0;
    const newId = () => `id${++counter}`;
    const readme = gitBlobSha(Buffer.from('# repo'));
    trees.set('t0', new Map([['README.md', readme]]));
    commits.set('c0', { tree: 't0', parents: [] });
    refs.set('gh-pages', 'c0');
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    /** Someone else commits a file to the branch. */
    const commitElsewhere = (file: string) => {
      const head = refs.get('gh-pages')!;
      const tree = new Map(trees.get(commits.get(head)!.tree)!);
      tree.set(file, gitBlobSha(Buffer.from(file)));
      const t = newId();
      trees.set(t, tree);
      const c = newId();
      commits.set(c, { tree: t, parents: [head] });
      refs.set('gh-pages', c);
    };
    vi.stubGlobal('fetch', async (url: string, init?: { method?: string; body?: string }) => {
      const route = new URL(url).pathname.replace('/repos/o/r', '');
      const method = init?.method || 'GET';
      const body = init?.body ? JSON.parse(init.body) : {};
      if (route === '' && method === 'GET') return json(200, { default_branch: 'main', permissions: { push: true } });
      if (route.startsWith('/git/ref/heads/')) return json(200, { object: { sha: refs.get('gh-pages') } });
      if (route.startsWith('/git/commits/') && method === 'GET') {
        return json(200, { tree: { sha: commits.get(route.slice('/git/commits/'.length))!.tree } });
      }
      if (route.startsWith('/git/trees/') && method === 'GET') {
        const tree = trees.get(route.slice('/git/trees/'.length))!;
        return json(200, { truncated: false, tree: [...tree].map(([p, sha]) => ({ path: p, type: 'blob', sha })) });
      }
      if (route === '/git/blobs') {
        blobPosts++;
        return json(201, { sha: gitBlobSha(Buffer.from(body.content, 'base64')) });
      }
      if (route === '/git/trees') {
        const tree = new Map(trees.get(body.base_tree)!);
        for (const entry of body.tree) {
          if (entry.sha === null) tree.delete(entry.path);
          else tree.set(entry.path, entry.sha);
        }
        const id = newId();
        trees.set(id, tree);
        return json(201, { sha: id });
      }
      if (route === '/git/commits') {
        const id = newId();
        commits.set(id, { tree: body.tree, parents: body.parents });
        return json(201, { sha: id });
      }
      if (route.startsWith('/git/refs/heads/') && method === 'PATCH') {
        patches.push(body);
        const forced = beforeRefUpdate(patches.length);
        if (forced) return json(forced, { message: 'Update is not a fast forward' });
        // A real fast-forward check: the new commit must sit on the current head
        if (!body.force && commits.get(body.sha)!.parents[0] !== refs.get('gh-pages')) {
          return json(422, { message: 'Update is not a fast forward' });
        }
        refs.set('gh-pages', body.sha);
        return json(200, {});
      }
      if (route === '/pages') return json(409, {});
      return json(404, { message: `unhandled ${method} ${route}` });
    });
    const headFiles = () => trees.get(commits.get(refs.get('gh-pages')!)!.tree)!;
    return { patches, commitElsewhere, headFiles, blobPosts: () => blobPosts };
  }

  const publish = async () => {
    const publisher = new SitePublisher(new StaticSiteGenerator(db));
    publisher.githubRetryDelaysMs = [0, 0];
    const settings = {
      ...db.getProfile().publishSettings,
      githubOwner: 'o',
      githubRepo: 'r',
      githubBranch: 'gh-pages',
      githubToken: 'tok',
    };
    return publisher.publishToGitHubPages(settings, fs.mkdtempSync(path.join(dir, 'gh-')));
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p8-gh-'));
    db = new StudioDatabase(dir, 'gh.sqlite');
    db.updateProfile({ siteUrl: 'https://me.ring.test', handle: 'me.ring.test', displayName: 'Me' });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the database file
    }
  });

  it('rebuilds on the new head when someone else committed mid-publish, keeping their file', async () => {
    const gh: ReturnType<typeof fakeGitHub> = fakeGitHub((n) => {
      if (n === 1) gh.commitElsewhere('manual.txt');
    });
    const res = await publish();
    expect(res.success).toBe(true);
    expect(gh.patches).toHaveLength(2);
    expect(gh.headFiles().has('manual.txt')).toBe(true);
    expect(gh.headFiles().has('index.html')).toBe(true);
    expect(gh.headFiles().has('README.md')).toBe(true);
    // The retry reuses the blobs it already uploaded: one upload per published file
    expect(gh.blobPosts()).toBe(gh.headFiles().size - 2);
  });

  it('gives up after three non-fast-forward attempts with a readable message', async () => {
    const gh = fakeGitHub(() => 422);
    const res = await publish();
    expect(res.success).toBe(false);
    expect(res.message).toContain(GITHUB_BRANCH_BUSY_MESSAGE);
    expect(gh.patches).toHaveLength(3);
  });

  it('never force-pushes', async () => {
    const gh = fakeGitHub((n) => (n < 3 ? 422 : undefined));
    expect((await publish()).success).toBe(true);
    expect(gh.patches).toHaveLength(3);
    for (const patch of gh.patches) expect(patch.force).toBe(false);
    expect(read('electron/services/publisher.ts')).not.toMatch(/force:\s*true/);
  });
});

describe('Security Phase 8: GitHub token guidance', () => {
  it('recommends a fine-grained token for one repository and links to create it', () => {
    const app = read('src/studio/App.tsx');
    expect(app).toContain("'https://github.com/settings/personal-access-tokens/new'");
    expect(app).toContain('Avoid classic tokens; they grant access to all your repositories.');
    expect(app.match(/Create token on GitHub/g)?.length).toBe(2);
    expect(app).not.toMatch(/Tokens \(classic\)|public_repo/);
  });
});

describe('Security Phase 8: the published page runs only its own scripts', () => {
  let dir: string;
  let db: StudioDatabase;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p8-csp-'));
    db = new StudioDatabase(dir, 'csp.sqlite');
    db.updateProfile({
      siteUrl: 'https://me.ring.test',
      handle: 'me.ring.test',
      displayName: 'Me',
      publishSettings: { analyticsEnabled: true, analyticsMeasurementId: 'G-ABC123XYZ' },
    });
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold the database file
    }
  });

  const scriptSrcOf = (html: string) => {
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)![1];
    return csp.split(';').map((d) => d.trim()).find((d) => d.startsWith('script-src'))!;
  };

  const pages = () => {
    const generator = new StaticSiteGenerator(db);
    const out = path.join(dir, 'site');
    generator.generateToDirectory(out);
    return {
      published: fs.readFileSync(path.join(out, 'index.html'), 'utf8'),
      preview: generator.buildStandaloneProfileHtml(db.buildSignedSiteBundle({ publish: true }), { preview: true }),
    };
  };

  it("has no 'unsafe-inline' scripts, and every inline script's hash is in the CSP", () => {
    for (const html of Object.values(pages())) {
      const scriptSrc = scriptSrcOf(html);
      expect(scriptSrc).not.toContain('unsafe-inline');
      expect(scriptSrc).not.toContain('__WEBRING_INLINE_SCRIPT_HASHES__');
      const inline = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].filter((m) => !/\bsrc\s*=/i.test(m[1]));
      expect(inline.length).toBeGreaterThanOrEqual(3); // bundle, page, analytics (and the preview bridge)
      expect(html).toContain("gtag('config', 'G-ABC123XYZ'");
      for (const m of inline) {
        const hash = `'sha256-${crypto.createHash('sha256').update(m[2], 'utf8').digest('base64')}'`;
        expect(scriptSrc).toContain(hash);
      }
      expect(inlineScriptHashes(html).length).toBe(new Set(inline.map((m) => m[2])).size);
      expect(html).not.toContain('\r');
    }
  });

  it('has no inline event handler attributes, in the page or in what its scripts render', () => {
    const { published } = pages();
    expect(published).not.toMatch(/\son[a-z]+\s*=\s*["']/i);
    for (const file of ['electron/services/siteGenerator.ts', 'electron/services/siteTemplates.ts', 'electron/services/pageEnhancements.ts']) {
      expect(read(file)).not.toMatch(/\son[a-z]+=\\?["']/);
    }
    expect(published).toContain("closest('[data-action]')");
  });

  it('refuses to build an unstyled page when the stylesheet is missing', () => {
    expect(() => loadSiteCss([path.join(dir, 'nope.css')])).toThrow('Site stylesheet missing — run npm run build:site-css');
    const css = path.join(dir, 'site.css');
    fs.writeFileSync(css, 'body{}');
    expect(loadSiteCss([path.join(dir, 'nope.css'), css])).toBe('body{}');
  });

  it('no longer has an unescaped hydration path', () => {
    const source = read('electron/services/siteGenerator.ts');
    expect(source).not.toContain('injectHydrationData');
    expect(source).not.toMatch(/__WEBRING_BUNDLE__ = \$\{JSON\.stringify/);
  });
});
