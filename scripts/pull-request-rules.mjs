export const pullRequestTypes = {
  feat: { label: 'New feature' },
  fix: { label: 'Bug fix' },
  perf: { label: 'Performance' },
  docs: { label: 'Documentation' },
  refactor: { label: 'Refactor with no change in behavior' },
  test: { label: 'Tests only' },
  build: { label: 'Build, dependencies, or tooling' },
  ci: { label: 'Continuous integration' },
  chore: { label: 'Maintenance' },
};

export const requiredSections = ['Summary', 'Testing'];

const titlePattern = new RegExp(`^\\((${Object.keys(pullRequestTypes).join('|')})(!)?\\) (.+)$`);

export function parseTitle(title) {
  const match = title.trim().match(titlePattern);
  return match ? { type: match[1], breaking: !!match[2], subject: match[3] } : undefined;
}

export function checkTitle(title) {
  const parsed = parseTitle(title);
  if (!parsed)
    return [
      `Start the title with a type in parentheses, such as "(feat) Add the Warp tool". Types: ${Object.keys(pullRequestTypes).join(', ')}.`,
    ];
  const failures = [];
  if (!/^[A-Z]/.test(parsed.subject))
    failures.push('Start the title after the type with a capital letter.');
  if (/[.\s]$/.test(parsed.subject)) failures.push('End the title without a period or space.');
  if (title.trim().length > 80) failures.push('Keep the title to 80 characters or fewer.');
  return failures;
}

const meaningful = (text) =>
  text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*]|\d+\.)\s*/, '').trim())
    .some(Boolean);

export function checkBody(body) {
  const text = (body ?? '').replace(/<!--[\s\S]*?-->/g, '').replace(/\r\n/g, '\n');
  const sections = [...text.matchAll(/^## +(.+?)\s*$/gm)].map((match, i, all) => ({
    title: match[1],
    content: text.slice(match.index + match[0].length, all[i + 1]?.index ?? text.length),
  }));
  const found = sections.map((section) => section.title);
  const failures = [];
  const positions = requiredSections.map((title) => found.indexOf(title));
  for (const [i, title] of requiredSections.entries())
    if (positions[i] < 0) failures.push(`Add a "## ${title}" section.`);
  if (
    positions.every((position) => position >= 0) &&
    positions.some((p, i) => i && p < positions[i - 1])
  )
    failures.push(
      `Order the sections ${requiredSections.map((title) => `"${title}"`).join(', ')}.`,
    );
  if (found[0] !== undefined && found[0] !== 'Summary')
    failures.push('Start the description with the "## Summary" section.');
  const content = (title) => sections.find((section) => section.title === title)?.content ?? '';
  for (const title of ['Summary', 'Testing'])
    if (found.includes(title) && !meaningful(content(title)))
      failures.push(`Fill in the "${title}" section.`);
  return failures;
}
