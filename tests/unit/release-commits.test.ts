import { describe, expect, it } from 'vitest';
import { firstCommits } from '../../scripts/release-commits.mjs';

describe('release commits', () => {
  it('names the first commit that added each release title', () => {
    const log = [
      '\0' + '1111111',
      'diff --git a/src/docs/changelog.ts b/src/docs/changelog.ts',
      '@@ -0,0 +1,475 @@',
      "+    title: 'Warp for scanned parts',",
      '\0' + '2222222',
      '@@ -17,0 +18,11 @@ export const releases: Release[] = [',
      "-    title: 'Warp for scanned parts',",
      "+    title: 'Warp for scanned parts',",
      "+    title: 'Commit versions',",
      "+        text: 'title: 'Not a title',",
    ].join('\n');
    expect(firstCommits(log)).toEqual({
      'Warp for scanned parts': '1111111',
      'Commit versions': '2222222',
    });
  });

  it('finds nothing in an empty history', () => {
    expect(firstCommits('')).toEqual({});
  });
});
