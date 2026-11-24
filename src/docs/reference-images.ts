import type { DocImage } from './types';

/** Crops of the actual editor, captured by scripts/capture-docs-reference.mjs. */
export const referenceImages = {
  sculpt: {
    src: './images/reference/sculpt.webp',
    width: 760,
    height: 800,
    alt: 'Sculpt inspector with Draw selected, radius, strength and detail fields, symmetry, and mask controls.',
    caption: 'Choose a brush in the inspector. Its settings appear below the brush buttons.',
  },
  warp: {
    src: './images/reference/warp.webp',
    width: 1440,
    height: 1000,
    alt: 'Scout torso selected with Warp control points on its surface and Point, Line and Area options in the inspector.',
    caption:
      'After you lay the grid, select a point on the surface or add a handle with Point, Line or Area.',
  },
  fileMenu: {
    src: './images/reference/file-menu.webp',
    width: 760,
    height: 500,
    alt: 'File menu below the top-left header with New assembly, Open scene, Import parts, Save scene, Google Drive, Export assembly, and Preferences.',
    caption:
      'Open File in the upper-left corner for scene files, imports, exports, and Preferences.',
  },
  toolbar: {
    src: './images/reference/toolbar.webp',
    width: 1440,
    height: 164,
    alt: 'Header and toolbar with transform icons, Align, Contact paint, Pin, Anchors, Joint, Measure, Snap, No clip, and World axes.',
    caption:
      'Tools sit directly below the header. Snap, No clip, allowed overlap, and axes are on the right.',
  },
  placementSettings: {
    src: './images/reference/placement-settings.webp',
    width: 480,
    height: 100,
    alt: 'Right end of the toolbar with Snap off, No clip enabled, allowed overlap set to 0.1 mm, and World axes.',
    caption:
      'The millimeter field beside No clip is Allowed overlap; this example uses the default 0.1 mm.',
  },
  partsControls: {
    src: './images/reference/parts-controls.webp',
    width: 760,
    height: 790,
    alt: 'Parts panel with Torso shell selected and its eye and lock controls exposed; Power pack is dimmed and Display base has a closed lock.',
    caption:
      'Hover a part row for its eye and lock. Power pack is hidden here; Display base is locked. Reference planes sit below the list.',
  },
  cameraControls: {
    src: './images/reference/camera-controls.webp',
    width: 650,
    height: 540,
    alt: 'Expanded Camera panel in the lower-right viewport with Orbit, Pan, direction arrows, Center selection, Pick surface pivot, and Orbit selection.',
    caption:
      'Choose Orbit in the lower-right Camera panel to expose direction buttons and Center selection. Pick surface pivot is just below.',
  },
  viewMenu: {
    src: './images/reference/view-menu.webp',
    width: 760,
    height: 440,
    alt: 'Perspective menu at the top-left of the viewport showing Isometric, Front, Right, Top, Back, Left, and Toggle projection.',
    caption:
      'Open Perspective or Orthographic above the viewport to choose a named view or toggle projection.',
  },
  isolation: {
    src: './images/reference/isolation.webp',
    width: 1440,
    height: 1000,
    alt: 'Torso shell isolated with Nearby surfaces enabled, a distance field, and Exit in the isolation bar.',
    caption:
      'Isolation keeps Torso shell and the nearby contact regions visible. Use the distance field to adjust the band, or Exit to restore the full view.',
  },
  contextActions: {
    src: './images/reference/context-actions.webp',
    width: 760,
    height: 864,
    alt: 'Component actions menu opened by right-clicking Torso shell in the Parts list.',
    caption:
      'Right-click a part row for component actions. The menu uses the current selection when you right-click a selected part.',
  },
  brushSettings: {
    src: './images/reference/brush-settings.webp',
    width: 890,
    height: 864,
    alt: 'Paint brush settings menu opened in the viewport, with brush radius, paint and erase controls, Undo last paint stroke, and Stay on seed plane.',
    caption:
      'While Contact paint is active, right-click in the viewport for brush settings. Choose Done to return to painting.',
  },
  precisionControls: {
    src: './images/reference/precision-controls.webp',
    width: 760,
    height: 800,
    alt: 'Move inspector for Torso shell with World and Local axes, Step, Snap dragging, axis minus and plus buttons, and numeric transforms.',
    caption:
      'Move exposes Step and the axis −/+ buttons above the absolute Position fields. Check the axes before adjusting a value.',
  },
  referencePlane: {
    src: './images/reference/reference-plane.webp',
    width: 1440,
    height: 1000,
    alt: 'Point to plane alignment with Torso shell as the moving part and Ground · XZ as the target; the ground reference plane is visible.',
    caption:
      'Choose Ground · XZ in Target part or plane. Toggle its visibility under Reference planes in the left panel.',
  },
  navigationPreferences: {
    src: './images/reference/preferences-navigation.webp',
    width: 760,
    height: 800,
    alt: 'Preferences Navigation tab with scroll zoom sensitivity, response curve and chart, smoothing, and scroll direction.',
    caption:
      'Preferences → Navigation groups the wheel controls with a response chart so you can tune small and large scroll steps.',
  },
  markerPreferences: {
    src: './images/reference/preferences-markers.webp',
    width: 760,
    height: 864,
    alt: 'Preferences Markers tab with point and label size, Beside point and Callout choices, label spacing, and a marker preview.',
    caption:
      'Preferences → Markers controls point size and label placement. The preview shows the effect without changing the model.',
  },
  notifications: {
    src: './images/reference/notifications.webp',
    width: 680,
    height: 540,
    alt: 'Notifications panel opened from the header bell after downloading a Scout scene copy.',
    caption:
      'Open the bell to revisit completed actions and errors. This example follows a local scene download.',
  },
  backgroundActivity: {
    src: './images/reference/background-activity.webp',
    width: 680,
    height: 540,
    alt: 'Background activity panel opened from the header after an interference check on Scout.',
    caption:
      'The activity icon beside the bell opens recent jobs. This interference check has finished; cancellable running jobs expose Cancel here.',
  },
  explodedView: {
    src: './images/reference/exploded-view.webp',
    width: 1440,
    height: 1000,
    alt: 'Scout parts separated by the Explode slider at the lower-left of the viewport.',
    caption:
      'Explode separates the parts for inspection. Return the slider to 0% before measuring or evaluating an assembled join.',
  },
  refine: {
    src: './images/reference/refine.webp',
    width: 1440,
    height: 1000,
    alt: 'Refine panel in Edge mode beside a synthetic block with softened edges. An accepted edge runs along the top front edge as a solid green line, and a pending guide runs down the right front edge as a dashed line with square handles at its ends. The panel reads 1 accepted · 1 proposed.',
    caption:
      'The accepted edge is solid and the selected pending guide is dashed between its handles. Accept keeps a guide in this session; Apply saves the accepted edges to the part.',
  },
  mobilePanels: {
    src: './images/reference/mobile-panels.webp',
    width: 640,
    height: 900,
    alt: 'Narrow Kitbasher workbench with panel toggles at the ends of the toolbar and the Scout model in the viewport.',
    caption:
      'On a narrow window, the toolbar’s left panel button opens Parts and the right panel button opens the inspector.',
  },
} satisfies Record<string, DocImage>;
