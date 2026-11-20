import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { sftpAuthMethodOf, StudioDatabase } from '../electron/db/database';
import {
  HostKeyMismatchError,
  resolveSshAgent,
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
