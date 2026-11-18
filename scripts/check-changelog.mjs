import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const changelogPath = 'src/docs/changelog.ts';
const base = process.argv[2] ?? process.env.CHANGELOG_BASE ?? 'origin/main';
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const failures = [];

const parse = (version) => version.split('.').map(Number);
const newer = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const latestIn = (source) => source.match(/version:\s*'(\d+\.\d+\.\d+)'/)?.[1];
const show = (path) => {
  try {
    return git('show', `${base}:${path}`);
  } catch {
    return undefined;
  }
};

const mergeBase = git('merge-base', base, 'HEAD').trim();
const changed = git('diff', '--name-only', mergeBase, 'HEAD').split('\n').filter(Boolean);
if (!changed.includes(changelogPath))
  failures.push(`Add a release for this change to ${changelogPath}.`);

const version = JSON.parse(readFileSync('package.json', 'utf8')).version;
const lockVersion = JSON.parse(readFileSync('package-lock.json', 'utf8')).version;
const latest = latestIn(readFileSync(changelogPath, 'utf8'));
const baseVersion = JSON.parse(show('package.json') ?? '{"version":"0.0.0"}').version;
const baseLatest = latestIn(show(changelogPath) ?? '') ?? '0.0.0';

if (latest !== version)
  failures.push(
    `The newest release in ${changelogPath} is ${latest}, but package.json is ${version}.`,
  );
if (lockVersion !== version)
  failures.push(`package-lock.json is ${lockVersion}, but package.json is ${version}.`);
if (!newer(version, baseVersion))
  failures.push(`Bump package.json above ${baseVersion}, the version on ${base}.`);
if (!newer(latest ?? '0.0.0', baseLatest))
  failures.push(`Add a release newer than ${baseLatest} at the top of ${changelogPath}.`);

if (failures.length) {
  console.error(`Changelog check failed against ${base}:\n- ${failures.join('\n- ')}`);
  console.error(
    '\nRun `npm version minor --no-git-tag-version` (or patch for fixes) and add a matching release to src/docs/changelog.ts.',
  );
  process.exit(1);
}
console.log(`Changelog has ${version}; ${base} has ${baseVersion}.`);
