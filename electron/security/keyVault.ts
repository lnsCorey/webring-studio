/**
 * Encrypts the persona's secrets at rest: the Ed25519 private key, and publishing credentials
 * (SFTP/FTP password, GitHub token). The database stores either a plaintext PEM
 * (legacy, or when no OS keychain is available) or `enc:v1:<base64>` sealed by the cipher.
 *
 * The cipher is OS-backed (Electron `safeStorage`: Keychain on macOS, DPAPI on Windows,
 * libsecret on Linux), so it's only available inside the running Studio app. The stdio MCP CLI
 * runs under plain Node without it: it can still read everything, but anything that signs
 * (export/publish) fails with `KeyVaultUnavailableError`.
 */
export interface KeyCipher {
  isAvailable(): boolean;
  encrypt(plainText: string): Buffer;
  decrypt(cipherText: Buffer): string;
}

export const ENCRYPTED_KEY_PREFIX = 'enc:v1:';

export class KeyVaultUnavailableError extends Error {
  constructor(message?: string) {
    super(
      message ||
        'This persona’s signing key and publishing credentials are encrypted with the OS keychain, which is only available inside the Webring Studio app. Open Webring Studio to publish (or use its in-app HTTP MCP endpoint).'
    );
    this.name = 'KeyVaultUnavailableError';
  }
}

/**
 * Thrown when a new password, token or proxy login would be stored without encryption because the
 * OS keychain isn't available, and the caller didn't get the user's consent to store it as is
 * (`allowPlaintext`). The Studio app asks first; the MCP never stores secrets unencrypted.
 */
export class SecretStorageUnavailableError extends KeyVaultUnavailableError {
  constructor() {
    super(
      "This device's secure storage isn't available, so the password or token wasn't saved. " +
        'Studio can store it unencrypted only if you allow that in the app.'
    );
    this.name = 'SecretStorageUnavailableError';
  }
}

/** True when `cipher` can seal secrets now (the OS keychain is available). */
export function isAvailable(cipher?: KeyCipher): boolean {
  try {
    return Boolean(cipher?.isAvailable());
  } catch {
    return false;
  }
}

const fallbackListeners = new Set<() => void>();

/**
 * Called whenever a secret couldn't be sealed because the keychain is unavailable, so the app can
 * show it (the security banner). Returns an unsubscribe function.
 */
export function onKeyVaultFallback(listener: () => void): () => void {
  fallbackListeners.add(listener);
  return () => fallbackListeners.delete(listener);
}

export function isEncryptedKey(stored: string): boolean {
  return stored.startsWith(ENCRYPTED_KEY_PREFIX);
}

let warnedPlaintextFallback = false;

/**
 * Returns the value to store: sealed when a cipher is available, otherwise unchanged
 * (logging a warning once when a non-empty secret cannot be sealed).
 */
export function sealPrivateKey(privateKeyPem: string, cipher?: KeyCipher): string {
  if (!privateKeyPem || isEncryptedKey(privateKeyPem)) {
    return privateKeyPem;
  }
  if (!cipher || !isAvailable(cipher)) {
    if (!warnedPlaintextFallback) {
      warnedPlaintextFallback = true;
      console.warn('[keyVault] OS keychain is unavailable; secret cannot be sealed at rest.');
    }
    for (const listener of fallbackListeners) {
      try {
        listener();
      } catch {
        // A listener's failure never stops a save
      }
    }
    return privateKeyPem;
  }
  return `${ENCRYPTED_KEY_PREFIX}${cipher.encrypt(privateKeyPem).toString('base64')}`;
}

export function openPrivateKey(stored: string, cipher?: KeyCipher): string {
  if (!isEncryptedKey(stored)) {
    return stored;
  }
  if (!cipher?.isAvailable()) {
    throw new KeyVaultUnavailableError();
  }
  return cipher.decrypt(Buffer.from(stored.slice(ENCRYPTED_KEY_PREFIX.length), 'base64'));
}

/** Same sealing for any secret string (publishing passwords and tokens). */
export const sealSecret = sealPrivateKey;
export const openSecret = openPrivateKey;
