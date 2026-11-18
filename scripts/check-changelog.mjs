import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { bumpVersion, expectedBump, isNewer, parseTitle } from './pull-request-rules.mjs';

const changelogPath = 'src/docs/changelog.ts';
const base = process.argv[2] ?? process.env.CHANGELOG_BASE ?? 'origin/main';
const title = process.env.PR_TITLE;
const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const failures = [];

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
const baseChangelog = show(changelogPath);
const baseLatest = latestIn(baseChangelog ?? '') ?? '0.0.0';

if (latest !== version)
  failures.push(
    `The newest release in ${changelogPath} is ${latest}, but package.json is ${version}.`,
  );
if (lockVersion !== version)
  failures.push(`package-lock.json is ${lockVersion}, but package.json is ${version}.`);
if (!isNewer(latest ?? '0.0.0', baseLatest))
  failures.push(`Add a release newer than ${baseLatest} at the top of ${changelogPath}.`);

// The pull request that introduces the changelog also backfills earlier versions.
const level = title && baseChangelog ? expectedBump(title) : undefined;
if (level) {
  const expected = bumpVersion(baseVersion, level);
  if (version !== expected)
    failures.push(
      `A "(${parseTitle(title).type})" pull request is a ${level} release: set the version to ${expected}, not ${version}.`,
    );
} else if (!isNewer(version, baseVersion))
  failures.push(`Bump package.json above ${baseVersion}, the version on ${base}.`);

if (failures.length) {
  console.error(`Changelog check failed against ${base}:\n- ${failures.join('\n- ')}`);
  console.error(
    `\nRun \`npm version ${level ?? 'minor'} --no-git-tag-version\` and add a matching release to ${changelogPath}.`,
  );
  process.exit(1);
}
console.log(`Changelog has ${version}; ${base} has ${baseVersion}.`);
