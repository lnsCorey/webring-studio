/**
 * Avatars for other people's sites, in the app and on the published site.
 *
 * A friend's avatar is shown only when it's an https URL on the friend's own site: an image on
 * another host would let that host see who looks at it (and when), and a `data:` or
 * `javascript:` URL is never an image we should load. Anything else gets a local placeholder
 * generated from the site address, with no network request. The published page runs the same
 * logic from AVATAR_PAGE_SCRIPT; a test checks the two agree.
 */

/** The avatar URL when it's https and on the same origin as `siteUrl`; otherwise null. */
export function safeAvatarUrl(avatarUrl: string | undefined | null, siteUrl: string | undefined | null): string | null {
  if (!avatarUrl || !siteUrl) return null;
  try {
    const avatar = new URL(avatarUrl);
    const site = new URL(siteUrl);
    if (avatar.protocol !== 'https:') return null;
    if (avatar.origin !== site.origin) return null;
    return avatar.href;
  } catch {
    return null;
  }
}

/**
 * A placeholder avatar for `seed` (normally the site address): a coloured circle with the first
 * letter of its hostname. The same seed always gives the same image, in the app and on the site.
 */
export function localAvatarDataUri(seed: string): string {
  const text = String(seed || '');
  let host = text;
  try {
    host = new URL(text).hostname;
  } catch {
    // not a URL: use the seed as given
  }
  const first = host.replace(/^www\./i, '').charAt(0).toUpperCase();
  const label = /^[A-Z0-9]$/.test(first) ? first : '?';
  let hash = 0;
  for (let i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="hsl(' +
    hue +
    ',55%,38%)"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="28" font-weight="700">' +
    label +
    '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/** The avatar to show for someone else's site: theirs when it's safe, otherwise the placeholder. */
export function friendAvatarSrc(avatarUrl: string | undefined | null, siteUrl: string): string {
  return safeAvatarUrl(avatarUrl, siteUrl) ?? localAvatarDataUri(siteUrl);
}

/**
 * The same two functions as plain browser JavaScript, for the published page's script (it has no
 * module loader). Keep in step with the TypeScript above; tests/avatar.test.ts compares them.
 */
export const AVATAR_PAGE_SCRIPT = `
      function safeAvatarUrl(avatarUrl, siteUrl) {
        if (!avatarUrl || !siteUrl) return null;
        try {
          var avatar = new URL(avatarUrl);
          var site = new URL(siteUrl);
          if (avatar.protocol !== 'https:') return null;
          if (avatar.origin !== site.origin) return null;
          return avatar.href;
        } catch (e) {
          return null;
        }
      }

      function localAvatarDataUri(seed) {
        var text = String(seed || '');
        var host = text;
        try { host = new URL(text).hostname; } catch (e) {}
        var first = host.replace(/^www\\./i, '').charAt(0).toUpperCase();
        var label = /^[A-Z0-9]$/.test(first) ? first : '?';
        var hash = 0;
        for (var i = 0; i < text.length; i++) hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
        var hue = hash % 360;
        var svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="32" fill="hsl(' + hue + ',55%,38%)"/><text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle" fill="#fff" font-family="system-ui,sans-serif" font-size="28" font-weight="700">' + label + '</text></svg>';
        return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
      }
`;
