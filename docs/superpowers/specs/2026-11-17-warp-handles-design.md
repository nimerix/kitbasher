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
button. It adds that many unmoved points by farthest-point sampling over the grid's free
nodes, measured along grid edges, seeded by the points already present. It is deterministic
(fixed first seed and tie-break), never puts two points on one node, gives each disconnected
piece of the region a point before doubling up, and stops at the number of free nodes. Each
point sits on a node's own scan vertex and pins the surface where it is now. One session
undo step.

Distributed points are ordinary points with radius 0 (section 4), marked automatic until
the user moves or edits them.

When the region is effectively the whole part (Whole part, or Painted with nothing
painted), the Region stage shows "Place points automatically" (on, with the same count),
and the first lay of the grid distributes them. Changing density, returning from Edit
region, or deleting them never places them again. Close gap removes automatic points that
are still untouched and sit on the nodes it is about to pull, in the same undo step, so a
seam still closes; points the user placed or moved are kept.

### 4. Radius and falloff

Every handle (a control point, or a line or area from section 6) has a **radius** in mm and
a **falloff** from 0 to 100 %, edited in the Control points section for the selected
handles. New handles take the last values used. Radius is 0 ("point only") or a value on a
fitted logarithmic slider. Defaults: radius 6 % of the part's size, but no more than a
quarter of the region's extent; falloff 100 %.

The handle's sample constraints stay exactly as they are today, at every radius: they are
what puts the grabbed surface on the target. Radius adds **guides** around them.

- **Reach.** One bounded multi-source Dijkstra over grid edges (world rest lengths), seeded
  from the nodes each sample is bound to, at their distance from the sample. Free nodes
  within the radius are in reach. Cached per handle; falloff remaps cached distances.
- **Weight.** `w` is 1 out to `radius × (1 − falloff)`, then a smoothstep to 0 at the
  radius. Falloff 0 is a hard-edged plateau, with no division by a zero width.
- **Guide.** Each node in reach gets a soft target `base(n) + w × D`, where `D` is how far
  the handle has moved from its pin, at stiffness `κ × w × (that node's edge diagonal)`.
  Stiffness reaches zero at the radius, so nothing switches on abruptly there.
- **Baseline.** `base(n)` is where the node was when the guide was made, so an unmoved
  handle's guide holds the surface as it is and adding a handle changes nothing. Whenever a
  handle's reach is rebuilt (radius change, density change), `base(n)` is the node's current
  settled position minus `w_before(n) × D`, with `w_before` the weight that node had from
  this handle before the change. After a density change this reproduces the shape that was
  there; after a radius change it widens or narrows the handle's own bump.
- **Several handles on one node.** Stiffnesses add, and the target is their
  stiffness-weighted mean. There is no case with two exact but different answers: only
  sample constraints are exact.
- **Solver.** `solveWarp` takes an optional per-node guide set (node, stiffness, target):
  one diagonal term and one right-hand-side term per node. Guide nodes and stiffnesses are
  part of the cached system's key; targets are not, so a drag reuses the system.
- Gap targets stay full-strength constraints and are not skipped under a guide.
- If the radius reaches no node beyond the sample's own, the handle behaves as radius 0 and
  the panel says that a finer grid would let the radius take effect.

`κ` is the builder's to set. It is right when, on a fine flat sheet with a far fixed border,
a point lifted by `h` with falloff 100 % gives a written surface that falls monotonically
from the point, is at least `0.9 h` at a tenth of the radius, within `0.1 h` of
`h × smoothstep` across the radius, and under `0.03 h` beyond it.

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

`WarpPoint` becomes the handle above. A point is a handle with one sample and keeps its
`target` meaning. `moveWarpPoints` keeps taking one target per handle. `selectedPoints`,
session undo (which compares radius and falloff as well as targets), rebinding after a
density or region change, undo snapshots, Apply's restart and the live-refusal recovery all
carry handles. Rebinding drops samples whose face left the region and a handle with none
left.

A pure module, `warp-handles.ts`, turns handles and a model into solver input: reach,
weights, guides and baselines, and farthest-point distribution. It is unit-tested without
the store.

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
