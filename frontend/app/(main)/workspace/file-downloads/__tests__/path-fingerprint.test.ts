/**
 * AUDITUI "Check a path": the browser computes the same SHA-256 the server
 * records (golden values from Node's crypto), normalizes like the server, and
 * also tries the path as typed for folders recorded before normalization.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath, pathFingerprints, pathForms, sha256Digest, shortDigest } from '../path-fingerprint';

const golden = (value: string) => `sha256:${createHash('sha256').update(value, 'utf8').digest('hex')}`;

describe('path fingerprints', () => {
  it('hashes a path exactly as the server does', async () => {
    expect(await sha256Digest('reports/q3-summary.pdf')).toBe(golden('reports/q3-summary.pdf'));
    expect(await sha256Digest('é/ü 名前.txt')).toBe(golden('é/ü 名前.txt'));
  });

  it('normalizes to NFC and drops a leading ./ and trailing slashes', () => {
    expect(normalizeWorkspacePath('  ./src/  ')).toBe('src');
    expect(normalizeWorkspacePath('docs//')).toBe('docs');
    expect(normalizeWorkspacePath('café/menu.md')).toBe('café/menu.md');
  });

  it('tries the typed form too when it differs, and only once when it does not', () => {
    expect(pathForms('src/')).toEqual(['src', 'src/']);
    expect(pathForms('src')).toEqual(['src']);
    expect(pathForms('   ')).toEqual([]);
  });

  it('answers both digests for a folder typed with a trailing slash', async () => {
    const { path, digests } = await pathFingerprints('src/');
    expect(path).toBe('src');
    expect(digests).toEqual([golden('src'), golden('src/')]);
  });

  it('shortens a digest for the table and keeps short values whole', () => {
    expect(shortDigest(golden('a'))).toMatch(/^sha256:[0-9a-f]{6}…[0-9a-f]{6}$/);
    expect(shortDigest('sha256:abc')).toBe('sha256:abc');
  });
});
