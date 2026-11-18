import { describe, expect, it } from 'vitest';
import { releaseId, releases } from '../../src/docs/changelog';
import { articleById } from '../../src/docs/content';

describe('changelog', () => {
  it('lists releases newest first with dates, titles and changes', () => {
    for (const [i, release] of releases.entries()) {
      expect(release.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(release.date))).toBe(false);
      expect(release.title.trim()).not.toBe('');
      expect(release.changes.length).toBeGreaterThan(0);
      if (release.commit !== undefined) expect(release.commit).toMatch(/^[0-9a-f]{7}$/);
      const older = releases[i + 1];
      if (older) expect(release.date >= older.date).toBe(true);
    }
  });

  it('gives every release its own link', () => {
    const ids = releases.map(releaseId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    expect(releaseId({ date: '2026-11-17', title: 'Isolation and No clip', changes: [] })).toBe(
      'isolation-and-no-clip',
    );
  });

  it('links only to existing guides', () => {
    for (const release of releases)
      for (const change of release.changes) {
        expect(change.text.trim()).not.toBe('');
        if (change.guide) expect(articleById.has(change.guide), change.guide).toBe(true);
      }
  });
});
