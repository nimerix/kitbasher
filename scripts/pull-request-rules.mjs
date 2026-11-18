export const pullRequestTypes = {
  feat: { label: 'New feature', bump: 'minor' },
  fix: { label: 'Bug fix', bump: 'patch' },
  perf: { label: 'Performance', bump: 'patch' },
  docs: { label: 'Documentation', bump: 'patch' },
  refactor: { label: 'Refactor with no change in behavior', bump: 'patch' },
  test: { label: 'Tests only', bump: 'patch' },
  build: { label: 'Build, dependencies, or tooling', bump: 'patch' },
  ci: { label: 'Continuous integration', bump: 'patch' },
  chore: { label: 'Maintenance', bump: 'patch' },
};

export const requiredSections = ['Summary', 'Testing', 'Release notes'];

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
  if (found.includes('Release notes')) {
    const notes = content('Release notes');
    if (/^\s*[-*] \[ \]/m.test(notes)) failures.push('Check every item under "Release notes".');
    else if (!/^\s*[-*] \[[xX]\]/m.test(notes))
      failures.push('Keep the checklist from the template under "Release notes".');
  }
  return failures;
}

const parseVersion = (version) => version.split('.').map(Number);

export function bumpVersion(version, level) {
  const [major, minor, patch] = parseVersion(version);
  return level === 'major'
    ? `${major + 1}.0.0`
    : level === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;
}

export function isNewer(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}

export function expectedBump(title) {
  const parsed = parseTitle(title);
  if (!parsed) return undefined;
  return parsed.breaking ? 'major' : pullRequestTypes[parsed.type].bump;
}
