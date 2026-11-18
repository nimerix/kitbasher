export type ChangeKind = 'new' | 'improved' | 'fixed';

export interface ReleaseChange {
  kind: ChangeKind;
  text: string;
  guide?: string;
}

export interface Release {
  date: string;
  title: string;
  /**
   * The short hash of the commit on main that shipped the release. New entries leave it out:
   * the build finds the commit that added them.
   */
  commit?: string;
  changes: ReleaseChange[];
}

// Newest first. Each title must be unique: it names the release's link.
export const releases: Release[] = [
  {
    date: '2026-11-17',
    title: 'Commit versions',
    changes: [
      {
        kind: 'improved',
        text: 'The version shown in the What’s new button and the documentation is the short hash of the commit the app was built from, and each release names the commit it shipped in. Quote it when you report a bug.',
      },
    ],
  },
  {
    date: '2026-11-17',
    title: 'Painting a warp region',
    commit: 'a5b7f6f',
    changes: [
      {
        kind: 'fixed',
        text: 'Dragging the brush while painting a warp region paints a stroke instead of orbiting the camera.',
      },
    ],
  },
  {
    date: '2026-11-17',
    title: 'Release notes',
    commit: '7ca14d6',
    changes: [
      {
        kind: 'new',
        text: 'A What’s new page in the documentation lists the features and changes in every release.',
      },
      {
        kind: 'new',
        text: 'The sparkle button in the workbench header shows the latest releases, with a dot when there is one you haven’t seen.',
      },
    ],
  },
  {
    date: '2026-11-17',
    title: 'Warp for scanned parts',
    commit: '198b3f2',
    changes: [
      {
        kind: 'new',
        text: 'Warp deforms a painted region or a whole part with an adjustable grid of control points, then applies the result as one undo step.',
      },
      {
        kind: 'new',
        text: 'Close gap snaps a warped surface to a neighbouring part, with seam and fold feedback while you work.',
      },
      {
        kind: 'improved',
        text: 'Pins, anchors, joints, other parts, and mesh data outside the warped region stay unchanged.',
      },
      {
        kind: 'improved',
        text: 'Undo history is capped by mesh memory, so long sessions with large scans stay responsive.',
      },
    ],
  },
];

export const latestRelease = releases[0];

// The build's list of the commits that added each title, for releases that name none. Tests
// that import this file outside Vite have no environment.
const addedIn: Record<string, string> = JSON.parse(import.meta.env?.VITE_RELEASE_COMMITS || '{}');

/** The short hash of the commit a release shipped in, or undefined before it is committed. */
export const releaseCommit = (release: Release): string | undefined =>
  release.commit ?? addedIn[release.title];

/** The release's anchor on the What's new page, from its title. */
export const releaseId = (release: Release) =>
  release.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
