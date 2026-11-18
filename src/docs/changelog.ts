export type ChangeKind = 'new' | 'improved' | 'fixed';

export interface ReleaseChange {
  kind: ChangeKind;
  text: string;
  guide?: string;
}

export interface Release {
  version: string;
  date: string;
  title: string;
  changes: ReleaseChange[];
}

// Newest first. Every pull request adds a release here and sets the same version in package.json.
export const releases: Release[] = [
  {
    version: '1.18.0',
    date: '2026-11-17',
    title: 'Release notes',
    changes: [
      {
        kind: 'new',
        text: 'A What’s new page in the documentation lists the features and changes in every version.',
      },
      {
        kind: 'new',
        text: 'The sparkle button in the workbench header shows the latest releases, with a dot when there is one you haven’t seen.',
      },
    ],
  },
  {
    version: '1.17.0',
    date: '2026-11-17',
    title: 'Warp for scanned parts',
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
  {
    version: '1.16.1',
    date: '2026-11-15',
    title: 'Screenshots in the guides',
    changes: [
      {
        kind: 'improved',
        text: 'Seventeen focused editor screenshots now sit beside the instructions they illustrate.',
      },
      {
        kind: 'improved',
        text: 'Guide sections link straight to the matching video walkthroughs.',
      },
    ],
  },
  {
    version: '1.16.0',
    date: '2026-11-15',
    title: 'Alignment tutorials',
    changes: [
      {
        kind: 'new',
        text: 'Fifteen step-by-step alignment tutorials with screenshots and downloadable practice scenes.',
        guide: 'alignment-tutorials',
      },
      {
        kind: 'new',
        text: 'Captioned video walkthroughs with accessible playback controls and reduced-motion support.',
      },
    ],
  },
  {
    version: '1.15.1',
    date: '2026-11-13',
    title: 'Steadier callouts',
    changes: [
      {
        kind: 'improved',
        text: 'Callout labels stay compact, close to their points, and stable while the camera moves.',
      },
      {
        kind: 'improved',
        text: 'Marker preferences are simplified to a single label spacing setting.',
        guide: 'preferences',
      },
    ],
  },
  {
    version: '1.15.0',
    date: '2026-11-13',
    title: 'Callout routing',
    changes: [
      {
        kind: 'improved',
        text: 'Each callout routes its own leader line around the model, other labels, and other leaders.',
      },
    ],
  },
  {
    version: '1.14.0',
    date: '2026-11-13',
    title: 'Part pins',
    changes: [
      {
        kind: 'new',
        text: 'Hard pins hold a surface point in place while a part moves or rotates.',
        guide: 'pins',
      },
      {
        kind: 'new',
        text: 'Soft pins resist movement with an adjustable priority from 0 to 100.',
        guide: 'pins',
      },
      {
        kind: 'improved',
        text: 'Pins are kept through saves, recovery, shared sessions, copies, and undo.',
      },
    ],
  },
  {
    version: '1.13.0',
    date: '2026-11-13',
    title: 'Illustrated documentation',
    changes: [
      {
        kind: 'new',
        text: 'An illustrated manual covering every tool, workflow, setting, and integration, with search and deep links.',
        guide: 'introduction',
      },
      {
        kind: 'new',
        text: 'Open the manual from the workbench header, the help dialog, or the site footer.',
      },
    ],
  },
  {
    version: '1.12.2',
    date: '2026-11-13',
    title: 'Drive recovery',
    changes: [
      {
        kind: 'fixed',
        text: 'Recovered scenes remember whether they were already saved to Drive, so a reload no longer uploads them again.',
        guide: 'google-drive',
      },
    ],
  },
  {
    version: '1.12.1',
    date: '2026-11-13',
    title: 'Faster inspection',
    changes: [
      {
        kind: 'improved',
        text: 'Interference results are reused when you change scope, selection, or visibility without changing the geometry.',
        guide: 'inspection',
      },
    ],
  },
  {
    version: '1.12.0',
    date: '2026-11-13',
    title: 'Focused alignment views',
    changes: [
      {
        kind: 'new',
        text: 'While placing alignment points, isolate the selected parts, show only the active part, or ghost the other part.',
        guide: 'alignment',
      },
    ],
  },
  {
    version: '1.11.2',
    date: '2026-11-13',
    title: 'Drive sessions and conflicts',
    changes: [
      {
        kind: 'fixed',
        text: 'Reloading Kitbasher keeps you signed in to Google Drive.',
        guide: 'google-drive',
      },
      {
        kind: 'fixed',
        text: 'A newer Drive version no longer blocks opening the scene. Choose to load it, overwrite it, or save a copy.',
        guide: 'google-drive',
      },
    ],
  },
  {
    version: '1.11.1',
    date: '2026-11-13',
    title: 'Faster mesh processing',
    changes: [
      {
        kind: 'improved',
        text: 'Merging, reduction, and remeshing run in cancellable background workers.',
        guide: 'performance',
      },
      {
        kind: 'improved',
        text: 'Repeated Boolean operations, remeshing, and picking on large meshes are faster.',
      },
    ],
  },
  {
    version: '1.11.0',
    date: '2026-11-12',
    title: 'Precise transforms',
    changes: [
      {
        kind: 'new',
        text: 'X, Y, and Z step controls for exact Move and Rotate adjustments, with configurable increments.',
        guide: 'transforms',
      },
      {
        kind: 'new',
        text: 'Free pointer movement and trackball rotation with axis constraints.',
        guide: 'transforms',
      },
      {
        kind: 'new',
        text: 'A combined Transform gizmo with optional scaling.',
      },
    ],
  },
  {
    version: '1.10.0',
    date: '2026-11-12',
    title: 'Background activity',
    changes: [
      {
        kind: 'new',
        text: 'An activity center shows progress, elapsed time, and cancellation for background jobs.',
        guide: 'performance',
      },
      {
        kind: 'new',
        text: 'Notifications report finished jobs and errors, with a history.',
      },
    ],
  },
  {
    version: '1.9.0',
    date: '2026-11-12',
    title: 'Headset controls',
    changes: [
      {
        kind: 'new',
        text: 'A wrist palette in the headset for assembly tools, alignment, painting, joints, measuring, and anchors.',
        guide: 'headset',
      },
      {
        kind: 'new',
        text: 'Configurable controller buttons, thumbsticks, precision adjustments, and world navigation.',
      },
      {
        kind: 'improved',
        text: 'Smoother one- and two-controller navigation with anchored zoom and stepped turns.',
      },
    ],
  },
  {
    version: '1.8.0',
    date: '2026-11-12',
    title: 'Packed scene files',
    changes: [
      {
        kind: 'new',
        text: 'Scene files are packed, so saves are faster and downloads much smaller. A tested 832 MB scene now saves at 54.7 MB.',
        guide: 'saving',
      },
      {
        kind: 'improved',
        text: 'Older scene files still open, and print exports are unchanged after a save and reopen.',
      },
    ],
  },
  {
    version: '1.7.1',
    date: '2026-11-11',
    title: 'Privacy policy',
    changes: [
      {
        kind: 'new',
        text: 'A privacy policy explains local processing, browser storage, hosting, Google Drive, and shared sessions.',
      },
    ],
  },
  {
    version: '1.7.0',
    date: '2026-11-11',
    title: 'Google Drive autosave',
    changes: [
      {
        kind: 'new',
        text: 'Sign in to Google Drive to save scenes automatically to the same file.',
        guide: 'google-drive',
      },
      {
        kind: 'new',
        text: 'Reopen Drive scenes, recover offline edits, and resolve conflicts.',
      },
    ],
  },
  {
    version: '1.6.0',
    date: '2026-11-11',
    title: 'High-poly scans',
    changes: [
      {
        kind: 'new',
        text: 'High-poly scans display through lighter proxies while the original geometry is kept for picking, fitting, saving, and export.',
        guide: 'performance',
      },
      {
        kind: 'new',
        text: 'Decimate or remesh a part in the background, keeping the original if you like.',
      },
      {
        kind: 'improved',
        text: 'Dense scenes render and check collisions faster.',
      },
    ],
  },
  {
    version: '1.5.0',
    date: '2026-11-11',
    title: 'Headset assembly',
    changes: [
      {
        kind: 'new',
        text: 'Place parts in a WebXR headset with controllers or hand tracking.',
        guide: 'headset',
      },
      {
        kind: 'new',
        text: 'Share a scene between a computer and a headset on your local network with a join code.',
        guide: 'headset',
      },
    ],
  },
  {
    version: '1.4.0',
    date: '2026-11-10',
    title: 'Colors and lighting',
    changes: [
      {
        kind: 'new',
        text: 'Editor part colors with Material, Editor, and Distinct display modes. Exports keep their material colors.',
        guide: 'display',
      },
      {
        kind: 'new',
        text: 'Lighting presets, brightness, and adjustable directional and point lights.',
        guide: 'display',
      },
    ],
  },
  {
    version: '1.3.0',
    date: '2026-11-10',
    title: 'Isolation and No clip',
    changes: [
      {
        kind: 'new',
        text: 'Isolate a part, optionally keeping nearby surfaces visible and pickable.',
        guide: 'navigation',
      },
      {
        kind: 'new',
        text: 'No clip stops moves and fits at the surfaces of other parts.',
        guide: 'no-clip',
      },
    ],
  },
  {
    version: '1.2.0',
    date: '2026-11-09',
    title: 'Preferences',
    changes: [
      {
        kind: 'new',
        text: 'A Preferences panel for navigation, markers, and keyboard shortcuts.',
        guide: 'preferences',
      },
      {
        kind: 'new',
        text: 'Rebindable keyboard shortcuts.',
        guide: 'keyboard-shortcuts',
      },
      {
        kind: 'improved',
        text: 'Smooth scroll zoom with adjustable sensitivity and direction.',
      },
      {
        kind: 'new',
        text: 'Screen-sized point markers and CAD-style callouts.',
      },
    ],
  },
  {
    version: '1.1.1',
    date: '2026-11-09',
    title: 'License and links',
    changes: [
      {
        kind: 'new',
        text: 'Kitbasher is MIT licensed, with links to the source code and issue tracker in the site footer.',
      },
    ],
  },
  {
    version: '1.1.0',
    date: '2026-11-09',
    title: 'Build with an agent',
    changes: [
      {
        kind: 'new',
        text: 'An MCP server lets AI agents create, import, assemble, inspect, render, and export models.',
        guide: 'automation',
      },
      {
        kind: 'new',
        text: 'Shared live editing between an agent and several browser tabs, with merged edits and per-author undo.',
      },
    ],
  },
  {
    version: '1.0.0',
    date: '2026-11-09',
    title: 'First release',
    changes: [
      {
        kind: 'new',
        text: 'A local-first 3D workbench for importing and assembling multipart models.',
        guide: 'quick-start',
      },
      {
        kind: 'new',
        text: 'Point alignment, contact painting, flush seam fitting, rigid anchor fitting, joints, and plane constraints.',
        guide: 'alignment',
      },
      {
        kind: 'new',
        text: 'Interference inspection, editor shortcuts, clipboard commands, and context menus.',
        guide: 'inspection',
      },
      {
        kind: 'new',
        text: 'Large imports and scenes, with local recovery.',
        guide: 'importing',
      },
    ],
  },
];

export const latestRelease = releases[0];

export function compareVersions(a: string, b: string) {
  const left = a.split('.').map(Number),
    right = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] - right[i];
  return 0;
}
