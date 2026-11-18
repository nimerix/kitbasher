# Warp: visible grid, fitted brush, handles with reach, feathered edges

Status: design, revised after review. Date: 2026-11-17. Follows
[the mesh warp design](2026-11-17-mesh-warp-design.md).

## Intent

Warp shipped and the product owner used it on real models: mostly 32 mm to 100 mm
miniatures. Six problems came back. This change fixes them without changing what Warp is: a
grid over a part, control points on it, an as-rigid-as-possible solve, a bake on Apply.

| #   | Reported                                                                                          |
| --- | ------------------------------------------------------------------------------------------------- |
| 1   | The grid has almost no contrast over the model, least of all with Distinct part colors.           |
| 2   | The region brush slider is too coarse: good sizes for these models sit in a sliver of its travel. |
| 3   | With Whole part there are no pins, so dragging one point just moves the model.                    |
| 4   | A control point moves a spike. Its radius and falloff need to be configurable.                    |
| 5   | A painted region warps with a hard crease at its perimeter. An option should feather it.          |
| 6   | Several points in a row give a row of peaks. A line or an area should move as one.                |

## Goals

- Each of the six, as the product owner described it.
- Everything a session could do before still works. A point with radius 0 solves exactly as
  today, and adding an unmoved point never changes the surface.

## Non-goals

- Phase 2 topology change, MCP tools, headset support, re-editable warps.
- Changing the Align tool's contact brush: its slider and its radius are untouched.
- Rotating or scaling a single line or area handle about itself. Handles translate.

## Anti-goals

- Moving a vertex outside the region the user can see. With feathering on, the feather band
  is shown and is part of the region; everything beyond it, and its outer border, keeps
  exact position and normal bits.
- Slower drags. A drag frame must cost no more than today for the same grid, measured.
- Export bytes changing for parts that were not warped.

## How it works today

- `warp-region.ts` welds the part and marks welded vertices Outside, Border or Interior from
  the painted faces. Its adjacency covers region triangles only. `warp-grid.ts` simplifies
  the region to roughly 60–4000 nodes (real scan vertices; `LockBorder` can exceed the
  target); border nodes are `fixed`.
- `warp-solve.ts` runs ARAP on the grid. A `WarpConstraint` ties a weighted set of nodes to
  a world target at strength 1000; weights are normalised, so they cannot carry stiffness.
  Fixed nodes are left out of the system. A control point is the barycentric sum of three
  skinned triangle corners (up to 12 nodes, plus a part held by fixed corners), and the
  constraint models exactly that.
- `warp-bind.ts` skins every dense vertex to its 4 nearest nodes by surface distance.
  `warp-evaluate.ts` writes skinned positions for interior vertices, then normals and folds.
- `store.ts` holds the `WarpSession`: `points: WarpPoint[]` (face, barycentric, binding,
  pin, target), `gapTargets`, session undo. A new point's `pin` is the surface where it is
  when clicked, not rest. `transform-selection.ts` presents selected points to every
  transform tool as position-only targets, and `moveWarpPoints` takes one target per point.
- `WarpOverlay.tsx` draws grid edges as straight 1 px chords between nodes, `#b9e3dd` at
  55 % opacity. The Distinct palette is OKLCH lightness 0.62–0.84, nearly the same tone.
- `SurfaceBrushControls.tsx` (shared with Align) has a linear 0.1–20 mm slider over the
  shared `brushRadius`.

## Design

### 1. Grid contrast

Draw grid edges as fat lines (`LineSegments2` and `LineMaterial`): an opaque dark core
about 1.5 px wide over a light casing about 3.5 px wide at partial opacity, both from one
shared, preallocated endpoint buffer (two endpoints per edge) updated in place per frame.
The far side stays hidden.

A grid edge is a straight chord between two scan vertices, so on a convex surface its
middle runs under the surface and is hidden however it is coloured. Measure it: on a curved
convex part at default density, find how much front-facing grid length is actually drawn.
If more than about a tenth is hidden, pull the lines toward the camera by a small amount
scaled to each edge's length (a depth bias in the line material). Only if that is not enough,
lay each edge along the surface instead.

Acceptance: over each of the first 24 Distinct colours, and over white and near-black parts,
in the light and dark themes, grid pixels reach at least 3:1 contrast against the surface
beside them; at least 90 % of front-facing grid length is visible on the curved part; the
far side does not show through; the grid stays readable at the highest density.

### 2. Brush size fitted to the part

Warp gets its own brush radius, separate from Align's. The cursor, region painting, area
handles (section 6) and the brush-size shortcuts all use it while warping.

- `SurfaceBrushControls` takes an optional value, setter and slider range. Warp passes a
  range fitted to the part: 0.1 mm to a quarter of the part's size (clamped to 2–100 mm) on
  a logarithmic slider, so each doubling takes the same travel. The numeric field still
  accepts 0.05–100 mm and steps by 0.1 mm.
- The part's size is its local bounding box times its scale, largest axis, so turning the
  part does not change it. A 32 mm model gets 0.1–8 mm with about 0.9 mm at mid-travel.
- Warp's radius starts at 3 % of the part's size, and keeps whatever the user then sets.

### 3. Even pins

**Distribute points** in the Control points section: a count (4, 8, 16, 32; default 8) and a
button. It adds that many unmoved points. First every connected piece of the region that has no
point gets one, larger pieces first, at its node farthest along the grid from its edge. Then
farthest-point sampling over the free nodes, measured along grid edges, from the points
present, those chosen and the region's edge. It is deterministic (lowest node first among
ties), never puts two points on one node, and stops at the number of free nodes. Each point sits
on a node's own scan vertex and pins the surface where it is now. One session undo step. With a
feathered region it uses painted free nodes only.

Distributed points are ordinary points with radius 0 (section 4), marked automatic until
the user moves or edits them.

When the region is effectively the whole part (Whole part, or Painted with nothing
painted), the Region stage shows "Place points automatically" (on, with the same count),
and the first lay of the grid distributes them. Changing density, returning from Edit
region, or deleting them never places them again.

An untouched automatic point inside the reach of a moved handle rides to where the guides take
the surface at its nodes, so a bump rises smoothly over it instead of pinching; it holds its pin
wherever nothing guided moves. A point the user placed always holds. Its marker is drawn where
the surface is written. When the user first moves it or gives it a radius, it is taken over where
it is: its samples' pins, its centre and its baseline are captured together from the surface as
shown, the gizmo starts there, and the old point stays in the undo step, so taking it changes
nothing. An untouched automatic point bound to a node a moved handle's samples are bound to
would hold the grab back, so moving that handle releases it in the same undo step.

Close gap releases, in the same undo step, the untouched automatic points that would hold its
seam open: it walks the grid from the nodes it pulls, never onto a node facing away from where
its pulled node goes, settles once from the surface as shown without the automatic points it
reached, and releases those whose spot that settle moves by more than 5 % of the largest pull
from where it is written before closing. Points on other pieces, on
the far side of a thin wall, or that the seam would not move stay. Points the user placed or
moved are kept.

### 4. Radius and falloff

Every handle has a **radius** in mm and a **falloff** from 0 to 100 %, edited in the Control
points section for the selected handles. New handles take the last values set. Until the user
sets a radius, a new point takes the larger of 6 % of the part's size and 4.5 node spacings
where it is clicked, no more than a quarter of the region's extent. Radius 0 is a bare point;
automatic points are radius 0. Effectively whole regions are laid at the 2,000-node level and
painted ones at 500 unless the user has chosen a density.

The handle's sample constraints stay exactly as they are at every radius: they place the grab.
Radius adds soft per-node **guides** around them.

- **Priority.** A moved point's sample, and gap targets, are held at 100 times the strength of
  an automatic pin. Any other sample the user placed or moved is too where other handles'
  samples or gap targets share its nodes, and by how firmly guides hold its nodes where they do
  (the nodes a handle moves as one do not count), so the surface stays continuous in the radius.
  A moved point then lands on its target within 0.01 mm at default density and 0.03 mm on the
  coarsest grid, unless a point the user placed on the same spot or the fixed edge holds it,
  which the panel states when it exceeds 0.02 mm; its marker shows where the surface is and the
  gizmo stays on the target. A drag frame solves without priority, so it costs what it did.
- **Settling.** The end of an edit settles for up to 50 iterations. A solve whose last iteration
  still moved a node by 1 µm or more is marked settling and goes on in idle steps of 8 ms,
  redrawing every 200 ms, until it converges (or 20,000 iterations). Undo restores the surface
  exactly as shown, settling on from there if it was. Apply bakes the preview as shown. An edit
  that changes nothing settles nothing.

- **Baseline.** A handle refers to a snapshot of the settled grid (positions and rotations),
  taken when it is created, and replaced by the settled grid when an unmoved handle with no
  active guides starts its first move or first gets a radius. Snapshots are never changed and
  are shared by reference between handles made on the same surface and all undo versions.
- **Reach.** Distance from the footprint is the larger of the straight-line distance and the
  path along grid edges divided by 1.16 (the overstatement of edge paths on the simplified
  flat grids, median 1.06, 99th percentile 1.15). It is round on flat areas and cannot cross a
  fold. Fixed nodes, and with a feather unpainted ones, are never reached. A footprint is a set
  of source points plus nodes that move as one; a point's footprint is its sample alone. It is
  built by kind (`handleFootprint`) wherever a reach is measured, and a reach is reused only on
  the same grid, at the same radius, from the same footprint.
- **Weight.** `w` is 1 out to `radius − fade`, then a smoothstep to 0 at the radius. The fade
  runs from 1.5 node spacings, the narrowest the grid holds, at falloff 0 to the whole radius at
  falloff 100 %, so every step of the slider changes the result. The panel states the fade.
- **Activation.** All of a handle's radius guides are scaled by a smoothstep that rises from 0
  at one local node spacing of radius to 1 at two, so the surface is continuous in the radius.
- **Terms.** At each node a handle has a profile: unmoved, `w`, holding softly over its radius;
  moved, 1 out to the radius, fading over a band of 2.5 spacings (3.5 at falloff 0) to a quarter,
  then to 0 over 10 more spacings. It drives the node toward `baseline + offset` at stiffness
  `κ w diag` and holds it at its baseline for the rest of the profile, so alone it targets
  `baseline + w × offset`, never more than the offset. A holding term, and all of an unmoved
  handle's profile, gives way by the largest driving weight any other moved handle has there.
  Unmoved becomes moved over the first quarter spacing of travel, so nothing jumps. `κ = 4`.
- **Accumulation.** Stiffnesses add and the target is their stiffness-weighted mean; nothing
  depends on the order of handles. Gap-target nodes get no guides.
- **Solver.** `solveWarp` takes the per-node guide set. Guide nodes and stiffnesses are part of
  the cached system's key; targets are not, so a drag reuses the system.
- **Edits.** A radius or falloff change only recomputes reach and weights; nothing settles on a
  slider frame. Each slider gesture has one owner and is one undo step.

On a fine flat sheet with a far fixed border, a point lifted by `h` with falloff 100 % falls
monotonically from the point, is 0.957 h at a tenth of the radius, within 0.08 h of
`h × smoothstep` across the radius and under 0.02 h beyond it.

### 5. Feathered edge

Region stage, painted regions only: **Feather edge**, off by default, with a width in mm
(fitted logarithmic slider, starting at Warp's brush radius). The choice is remembered for
the page session. Off, or width 0, builds exactly today's region with its fixed edge.

- **Growth.** The build worker keeps the painted-face mask, builds whole-mesh welded
  topology once, and runs a bounded Dijkstra over world-length edges outward from the
  painted edge through unpainted vertices. Unpainted faces with all three vertices within
  the width join the region. Role, grid, solve and the fixed border then come from the grown
  region, so the painted edge is free.
- **Blend.** Every welded vertex gets `b`: 1 on painted faces, 0 on the actual outer border,
  and between them a smoothstep of `d_out / (d_in + d_out)`, its surface distances to the
  outer border and to the painted edge. Endpoints are set explicitly.
- **One written surface.** `warp-evaluate` blends once, in the welded world buffer, before
  the local write: `rest + b × (skinned − rest)`. Folds, normals, moved bounds and upload
  ranges all read that. The outer border keeps its position and normal bits.
- **Handles stay on the paint.** A handle can be added only on a painted face, and
  rebinding drops samples whose face is no longer painted. A handle's reach stops at the
  painted edge; the band carries the bend the rest of the way. Painted corners have `b = 1`,
  so bindings and pins need no blend.
- **Readouts.** The grid overlay draws nodes at their written positions and draws the band
  fainter. The seam readout measures painted vertices only. Close gap targets painted nodes
  only.
- **Coarse meshes.** Where triangles beside the paint are larger than the width, nothing
  can join and that stretch keeps a fixed edge. If no face joined at all, the panel says the
  mesh is too coarse there for that width.

Acceptance: on a dense sheet with a six-ring band or wider, the change in angle between
adjacent faces at the painted edge and at the outer border is under a fifth of what the same
drag gives with feathering off; vertices outside the band keep exact bits; the same on a
mirrored, non-uniformly scaled part.

### 6. Line and area handles

In the Warp stage an **Add** selector chooses what a press on the surface makes:

- **Point**: a click adds a control point (today).
- **Line**: press and drag draws a line; release makes one line handle.
- **Area**: press and drag paints with Warp's brush; release makes one area handle from the
  faces painted in that stroke.

**Input.** A stroke is a draft owned by one pointer. On press, camera navigation, pivot
picking, free transform, gizmo handles and point markers take priority over starting one.
An unmodified primary drag on the region draws; middle, right and Space navigation still
work. Release commits once; Escape, pointer cancel and window blur discard. The click that
ends a stroke adds no point, also when a short line is rejected. Hits come from the warped
preview. A line breaks where the pointer leaves the surface or jumps to a disconnected
spot, and only its longest run is kept. Area painting measures distance on the warped
preview and connectivity on the source mesh, and does not touch the region or its paint
history.

**Handle.** One selectable object: `kind`, immutable samples (each a surface binding with
its pin), for an area its source faces, shared radius and falloff, and one target for its
centre. It is selected, moved, deleted and undone as one; all its samples move by the same
translation. In a multiple selection, rotate and scale move handle centres about the pivot,
as for points. Snap to neighbour snaps the centre and carries the rest with it. It is drawn
as its line or its tinted area with one marker at the centre.

**Samples.** A line is resampled by arc length to half the local node spacing; an area
takes up to a few dozen face centres spread by farthest-point sampling, always including
the first hit. Samples with the same bound nodes are merged, so pointer speed does not
change stiffness. An area smaller than a grid cell still has several samples, so it lifts a
small plateau rather than a peak.

**Reach.** The footprint is the nodes bound to the samples, plus for an area the nodes on
its faces. Section 4 applies with distance measured from the footprint: radius 0 gives a
continuous ridge or a rigid patch, and a radius above 0 adds the smooth skirt.

Acceptance: along a line handle moved by `h`, the written surface between samples stays
within `0.1 h` of `h`; several interior points of an area do the same, including an area
smaller than a cell and a 60-node grid.

### Data model

`WarpPoint` is a `WarpHandle`: `kind` (`point`; `line` and `area` are reserved), immutable
samples, for an area its source `faces`, `radius`, `falloff`, `auto`, one `target` (null while
unmoved), `baseline` (a shared snapshot) and a cached `reach`. `moveWarpPoints` keeps taking one
target per handle.

Each session undo step holds the points, gap targets, the settled grid they held and the
settings new points take, so undo restores the surface exactly without solving. Laying the
same region at the same density and feather keeps the model. A real rebuild carries each
distinct snapshot to the new grid once, through the old binding of each new node's scan vertex,
rebinds samples, dropping those bound exactly as another and an area's faces no longer painted,
and drops handles whose samples are bound only to fixed nodes, from the session and its undo
steps; undo across it settles from the carried grid. A vertex in the old feather band that the
new region paints is carried at the position it was written at; where a feather still applies,
it stays unblended so the blend applies once.

A pure module, `warp-handles.ts`, turns handles and a model into solver input: reach, weights,
guides, snapshots and their transfer, and distribution. It is unit-tested without the store.

## Approaches considered

**Radius and falloff.** (1) Keep the sample constraint and add soft guides whose target and
stiffness both taper (chosen). (2) Hard targets on every node in reach: review showed it
loses the barycentric constraint (a 1 mm drag moved the grabbed surface 0.33 mm in a hard
case), has no answer where two handles both demand exactness, and switches a strength-1000
row on at the radius. (3) A second-order energy so points stop spiking unaided: no radius to
set, and a new solver.

**Baseline.** (1) Guides relative to rest: dragging a point on an already bent limb would
dent a ring around it. (2) Guides relative to where the surface was (chosen).

**Feather.** (1) Grow the region and taper the written displacement (chosen). (2) Clamp
rotations at border nodes: smoothness would depend on grid density. (3) Taper inward only:
nothing outside the paint moves, which is not what was asked.

**Lines and areas.** (1) One handle, many samples, one translation (chosen). (2) Group
existing points: each still spikes and carries its own radius. (3) A full pose per handle
with rotation and scale: every transform entry point discards those for a single target
today; not asked for.

## Order of work

1. In parallel: (a) grid contrast and Warp's brush; (b) handle model, radius and falloff,
   Distribute points; (c) feather growth and the written surface.
2. Merge. Line and area handles on top of (b).
3. Integration: reach stops at the painted edge; handle eligibility and Close gap with
   feather; end-to-end checks; release note in `src/docs/changelog.ts`.

## Verification

- Unit: the acceptance figures above; radius 0 reproduces today's constraints bit for bit;
  a pin added after a deformation changes nothing; overlapping handles; a coarse grid and an
  off-grid point; Close gap on a whole-part seam with automatic points; distribution is even
  and deterministic; welded duplicates stay identical; a closed mesh stays closed.
- End to end: whole part with automatic points bends instead of translating; a line drag
  gives a ridge, moves no camera and adds no stray point; radius and falloff change the
  result; feather leaves no crease; Apply, undo, cancel, density change.
- Performance: `warp-benchmark` before and after, plus a wide handle on a 4000-node grid.
- Existing warp unit, session and e2e suites pass (with the whole-part fixtures choosing
  their pin policy explicitly); `npm run build` and `npm run format:check` pass.
