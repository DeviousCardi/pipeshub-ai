/**
 * "Check a path": the fingerprints a download of a path was recorded under,
 * computed in the browser so the path is never sent. The server hashes a
 * workspace path after NFC normalization; folder downloads recorded before
 * folders were normalized hashed the folder as typed, so both forms count.
 */

/** A path as the server names it: NFC, no leading `./`, no trailing `/`. */
export function normalizeWorkspacePath(path: string): string {
  return path
    .trim()
    .normalize('NFC')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '');
}

export async function sha256Digest(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const hex = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256:${hex}`;
}

/** The normalized path and, when it differs, the path as typed; empty for a blank input. */
export function pathForms(input: string): string[] {
  const typed = input.trim();
  const normalized = normalizeWorkspacePath(input);
  return [...new Set([normalized, typed].filter((form) => form !== ''))];
}

export async function pathFingerprints(input: string): Promise<{ path: string; digests: string[] }> {
  const forms = pathForms(input);
  const digests = await Promise.all(forms.map(sha256Digest));
  return { path: forms[0] ?? '', digests: [...new Set(digests)] };
}

/** `sha256:3f9a1c…e04c21`: enough to tell rows apart, the whole value in its title. */
export function shortDigest(digest: string): string {
  const hex = digest.startsWith('sha256:') ? digest.slice(7) : digest;
  return hex.length <= 12 ? digest : `sha256:${hex.slice(0, 6)}…${hex.slice(-6)}`;
}
