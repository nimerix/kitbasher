import { execFileSync } from 'node:child_process';

const git = (...args) =>
  execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();

/** From `git log --reverse --format=%x00%h -p` output, the first commit that added each release title. */
export function firstCommits(log) {
  const found = {};
  let commit;
  for (const line of log.split('\n')) {
    // A NUL marks each commit; no diff line can start with one.
    if (line.startsWith('\0')) commit = line.slice(1);
    else {
      const title = line.match(/^\+ {4}title: '(.*)',$/)?.[1];
      if (title && commit && !(title in found)) found[title] = commit;
    }
  }
  return found;
}

/** The short hash of the commit that added each release title to the changelog. */
export function releaseCommits(path = 'src/docs/changelog.ts') {
  try {
    // Builds that clone only the latest commit fetch the rest; the repository is public.
    if (git('rev-parse', '--is-shallow-repository') === 'true')
      git('fetch', '--unshallow', '--quiet');
  } catch {
    // Without history, releases that name no commit show none.
  }
  try {
    return firstCommits(
      git('log', '--reverse', '--abbrev=7', '--format=%x00%h', '-p', '-U0', '--', path),
    );
  } catch {
    return {};
  }
}
