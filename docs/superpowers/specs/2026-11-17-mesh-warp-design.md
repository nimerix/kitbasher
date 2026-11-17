# Mesh warp: closing gaps between scanned parts

Status: design, awaiting approval. Date: 2026-11-17.

## Intent

Users rebuild physical objects from separately 3D-scanned pieces. The originals fit
seamlessly, but scanning loses surface, so the reassembled scans leave small gaps
(about 0.1 mm to a few mm) along their joins. Each scan is itself a closed mesh. The
assembly is being positioned so that a future step (not built yet) can voxel-remesh all
parts into one connected model. Any gap wider than the remesh resolution makes that model
come out in pieces. Today users close gaps by sculpting in another program.

Warp is a 3D counterpart to Photoshop's Puppet Warp. A coarse grid is laid over a part's
surface, the user adds control points and moves them, and the scan surface stretches
smoothly with them. Closing gaps is the main use, but it is a general tool: users may also
reshape a scan with it.

## Goals

- Close seams so neighbouring scans touch or slightly overlap along the whole join.
- Let users reshape a scan locally without leaving Kitbasher.
- Stay usable on scans of several million triangles.
- Show the remaining gap to a neighbour while working, since the voxel remesh that will
  consume the result does not exist yet.

## Non-goals

- MCP tools. None are added or changed. The live server's history budget (see Undo
  memory) is the only `mcp/` change.
- The voxel remesh of the whole assembly.
- Persistent, re-editable warps. A warp is baked into the mesh on Apply.
- Headset (XR) support. Warp is desktop only; VR draws display proxies, not full meshes.
- General sculpting brushes (inflate, smooth brush, and so on).

## Anti-goals

- Changing anything outside the warped region. Vertices outside it, and the region border,
  keep their exact original bits.
- Making existing features slower, or changing export bytes for parts that were not warped.
- Losing a user's warp to a sync or live-session conflict without telling them.
- Snapping or moving anything automatically that the user did not ask for.

## Constraints

- Meshes are immutable and shared. Pasted copies, the 40-step undo history
  (`store.ts:120`), the clipboard and caches all hold the same `BufferGeometry`. The live
  preview must never write into `part.geometry`.
- The editor keeps position, normal and vertex color only (`geometry-transfer.ts`). UVs are
  not a concern.
- Geometry can be indexed or non-indexed. Welding must use `weldedPositionIndex` at 1e-5
  (`mesh-topology.ts:5`), the same tolerance `assertClosed` uses (`merge.ts:21`), and every
  duplicate of a welded vertex must receive identical bits, or unindexed scans crack.
- No sparse linear solver exists in the repo. `ml-matrix` is dense. `native/` is an
  optional host process, not a browser WASM toolchain. `SharedArrayBuffer` cannot be
  assumed (`bvh.ts` checks `crossOriginIsolated`).
- Painting regions currently lives inside the alignment operation (`store.ts:838-911`,
  `SurfacePatch` in `types.ts:173`), and `faceAdjacency` runs on the main thread (12.6 s at
  10M triangles, per its own comment in `surfaces.ts`).
- The transform tools (`transform-selection.ts:21`, `free-transform.ts:39`) operate on
  `Part[]` and emit `Partial<Part>`. The anchor and light gizmos (`Viewport.tsx:536-560`,
  `865`) are the precedent for transforming something that is not a part.

## Approaches considered

**Region: what stops the warp spreading.** (1) influence radius per control point,
(2) a painted region with a fixed border, (3) Puppet Warp as-is, where the grid covers the
whole part and unmoved control points act as pins. **Chosen: 2 and 3 combined.** A painted
region confines the warp and fixes its border; with nothing painted the whole part is the
region. Unmoved control points pin in both cases. The radius option was dropped because a
sphere of influence crosses thin walls.

**Deformation method.** (1) as-rigid-as-possible (ARAP) solve on a coarse grid, with dense
vertices bound to the grid; (2) ARAP or biharmonic solve directly on every dense vertex;
(3) radial-basis or falloff blending of control-point offsets. **Chosen: 1.** Option 2
needs a sparse solver on hundreds of thousands of unknowns, which the browser build lacks
and which would not be interactive. Option 3 is fast but shears surface detail instead of
rotating it, and only approximately fixes the border. The binding of dense vertices to the
grid was revised after review (see Design).

**Moving control points.** (1) free drag only, (2) push/pull along the normal only,
(3) drag that snaps to the neighbouring part. **Chosen:** points move with all of the
editor's normal transform tools, and snapping (option 3) is an optional toggle. The user
decides.

**Persistence.** (1) baked into the mesh on Apply, (2) re-editable warp stored with the
part. **Chosen: 1.** Option 2 doubles each warped scan's share of the file and needs a
scene-format change; users rarely revisit a closed seam.

**Topology under stretch.** (1) split long edges only, (2) split plus optional collapse
and relax, (3) remesh the region on Apply. **Chosen: 2, in a second phase.** Option 3
resamples the scan and softens detail even where little moved. Phase 1 ships without
topology change, because a 0.1 to 3 mm seam closure barely stretches edges.

## Design

### User experience

Warp is a new tool in the tool strip, with an inspector panel:

```
  ┌ Warp ──────────────────────┐
  │ Region   ◉ Painted ○ Whole  │
  │ Density  ──●────────        │
  │ Snap to neighbour  [ ]      │
  │ [Close gap]  overlap 0.10mm │
  │ Smooth squeezed    [ ]  (2) │
  │ Gap to neighbour  0.42 mm   │
  │ [Cancel]           [Apply]  │
  └─────────────────────────────┘
```
(2) marks phase-2 controls.

1. Select one part and choose Warp. Optionally paint a region with the existing surface
   brush. With nothing painted, the whole part is the region.
2. A coarse grid appears over the region as thin lines. Density sets how coarse it is:
   coarser gives broader, smoother bends; finer gives tighter, local ones.
3. Click anywhere on the region's surface to add a control point; points need not sit on
   grid crossings. Points can be selected and deleted. Unmoved points hold their place.
4. Move selected points with the move gizmo, the combined Transform tool, Shift+G pointer
   move, Shift for fine adjustment, and numeric entry, all as they work for parts.
   Control points are positions only, with no orientation of their own (designer's call).
   Rotating or scaling a multi-point selection moves the points about the selection's pivot;
   with a single point selected, rotate and scale do nothing.
5. **Snap to neighbour** (off by default): while on, a dragged point locks onto the
   nearest surface of another visible part, pushed in by the overlap depth.
6. **Close gap**: pulls every grid node within range of a neighbouring part onto that
   part's surface at the overlap depth, in one action. The user can keep adjusting with
   control points afterwards. Overlap defaults to 0.1 mm, matching
   `defaultClipSettings.overlap` (`clipping.ts:12`).
   Close gap works at grid nodes (designer's call). Between nodes, scan noise and shape
   mismatch can leave small residual gaps; the overlay shows them and the user raises
   Density or adds points there. Residuals smaller than the future voxel size fuse on
   remesh, so per-vertex projection onto the neighbour is not done.
7. **Gap to neighbour** readout and a colored seam overlay appear only when another part
   is near the region. The readout shows the largest remaining dense-vertex gap along the
   seam, and the overlay colors where it is.
8. Triangles that fold over (normal flipped relative to rest) are highlighted with a
   warning. Apply is still allowed; voxel remesh tolerates them.
9. **Apply** bakes the result into the part as one undo step. **Cancel** discards it.
   Inside the session, Ctrl/⌘+Z steps back through control-point edits; these steps are
   session-local and leave the scene history untouched.

### Data flow and state

- Warp session state lives in the store, separate from the alignment operation: target
  part id, source geometry reference, region faces, grid, control points, toggles. The
  painted-region code is reused but decoupled from `SurfacePair`.
- The preview draws a session geometry that shares the source index and color buffers and
  owns new position and normal attributes. `part.geometry` is untouched until Apply.
- On Apply, follow `applyProcessedMesh` (`store.ts:1542`) and its guards: refuse if the
  part changed, is locked, or the scene epoch changed. Unlike mesh processing, the warp
  edits in place and keeps every link exactly as it was (product owner's decision): pins,
  anchors, pivot, joint anchors and plane-constraint frames are not modified, and neither is
  anything on other parts. This guarantees no hard-pin conflict (`sync.ts:331`) and no joint
  or plane solve moves any part as a result of a warp. An attachment point may sit off the
  warped surface by as much as the surface moved there; that is accepted. Pasted siblings
  that shared the geometry keep the original.
- Live session: keep the warp session alive until the live edit is confirmed. If it is
  refused because of a concurrent edit (`live.ts:176`, `sync.ts:35`), tell the user and
  let them retry rather than silently reverting.

### Deformation

- **Grid**: weld the region (1e-5), then simplify it with `MeshoptSimplifier` and
  `LockBorder`, so grid nodes are real scan vertices and the region border survives as
  fixed nodes. Cap at a few thousand nodes; Density chooses the target count. Border
  triangles of the grid may be poor; they are drawn but not relied on for quality.
- **Solve**: ARAP local/global iterations on the grid, with a warm-started preconditioned
  conjugate gradient solver in TypeScript. Constraints: border nodes fixed; moved control
  points as targets; unmoved control points as pins; Close-gap nodes as soft targets.
  Output is a rotation and translation per node.
- **Binding** (revised after review): each dense vertex is skinned as a weighted blend of
  nearby nodes' rigid transforms (embedded deformation). Weights come from distance along
  the surface, computed by multi-source Dijkstra on the welded dense graph, so binding
  cannot jump across a thin wall and the result is smooth across grid edges.
- **Border and outside**: vertices outside the region, and border vertices, copy their
  original bits.
- **Preview cost**: for whole-part regions on very large scans, drags may deform the
  display proxy (`display-performance.ts`) and evaluate the full mesh on release.
- **Part scale**: the solve runs in world space, so non-uniform or mirrored part scales
  stay rigid as seen by the user.

### Picking and neighbours

- In phase 1 topology is unchanged, so the part's BVH is refitted rather than rebuilt
  (the deserialize-and-refit pattern near `bvh.ts:47`), keeping the part clickable.
- Snap, Close gap and the gap readout query neighbours through their existing
  `boundsTree` via `treeOf` (`clipping.ts:73`). `surfaceDistances` copies and rebuilds a BVH
  per call, so it is not used per frame. Neighbours whose index is still being built are
  skipped, with a notice.

### Undo memory

A warp is one undo step. Because each step on a multi-million-triangle scan holds hundreds
of MB, the history gets a byte budget (designer's call on scope). History holds whole-scene
snapshots, so the budget counts the mesh bytes that history keeps alive beyond the current
scene, whatever step introduced them. When it is exceeded, the oldest entries are dropped
and the user is told once that undo depth was reduced. Below the budget, history behaves
exactly as today, so ordinary scenes see no change. In phase 1 the warped geometry shares
index and color buffers with its source, which halves the cost per step.

Live sessions: the live server (`mcp/document.ts`) keeps 40 steps per author and 200 scene
versions, each able to pin an old mesh. The same byte budget applies there. This is the
only change under `mcp/`; no MCP tools are added or changed.

### Phase 2: adaptive topology

- **Split** (always on): after each drag, edges whose deformed length exceeds the region's
  typical rest edge length are split in rest space; the new vertex is sent through the
  warp, and color is interpolated. Only edges whose two faces are both inside the region
  are split. Border edges never move, so they never stretch.
- **Smooth squeezed areas** (toggle, off by default): edges that became much shorter than
  normal are collapsed, and that area is relaxed tangentially (vertices move only along
  the surface) until ripples flatten.
- Refinement runs in a worker on typed arrays when the pointer is released. While dragging,
  the existing triangles deform.
- Topology change means a full BVH rebuild in a worker after Apply, and new index and color
  buffers in history.
- The welded result must stay closed and manifold under `hasClosedEdges`.

## Builder's discretion

- Grid node counts per Density step, and ARAP iteration counts and tolerances.
- Number of nodes each dense vertex is skinned to, and the weight falloff.
- Close-gap search range and how it treats nodes facing away from the neighbour.
- The keyboard shortcut for the tool, and its icon.
- Byte budget value for history.
- Thresholds for "much shorter than normal" and relaxation iterations in phase 2.

## Verification

- Unit tests: warp leaves outside and border bits unchanged; welded duplicates stay
  identical; a closed input stays closed; Apply leaves pins, anchors, pivot, joints and
  plane constraints unchanged and moves no other part; Close gap
  leaves every grid node in range at the overlap depth on a test seam, and the readout
  reports the residual between nodes.
- End-to-end: paint, add points, drag, Close gap, Apply, undo, on the sample and on a
  large scan.
- Performance: no regression in existing benchmarks; warp drag stays interactive on a
  3M-triangle scan.
- Exports of unwarped parts stay bit-identical.
