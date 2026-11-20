import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { PersonaManager } from '../electron/services/personaManager';
import { WebringMcpServer } from '../electron/mcp/mcpServer';

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
