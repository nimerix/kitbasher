# Verification

Verified locally on November 11, 2026.

## Automated checks

- `npm run build`: TypeScript checks and production compilation pass.
- `npm test`: **655 tests pass**, covering Kabsch registration, non-collinear
  point selection, reflection prevention, all four alignment methods, axis locks,
  anchor coincidence, descendant propagation, capture of the current pose when
  locking an axis, invalid joint graphs, scene round trips, mesh combination,
  manifold input checks, 3MF structure, STL up axis, undo/redo, surface contact fitting, camera
  navigation, interference analysis, standard shortcuts, and component clipboard
  behavior including joint preservation and locked-part handling. New coverage
  includes continuous transform precision, edge connectivity, seeded plane
  filters, area-weighted plane fits, all four plane relationships, multiple
  equations and dependency chains, joint conflicts, suppression, and persistence.
  `tests/unit/regressions.test.ts` adds lossless compact scene numbers, retained
  normals, typed-array recovery, reopenable subset exports, mirrored STL facets,
  geometry disposal, and projection-preserving camera transfer.
  `tests/unit/preferences.test.ts` covers key matching across layouts, Alt, Shift-implied
  symbols, and Num Lock off, binding capture and conflicts, stored preference validation,
  wheel zoom response, pinch, smoothing that lands, and callout placement and stacking.
- `npm run test:e2e`: **118 browser tests pass** in headless installed Google Chrome.
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
  `tests/e2e/regressions.spec.ts` covers hidden-part picking, camera stability across
  resize and projection changes, keyboard activation of focused controls, retained
  paint and pick work, undo history, menu dismissal, and the crash recovery screen.
  `tests/e2e/preferences.spec.ts` checks that the non-modal Preferences panel leaves the
  viewport zoomable, that wheel zoom glides and follows sensitivity and smoothing, that a
  rebound key works, updates labels, survives a reload, and resets, and that markers keep
  their pixel size while callouts stay straight above their point through an orbit.
  `tests/e2e/isolation.spec.ts` presses I and Shift + I on real parts and reads viewport
  pixels. Other parts disappear and cannot be clicked, while the scene, its history, and part
  visibility stay untouched. A neighbor is drawn only within the distance, as the distance
  changes and as the isolated part moves, without measuring the field again. Nearby surfaces
  take clicks and alignment picks and cut-away ones do not, also through a cut seen from
  behind, and a part too far away to be drawn offers no gizmo. The menus, isolation bar,
  framing, interference view, and deleting the isolated part all follow, and a
  1.2-million-triangle part is isolated with nearby surfaces without holding the viewport.
  `tests/e2e/large-scenes.spec.ts` round trips a 3-million-triangle scene and checks
  that autosave writes each mesh once, survives failed writes, and upgrades old saves.
  `tests/unit/scene-format.test.ts` covers the binary layout and damaged or crafted files, and
  editor colors and lighting: exact round trips, saved selections, scenes from before them, and
  partly invalid lighting that opens repaired.
  `tests/e2e/large-imports.spec.ts` imports an OBJ of the size that used to crash the tab and a
  text STL past the browser's string limit, and checks that a dense mesh stays usable while
  picking is prepared in a worker. `tests/unit/model-readers.test.ts` compares the streaming OBJ
  and STL readers against three.js's loaders, value for value.
  `tests/unit/import-limits.test.ts` covers each import and export limit.
  `tests/unit/isolation.test.ts` compares the nearby-surface distance field with exact mesh
  distances for coarse, dense, thin, turned, stretched, mirrored, and sliver-heavy meshes, and
  checks that a surface in contact always reads below the drawing limit, also on a part far
  larger than the distance. It covers the grid limits, the field following parts that move
  together, isolation leaving the scene and its history untouched, parts that leave or join
  the isolated view, the two commands, and a rebound key staying with its action.
  `tests/unit/appearance.test.ts` covers the color shown in each mode with and without an editor
  color, vertex colors, and a distinct color, distinct colors that follow scene order and stay
  apart, an OKLCh conversion that always lands in gamut and cannot loop, and part swatches that
  sample a mesh's main vertex colors.
  `tests/unit/lighting.test.ts` checks that Studio matches the editor's original fixed lights,
  preset matching, sanitizing (clamping, per-field fallbacks, dropped and repeated lights, the
  8-light limit, unknown fields), adding and removing lights, azimuth and elevation round trips,
  converting a light between world and camera frames, and the saved default with damaged or unavailable storage. `tests/unit/editor-appearance.test.ts`
  covers editor colors and lighting in the store as undo steps, a drag as one step, and the
  default lighting. It also checks that baked vertex colors, Combine, merges, STL, 3MF, GLB, and
  the Blender package come out identical with and without editor colors, and that GLB carries no
  editor colors or lighting.
- `npm run format:check` and `git diff --check`: clean.

The production build was also served from a `/kitbasher/` subpath, and both the
Boolean and inspection workers, fonts, and favicon loaded without errors. It was then
opened over plain HTTP on a LAN address, where `isSecureContext` is false and
`crypto.randomUUID` is absent. Duplicate, import, autosave, and recovery all worked. The
worker that prepares dense meshes for clicking was checked in the same two setups: it loaded
without errors, and a click selected a 1.2-million-triangle part.

The full suite and production build passed after the camera, precision, connected
painting, and plane-constraint update. Current browser checks use the local Vite
development server. New plane controls and constraint cards were visually reviewed
at 1440 × 1000 and 390 × 844. Browser tests assert no page/console errors or Vite
error overlay, preserve native field editing, and verify no horizontal overflow.
Context menus reposition on resize, and early right-button menus dismiss when a
surface gesture becomes a camera pan.

## MCP server

`tests/unit/mcp/` compares every shape with its analytic volume and checks that it stays closed
through any placement. It covers each session operation, including all-or-nothing calls, joints,
plane constraints, Booleans, every import and export format, renderer pixels, and the protocol
through a real client, with every tool reached. It also tries the live view's refusals: other host
names, a missing token, and paths outside the app. `tests/e2e/mcp.spec.ts` starts the built server
over real stdio, opens a saved scene in the app, and follows live edits in Chrome. It checks that
each mesh is fetched once, that autosave is left alone, and that the server exits with its client.

Shared editing: `tests/unit/sync.test.ts` covers merging by part and by field, conflicts, removals,
joints reseated after a merge, and undo steps that leave others' later values. It also covers editor
colors and lighting: merging by setting, conflicts, undo, and staying out of what the agent is told.
`tests/unit/mcp/shared.test.ts`
drives the live view's HTTP protocol against a real MCP client: stale and conflicting edits, refused
joints that change nothing, mesh uploads and bad meshes, per-author undo, one undo step per drag, and
a scene replaced from a tab. In Chrome, two tabs and the agent edit one scene: an edit in either tab
reaches the other and the agent, orbiting and zooming send nothing, undo in a tab and the agent's
`undo` each revert only their own change, and a model imported in a tab uploads its mesh once.

Two real clients each built a stool from one prompt, through the built server, with no tool errors:

| Client              | Model                        | Result                                             |
| ------------------- | ---------------------------- | -------------------------------------------------- |
| Claude Code 2.1.319 | `claude-haiku-5-5`           | All 26 tools listed. 5 parts, checked and saved    |
| Codex CLI 0.167.0   | `gpt-6.1-sol`, low reasoning | 5 parts, checked and saved, in a read-only sandbox |

Each was asked for the scale bar's text in the image it rendered, which no tool result states.
Both answered `100 MM`, which matches the image, so the render does reach the model. Both saved
files reopened through the server with correct dimensions and no isolated parts. Codex ran with
`approval_policy = "never"` and `default_tools_approval_mode = "approve"`. Its interactive approval
prompts were not exercised.

## Headset

Checked with Meta's Immersive Web Emulation Runtime 2.8.0 standing in for a Quest 3, its
controllers, and its hands, in headless installed Google Chrome. **It has not been run on a
physical headset.** Frame rate there, the time a held part takes to stay clear of others, how
far a shared scene keeps up over Wi-Fi, and how the controls feel in the hand are all unmeasured.
The panel in the headset reports the first two.

`tests/unit/xr.test.ts` covers the room's place in the scene: a new view set ahead of the
viewer, upright and facing the model's front from any heading, also when looking straight
down; one hand carrying the point it holds; two hands keeping hold of both points when free to
tilt, and of the point between them when kept level; the magnification limits; resizing and
levelling about a point that stays put; and a held part moving as far as the hand and turning
about the point it was taken by.

`tests/e2e/headset.spec.ts` drives the emulator through the real app. The button appears only
where the browser has a headset. A session sets the model 0.55 m ahead and 0.25 m below the
eyes, and leaving returns the viewport's camera, field of view, clipping planes, orbit
controls, and background exactly. A part taken by touch moves with the hand as one undo step,
stops at another part within the allowed overlap, and passes through once No clip is turned
off on the panel. A part taken from 0.3 m away moves as far as the hand and turns about the
point it was taken by. One hand carries the world, two resize it by the ratio of their spread,
and Keep level decides whether they can tip it. A locked part holds the world. A pinch with a
bare hand takes a part. The panel's buttons work by ray, the panel moves by its background,
and B brings it back. A scene that replaces the one in view is set before the viewer again.
In your room draws no background, and restores it on leaving.

`tests/unit/mcp/sharing.test.ts` covers the network listener: the page that asks for the code,
the scene's address given only for the right code, nothing else served without that address,
the code replaced after five wrong ones and counted afresh after a right one, oversized and
malformed codes, other host names refused, the loopback listener left without a way in by
code, and the code sent only to tabs on the computer.

`tests/e2e/headset-session.spec.ts` starts the built `kitbasher-headset.js` with its own home
folder. A tab on the computer shows the address and code. An emulated headset in a separate
browser context opens the network address over the self-made certificate, is refused a wrong
code, joins with the right one, enters the headset view, and moves the sample's left arm by
hand. The tab on the computer shows the arm 30 mm of hand travel away, with nothing of its
own to undo.

The emulated headset's view was captured and inspected: the panel's text and switches, the
beam and tint on a part pointed at, a part held from a distance with its connected assembly,
the scale readout between two hands, and the desktop viewport before and after a session,
which match.

With the hand 15 mm past a wall in the scene's millimeters and sliding along it at 1 mm a
frame, a held block trailed the hand by about 5 mm, and closed to within 0.02 mm in 30 frames
once the hand stopped. On the sample, lifting the head carried the torso and power pack with
it, and a twist of the wrist turned the head about its neck joint alone.

## Part colors and lighting

`tests/e2e/appearance.spec.ts` reads viewport pixels in Chrome. An editor color paints only its
part, leaves the material tint alone, and clears again. Distinct tells apart parts of one material
color, an editor color wins over it, Material hides both, and the mode and editor colors come back
after a reload. A GLB export has material colors and no editor colors or lighting. Brightness and a
positioned point light brighten the view, undo steps back through them, a saved scene keeps its
lighting and editor colors, and Reset to default returns to the default. Clicking a light handle
picks that light without changing the part selection, also with a part behind the handle, and
closing the panel removes the handles.

The checks below were run once in Chrome with Playwright scripts kept outside the suite, against
the Vite development server.

- With the default lighting, the sample robot was compared with the previous version at
  1440 × 1000. Of 288,000 pixels around the robot, 455 differed by more than 4 levels, at most
  19 of 255, all on self-shadow edges from the refitted shadow map. With the torso moved in both
  versions the difference stayed at most 22 of 255, so the ground shadow still follows the parts.
- Switching between Material, Editor, and Distinct renders the same pixels as loading in that
  mode. Turning shadows off and on with light handles shown gives an identical image, so handles
  stay out of the ground shadow.
- Dragging the key light's arrow 60 pixels moved it 22.83 mm as one undo step; with Shift it
  moved 2.28 mm. Undo restored the default lighting.
- The ground contact shadow matched the previous version at the origin (equal mean luminance in
  a band under the sample's base) and, unlike the previous version, still showed with the whole
  sample moved 260 mm in X and 140 mm in Z.
- With the lighting panel open, the active light's gizmo showed with the Select tool and gave way
  to the part gizmo with the Translate tool.
- Shadows stayed fitted with the sample scaled to 0.01× and 50×. The Headlight, Soft, and
  Dramatic presets rendered without errors, and the headlight followed the camera to the back
  view.
- In the panels, each slider or color-picker drag was one undo step, turning a directional
  light kept its distance, Add was disabled at 8 lights, undoing an added light selected the
  first, and Escape in a text or number field did not close the panel. Use as default, Restore
  built-in default, and Reset to default each showed and hid as expected. The display menu
  moved focus to the checked mode, changed it with arrow keys, and returned focus to its button
  on Escape. The inspector's editor color left the material color untouched and applied to every
  selected part.
- The panel and display menu were reviewed at 1440 × 1000, 1024 × 768, 700 × 800, and 390 × 844.

## Large scenes

Measured once in headless Chrome on an Apple M4 Max with 36 GB of memory, using a
real profile that can page blobs to disk and the real GPU (`ANGLE Metal Renderer: Apple M4 Max`).
Mesh contents were compared by checksum after each round trip and were identical. These sizes
are too large for the regular test suite. Firefox and Safari were not tested. The parts in
this first table were hidden, so it measures file handling alone.

| Scene                   | Operation                 | Time  |
| ----------------------- | ------------------------- | ----- |
| 60M triangles, 4.03 GiB | Save scene                | 5.4 s |
| 60M triangles, 4.03 GiB | Open scene                | 4.7 s |
| 30M triangles, 2.0 GiB  | First autosave            | 3.3 s |
| 30M triangles, 2.0 GiB  | Autosave after an edit    | 0.5 s |
| 30M triangles, 2.0 GiB  | Reload and recover        | 2.7 s |
| 3M triangles, shown     | Longest main-thread stall | 0.4 s |

The largest buffer in the first two rows was 2.01 GiB. Before the binary format, a
3-million-triangle scene could not be saved at all. With a 5-million-triangle scene, STL
exported in 0.5 s and GLB in 1.1 s, while 3MF reported its text limit after 15 s.
A private window reported a clear error for a 2.7 GiB scene.

### Imports

Each file was imported through the dialog in a fresh browser, then framed and orbited in view.
"Longest stall" is the longest main-thread task up to the end of the import.

| File                          | Triangles | Import | Longest stall | Clickable after | Orbit  | Peak memory |
| ----------------------------- | --------- | ------ | ------------- | --------------- | ------ | ----------- |
| Binary STL, 1.1 GiB           | 24M       | 1.6 s  | 0.4 s         | 2.5 s           | 60 fps | 5.0 GiB     |
| OBJ, 1.9 GiB                  | 48M       | 13.5 s | 1.4 s         | 8.2 s           | 30 fps | 6.9 GiB     |
| Binary STL, 2.8 GiB           | 59M       | 4.5 s  | 1.6 s         | 10.6 s          | 30 fps | 6.9 GiB     |
| GLB, 3.4 GiB (indexed)        | 150M      | 7.4 s  | 2.7 s         | parts list only | 30 fps | 6.9 GiB     |
| 3MF, 61 MiB (478 MiB of text) | 7M        | 28.5 s | 26 s          | 0.5 s           | 60 fps | 5.9 GiB     |

Before this work, a 405 MiB OBJ crashed the tab, a 636 MiB OBJ reported that it held no meshes
(`TextDecoder` returns an empty string past 512 MiB instead of failing), and a 1.1 GiB STL held
the main thread for 5.6 s. A 64-million-triangle STL is now refused in 0.03 s, before it is read;
`bufferData` otherwise rejects it with `size more than 32-bit`, and the part silently does not
draw. A 24-million-triangle STL and a 50-million-triangle GLB were each taken through import,
autosave, reload, save, and reopen. Their checksums stayed identical, and clicks selected the
right part at every stage.

### Tools on dense meshes

| Tool            | Triangles | Result                                                  |
| --------------- | --------- | ------------------------------------------------------- |
| Contact paint   | 5M, 10M   | Works. First stroke holds the main thread 5.9 s, 12.6 s |
| Contact paint   | 24M       | Refused immediately. Previously 22 s, then no paint     |
| Boolean union   | 5M, 10M   | Manifold check holds the main thread 6.2 s, 14 s        |
| Boolean union   | 24M       | Refused immediately. Previously failed in the check     |
| Combine         | 24M, 48M  | Works. Holds the main thread 7.3 s, 14.6 s              |
| Interference    | 24M       | 20 s in its worker. Reports a partial analysis          |
| STL export      | 48M       | 7.5 s, 2.29 GiB. Header matches the file size           |
| GLB export      | 24M       | 6.9 s, 1.6 GiB                                          |
| GLB export      | 30M       | Refused immediately. Previously never finished          |
| Blender package | 24M       | 9.3 s, stored uncompressed. Previously 30 s, 25 s held  |
| 3MF export      | 2M        | Works. Holds the main thread 11.2 s                     |
| 3MF export      | 3M        | Fails with a clear error after 9.6 s                    |
| 3MF export      | 24M       | Refused immediately. Previously took 24 s to fail       |

Isolating a part with nearby surfaces measures a distance field around it once. Each row is
three runs in headless Chrome on the same machine, timed from the key press until the nearby
surfaces were drawn. The work is sliced, so the viewport keeps drawing throughout.

| Isolated part  | Triangles | Nearby surfaces drawn after | Longest gap between frames |
| -------------- | --------- | --------------------------- | -------------------------- |
| Sample torso   | 3.2K      | 0.17 to 0.26 s              | 0.05 s                     |
| Unindexed scan | 1.2M      | 0.26 to 0.31 s              | 0.05 s                     |
| Unindexed scan | 10M       | 0.67 to 0.68 s              | 0.05 s                     |

The GLB exporter's limit was located by bisection: 2,036 MiB of output works and 2,060 MiB does
not. Preparing a mesh for clicking took 19 s at 120 million triangles and failed at 150 million
with `Array buffer allocation failed`.

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
