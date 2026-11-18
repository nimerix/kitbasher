import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  bumpVersion,
  checkBody,
  checkTitle,
  expectedBump,
} from '../../scripts/pull-request-rules.mjs';

const template = readFileSync('.github/pull_request_template.md', 'utf8');
const filled = `## Summary

- Add the Warp tool.

## Testing

- \`npm test\` passed.

## Council review

Approved.

## Release notes

- [x] Added a release to \`src/docs/changelog.ts\`
- [x] Bumped the version
`;

describe('pull request titles', () => {
  it('accepts a type, optional scope or breaking marker, and a sentence-case subject', () => {
    for (const title of [
      'feat: Add the Warp tool for closing gaps in scanned parts',
      'fix(drive): Keep Drive connected after a reload',
      'perf: Speed up remeshing',
      'docs: Add editor screenshots to guides',
      'feat!: Replace the scene format',
    ])
      expect(checkTitle(title), title).toEqual([]);
  });

  it('rejects titles without a known type or with a malformed subject', () => {
    expect(checkTitle('Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('feature: Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('feat: add the Warp tool')).toEqual([
      'Start the title after the type with a capital letter.',
    ]);
    expect(checkTitle('fix: Keep Drive connected.')).toEqual([
      'End the title without a period or space.',
    ]);
    expect(checkTitle(`feat: ${'A'.repeat(80)}`)).toContain(
      'Keep the title to 80 characters or fewer.',
    );
  });

  it('maps the type to a version bump', () => {
    expect(expectedBump('feat: Add pins')).toBe('minor');
    expect(expectedBump('fix: Keep pins')).toBe('patch');
    expect(expectedBump('docs: Explain pins')).toBe('patch');
    expect(expectedBump('feat!: Replace pins')).toBe('major');
    expect(expectedBump('Add pins')).toBeUndefined();
    expect(bumpVersion('1.18.3', 'minor')).toBe('1.19.0');
    expect(bumpVersion('1.18.3', 'patch')).toBe('1.18.4');
    expect(bumpVersion('1.18.3', 'major')).toBe('2.0.0');
  });
});

describe('pull request descriptions', () => {
  it('accepts the filled-in template, with extra sections allowed after the summary', () => {
    expect(checkBody(filled)).toEqual([]);
  });

  it('rejects the unfilled template', () => {
    expect(checkBody(template)).toEqual([
      'Fill in the "Summary" section.',
      'Fill in the "Testing" section.',
      'Check every item under "Release notes".',
    ]);
  });

  it('requires every section, in order, starting with the summary', () => {
    expect(checkBody('')).toEqual([
      'Add a "## Summary" section.',
      'Add a "## Testing" section.',
      'Add a "## Release notes" section.',
    ]);
    const reordered = filled
      .replace('## Summary', '## Tmp')
      .replace('## Testing', '## Summary')
      .replace('## Tmp', '## Testing');
    expect(checkBody(reordered)).toContain(
      'Order the sections "Summary", "Testing", "Release notes".',
    );
    expect(checkBody(`## Notes\n\nHi\n\n${filled}`)).toContain(
      'Start the description with the "## Summary" section.',
    );
  });

  it('requires the release notes checklist to be kept and checked', () => {
    expect(checkBody(filled.replace('- [x] Bumped', '- [ ] Bumped'))).toEqual([
      'Check every item under "Release notes".',
    ]);
    expect(checkBody(filled.replace(/- \[x\].*\n/g, 'Done.\n'))).toEqual([
      'Keep the checklist from the template under "Release notes".',
    ]);
  });
});
