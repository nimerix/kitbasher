<img src="assets/kitbasher.svg" width="64" height="64" alt="Kitbasher">

# Kitbasher

A local-first 3D workbench for assembling multipart models and scanned miniatures.
Runs in modern WebGL browsers on Windows, macOS, and Linux, with a responsive
layout for tablets and smaller screens. No account, API keys, or cloud uploads.

## Run

Requires Node.js 22.12 or newer and npm.

```sh
npm install
npm run dev
```

Open the local URL printed by Vite, usually http://localhost:5173.

```sh
npm run build        # TypeScript checks + static production build
npm run preview      # Serve the production build locally
npm test             # Geometry, constraints, scene and export tests
npm run test:e2e     # Interaction and WebGL tests in installed Google Chrome
npm run format       # Format source and tests
```

Deploy the `dist/` directory to any static web host. Fonts and application assets
are bundled locally. This is a browser application; native desktop installers
are not included.

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
   camera freely; orbiting again returns to the selection when the preference is on.

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
   Use **O** / **H** for camera navigation, then **Esc** to resume painting.

   **Fit contact surfaces** seeds a rigid fit from the patch centers and normals,
   then refines symmetric closest-surface matches within each numbered pair.
   Samples are distributed by surface area, with opposing normals by default.
   Paint marks whole mesh triangles, so brush detail follows mesh resolution.
   Contact RMS measures sampled distances to the actual matching painted surfaces,
   after joint constraints. This is a local fit; spread pairs around the join to
   distinguish similar or symmetric surfaces. It preserves scale and does not
   deform the scan or perform collision avoidance. Unfinished pairs must be
   completed or removed before fitting.

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
orthographic views, framing, visibility, and fixed part locks are included.
Larger meshes use BVH-accelerated picking; rendering pauses when the view is idle.

## Save and export

**Save scene** downloads a self-contained `.kitbash` file, including geometry,
vertex colors, part transforms, names, visibility, fixed locks, and joints.
**File → Open scene** restores it. Changes also recover through IndexedDB in the
same browser and origin. Recovery is not a replacement for a downloaded scene;
clearing browser storage removes it. View/camera preferences are not in scene files.

| Format         | Contents                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------- |
| `.kitbash`     | Complete editable assembly and joint definitions                                                          |
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

Export all, visible, or selected parts. GLB uses meters as required by glTF. 3MF
retains separate objects but does not store colors or joints in this exporter.
STL contains no names, colors, or joint data and does not automatically union
overlapping geometry.

## Navigation

| Action                           | Control                                           |
| -------------------------------- | ------------------------------------------------- |
| Orbit                            | Left drag; one-finger drag                        |
| Pan                              | Right drag; Shift + left drag; two-finger gesture |
| Zoom                             | Scroll, pinch, or viewport buttons                |
| Select multiple                  | Shift + click                                     |
| Focus / frame all                | `F` / `Home`                                      |
| Select / move / rotate / scale   | `V` / `G` / `R` / `S`                             |
| Align / joint / measure          | `A` / `J` / `D`                                   |
| Front / right / top / projection | `1` / `3` / `7` / `5`                             |
| Save / open                      | `Ctrl/⌘ S` / `Ctrl/⌘ O`                           |
| Undo / redo                      | `Ctrl/⌘ Z` / `Ctrl/⌘ Shift Z`                     |
| Duplicate                        | `Ctrl/⌘ D`                                        |
| Delete unlocked selection        | `Delete` / `Backspace`                            |
| Apply / cancel active operation  | `Enter` / `Esc`                                   |

## Scope and limitations

- Geometry, vertex colors, and material tints are retained. Texture maps,
  animation, rigging, and advanced glTF compression are not retained/supported.
  Use self-contained GLB files; external `.gltf` resources are not bundled.
- Import has a 250 MB per-file limit. Capacity depends on device memory and GPU;
  this is not an out-of-core mesh editor.
- Boolean union expects repaired closed, consistently oriented inputs without
  self-intersections. It does not repair scans or guarantee print watertightness.
  The original scene remains unchanged on failure; jobs time out after 90 seconds.
- Joints use a parent/child constraint tree, not a physics solver. There are no
  closed-loop assemblies or joint angle limits. Turn Keep connected off to bypass
  a joint temporarily; alignment can also run with the joint active.
- Alignment uses picked triangle face normals, not a fitted average plane.
  Multi-point registration assumes the source and target share the same scale.
- Undo history retains the most recent 40 changes in the current session.

## Source

`src/core/` owns geometry, rigid registration, constraints, serialization, imports,
exports, and the Boolean worker. `src/components/` owns the viewport, part tree,
inspector, and dialogs. `src/hooks/` owns keyboard controls and local recovery.
State lives in a typed Zustand store. Tests are in `tests/unit/` and `tests/e2e/`.

See [design specification](docs/design.md) and [verification notes](docs/verification.md).
