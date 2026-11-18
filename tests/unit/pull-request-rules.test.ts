import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { checkBody, checkTitle } from '../../scripts/pull-request-rules.mjs';

const template = readFileSync('.github/pull_request_template.md', 'utf8');
const filled = `## Summary

- Add the Warp tool.

## Testing

- \`npm test\` passed.

## Council review

Approved.
`;

describe('pull request titles', () => {
  it('accepts a type in parentheses, an optional breaking marker, and a sentence-case subject', () => {
    for (const title of [
      '(feat) Add the Warp tool for closing gaps in scanned parts',
      '(fix) Keep Drive connected after a reload',
      '(perf) Speed up remeshing',
      '(docs) Add editor screenshots to guides',
      '(feat!) Replace the scene format',
    ])
      expect(checkTitle(title), title).toEqual([]);
  });

  it('rejects titles without a known type in parentheses or with a malformed subject', () => {
    expect(checkTitle('Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('feat: Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('(feat): Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('(fix/drive) Keep Drive connected')).toHaveLength(1);
    expect(checkTitle('(feature) Add the Warp tool')).toHaveLength(1);
    expect(checkTitle('(feat) add the Warp tool')).toEqual([
      'Start the title after the type with a capital letter.',
    ]);
    expect(checkTitle('(fix) Keep Drive connected.')).toEqual([
      'End the title without a period or space.',
    ]);
    expect(checkTitle(`(feat) ${'A'.repeat(80)}`)).toContain(
      'Keep the title to 80 characters or fewer.',
    );
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
    ]);
  });

  it('requires every section, in order, starting with the summary', () => {
    expect(checkBody('')).toEqual(['Add a "## Summary" section.', 'Add a "## Testing" section.']);
    const reordered = filled
      .replace('## Summary', '## Tmp')
      .replace('## Testing', '## Summary')
      .replace('## Tmp', '## Testing');
    expect(checkBody(reordered)).toContain('Order the sections "Summary", "Testing".');
    expect(checkBody(`## Notes\n\nHi\n\n${filled}`)).toContain(
      'Start the description with the "## Summary" section.',
    );
  });
});
