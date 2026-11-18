# Warp: visible grid, fitted brush, handles with reach, feathered edges

Status: design, under review. Date: 2026-11-17. Follows
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
- Everything a session could do before still works, and a point with radius 0 solves exactly
  as today.

## Non-goals

- Phase 2 topology change, MCP tools, headset support, re-editable warps.
- Changing the Align tool's contact brush. It keeps its slider.

## Anti-goals

- Moving a vertex outside the region the user can see. With feathering on, the feather band
  is part of what is shown; everything beyond it and its outer border keeps exact bits.
- Slower drags. A drag frame must cost what it does today for the same grid.
- Export bytes changing for parts that were not warped.

## How it works today (what the change touches)

- `warp-region.ts` welds the part and marks welded vertices Outside, Border or Interior from
  the painted faces. `warp-grid.ts` simplifies the region to 60–4000 nodes (real scan
  vertices); border nodes are `fixed`.
- `warp-solve.ts` runs ARAP on the grid. A `WarpConstraint` ties a weighted set of nodes to
  a world target at strength 1000. Gap targets already use one single-node constraint each.
- `warp-bind.ts` skins every dense vertex to its 4 nearest nodes by surface distance.
  `warp-evaluate.ts` writes skinned positions for interior vertices only.
- `store.ts` holds the `WarpSession`: `points: WarpPoint[]` (face, barycentric, binding,
  pin, target), `gapTargets`, session undo. `transform-selection.ts` presents selected
  points to the transform tools as position-only targets.
- `WarpOverlay.tsx` draws the grid as 1 px `lineBasicMaterial` `#b9e3dd` at 55 % opacity.
  The Distinct palette is OKLCH lightness 0.62–0.84, so the two are nearly the same tone.
- `SurfaceBrushControls.tsx` (shared with Align) has a linear 0.1–20 mm slider.

## Design

### 1. Grid contrast

Draw grid edges as fat lines (`LineSegments2`/`LineMaterial` from three's examples, which
drei already ships): a dark core about 1.5 px wide over a light casing about 3.5 px wide at
partial opacity. One of the two contrasts with any surface colour; the dark core is what
reads on the Distinct, Editor and typical scan colours. Depth testing stays on so the far
side stays hidden. Positions still update in place per drag frame.

Acceptance: over each of the first 24 Distinct colours, and over white and near-black parts,
in the light and dark themes, a pixel probe finds grid pixels at a contrast ratio of at
least 3:1 against the surface next to them.

### 2. Brush size fitted to the part

`SurfaceBrushControls` gains an optional range. Warp passes one fitted to the part: 0.1 mm
to a quarter of the part's largest world dimension (clamped to 2–100 mm), on a logarithmic
slider, so each doubling of size takes the same travel. A 32 mm model gets 0.1–8 mm with
about 0.9 mm at mid-travel. The numeric field steps by 0.1 mm. When a warp starts, a radius
above the fitted maximum is brought down to it. Align passes no range and is unchanged.

### 3. Even pins ("Distribute points")

A **Distribute points** control in the Control points section: a count (8, 16, 32; default 16) and a button. It adds that many unmoved points, spread evenly by farthest-point sampling
over the grid's free nodes, measured along grid edges, seeded by the points already there so
repeated use fills gaps. Each point sits on a node's own scan vertex. It is one session undo
step.

With **Whole part**, the Region stage shows "Place points automatically" (on by default,
with the same count) and laying the grid distributes them, so the first drag bends the part
instead of carrying it away. Painted regions have a fixed border and start with no points,
as today.

### 4. Radius and falloff

Every handle (a control point, or a line or area from section 6) has a **radius** in mm and
a **falloff** from 0 to 100 %. Both are edited in the Control points section for the
selected handles; new handles take the last values used. Radius uses a fitted logarithmic
slider like the brush, plus 0. Defaults: radius 6 % of the part's largest dimension,
falloff 100 %.

- Radius 0 is today's behaviour: the handle constrains its sample points only.
- Radius above 0: the handle's **core** is the grid nodes its samples are bound to. Every
  free node within the radius gets a displacement weight `w`: 1 across the core and out to
  `radius × (1 − falloff)`, then a smoothstep down to 0 at the radius.
- Distance is straight-line distance in rest space from the node to the nearest core
  sample, counted only for nodes reachable along grid edges within 1.5 × radius, so reach
  never jumps a thin wall and the falloff is round rather than following grid edges.
- A node's target is its rest position plus the blend of the handles reaching it. With
  `δ_h(n)` the displacement handle `h`'s pose gives node `n`, and `u_h = w_h / (1 − w_h)`:

  `D(n) = (Σ u_h δ_h(n) / Σ u_h) × (1 − Π (1 − w_h))`

  A handle's core moves exactly with it (`w = 1`), an unmoved handle's core stays exactly
  put, and overlapping reaches blend smoothly.

- Each node in reach becomes one single-node `WarpConstraint`, as gap targets are. The
  solver is unchanged; it still fits a rotation per node, so surface detail turns with the
  bend rather than shearing. Beyond every radius the ARAP solve acts as today.
- An unmoved handle with radius 0 stays a point pin. Inside another handle's reach its bound
  nodes hold (`w = 1`, zero displacement), which leaves a dimple there; that is the pin the
  user placed, and raising its radius or deleting it smooths it.
- Reach (the node set and weights) depends on the core and radius only, so it is cached per
  handle and a drag frame only rewrites targets. The constraint key the solver caches on
  stays the same through a drag.
- Gap targets on nodes that a handle also reaches: the handle wins, the gap target is
  skipped for that node.

### 5. Feathered edge

Region stage, painted regions only: **Feather edge** (on by default) with a width in mm
(fitted slider; default 4 % of the part's largest dimension).

- The model build takes the width. It grows the region outward: a multi-source Dijkstra over
  the welded dense graph from the painted border, through unpainted vertices, bounded by the
  width. Faces whose three vertices are within the width join the region. The grid, the
  solve and the fixed border now belong to this grown region.
- Each welded vertex gets a blend `b`: 1 on painted faces, a smoothstep from 1 at the
  painted edge to 0 at the outer border across the band. `warp-evaluate` writes
  `rest + b × (skinned − rest)` for band vertices. Displacement and its slope both reach
  zero at the outer border, so no crease forms there, and the painted edge is no longer
  fixed, so none forms there either.
- Handles can only be placed on painted faces; a click on the band says so. A handle's
  reach may extend into the band, where the blend tapers it. Close gap only targets nodes on
  painted faces. The seam and fold readouts use the written positions, as now.
- The overlay shows the band: grid lines over it are drawn at the blended positions and
  fainter, and in the Region stage the band is not drawn (it does not exist until the grid
  is laid); the help text says the feather reaches past the paint.
- Width 0, or the toggle off, builds exactly today's region. Whole part has no edge and
  hides the control.

### 6. Line and area handles

In the Warp stage an **Add** selector chooses what a press on the surface makes:

- **Point**: a click adds a control point (today).
- **Line**: press and drag draws a line on the surface; release makes one line handle from
  the stroke, resampled so samples are no farther apart than half the grid's typical edge.
- **Area**: press and drag paints with the brush (same radius control and cursor); release
  makes one area handle from the faces painted in that stroke.

Strokes that leave the region are clipped to it. A stroke shorter than a few pixels in Line
mode adds nothing. Drawing suppresses camera orbit the way region painting does.

A handle is one object with many samples. It is selected, moved, deleted and undone as one,
and shown as its line or its tinted area with one marker at its centre.

- It is presented to the transform tools as one target with a position, rotation and scale.
  Moving translates every sample; rotating or scaling a line or area handle on its own
  turns or sizes it about its centre (a single point still ignores rotate and scale).
  Sample targets are the handle's pose applied to its samples' pins.
- With radius 0, a line constrains every sample (a continuous sharp ridge), and an area
  constrains every grid node inside it rigidly (falling back to its centre sample if it
  holds no node).
- With radius above 0 the core is the nodes the samples are bound to (line) or the nodes
  inside (area), and section 4 applies: the whole line or area moves as one flat-topped
  shape with a smooth skirt.

### Data model

`WarpPoint` generalises to a handle: `kind` (`point`, `line`, `area`), `samples` (each
with face, barycentric, binding, rest position, pin), `radius`, `falloff`, and a pose that
is null while unmoved. `selectedPoints`, session undo, rebinding after a density change,
and the applied-warp recovery path all carry handles. Rebinding drops samples whose face
left the region and drops a handle with none left.

A new pure module (`warp-handles.ts`) turns handles and a model into solver constraints:
reach and weights (cached), per-frame targets, and farthest-point distribution. It is
unit-tested without the store.

## Approaches considered

**Radius and falloff.** (1) Prescribe a falloff displacement on the nodes in reach and let
ARAP supply rotations and everything beyond (chosen). (2) Soft constraints whose stiffness
falls off: the shape then depends on the balance against ARAP's edge weights, not on the
falloff the user set. (3) A biharmonic or second-order energy so point handles stop spiking
on their own: no radius to set, and a new solver. (1) gives the two numbers the product
owner asked for an exact meaning and leaves the solver alone.

**Feather.** (1) Grow the region and taper the written displacement (chosen). (2) Clamp
rotations at the border nodes so the solve itself meets the border flat: the grid is coarse
there and border triangles are poor, so smoothness would depend on density. (3) Taper
inward only: nothing outside the paint moves, which is not what was asked.

**Lines and areas.** (1) One handle with many samples and a pose (chosen). (2) Group
existing points: they would still each spike at radius 0 and each carry its own radius.

## Order of work

1. Grid contrast and brush range (independent, small).
2. Handle model, radius and falloff, Distribute points.
3. Line and area handles, on top of 2.
4. Feather, on top of 3.
5. Release note in `src/docs/changelog.ts`; `docs/design.md` where it describes Warp.

## Verification

- Unit: reach weights (core 1, zero at radius, monotone, no wall jumping); blend formula at
  cores and overlaps; radius 0 reproduces today's constraints bit for bit; distribution is
  even and deterministic; feather keeps exact bits outside the band and on its border, and
  the written displacement and its gradient vanish at the outer border; welded duplicates
  stay identical; a closed mesh stays closed.
- End to end: whole part with auto points bends instead of translating; a line handle drag
  gives a ridge with no per-sample peaks; radius and falloff sliders change the result;
  feather on leaves no crease; Apply and undo still work.
- Existing warp unit, session, benchmark and e2e suites pass; `npm run build` and
  `npm run format:check` pass.
