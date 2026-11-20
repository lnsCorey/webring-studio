import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../electron/services/personaManager';
import { getMcpToolTier, MAX_PENDING_APPROVALS, McpPendingApproval, WebringMcpServer } from '../electron/mcp/mcpServer';
import { describeToolCall } from '../electron/mcp/describeToolCall';
import { AutoPublisher } from '../electron/services/autoPublisher';
import { runScheduledPublish } from '../electron/services/jobs';
import { Scheduler } from '../electron/services/scheduler';
import { checkExportFolder, EXPORT_MARKER, ExportFolderRefusedError } from '../electron/services/siteGenerator';
import { LocalPreviewServer } from '../electron/services/localPreviewServer';
import { runWithoutNetwork } from '../electron/security/networkPolicy';
import { requestPublicJson } from '../electron/services/ringCrawler';
import { EXPECTED_TOOL_TIERS } from './mcpToolTiers.expected';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Post titles in one persona's database. */
const titlesIn = (manager: PersonaManager, personaId: string) =>
  manager.withPersonaContext(personaId, async (ctx) => ctx.db.getItems().map((i) => i.title).sort());

describe('Security Phase 7: each MCP call stays in its own persona', () => {
  let dir: string;
  let manager: PersonaManager;
  let mcp: WebringMcpServer;
  let other: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-persona-'));
    manager = new PersonaManager(dir);
    other = manager.createPersona({ label: 'B', displayName: 'Persona B' }).created.id;
    manager.switchPersona('default');
    mcp = new WebringMcpServer(manager, dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.closeAll();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  /** Holds the next call 50 ms after its persona is fixed and before the tool runs. */
  const delayNextCall = () => {
    let armed = true;
    const hold = <T>(original: (...a: never[]) => Promise<T>) =>
      function (this: PersonaManager, ...a: unknown[]) {
        const fn = a[a.length - 1] as (ctx: unknown) => Promise<unknown>;
        const delayed = async (ctx: unknown) => {
          if (armed) {
            armed = false;
            await tick(50);
          }
          return fn(ctx);
        };
        return (original as (...b: unknown[]) => Promise<T>).apply(this, [...a.slice(0, -1), delayed]);
      };
    // Read the real methods before spying replaces them
    const withPersona = hold(PersonaManager.prototype.withPersonaContext as never);
    const withActive = hold(PersonaManager.prototype.withActiveContext as never);
    vi.spyOn(PersonaManager.prototype, 'withPersonaContext').mockImplementation(withPersona as never);
    vi.spyOn(PersonaManager.prototype, 'withActiveContext').mockImplementation(withActive as never);
  };

  it('two calls in flight for different personas each write to their own', async () => {
    delayNextCall();
    const a = mcp.executeToolCall('webring_create_post', { personaId: other, title: 'From call A', commentary: 'a' });
    const b = mcp.executeToolCall('webring_create_post', { title: 'From call B', commentary: 'b' });
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.isError).toBeUndefined();
    expect(rb.isError).toBeUndefined();
    vi.restoreAllMocks();
    expect(await titlesIn(manager, other)).toContain('From call A');
    expect(await titlesIn(manager, other)).not.toContain('From call B');
    expect(await titlesIn(manager, 'default')).toContain('From call B');
    expect(await titlesIn(manager, 'default')).not.toContain('From call A');
  });

  it('switching persona in the app during a call neither redirects nor breaks it', async () => {
    delayNextCall();
    const pending = mcp.executeToolCall('webring_create_post', { title: 'Started on default', commentary: 'x' });
    await tick(10);
    manager.switchPersona(other);
    const res = await pending;
    expect(res.isError).toBeUndefined();
    vi.restoreAllMocks();
    expect(manager.getActivePersonaId()).toBe(other);
    expect(await titlesIn(manager, 'default')).toContain('Started on default');
    expect(await titlesIn(manager, other)).not.toContain('Started on default');
  });
});

describe('Security Phase 7: tool tiers and read-only mode', () => {
  let dir: string;
  let manager: PersonaManager;
  let mcp: WebringMcpServer;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-tiers-'));
    manager = new PersonaManager(dir);
    mcp = new WebringMcpServer(manager, dir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.closeAll();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  const agent = (name: string, args: Record<string, unknown> = {}) =>
    mcp.executeToolCall(name, args, { enforcePolicy: true });

  it('classifies every tool exactly as the reviewed table says', () => {
    const names = mcp.getTools().map((t) => t.name).sort();
    expect(names).toEqual(Object.keys(EXPECTED_TOOL_TIERS).sort());
    for (const name of names) {
      expect(getMcpToolTier(name, {}), name).toBe(EXPECTED_TOOL_TIERS[name]);
    }
  });

  it('makes a call outward when its arguments would publish or change hubs', () => {
    for (const args of [{ publishEnabled: true }, { publishPreset: 'hourly' }, { autoPublishEnabled: true }, { publishDestination: 'github' }]) {
      expect(getMcpToolTier('webring_set_schedule', args), JSON.stringify(args)).toBe('outward');
    }
    expect(getMcpToolTier('webring_set_schedule', { syncEnabled: true })).toBe('local-write');
    expect(getMcpToolTier('webring_hubs', { action: 'list' })).toBe('read');
    expect(getMcpToolTier('webring_hubs', { action: 'add' })).toBe('outward');
    expect(getMcpToolTier('webring_hubs', { action: 'remove' })).toBe('outward');
  });

  it('read-only: the hub list comes from storage, and nothing opens a connection', async () => {
    const ctx = manager.getActiveContext();
    ctx.db.saveWebringHubs([
      {
        url: 'https://hub.p7.test',
        title: 'Stored Hub',
        addedAt: '2026-01-01T00:00:00.000Z',
        listMe: false,
        state: 'not-listed',
        infoCheckedAt: '2026-01-01T00:00:00.000Z', // stale: a refresh would fetch it
      },
    ]);
    const connect = vi.spyOn(net.Socket.prototype, 'connect').mockImplementation(() => {
      throw new Error('A connection was attempted');
    });

    const list = await agent('webring_hubs', { action: 'list' });
    expect(list.isError).toBeUndefined();
    expect((list.data as { webringHubs: Array<{ title: string }> }).webringHubs.map((h) => h.title)).toEqual(['Stored Hub']);

    for (const [name, args] of [
      ['webring_search_hub', { url: 'https://hub.p7.test', query: 'x' }],
      ['webring_check_live_site', {}],
    ] as const) {
      const res = await agent(name, args);
      expect(res.isError, name).toBe(true);
      expect(res.content[0].text, name).toMatch(/read-only mode/);
    }
    expect((await agent('webring_get_setup_status', {})).isError).toBeUndefined();
    expect(connect).not.toHaveBeenCalled();

    const add = await agent('webring_hubs', { action: 'add', url: 'https://other.p7.test' });
    expect(add.isError).toBe(true);
    expect(add.content[0].text).toMatch(/Read-Only mode/);
  });

  it('read-only also refuses a network fetch from inside a tool', async () => {
    await expect(runWithoutNetwork(() => requestPublicJson('https://hub.p7.test/api/info'))).rejects.toThrow(
      'Network access is disabled in read-only MCP mode'
    );
  });

  it('turning on scheduled publishing goes to the approval queue', async () => {
    mcp.setReadOnlyMode(false);
    const res = await agent('webring_set_schedule', { publishEnabled: true, publishPreset: 'hourly' });
    expect((res.data as { pendingApproval?: boolean }).pendingApproval).toBe(true);
    expect(mcp.listPendingApprovals().map((a) => a.toolName)).toEqual(['webring_set_schedule']);
  });
});

describe('Security Phase 7: private data stays hidden from agents unless allowed', () => {
  let dir: string;
  let manager: PersonaManager;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-private-'));
    manager = new PersonaManager(dir);
    const db = manager.getActiveContext().db;
    db.updateProfile({ siteUrl: 'https://me.p7.test', displayName: 'Me' });
    db.updateProfile({ publishSettings: { ...db.getProfile().publishSettings, host: 'sftp.private.example', exportPath: 'C:\\Users\\me\\site' } });
    db.addOrUpdateFriend({ siteUrl: 'https://public.p7.test', displayName: 'Public Pal', visibility: 'public' });
    db.addOrUpdateFriend({ siteUrl: 'https://secret.p7.test', displayName: 'Secret Pal', visibility: 'private' });
    db.addOrUpdateFriend({ siteUrl: 'https://quiet.p7.test', displayName: 'Quiet Pal' });
    db.upsertNetworkFeedEntry({
      friendSiteUrl: 'https://public.p7.test',
      friendName: 'Public Pal',
      friendAvatarUrl: '',
      friendDid: '',
      entryType: 'post',
      title: 'Saved one',
      canonicalUrl: 'https://public.p7.test/posts/1',
      targetUrl: '',
      commentary: 'hello',
      mediaUrl: '',
      tags: [],
      createdAt: new Date().toISOString(),
      verifiedSignature: true,
    });
    db.saveFeedEntry('https://public.p7.test/posts/1', 'my private note');
  });

  afterEach(() => {
    manager.closeAll();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  const agent = (mcp: WebringMcpServer, name: string) => mcp.executeToolCall(name, {}, { enforcePolicy: true });

  it('hides private friends, saved posts and private profile fields, and says how many', async () => {
    const mcp = new WebringMcpServer(manager, dir);
    expect(mcp.isPrivateDataAllowed()).toBe(false);

    const friends = (await agent(mcp, 'webring_list_friends')).data as {
      friends: Array<{ displayName: string }>;
      redacted: { reason: string; count: number };
    };
    expect(friends.friends.map((f) => f.displayName)).toEqual(['Public Pal']);
    expect(friends.redacted).toEqual({ reason: expect.stringContaining("Allow agents to read private data"), count: 2 });

    const saved = (await agent(mcp, 'webring_list_saved')).data as { savedPosts: unknown[]; redacted: { count: number } };
    expect(saved.savedPosts).toEqual([]);
    expect(saved.redacted.count).toBe(1);

    const profile = await agent(mcp, 'webring_get_profile');
    expect(profile.content[0].text).not.toContain('sftp.private.example');
    expect(profile.content[0].text).not.toContain('C:\\\\Users');
    expect((profile.data as { publishSettings?: unknown }).publishSettings).toBeUndefined();
    expect((profile.data as { redacted: { count: number } }).redacted.count).toBe(1);

    const bundle = JSON.parse(mcp.readResource('webring://active/bundle').contents[0].text);
    expect(JSON.stringify(bundle)).not.toContain('Secret Pal');

    // The app's own (non-agent) calls still see everything
    const own = (await mcp.executeToolCall('webring_list_friends', {})).data as { friends: unknown[] };
    expect(own.friends).toHaveLength(3);
  });

  it('includes them once the user allows it, and both settings survive a restart', async () => {
    const mcp = new WebringMcpServer(manager, dir);
    expect(mcp.isReadOnlyMode()).toBe(true); // no settings file yet: read-only by default
    mcp.setAllowPrivateData(true);
    mcp.setReadOnlyMode(false);

    const friends = (await agent(mcp, 'webring_list_friends')).data as { friends: unknown[]; redacted?: unknown };
    expect(friends.friends).toHaveLength(3);
    expect(friends.redacted).toBeUndefined();
    expect(((await agent(mcp, 'webring_list_saved')).data as unknown[]).length).toBe(1);

    const restarted = new WebringMcpServer(manager, dir);
    expect(restarted.isPrivateDataAllowed()).toBe(true);
    expect(restarted.isReadOnlyMode()).toBe(false);

    // No tool can change either setting
    const names = restarted.getTools().map((t) => t.name).join(' ');
    expect(names).not.toMatch(/read_only|readonly|private_data|mcp_settings/i);
  });
});

describe('Security Phase 7: the approval queue', () => {
  let dir: string;
  let manager: PersonaManager;
  let mcp: WebringMcpServer;
  let other: string;
  let requested: McpPendingApproval[];

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-approve-'));
    manager = new PersonaManager(dir);
    other = manager.createPersona({ label: 'Side project', displayName: 'Persona B' }).created.id;
    manager.switchPersona('default');
    mcp = new WebringMcpServer(manager, dir);
    mcp.setReadOnlyMode(false);
    requested = [];
    mcp.attachAppServices({
      publishPaths: () => ({ userDataDir: dir, tempDir: dir }),
      deviceLogin: {} as never,
      onApprovalRequested: (approval) => requested.push(approval),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.closeAll();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  const agent = (name: string, args: Record<string, unknown> = {}) =>
    mcp.executeToolCall(name, args, { enforcePolicy: true });

  it('binds a request to the persona it targeted, and runs it there when approved later', async () => {
    const queued = await agent('webring_create_hosted_ring', { personaId: other, name: 'Bound ring' });
    expect((queued.data as { pendingApproval: boolean }).pendingApproval).toBe(true);
    const [item] = mcp.listPendingApprovals();
    expect(item).toMatchObject({
      personaId: other,
      personaName: 'Side project',
      summary: expect.stringContaining('Bound ring'),
      status: 'pending',
    });
    expect(Date.parse(item.expiresAt) - Date.parse(item.requestedAt)).toBe(30 * 60 * 1000);
    expect(requested.map((r) => r.id)).toEqual([item.id]);

    expect(manager.getActivePersonaId()).toBe('default');
    const res = await mcp.resolveApproval(item.id, true);
    expect(res.ok).toBe(true);
    const ringsIn = (id: string) => manager.withPersonaContext(id, async (ctx) => ctx.db.getHostedRings().map((r) => r.name));
    expect(await ringsIn(other)).toEqual(['Bound ring']);
    expect(await ringsIn('default')).toEqual([]);
    expect(mcp.listApprovalHistory()[0]).toMatchObject({ id: item.id, status: 'approved' });
  });

  it("an approved export still writes only to the saved folder, never the agent's", async () => {
    const saved = path.join(dir, 'saved-export');
    const db = manager.getActiveContext().db;
    db.updateProfile({ publishSettings: { ...db.getProfile().publishSettings, exportPath: saved } });
    const elsewhere = path.join(dir, 'agent-folder');
    await agent('webring_export_static_site', { targetDir: elsewhere });
    const [item] = mcp.listPendingApprovals();
    const res = await mcp.resolveApproval(item.id, true);
    const data = (res.result as { data: { success: boolean; ignoredTargetDir?: string } }).data;
    expect(data.success).toBe(true);
    expect(data.ignoredTargetDir).toBe(elsewhere);
    expect(fs.existsSync(path.join(saved, 'index.html'))).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(false);
  });

  it('an expired request can no longer be approved', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    await agent('webring_rotate_keys');
    const [item] = mcp.listPendingApprovals();
    vi.setSystemTime(new Date('2026-11-20T10:31:00.000Z'));
    expect(mcp.listPendingApprovals()).toEqual([]);
    const res = await mcp.resolveApproval(item.id, true);
    expect(res).toMatchObject({ ok: false, error: expect.stringMatching(/expired/) });
    expect(mcp.listApprovalHistory()[0]).toMatchObject({ id: item.id, status: 'expired' });
  });

  it('refuses a request beyond the limit with a readable error, keeping the first ones', async () => {
    for (let i = 0; i < MAX_PENDING_APPROVALS; i++) {
      const res = await agent('webring_create_hosted_ring', { name: `Ring ${i}` });
      expect(res.isError, `request ${i}`).toBeUndefined();
    }
    const over = await agent('webring_create_hosted_ring', { name: 'One too many' });
    expect(over.isError).toBe(true);
    expect(over.content[0].text).toMatch(/Too many requests are waiting for approval in Studio; ask the user to review them/);
    const pending = mcp.listPendingApprovals();
    expect(pending).toHaveLength(MAX_PENDING_APPROVALS);
    expect(pending[0].summary).toContain('Ring 0');

    expect(mcp.denyAllApprovals()).toBe(MAX_PENDING_APPROVALS);
    expect(mcp.listPendingApprovals()).toEqual([]);
  });

  it('describes every outward tool in plain words (no fallback)', () => {
    const outward = Object.entries(EXPECTED_TOOL_TIERS)
      .filter(([, tier]) => tier === 'outward')
      .map(([name]) => name);
    // Tools that are outward only with some arguments
    outward.push('webring_set_schedule', 'webring_set_profile_image', 'webring_hubs');
    for (const name of outward) {
      expect(describeToolCall(name, {}), name).not.toBe(`Run ${name}`);
    }
    expect(describeToolCall('webring_set_schedule', { publishEnabled: true, publishPreset: { kind: 'interval', minutes: 15 } })).toBe(
      'Turn on scheduled publishing every 15 minutes.'
    );
    expect(describeToolCall('webring_update_profile', { siteUrl: 'https://new.example' })).toMatch(
      /^Change your profile site URL to https:\/\/new\.example/
    );
    expect(describeToolCall('webring_set_proxy', { proxyUrl: 'socks5h://me:secret@127.0.0.1:9050' })).not.toContain('secret');
  });
});

describe('Security Phase 7: agent changes are held from every kind of publishing', () => {
  let dir: string;
  let manager: PersonaManager;
  let mcp: WebringMcpServer;
  let notes: Array<{ personaId: string; reason: string; fromAgent?: boolean }>;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-hold-'));
    manager = new PersonaManager(dir);
    const db = manager.getActiveContext().db;
    db.updateProfile({ siteUrl: 'https://me.hold.test', displayName: 'Me' });
    db.updateProfile({ publishSettings: { ...db.getProfile().publishSettings, exportPath: path.join(dir, 'site') } });
    mcp = new WebringMcpServer(manager, dir);
    mcp.setReadOnlyMode(false);
    notes = [];
    mcp.attachAppServices({
      publishPaths: () => ({ userDataDir: dir, tempDir: dir }),
      deviceLogin: {} as never,
      onLocalChange: (personaId, reason, options) => notes.push({ personaId, reason, fromAgent: options?.fromAgent }),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    manager.closeAll();
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  const agent = (name: string, args: Record<string, unknown> = {}) =>
    mcp.executeToolCall(name, args, { enforcePolicy: true });

  const newAutoPublisher = (published: string[]) => {
    const scheduler = new Scheduler({
      configPath: path.join(dir, 'scheduler.json'),
      listPersonaIds: () => ['default'],
      runner: { sync: () => Promise.reject(new Error('unused')), publish: () => Promise.reject(new Error('unused')) },
    });
    return new AutoPublisher({
      scheduler,
      listPersonaIds: () => ['default'],
      hasUnpublishedChanges: async () => false,
      publish: async (personaId) => {
        published.push(personaId);
        return { at: new Date().toISOString(), status: 'ok', message: 'published' };
      },
      loadAgentHold: (personaId) => manager.withPersonaContext(personaId, async (ctx) => ctx.db.getHeldAgentChanges().length),
      clearAgentHold: (personaId) => manager.withPersonaContext(personaId, async (ctx) => ctx.db.clearHeldAgentChanges()),
    });
  };

  it("holds an agent's profile change (formerly untracked), and the hold survives a restart", async () => {
    // update_profile is outward: queued, then approved by the user
    await agent('webring_update_profile', { tagline: 'Written by an agent' });
    const [request] = mcp.listPendingApprovals();
    expect((await mcp.resolveApproval(request.id, true)).ok).toBe(true);

    const held = manager.getActiveContext().db.getHeldAgentChanges();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ tool: 'webring_update_profile', summary: expect.any(String) });
    expect(notes).toEqual([{ personaId: 'default', reason: expect.any(String), fromAgent: true }]);

    // A read doesn't count as a change
    await agent('webring_list_items');
    expect(manager.getActiveContext().db.getHeldAgentChanges()).toHaveLength(1);

    // A fresh AutoPublisher (an app restart) picks the hold up from the persona
    const restarted = newAutoPublisher([]);
    await restarted.refresh();
    expect(restarted.status('default').agentHeld).toBe(true);
    const now = await restarted.publishNow('default');
    expect(now.status).toBe('held');

    restarted.approveAgentChanges('default');
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.getActiveContext().db.getHeldAgentChanges()).toEqual([]);
    restarted.dispose();
  });

  it('a scheduled publish with held changes returns held and publishes nothing; after release it runs', async () => {
    await agent('webring_create_post', { commentary: 'An agent post' });
    const ctx = manager.getActiveContext();
    expect(ctx.db.getHeldAgentChanges()).toHaveLength(1);

    const local = vi.spyOn(ctx.sitePublisher, 'publishToLocalDirectory');
    const heldRun = await runScheduledPublish(ctx, 'local', false, { userDataDir: dir, tempDir: dir });
    expect(heldRun).toMatchObject({ status: 'held', message: 'Agent changes awaiting review' });
    expect(local).not.toHaveBeenCalled();

    // An agent's own publish is refused too
    const agentPublish = await mcp.executeToolCall('webring_publish', { destination: 'local' }, { enforcePolicy: true, approved: true });
    expect(agentPublish.isError).toBe(true);
    expect(agentPublish.content[0].text).toMatch(/waiting for the user's review/);
    expect(local).not.toHaveBeenCalled();

    ctx.db.clearHeldAgentChanges();
    const released = await runScheduledPublish(ctx, 'local', false, { userDataDir: dir, tempDir: dir });
    expect(released.status).toBe('ok');
    expect(local).toHaveBeenCalledTimes(1);
  });

  it('an edit during a publish starts a follow-up countdown instead of counting as published', async () => {
    const scheduler = new Scheduler({
      configPath: path.join(dir, 'scheduler2.json'),
      listPersonaIds: () => ['default'],
      runner: { sync: () => Promise.reject(new Error('unused')), publish: () => Promise.reject(new Error('unused')) },
    });
    scheduler.setPersonaSchedule('default', { autoPublish: { enabled: true, delaySeconds: 30 } });
    let release!: () => void;
    const runs: number[] = [];
    const armed: number[] = [];
    const auto = new AutoPublisher({
      scheduler,
      listPersonaIds: () => ['default'],
      hasUnpublishedChanges: async () => false,
      publish: async () => {
        runs.push(Date.now());
        await new Promise<void>((r) => (release = r));
        return { at: new Date().toISOString(), status: 'ok', message: 'published' };
      },
      onArmed: (_id, seconds) => armed.push(seconds),
    });
    auto.noteLocalChange('default', 'post');
    expect(armed).toHaveLength(1);
    const first = auto.publishNow('default');
    await new Promise((r) => setTimeout(r, 10));
    expect(auto.status('default').state).toBe('running');
    auto.noteLocalChange('default', 'edit during publish');
    release();
    await first;
    // The edit wasn't part of that run: a new countdown is armed for it
    expect(runs).toHaveLength(1);
    expect(auto.status('default').state).toBe('pending');
    expect(auto.status('default').reasons).toContain('edit during publish');
    expect(armed).toHaveLength(2);
    auto.dispose();
  });
});

describe('Security Phase 7: the export folder', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webring-p7-export-'));
  });

  afterEach(() => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows may still hold a database file
    }
  });

  const someonesSite = (name: string) => {
    const folder = path.join(dir, name);
    fs.mkdirSync(path.join(folder, 'api'), { recursive: true });
    fs.writeFileSync(path.join(folder, 'api', 'manifest.json'), '{}');
    fs.writeFileSync(path.join(folder, 'index.html'), '<p>not Studio</p>');
    return folder;
  };

  it("refuses a non-empty folder that only has an api/manifest.json, and migrates the saved one once", () => {
    const manager = new PersonaManager(path.join(dir, 'studio'));
    try {
      const ctx = manager.getActiveContext();
      ctx.db.updateProfile({ siteUrl: 'https://me.export.test', displayName: 'Me' });

      const stranger = someonesSite('stranger');
      expect(checkExportFolder(stranger).ok).toBe(false);
      expect(() => ctx.siteGenerator.generateToDirectory(stranger)).toThrow(ExportFolderRefusedError);
      expect(fs.readFileSync(path.join(stranger, 'index.html'), 'utf8')).toBe('<p>not Studio</p>');

      // The saved export folder from an older build: accepted once, and marked
      const saved = someonesSite('saved');
      ctx.db.updateProfile({ publishSettings: { ...ctx.db.getProfile().publishSettings, exportPath: saved } });
      expect(checkExportFolder(saved, saved)).toEqual({ ok: true, migrate: true });
      ctx.siteGenerator.generateToDirectory(saved);
      expect(fs.existsSync(path.join(saved, EXPORT_MARKER))).toBe(true);
      expect(fs.existsSync(path.join(saved, `${EXPORT_MARKER}.lock`))).toBe(false);
      expect(checkExportFolder(saved)).toEqual({ ok: true });

      // Empty and new folders are fine
      expect(checkExportFolder(path.join(dir, 'new-folder')).ok).toBe(true);
      fs.mkdirSync(path.join(dir, 'empty'));
      expect(checkExportFolder(path.join(dir, 'empty')).ok).toBe(true);
    } finally {
      manager.closeAll();
    }
  });
});

describe('Security Phase 7: renderer boundary and MCP token', () => {
  const root = path.join(__dirname, '..');
  const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');

  it('gives the window no way to call MCP tools in packaged builds', () => {
    const preload = read('electron/preload.ts');
    expect(preload).not.toMatch(/callMcpTool|studio:call-mcp-tool/);
    const main = read('electron/main.ts');
    expect(main).not.toContain("'studio:call-mcp-tool'");
    // The developer runner is registered only when not packaged, and goes through agent policy
    expect(main).toMatch(/if \(!app\.isPackaged\) \{\s*ipcMain\.handle\('studio:dev-run-mcp-tool'[\s\S]{0,300}enforcePolicy: true/);
  });

  it('ships a strict CSP in index.html, relaxed only by the dev server', () => {
    const html = read('index.html');
    const csp = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] || '';
    expect(csp).toContain("script-src 'self';");
    expect(csp).not.toMatch(/unsafe-eval/);
    expect(csp.split(';').find((d) => d.trim().startsWith('script-src'))).not.toContain('unsafe-inline');
    for (const directive of ["object-src 'none'", "base-uri 'none'", "form-action 'none'", 'frame-src http://127.0.0.1:*']) {
      expect(csp).toContain(directive);
    }
    const vite = read('vite.config.ts');
    expect(vite).toMatch(/apply: 'serve'/);
    // A build in this checkout keeps it (checked when dist exists)
    if (fs.existsSync(path.join(root, 'dist/index.html'))) {
      expect(read('dist/index.html')).toContain(`content="${csp}"`);
    }
  });

  it('takes no paths from the window for exports or syncing a friend', () => {
    const main = read('electron/main.ts');
    const exportHandler = main.slice(main.indexOf("ipcMain.handle('studio:export-local'"), main.indexOf("ipcMain.handle('studio:export-local'") + 900);
    expect(exportHandler).toContain("publishTo(ctx, 'local', publishPaths())");
    expect(exportHandler).not.toMatch(/targetDir/);
    const crawl = main.slice(main.indexOf("ipcMain.handle('studio:crawl-friend'"), main.indexOf("ipcMain.handle('studio:crawl-friend'") + 400);
    expect(crawl).toMatch(/!app\.isPackaged && typeof localDirOverride === 'string'/);
  });

  it('serves the live preview from loopback, so it never runs inside the strict window CSP', async () => {
    const server = new LocalPreviewServer();
    try {
      const url = await server.serveLivePreview('<!doctype html><p>live preview</p>');
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/__studio-live-preview\?v=1$/);
      const res = await fetch(url);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('live preview');
      expect(await server.serveLivePreview('<p>again</p>')).toMatch(/\?v=2$/);
    } finally {
      await server.stop();
    }
  });
});
