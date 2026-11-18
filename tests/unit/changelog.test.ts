import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { compareVersions, releases } from '../../src/docs/changelog';
import { articleById } from '../../src/docs/content';

const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { version: string };

describe('changelog', () => {
  it('starts with the package version', () => {
    expect(releases[0].version).toBe(pkg.version);
  });

  it('lists releases newest first with valid versions and dates', () => {
    for (const [i, release] of releases.entries()) {
      expect(release.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(release.date))).toBe(false);
      expect(release.title.trim()).not.toBe('');
      expect(release.changes.length).toBeGreaterThan(0);
      const older = releases[i + 1];
      if (older) {
        expect(compareVersions(release.version, older.version)).toBeGreaterThan(0);
        expect(release.date >= older.date).toBe(true);
      }
    }
  });

  it('links only to existing guides', () => {
    for (const release of releases)
      for (const change of release.changes) {
        expect(change.text.trim()).not.toBe('');
        if (change.guide) expect(articleById.has(change.guide), change.guide).toBe(true);
      }
  });
});
