# Verification

Verified locally on November 7, 2026.

## Automated checks

- `npm run build`: TypeScript checks and production compilation pass.
- `npm test`: **87 tests pass**, covering Kabsch registration, non-collinear
  point selection, reflection prevention, all four alignment methods, axis locks,
  anchor coincidence, descendant propagation, capture of the current pose when
  locking an axis, invalid joint graphs, scene round trips, mesh combination,
  manifold input checks, 3MF structure, STL up axis, undo/redo, surface contact fitting, camera
  navigation, interference analysis, standard shortcuts, and component clipboard
  behavior including joint preservation and locked-part handling. New coverage
  includes continuous transform precision, edge connectivity, seeded plane
  filters, area-weighted plane fits, all four plane relationships, multiple
  equations and dependency chains, joint conflicts, suppression, and persistence.
- `npm run test:e2e`: **46 browser tests pass** in headless installed Google Chrome.
  Exercises real gizmo dragging, numeric edit cancellation, surface picking,
  joint creation, local recovery, save/open, STL import, combination/undo,
  GLB/3MF downloads and reimports, physical scale, Boolean worker volume and
  vertex colors, narrow-screen controls, a 43,200-triangle imported mesh,
  surface painting, custom pivots, panned camera orbit, interference layers,
  Ctrl/Command selection and clipboard commands, rename, native text editing,
  keyboard context menus, surface-specific actions, and right-drag panning.
  New real-pointer tests exercise middle/Space orbit over painted models, pending
  point preservation, mid-drag Shift changes for both movement and rotation,
  interrupted gizmo cleanup, plane filter clipping, disconnected coplanar patches,
  and mate creation/editing/suppression followed by target motion and save/reopen.
- `npm run format:check` and `git diff --check`: clean.

The full suite and production build passed after the camera, precision, connected
painting, and plane-constraint update. Current browser checks use the local Vite
development server. New plane controls and constraint cards were visually reviewed
at 1440 × 1000 and 390 × 844. Browser tests assert no page/console errors or Vite
error overlay, preserve native field editing, and verify no horizontal overflow.
Context menus reposition on resize, and early right-button menus dismiss when a
surface gesture becomes a camera pan.

## Earlier native Blender verification

The joint-export verification below predates the plane-constraint update; live
painted-plane solving is native to Kitbasher and is not rebuilt in Blender.
The Blender ZIP was downloaded through the production editor's Export dialog.
Its Python script was run in **Blender 5.2.2 LTS** with factory startup. The script
created `assembly.blend`; the saved file was reopened before validation.

- All **15** mesh parts and **2** named joint pivots were restored.
- Head, torso, and power pack retained their positions at meter scale.
- Editor Y-up constraints map to Blender Z-up axes.
- Fixed locks on the display base were preserved.
- Rotating the neck pivot 37° around an unlocked test axis preserved its anchor.
  Measured anchor error was approximately **0.000000058 mm**.
- Moving the torso carried its head and joint pivot without detaching them.

Blender posing uses the named joint empty. Its local rotation axes enforce the
locks, and the mesh retains a fixed offset from that pivot. This keeps the mesh's
surface anchor connected while rotating around the joint.

## Render and interaction review

The production app was served with `npm run preview` and checked in local
Playwright-controlled Chromium. T3 preview tools are restricted to explicitly
requested browser work in this environment, so they were not used for this
implementation check. No production page or console errors were observed.

Screenshots were captured at **1440 × 1000** and **390 × 844** and inspected with
`view_image`:

- [Primary workbench](workbench.png)
- [Plane alignment against a reference plane](workbench-alignment.png)
- [Narrow-screen workbench](workbench-mobile.png)

There is no generated concept image: image generation tools were unavailable.
The reference is the [code-native design specification](design.md). The complete
workbench and alignment state were visually checked against that specification.

| Comparison           | Evidence and result                                                                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Layout               | Compact header/tool strip, 248px part tree, 286px inspector, and a real WebGL center match the intended editor shell.                                          |
| Typography           | Bundled Inter is used across menus, lists, inputs, labels, buttons, and dialogs. Numeric fields use tabular numbers. No browser-default control typography.    |
| Palette              | Dark graphite panels, subtle dividers, warm orange active controls, and mint target/constraint indicators are consistent throughout.                           |
| Geometry and framing | The original multipart robot is editable geometry, fully in frame with both feet on the display base. Multi-angle navigation and orthographic projection work. |
| Alignment state      | Actual source/target markers, a connecting line, selected method, reference plane, paired-point status, and an enabled Apply control agree.                    |
| Primary action       | The initial alignment render required scrolling to Apply. Repaired by giving settings their own scroll region and pinning Apply/Cancel below it.               |
| Responsive behavior  | Sidebars collapse into dismissible drawers; navigation and tool controls remain available. No horizontal page overflow at 390px.                               |
| Asset treatment      | No raster model backdrop or screenshot UI. Icons and chrome are code-native; model shading, grid, and orientation gizmo are rendered in 3D.                    |

Copy review found the expected File/Edit/View, Save scene/Export, parts/joints,
reference-plane, transform, and alignment labels. No unrelated marketing surface
or dashboard sections were added. No material visual mismatches remain against
the code-native specification. Native desktop installers and texture-map
preservation are outside this implementation; other functional limits are
listed in the README.
