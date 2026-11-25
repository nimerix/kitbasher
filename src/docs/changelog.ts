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
    date: '2026-11-24',
    title: 'Crease finds the edge',
    changes: [
      {
        kind: 'improved',
        text: 'The Refine Crease brush finds the rounded edge under a rough stroke, drawn on the rounding or beside it on either face. It fits the edge as lines and arcs, with sharp corners where the edge turns, and a stroke that comes back to its start closes the guide.',
        guide: 'refine',
      },
    ],
  },
  {
    date: '2026-11-24',
    title: 'Guides you can place exactly',
    changes: [
      {
        kind: 'improved',
        text: 'A Refine edge guide is now the edge itself. Position, Fit, Use guide path and Wall angle say where the guide lies on a rounded edge and how far the result may move to fit the scan. Width follows the guide’s edge around narrow slots. Choose Along with Automatic fit and Use guide path off for the earlier behaviour.',
        guide: 'refine',
      },
      {
        kind: 'new',
        text: 'Draw guides on sketch planes made from 3 points or a flat face. Lock points to a plane or a line or fix them, move them with a widget, and right-click a point for Lock, Align, Constrain and Delete.',
        guide: 'refine',
      },
      {
        kind: 'new',
        text: 'Constrain segments of a guide on a plane as in a CAD sketch: parallel, perpendicular, collinear, equal, tangent, concentric, horizontal and vertical. The guide stays in place if moving it to another plane would break a lock or constraint.',
        guide: 'refine',
      },
    ],
  },
  {
    date: '2026-11-24',
    title: 'Longer undo history',
    commit: 'e578cea',
    changes: [
      {
        kind: 'improved',
        text: 'Undo now keeps up to 120 changes, up from 40. Sculpt strokes share unchanged mesh data so more strokes fit in the available memory.',
        guide: 'sculpt',
      },
    ],
  },
  {
    date: '2026-11-24',
    title: 'Shared scene reconnection',
    commit: '367b020',
    changes: [
      {
        kind: 'fixed',
        text: 'When a shared scene loses its connection, the editor reconnects and checks which sculpt edits reached the scene before retrying.',
        guide: 'automation',
      },
    ],
  },
  {
    date: '2026-11-23',
    title: 'Sculpt directly on a part',
    commit: '35dab3f',
    changes: [
      {
        kind: 'new',
        text: 'Drag a brush to build up clay, carve a crease or pull a patch into shape. Sculpt adds triangles where the stroke needs detail. Each finished stroke is one undo step.',
        guide: 'sculpt',
      },
      {
        kind: 'new',
        text: 'Paint a mask to protect nearby details, mirror strokes with Local X symmetry, or use pen pressure to vary brush strength and radius.',
        guide: 'sculpt',
      },
    ],
  },
  {
    date: '2026-11-21',
    title: 'Refine edges and surfaces on scans',
    changes: [
      {
        kind: 'new',
        text: 'Refine rebuilds softened edges from a line, arc or spline laid along them, smooths, flattens or shape-snaps a painted area while keeping rivets and other detail, adds crease, flatten and smooth brushes, and can propose guides and regions for you to accept or adjust. A guide may be laid beside the edge rather than on it, and narrow lips and rims are read.',
        guide: 'refine',
      },
    ],
  },
  {
    date: '2026-11-19',
    title: 'Smoother warp pulls and finer voxel remeshing',
    changes: [
      {
        kind: 'fixed',
        text: 'Long point pulls on flat surfaces have a smoother base, including at 0% falloff.',
        guide: 'warp',
      },
      {
        kind: 'improved',
        text: 'Voxel remesh now uses a default resolution of 128 and goes up to 1024. Above 256 it fits each vertex to the original surface, so dense scans keep their detail.',
        guide: 'performance',
      },
    ],
  },
  {
    date: '2026-11-18',
    title: 'Warp handles, lines and a clearer grid',
    changes: [
      {
        kind: 'improved',
        text: 'The warp grid is drawn in dark lines that follow the surface and stay readable on any part color. Lines lighten as the grid gets denser, so the model stays visible underneath.',
      },
      {
        kind: 'improved',
        text: 'Warp has its own brush, with a size slider fitted to the part you are warping.',
      },
      {
        kind: 'new',
        text: 'A whole-part warp can place control points automatically, so moving one bends the part and no longer carries it away. Distribute points spreads more points over any region.',
      },
      {
        kind: 'new',
        text: 'Each control point has a radius and a falloff, so one point can move a wide, smooth area.',
      },
      {
        kind: 'new',
        text: 'Feather edge softens the edge of a painted region by letting the surface just beyond it bend too.',
      },
      {
        kind: 'new',
        text: 'Draw a line or paint an area on the surface and move it as one handle, without a peak at each point.',
        guide: 'warp',
      },
      {
        kind: 'improved',
        text: 'Warped surfaces fold far less on dense scans, a density or region change is one undo step, and Apply waits for the surface to settle.',
      },
    ],
  },
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
        guide: 'warp',
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
