/**
 * A key fingerprint (hex) laid out for people to read aloud and compare: uppercase, in groups of
 * four characters separated by spaces, eight groups per line. A 64-character SPKI SHA-256
 * fingerprint becomes two lines.
 */
export function formatFingerprint(hex: string): string {
  const clean = hex.replace(/[^0-9a-f]/gi, '').toUpperCase();
  const groups = clean.match(/.{1,4}/g) || [];
  const lines: string[] = [];
  for (let i = 0; i < groups.length; i += 8) lines.push(groups.slice(i, i + 8).join(' '));
  return lines.join('\n');
}

/** The first and last eight characters, for comparing over the phone ("ABCD 1234 … 5678 EF90"). */
export function fingerprintEnds(hex: string): { first: string; last: string } {
  const clean = hex.replace(/[^0-9a-f]/gi, '').toUpperCase();
  return { first: clean.slice(0, 8), last: clean.slice(-8) };
}
