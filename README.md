<img src="assets/kitbasher.svg" width="64" height="64" alt="Kitbasher">

# Kitbasher

A local-first 3D workbench for assembling multipart models and scanned miniatures.
Runs in modern WebGL browsers on Windows, macOS, and Linux, with a responsive
layout for tablets and smaller screens. Work locally without an account, or connect
Google Drive for automatic cloud saves.

## Run

Requires Node.js 22.12 or newer and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, usually http://localhost:5173.

```sh
npm run build        # TypeScript checks, static production build, and MCP server
npm run preview      # Serve the production build locally
npm run headset      # Share a scene with a headset on your network
npm test             # Geometry, constraints, scene and export tests
npm run test:e2e     # Interaction and WebGL tests in installed Google Chrome
npm run test:e2e:drive # Drive autosave UI tests with mocked Google services
npm run format       # Format source and tests
```

Deploy the `dist/` directory to any static web host, at the site root or under a
subpath such as a GitHub Pages project site. It also runs over plain HTTP on a local
network, for example when testing on a tablet. Fonts and application assets are
bundled locally. This is a browser application; native desktop installers are not
included.

## Privacy

The website's [Privacy Policy](public/privacy.html) explains local processing,
browser storage, Cloudflare hosting, and optional Google Drive and shared sessions.
It is available at `privacy.html` in the production build. Keep hosting analytics
and tracking disabled to preserve the policy's no-tracking commitments, and update
the policy before changing data handling or adding third-party services.

## Assemble

The initial workspace contains **Scout · MK.04**, an original 15-part robot.
Every visible piece is actual editable mesh geometry. Use **File → New assembly**
for an empty workbench or to reload the sample.

1. Drop STL, OBJ, GLB, embedded GLTF, or 3MF files into the editor. Source units
   and up axis can be overridden. Automatic mode uses meters / Y up for glTF,
   millimeters / Z up for STL and OBJ, and declared 3MF units / Z up.
2. Select parts in the viewport or the searchable part tree. Shift-click selects
   several parts. Move, rotate, and scale using gizmos or numeric fields. Snapping
   supports 0.1, 0.5, 1, and 5 mm translation increments and 15° rotation steps.
   Hold **Shift** during a gizmo drag for one-tenth movement, rotation, or scale
   sensitivity. Press or release it mid-drag without jumping; the whole drag is
   one undo step.
   Gizmos sit on the visible geometry, including scans with distant scanner
   origins. Press **P** (or **Pick surface pivot** in the Camera panel), then click a
   spot on a model to set its rotation, scale, and orbit pivot. A visible marker
   follows the part. **Reset custom pivot** returns to the mesh center. Custom
   pivots are undoable and survive scene save, recovery, and reopen; active joints
   retain their own rotation anchors. Numeric rotation and scale use the same
   pivot. Imports rebase each mesh around its center while preserving the original
   world placement.

   Use the **Camera** controls in the viewport for **Orbit (O)** and **Pan (H)**.
   In either mode, left-drag anywhere or use the directional buttons; **Esc**
   returns to editing without clearing picked alignment pairs. One-finger touch
   gestures use the active camera mode; two fingers pan and zoom.
   **Orbit selection** uses the selected part's custom pivot, or the visible center
   of the selected parts, whenever you orbit. This preference starts on and is
   saved in this browser.
   Toggle it in the camera controls or with **Shift + .**. Press **.** (also numpad
   decimal) to center the orbit on the selection once, keeping the current zoom
   and view direction. **F** frames the selection; **Home** frames everything.
   Camera tools work with perspective and orthographic views. Panning moves the
   camera freely. Orbiting then carries the panned view around the selection without
   snapping it back to the center. This also works with clicked custom pivots and
   the directional buttons; only explicit centering or framing recenters the view.

   **Anchors (K)** provides fine rigid fitting for imperfect scanned interfaces.
   Select a moving part, click **Add anchors on surface**, and place three points
   around the interface. Click **Finish adding anchors**, select a numbered target,
   and drag its XYZ handle, or edit its world coordinates in 0.01 mm increments.
   Hold **Shift** while dragging for 10× finer movement; the existing Snap and
   World/Local settings also apply. One or two anchors work too, retaining the
   current orientation wherever the points do not determine it.

   All targets participate equally in a best fit. Moving one target leaves the
   other targets fixed, while the part translates and rotates to minimize the
   combined gaps. A reachable adjustment can pivot around the other anchors;
   incompatible targets leave residual gaps rather than stretching the mesh.
   Numbered circles mark targets, surface dots mark actual attachment points,
   and connecting lines and per-anchor millimeter values show the difference.
   Existing joints, locked parts, and retained plane constraints remain
   authoritative. **Hold current positions** resets all targets to the achieved
   placement for another adjustment. Anchors are undoable, each drag is one undo
   step, and anchors survive scene save/recovery/reopen. Other transform tools
   leave their world targets unchanged; use **Hold current positions** to rebase
   after moving the part with those tools. **Esc** leaves anchor editing while
   keeping the anchors and adjustments.

3. Choose **Align** and a method. Click a source surface and its matching target.
   Targets can be another part or a world reference plane:
   - **Point to point:** translate the picked point to the matching target.
   - **Point to plane:** project onto the picked target plane along its normal.
   - **Plane to plane:** orient by face normals and seat the picked points.
     Opposing normals and a positive outward surface offset are available.
   - **3+ point fit:** alternate source and target picks for any number of
     non-collinear matching pairs (at least three). Keep clicking to add a fourth,
     fifth, or more; there is no three-pair cap. The inspector numbers every pair,
     shows a pending source, supports removing individual pairs, and previews the
     RMS error of the result. Every completed pair contributes to the fit; scale
     stays unchanged. Finish or clear a pending source before applying.

   **Contact paint (B)** also opens the surface-paint method directly. Select the
   moving part and target, paint a moving patch, choose **Next: paint target**, and
   paint the matching contact area. Finish the pair, add another, and repeat for
   at least three complete pairs. There is no fixed limit on the pair count.
   Brush radius is in millimeters; **[ / ]** resize it, **Erase** or **Alt** removes
   paint, and **Undo last paint stroke** (also Ctrl/⌘ Z) restores the last stroke.
   **Right-click** in the viewport opens brush settings for radius, paint/erase,
   stroke undo, and seed-plane limits. Changes also update the inspector; click
   **Done**, press **Esc**, or click outside to continue painting.
   **Middle-drag** or hold **Space** and left-drag to orbit while keeping the paint
   tool and all picks. **Right-drag** pans and the wheel zooms. These gestures also
   work during point alignment. **O** / **H** select persistent camera tools;
   **Esc** returns to the alignment workflow.

   Each painted patch grows through shared mesh edges and stays contiguous,
   including across separate strokes. Nearby disconnected coplanar surfaces are
   excluded. Erasing a bridge keeps the seeded component, or the largest remaining
   component if the seed was erased. Use a separate pair for each disconnected
   contact area. Enable **Stay on seed plane** to limit face angles and distances
   from the patch's first hit with tolerances in degrees and millimeters. Clear
   the patch to start with a different seed plane.

   **Fit contact surfaces** seeds a rigid fit from the patch centers and normals,
   then refines symmetric closest-surface matches within each numbered pair.
   Samples are distributed by surface area, with opposing normals by default.
   Paint marks whole mesh triangles, so brush detail follows mesh resolution.
   Contact RMS measures sampled distances to the actual matching painted surfaces,
   after joint constraints. This is a local fit; spread pairs around the join to
   distinguish similar or symmetric surfaces. It preserves scale and does not
   deform the scan. With [No clip](#avoid-clipping) on, the fit stops at the surfaces
   of other parts. Unfinished pairs must be
   completed or removed before fitting.

   **Paint flush:** press **B**, then choose **Paint flush · across seams** in
   **Surface relationship**. Choose the moving part and drag from its outer
   surface across a gap onto the neighboring part. The stroke automatically
   paints both sides, without a separate target-paint step. With the moving part
   chosen, strokes can also start on the neighbor. Use **Add seam** for every
   additional connection you want to keep aligned; each seam can reference a
   different stationary neighbor. Repaint either side to extend it, or use
   **Alt / Erase** and stroke undo to revise it.

   Flush fitting balances all painted regions in one rigid rotation/translation,
   matching local surface-plane height and outward normal direction rather than
   pulling patch centers together. Free sideways spacing is preserved, and a
   small motion penalty favors minimal corrections. This is a local adjustment,
   limited to 30° from the starting orientation. Paint small, locally flat areas
   near the seam; broad curved areas only supply approximate fitted planes.
   The cyan ghost previews the result without moving the original geometry.
   Per-seam height and tilt errors, plus overall height RMS / maximum tilt,
   describe the achieved fit. Conflicting seams or existing constraints can
   leave a compromise; residuals above 0.05 mm or 1° are flagged, not called exact.

   **Apply flush fit** makes one undoable edit. All painted neighbors stay fixed,
   and existing joints, locked parts, and retained plane constraints remain
   authoritative. Connected descendants may follow the moving part. Unpainted
   connections without joints or constraints are not automatically protected.
   This does not scale, deform, weld, or fill gaps. Painted
   regions are temporary and reset on apply, cancel, or switching into/out of
   flush mode; the applied transforms are saved normally with the scene. Use
   retained plane constraints or joints for relationships that must persist
   through future edits.

   For coarse placement, choose a **Surface relationship** using one or more
   complete painted pairs. Planes are fitted across each patch by triangle area,
   so dense scan tessellation does not bias the orientation:
   - **Mate planes:** match the normal direction and seat the moving plane at a
     signed offset. Sliding in the plane and twisting around its normal remain free.
   - **Parallel:** orient the normals in the same or opposing direction.
   - **Perpendicular:** set a 90° angle between the normals.
   - **Angle:** set an explicit 0–180° normal angle.

   The angle-only methods rotate around the painted moving patch and leave its
   position free. Turn on **Keep constraint active** to retain these relationships
   through moves, rotations, and later alignments. The **Constraints** tab lets
   you rename, edit, suppress, or delete them and inspect their residual errors.
   Targets drive moving parts; multiple compatible plane equations can reduce
   the remaining movement freedom. Joints and fixed part locks also apply. A
   conflicting or circular relationship produces an error and keeps the previous
   scene. Suppress a constraint to position the part freely.

4. Choose **Joint**, pick moving and target anchors, and choose rotation locks.
   **Keep connected** is available when creating the joint and in the child
   part's **Connections** inspector:
   - **On:** rotation and scale pivot around the joint anchor; chosen rotation
     axes remain locked. Translating a child carries the connected assembly.
     A fixed connected part pins translation, while free hinge rotation remains
     available. Moving a parent carries its active descendants.
   - **Off:** parts move, rotate, and align independently. Anchors and rotation
     lock settings are retained. Turning it back on seats the child at its parent
     anchor in its current orientation. The toggle and transforms are undoable.
     Alignment works with active joints. It keeps anchors connected, applies axis
     locks, and holds the target stationary; connected parts may move with the source.
     The displayed RMS measures the achieved result, including constraint limits.
     If a fixed anchor prevents an exact fit, the result is labeled constrained.
     Locking a free rotation axis captures the current pose. Numeric rotation uses
     joint axes for connected parts. A part can have one parent; cycles are prevented.
5. Multiselect parts and **Merge**. **Combine meshes** preserves triangles and
   vertex colors in one object. **Boolean union** fuses overlapping volumes in a
   worker, first checking for open/non-manifold edges. Both are undoable.

World reference planes, wireframe, an exploded view, distance measurement,
orthographic views, framing, [isolation](#isolate-a-part), visibility, and fixed part locks
are included.
Larger meshes use BVH-accelerated picking; rendering pauses when the view is idle. Above
100,000 triangles, picking is prepared in the background: the mesh draws and can be selected
in the parts list straight away, and can be clicked when the status bar notice clears.

## High-poly scans

**Display → Scan detail** defaults to **Automatic**. Scans with at least 100,000 triangles
get a lightweight display mesh in a background worker. While moving the camera or parts, and
throughout a VR session, the viewport uses that mesh. At rest on desktop it returns to the
original. **Fast** keeps lightweight meshes visible; **Full** disables them. Proxies target
50,000 triangles with an approximate 0.2% size error limit; topology and borders can prevent
that target. VR shares an approximate 300,000-triangle display budget across visible parts,
choosing lower proxy targets for larger assemblies while keeping the same error limit.
The headset readout shows drawn and source triangle counts when they differ. Originals remain
visible while processing or if a proxy cannot be built.

These meshes are display-only. Picking, No clip, mating, anchors, saved scenes, and exports
use the original geometry. Desktop surface tools, wireframe, and interference inspection draw full
detail. Dense scenes also omit shadow passes while moving. These measures reduce rendering
and contact work but do not guarantee a headset frame rate, especially in large assemblies.
Collision checks reject distant parts by their bounds before building or querying surface
indexes. Repeated moves reuse transforms and proven exterior clearance; no contact samples
are removed by this cache. Stationary viewport meshes also skip React work during another
part's movement. Index jobs stop when their source mesh is disposed.

To profile the synthetic dense-contact and cold-start scenarios, run
`KITBASHER_BENCH=current npx vitest run tests/unit/scan-benchmark.test.ts`.
Results are written to `kitbasher-performance/current.json` under the OS temporary directory.
These CPU measurements are separate from physical-headset FPS.

Select one unlocked part, then choose **Mesh details → Decimate or remesh…** in the inspector
to change geometry explicitly:

- **Decimate** reduces triangles toward a percentage target within an approximate error limit
  expressed as a percentage of mesh size. Open borders are preserved by default. Vertex colors
  are retained, but this is not a guarantee that a precision mating surface remains unchanged.
- **Voxel remesh** rebuilds a closed, manifold mesh at a resolution of 24–128. It can remove thin
  details and change mating surfaces. Vertex colors are removed; material tint remains.

**Prepare mesh** processes in a worker and reports the actual triangle count before applying.
Cancel stops the worker. By default, applying creates an independent part in the same position
and keeps the original hidden in the parts list. Parts with anchors, joints, or constraints
always use this copy workflow, retaining those links on the original. Undo restores the entire
change in one step. Hidden originals remain in saved scenes and in exports scoped to all parts;
choose visible or selected parts to export only the processed result.

## Isolate a part

Press **I** to draw only the selected parts, and **I** again to show everything. The isolate
button beside the zoom controls, **View ▸ Isolate selected**, and the context menu do the
same. Isolation changes the view and nothing else. It is not saved, undone, or shared, and
part visibility is untouched. The other parts stay in the assembly, so
[No clip](#avoid-clipping), joints, and constraints still act on them.

- Select another part in the Parts panel and press **I** to move the isolation to it. With
  nothing new selected, **I** exits. Parts outside the isolated view are dimmed in the list.
- **Frame all** (Home) frames the isolated parts, and the interference view compares only
  them. Parts you paste, duplicate, import, or merge while isolating join the view.
- **Hide others** in the context menu is the lasting version. It changes part visibility in
  the scene, is undoable, and affects exports of visible parts.

**Nearby surfaces** keeps the surroundings of the isolated part in view. Press **Shift + I**,
or use the switch in the bar at the top of the viewport, to also draw the other parts
wherever their surface comes within a set distance of an isolated part. **I** always starts
without them, and the switch stays as set while you move the isolation between parts. The distance is in
millimeters, 2 by default and up to 200. Everything farther is cut away, so a socket, seam,
or mating face stays visible around the part you are fitting, without the rest of the model
in the way. A cut-away part is drawn on both sides, because its facing surface is often seen
from behind.

- The cut follows the part as you move, rotate, or fit it, and follows its neighbors as they
  move, with no delay, including on dense scans.
- Nearby surfaces can be clicked, picked for alignment, joints, and measurement, and painted.
  Cut-away surfaces cannot, and a click passes through them to whatever is drawn behind.
- Distances are read from a grid around the isolated parts with cells about a hundredth of
  their size, 0.4 mm for a 40 mm part. The cut is accurate to about one cell, and the
  tooltip on the distance shows the size. A surface in contact always shows, even with the
  distance at 0.
- The grid is measured once, when you isolate, without holding the viewport. In testing it
  took about 0.2 seconds for a simple part and 0.7 seconds for a 10-million-triangle scan.
  It is measured again when the isolated parts, their scale, or the range of the distance
  change.
- Nearby surfaces pause in the exploded and interference views.

## Avoid clipping

**No clip** in the toolbar keeps parts from passing through each other, the way physical
pieces cannot. It starts on, is saved in this browser, and applies to every move and fit:

- **Dragging** a move, rotate, or scale gizmo, or an anchor target, slides the part along the
  surfaces it meets instead of pushing into them. It never jumps through a thin part,
  however fast the pointer moves. Turning or scaling a part against another shifts it clear.
  A dragged part can trail the pointer briefly on dense scans and settles when you release.
- **Typed values** and every **alignment** (point, plane, 3+ point, contact fit, flush fit,
  plane relationships) and **anchor fit** land on the nearest placement to the request that
  stays clear. The preview, residuals, and RMS describe that achieved placement, and a note
  says how far it moved and which parts were in the way.

The field beside the toggle is the **allowed overlap** in millimeters, 0.1 by default and up
to 5. Parts may sink into each other by that much and no farther, which lets imperfect
scanned interfaces seat, like fitting with a file. Raise it for rough scans or a snug socket;
set it to 0 for hard contact.

- Every visible part is solid, including locked ones. **Hide a part** to work through it, for
  example parts still piled where they were imported.
- Overlap that already exists is never forced apart by a drag or a typed move, and can
  always be pulled out, but cannot be pushed deeper. An alignment or anchor fit is a fresh
  placement, so it does clear existing overlap.
- Jointed parts may keep the overlap they have around their anchor, like a ball in a
  socket, so they still pose freely. The rest of the part stops at its parent.
- Joints, locks, and kept plane constraints stay authoritative. When one of them, or a fit
  tighter than the allowance, holds parts together, the result says how much overlap remains.
- Creating a joint or editing a kept constraint seats parts exactly as asked, without this check.

Contact is measured from about 3,000 points spread evenly over each part, plus the edges of
coarse meshes, against the exact surface of the other part. Features much finer than that
spacing, or thinner than twice the allowed overlap, can slip through. Open scans block from
both sides, except within a hair of their open rim. Meshes above 100,000 triangles join in
once they are prepared for clicking. Until then, No clip holds nearby moves at their current
position; moves in open space remain available. Retry a held move when preparation finishes.
This does not replace
[interference inspection](#inspect-contact-and-interference), which measures exact overlap volume.
During a dense-mesh drag, a smaller set of about 256 original-surface samples reduces contact
work. Releasing the part checks the placement with the full sample set. Very thin details can
still evade sampling; use interference inspection for the final fit.

## Inspect contact and interference

Click **Interference** beside the projection selector to inspect the assembled
positions. The view shows **red solid overlap volumes** and **amber surfaces near
another part**. Set **Within distance** in millimeters and press Enter or leave the
field to update the band. For example, 0.5 mm highlights surfaces no more than
about half a millimeter from the other part's surface, including near an interface.

- Compare **All visible parts**, or select two or more parts and choose
  **Selected parts (2+)** to focus on their interfaces.
- Toggle **Solid overlap** and **Nearby surfaces** separately. Turn off **Show
  surrounding parts** to isolate the inspection geometry.
- **Closest-point markers** show the nearest pair of surface points and their gap
  for every pair within the distance threshold.
- Part movement, alignment, undo/redo, and visibility changes update the analysis.
  Superseded analysis is canceled and its old overlays are cleared. Camera tools
  remain available; the inspection panel can be collapsed for more viewport space.

This inspection preserves the editable source meshes and scene history. It uses a
background worker, with a short pause after dragging before recalculating. The
near-surface band is an adaptive sampled estimate; its approximate detail is shown
in the panel. A detail budget prevents extremely dense contact bands from growing
without bound and is explicitly reported if reached. Solid overlap uses mesh
intersection and assumes closed, consistently wound geometry. Open or non-manifold
scans show a partial-analysis warning and retain proximity checks. Self-intersecting
or incorrectly wound scans can affect solid results. Reported overlap volume is
summed **per pair**, so a region shared by three parts is counted in each relevant
pair. Exploded view is disabled until inspection is closed.

## Part colors and lighting

Editor colors and lighting change only how the scene looks here. Both are undoable, are saved
in the `.kitbash` file, and are never exported.

**Editor colors.** Select one or more parts and pick an **Editor color** under **Appearance**
in the inspector. **Material tint**, above it, is the color the part exports with. The **×**
beside the editor color clears it, and **Clear all editor colors** in the display menu clears
every part's. Copies keep their editor color; a merged part has none.

The display menu beside **Interference**, or the **View** menu, chooses how parts are shown:

- **Material:** the colors parts export with, including vertex colors.
- **Editor**, the default: editor colors where set, material colors elsewhere.
- **Distinct:** a different color for every part, by its place in the parts list. Editor
  colors still win. Deleting or merging parts recolors the parts listed after them.

An editor or distinct color replaces a part's vertex colors in the view. Picking an editor
color while showing Material switches to Editor. The mode is saved in this browser, not in the
scene. Each row of the parts list has a swatch of the part's shown color, and the interference
view keeps its grey parts.

**Lighting.** The display menu's button shows the color mode and the lighting preset, for example
**Editor · Studio**, or **Custom** once the lighting has been changed. The menu offers four presets,
**Studio**, **Soft**, **Headlight**, and **Dramatic**, and a **Brightness** slider.
**Edit lights…** there, or **View ▸ Lighting…**, opens the lighting panel over the viewport,
or along its bottom on narrow windows. **Esc** closes it.

- **Brightness**, **Ambient**, and **Sky fill**, with the sky fill's **Sky** and **Ground**
  colors. Each slider has a field for an exact value.
- **Shadows** turns on shadows from directional lights that have **Cast shadows** on, and the
  soft shadow on the ground.
- Up to 8 lights, added with **Add directional** and **Add point**. Each has an on/off switch, a
  name, a color, and an intensity. Click one in the list to edit it.
- A directional light shines at the center of the visible parts from a direction set by
  **Azimuth**, 0° from the front and 90° from the right, and **Elevation**.
- A point light sits at an X, Y, Z position in millimeters and is equally bright at any
  distance. **Range** fades it out by that distance; 0 reaches everything.
- **Follow camera** attaches a light to the view, like a headlight, so it lights whatever you
  face. Its direction or position is then relative to the camera. Turning it on or off keeps
  the light where it is at that moment.

While the panel is open, each light that does not follow the camera has a handle in the
viewport: a dot in the light's color, with a dashed line to the center for directional lights.
Click a handle to edit that light; this never changes the part selection. With the **Select**
tool, drag the arrows on the active light to move it; other tools keep their own gizmos.
Snapping applies, **Shift** gives one-tenth movement, and each drag is one undo step. Only a
directional light's direction matters, so its handle sits just outside the parts, where it
stays in view.

A scene uses your default lighting until you change it, and **Reset to default** in the panel
returns to it. The default is Studio, the editor's original lighting, until you save another
with **Use as default**. That is kept in this browser and applies to every scene without
lighting of its own. **Restore built-in default** goes back to Studio.

## Save and export

**Google Drive** connects your account and saves the current assembly automatically
after you choose **Save this scene to Drive**. Later edits update the same file;
the header shows saving, failures, and **Saved to Drive**. Open saved
assemblies from the Drive dialog. Local recovery continues offline. A Google OAuth
client ID must be configured for the installation; see [Google Drive setup and
autosave behavior](docs/google-drive.md).

**Save scene** downloads a self-contained `.kitbash` file when Drive is not attached.
For a Drive scene, **Save** / **Cmd/Ctrl+S** flushes pending cloud edits and
**File → Download scene copy** downloads a portable copy. Scene files include geometry,
surface normals, vertex colors, part transforms, names, visibility, fixed locks,
joints, editable plane constraints, and [editor colors and lighting](#part-colors-and-lighting).
Files are binary, so scene size is limited by
device memory rather than a file format limit. Meshes are packed: values that repeat are
stored once, so an assembly of STL parts with 7.7 million triangles takes 55 MB where it took
832 MB, and opens in half the time. Each mesh is packed the first time it is saved, and later
saves and Drive autosaves reuse it. Positions, colors, and triangles reopen exactly, so STL and
3MF exports are the same bytes after reopening. Normals that the triangles alone give are
computed again rather than stored. Pasted copies share one mesh, in memory and in the file. Private windows
cannot hold files above roughly 1.5 to 2 GiB and report an error; use a normal window for
larger scenes. Scene files from earlier versions still open. See the
[scene format](docs/scene-format.md).
**File → Open scene** restores it. Changes also recover through IndexedDB in the
same browser and origin. Each mesh is stored once, so edits stay fast at any scene size.
Recovery is not a replacement for a downloaded or Drive-saved scene; clearing browser storage removes
it. View and camera preferences, including the part color mode and your default lighting,
are not in scene files.
If the editor ever hits an unexpected error, it offers to reload from that local
save, or to discard the save if it keeps failing.

| Format         | Contents                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `.kitbash`     | Complete editable assembly, joint definitions, plane constraints, editor colors, and lighting             |
| `.glb`         | Separate named meshes, colors, and transforms; opens in Blender                                           |
| Blender `.zip` | GLB plus `import_assembly.py`, which rebuilds joint anchors and rotation locks and saves `assembly.blend` |
| `.3mf`         | Separate mesh objects and placement at millimeter scale                                                   |
| `.stl`         | Binary triangles in millimeters, converted to Z up                                                        |

For the Blender package, extract the ZIP, open the included Python file in
Blender's Scripting workspace, and run it. It creates a new assembly scene and
saves `assembly.blend` beside the script. It supports Blender 4.x / 5.x; verified
in Blender 5.2.2. Blender's Z-up rotation locks are mapped from the editor's Y-up
axes. Plain GLB import retains meshes and materials; use the package for joints.
In Blender, select the named joint empty to pose a connected part. Free axes
rotate around that pivot while its surface anchor stays connected; mesh
transforms are fixed to the pivot. Joints with **Keep connected** off retain their
metadata but are exported without constraint parenting, leaving their parts free.
Existing `.kitbash` scenes without this toggle load with Keep connected on.
Painted plane constraints are retained as metadata in GLB and the Blender package;
their current solved placement is exported, while live plane solving remains in
Kitbasher. Older scenes without plane constraints open normally.

Export all, visible, or selected parts. Formats that carry color use each part's material
tint; editor colors and lighting are never exported. Joints and plane constraints are kept only
when both of their parts are included. GLB uses meters as required by glTF. 3MF
retains separate objects but does not store colors or joints in this exporter. 3MF
is XML text, so very dense assemblies report an error (one of 5 million triangles did
in testing); use GLB or STL for those.
STL contains no names, colors, or joint data and does not automatically union
overlapping geometry.

## Navigation and shortcuts

Use `⌘` on macOS or `Ctrl` on Windows/Linux for the standard shortcuts below.
Both modifiers are accepted in the workbench. These are the defaults; every key can
be changed in [Preferences](#preferences), and menus, tooltips, and help follow. Text fields retain native selection,
copy, cut, paste, and undo behavior; Save and Open also work while editing a field.
Controls reached with `Tab` activate with `Space` and `Enter` as usual. Pressing a
tool's shortcut again keeps unfinished picks and painted patches; `Esc` discards them.
During contact painting, undo removes the last brush stroke before scene changes.

| Action                                | Control                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- |
| Orbit                                 | Middle drag; hold Space + left drag; left drag outside painting; one-finger drag |
| Pan                                   | Right drag; Shift + left drag; two-finger gesture                                |
| Zoom                                  | Scroll, pinch, or viewport buttons; tune it in Preferences                       |
| Fine gizmo adjustment                 | Hold `Shift` during move / rotate / scale (10× finer)                            |
| Select multiple                       | Shift / Ctrl / ⌘ + click                                                         |
| Focus / frame all                     | `F` / `Home`                                                                     |
| Isolate / with nearby surfaces        | `I` / `Shift + I`                                                                |
| Center orbit / toggle orbit selection | `.` / `Shift + .`                                                                |
| Select / move / rotate / scale        | `V` / `G` / `R` / `S`                                                            |
| Align / joint / measure               | `A` / `J` / `D`                                                                  |
| Paint contacts / pick pivot           | `B` / `P`                                                                        |
| Front / right / top / projection      | `1` / `3` / `7` / `5`                                                            |
| Apply / cancel active operation       | `Enter` / `Esc`                                                                  |
| Context menu                          | Right-click / `Shift + F10` / Menu key                                           |
| Keyboard shortcut help                | `F1` / `?`                                                                       |
| Preferences                           | `Ctrl/⌘ + ,`                                                                     |

| Standard action                | Shortcut                                        |
| ------------------------------ | ----------------------------------------------- |
| Select all components          | `Ctrl/⌘ + A`                                    |
| Deselect all                   | `Ctrl/⌘ + Shift + A`; `Esc` in Select mode      |
| Copy / cut / paste components  | `Ctrl/⌘ + C` / `X` / `V`                        |
| Duplicate selected             | `Ctrl/⌘ + D`                                    |
| Rename one component           | `F2`                                            |
| Delete unlocked selection      | `Delete` / `Backspace`                          |
| Undo / redo                    | `Ctrl/⌘ + Z` / `Ctrl/⌘ + Shift + Z`; `Ctrl + Y` |
| New assembly / import parts    | `Ctrl/⌘ + N` / `Ctrl/⌘ + I`                     |
| Save / save another scene copy | `Ctrl/⌘ + S` / `Ctrl/⌘ + Shift + S`             |
| Open scene                     | `Ctrl/⌘ + O`                                    |
| Export assembly                | `Ctrl/⌘ + Shift + E`                            |
| Find a component               | `Ctrl/⌘ + F`                                    |

Select All includes hidden and locked components. Moving, cutting, and deleting
still respect part locks. Component copy/cut/paste uses a clipboard within the
open editor, which survives opening another scene and clears on page reload.
It retains geometry, colors, transforms, pivots, joints, and plane constraints
between copied parts. Relationships to parts outside the selection are omitted. Copies paste with a
12 mm X offset, with an additional 12 mm for each paste. The first paste after a
cut restores the original placement. Pasted parts are visible, unlocked, and
selected, and scene changes can be undone.

Right-click a component in the viewport or Parts panel for transform, clipboard,
rename/delete, alignment, contact painting, joint, merge, interface inspection,
isolation, visibility, and lock actions. Right-clicking a selected part retains the whole
selection; right-clicking another part selects it. A model surface menu also
offers **Set pivot here** at the clicked point. Right-drag continues to pan the
camera. The menu supports arrow keys, Home/End, typing an action name, Enter/Space,
and Escape, and fits within small windows. Editable fields keep their native
context menu. The File and Edit menus expose the same commands and shortcuts.

## Preferences

Open Preferences from the gear in the top bar, **File ▸ Preferences…**, or `Ctrl/⌘ + ,`.
It opens as a side panel rather than a dialog, so the viewport stays usable and each
change can be tried immediately. Settings are saved in this browser, apply to every
scene, and sync between open tabs.

- **Scroll zoom.** The wheel glides smoothly toward each step instead of jumping.
  _Sensitivity_ scales every step. _Response curve_ shapes how wheel distance becomes
  zoom: below 1, small and large steps zoom more evenly (useful on macOS, where slow
  wheel notches are reported as tiny scrolls); 1 follows scroll distance exactly, which
  suits trackpads; above 1, fast scrolling accelerates. A chart shows the zoom for one
  notch and for a fine step. _Smoothing_ sets how long the glide lasts, or turns it off.
  The direction can be inverted. A trackpad pinch always follows your fingers.
- **Orbit.** The same _Orbit around selection_ preference as the Camera panel.
- **Point markers.** Anchors, pivots, picked points, measurements, joints, and painted
  patches share one size, set in screen pixels, so they stay the same size at any zoom.
  Labels can sit beside their point or appear as CAD-style callouts: the label sits
  away from the model with a leader line back to the point, always straight above it on
  screen. Callouts can stay a set clearance above the model's outline or use a fixed
  leader length, and overlapping labels stack outward instead of covering each other.
- **Keyboard.** Every tool, camera, editing, and file shortcut can be changed, given a
  second key, removed, or reset. A key belongs to one action at a time, so assigning it
  moves it and says where it came from. Bindings use the physical key when a layout or
  `Alt` changes the typed character.

## Build with an agent

Coding agents can build models directly through the included MCP server. It adds, places, and
joins parts, checks them for interference, renders views the agent can see, and saves `.kitbash`
files that open here. It runs locally, without a browser or GPU. Its live view opens the agent's
scene here, where you can look around freely and edit alongside the agent: each tab keeps its own
camera and selection, edits from both sides merge, and undo reverts only your own changes.

```sh
npm run build
claude mcp add --scope user kitbasher -- node "$PWD/dist-mcp/kitbasher-mcp.js"
codex mcp add kitbasher -- node "$PWD/dist-mcp/kitbasher-mcp.js"
```

See [Building with agents](docs/mcp.md) for the tools, the live view, and limits.

## Assemble in a headset

In a WebXR headset such as a Meta Quest, you pick parts up and place them by hand, and choose
how large the model looks. The headset and a tab on your computer work on one scene together,
so each does what it suits: import, fit, paint, and export on the computer, and place parts by
hand in the headset. Edits from both merge, and undo on each side reverts only its own changes.

```sh
npm run headset                            # starts with the sample
npm run headset -- path/to/scene.kitbash   # or with a scene of yours
```

This builds Kitbasher, opens the scene in your browser, and prints an address and a six-digit
code. Both also show under **Headset** at the top of the viewport on the computer. If the
computer's firewall asks, allow Node to accept incoming connections.

1. With the headset on the same network as the computer, open the address in the headset's
   browser, for example `https://192.168.1.20:8443`. The browser warns that the connection is
   not private, because the computer makes its own certificate. Choose **Advanced**, then
   **Proceed**. The address usually stays the same from one session to the next, so it is
   worth a bookmark.
2. Enter the code.
3. Choose **Headset** at the top of the viewport, then **In your room**, which shows the model
   in the room around you, or **Virtual space**, which shows it on the workbench grid.

Open or import models on the computer at any time, and the headset shows them. Save from the
computer: the scene ends with the session, and nothing is kept on the headset. `Ctrl + C` in
the terminal ends the session.

The model starts within reach, about 40 cm across. In the headset:

- **Trigger on a part** holds it, and letting go puts it down. Touch the part, or point at it
  from a distance. Either way it moves exactly as far as your hand does and turns with your
  wrist, about the point you took it by. The part a press would take is tinted.
- [No clip](#avoid-clipping) applies as it does to a drag: a held part stops at the surface of
  other parts and slides along them, and the controller taps when it is first held back. Joints,
  locks, and kept plane constraints hold too. A part on a joint turns about its anchor and
  carries its connected assembly with it.
- **Trigger on empty space, or the grip anywhere,** holds the world, which moves with your
  hand. A locked part holds the world as well.
- **Both hands** holding the world resize it, turn it, and carry it. Move them apart to make
  everything larger, which also makes your hands steadier in the model's own millimeters. The
  scale shows between your hands.
- **Bare hands** work like controllers: pinch for the trigger. A pinch on empty space holds
  the world.

A panel hangs to your lower left, with the world scale, **1:1** for true size, **Reset view**,
**Undo** and **Redo**, **No clip**, **Keep level**, and **Leave headset view**. Point at a control
and pull the trigger. Take the panel by its background to move it, and press **B** or **Y** to
bring it back in front of you. **Keep level**, on to start, keeps the model upright while two
hands turn it, like a turntable. Turn it off to tip the model over and look underneath.

The last line of the panel shows how the headset is coping: frames per second, the slowest
frame in the last second, the time spent moving a held part, and the triangles drawn.

Without `npm run headset`, a copy of Kitbasher served over HTTPS also offers **Headset** when
opened in the headset's browser. It works on that browser's own scene, with nothing shared.

Limits in a headset:

- **Placing by hand only.** Alignment, contact paint, anchors, joints, measuring, merging,
  colors, lighting, and files stay on the computer, as does everything typed.
- **A headset draws far less than a computer.** Expect it to keep up with hundreds of thousands
  of triangles, not the millions a desktop shows. Ground shadows are off in a headset, and other
  shadows are off above 300,000 triangles. Automatic scan detail uses display proxies;
  [decimation and remeshing](#high-poly-scans) can further reduce a model when needed.
- **A held part can trail a fast hand** against other parts, more than a mouse drag does,
  because a headset frame leaves less time to keep it clear. It catches up when your hand slows.
- **Anyone on your network with the code can edit the scene** while the session runs. Five wrong
  codes replace it with a new one. The connection is encrypted, with a certificate the headset
  cannot verify, which is why its browser warns. The certificate is kept in `.kitbasher` in
  your home folder. Set `KITBASHER_SHARE_PORT` to change the port.
- **Checked with an emulated headset.** Everything above runs against Meta's WebXR emulator in
  the tests. It has not yet been measured on a physical headset.

## Large files

Imports have no fixed size limit. STL and OBJ are read in pieces into typed arrays, so
they are not bound by the browser's limits on strings or its JavaScript heap. An import
shows its progress, and failing for lack of memory reports that instead of a damaged file.

These were measured once in Chrome on an Apple M4 Max with 36 GB of memory:

| File                   | Triangles | Import | Clickable after | Orbit  |
| ---------------------- | --------- | ------ | --------------- | ------ |
| Binary STL, 1.1 GiB    | 24M       | 1.6 s  | 2.5 s           | 60 fps |
| OBJ, 1.9 GiB           | 48M       | 13.5 s | 8.2 s           | 30 fps |
| Binary STL, 2.8 GiB    | 59M       | 4.5 s  | 10.6 s          | 30 fps |
| GLB (indexed), 3.4 GiB | 150M      | 7.4 s  | parts list only | 30 fps |

Limits that remain, each reported with an explanation:

- **One mesh:** a browser accepts at most 2 GB in one GPU buffer, about 59 million triangles
  in STL or OBJ. Indexed GLB meshes share vertices, so they go further.
- **Text formats:** embedded `.gltf` files and the model text inside a `.3mf` are limited to
  512 MiB. A 3MF near that limit holds the interface for about 26 seconds. Prefer GLB.
- **Contact paint and Boolean union:** 10 million triangles per part. The first paint stroke
  on a mesh near that limit holds the interface for about 13 seconds.
- **Clicking a mesh:** preparing one failed at 150 million triangles (120 million worked).
  It still draws, and can be selected in the parts list.
- **GLB export:** 2 GB of mesh data, about 29 million triangles of STL or OBJ. STL and `.kitbash`
  exports have no such limit.
- **3MF export:** about 2 million triangles of STL or OBJ, because the format is XML text.

Interference inspection reports a partial analysis on very dense meshes, and Combine holds
the interface for about 15 seconds at 48 million triangles. These limits were not measured in
Firefox or Safari.

## Scope and limitations

- Geometry, vertex colors, and material tints are retained. Texture maps,
  animation, rigging, and advanced glTF compression are not retained/supported.
  Use self-contained GLB files; external `.gltf` resources are not bundled.
- There is no fixed limit on file size, but this is not an out-of-core mesh editor: every
  mesh stays in memory and on the GPU while open. See [large files](#large-files).
- Boolean union expects repaired closed, consistently oriented inputs without
  self-intersections. It does not repair scans or guarantee print watertightness.
  The original scene remains unchanged on failure; jobs time out after 90 seconds.
- Joints use a parent/child constraint tree, not a physics solver. There are no
  closed-loop assemblies or joint angle limits. Turn Keep connected off to bypass
  a joint temporarily; alignment can also run with the joint active.
- Point-based plane alignment uses the picked triangle's face normal. Painted
  plane relationships use an area-weighted fitted plane; paint a flatter patch
  when the surface does not define a stable plane. Multi-point registration
  assumes the source and target share the same scale.
- Plane constraints are an initial mesh assembly constraint system, with directed
  dependencies and bounded projection. They do not provide a complete Fusion
  sketch/B-rep solver or solve cyclic mechanisms. Angle-only constraints allow
  translation; a single mate still allows planar sliding and twist.
- Lighting is for viewing in the editor. A scene has at most 8 lights. Only directional
  lights that do not follow the camera cast shadows; point lights do not.
- Undo history retains the most recent 40 changes in the current session.

## Source

`src/core/` owns geometry, rigid registration, constraints, serialization, imports,
exports, and the Boolean worker. `src/components/` owns the viewport, part tree,
inspector, and dialogs. `src/hooks/` owns keyboard controls and local recovery.
`src/xr/` owns the headset session. State lives in a typed Zustand store. `mcp/` holds the
[MCP server](docs/mcp.md) and the headset session's host, which reuse `src/core/`. Tests are
in `tests/unit/` and `tests/e2e/`.

See [design specification](docs/design.md) and [verification notes](docs/verification.md).

## License

Copyright © 2026 Michael Pearce. Licensed under the [MIT License](LICENSE).
