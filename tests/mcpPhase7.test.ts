import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../electron/services/personaManager';
import { getMcpToolTier, WebringMcpServer } from '../electron/mcp/mcpServer';
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
