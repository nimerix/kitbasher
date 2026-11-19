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
- `warp-solve.ts` runs ARAP on the grid, its edges weighted by their cotangents at rest (clamped
  to 0.5–10, an equilateral grid's being 1), so an uneven grid bends as smoothly as an even one
  and a node close to the fixed border follows it. Each iteration refines its warm-started
  rotations three steps. A `WarpConstraint` ties a weighted set of nodes to
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

A grid edge is a straight chord between two scan vertices, so on a convex surface its middle
runs under the surface and is hidden however it is coloured. Each edge is therefore laid on
the surface (`warp-grid-path.ts`): it is traced across the region's triangles along the plane
through its chord and the nodes' averaged normal, and keeps points where it crosses mesh
edges. Every edge keeps every point it crosses, up to 256, while 32,000 in all hold them;
beyond that, every edge keeps evenly spaced ones, as close as the total allows. A coarse grid
has few edges, so its long edges keep all their points and follow the surface as soon as it
bends; a fine grid's short edges cross few. A walk that fails is retried from the other node and
with each node's own normal; if every walk fails, the edge follows the shortest bounded path
over mesh edges, or is not drawn. The trace runs a few milliseconds at a time; until it is
done, edges are chords.

The trace keeps every point it found. Once the written surface has stayed put a moment, the
solve has settled and no drag is under way, the drawn line is checked against it, a few
milliseconds at a time: the furthest any found point lies from the segment drawn through it.
Only a line that strays by more than 0.1 mm, or a pixel where that is less, has its points
chosen again: each edge keeps evenly spaced points within half the total, then the points
furthest from the line drawn so far go in wherever on the grid they are, up to 512 per edge and
32,000 in all. While a solve settles in idle time the points stay as they are, so a settled
edit chooses them again once at most, and in the ordinary case not at all. Each point chosen
again remembers how far it bent the line; a view leaves out those that bend it by less than half
its smallest pixel on the grid, and never by more than 0.0375 mm, so a chord never dips under
the pull toward the camera. Evenly spaced points always show.

Coarser nets of the grid's own edges keep a readable grid when its cells are too small to show:
level k picks nodes of the net below about 2^k typical edges apart along it and joins each two
whose shares of it meet by the shortest way along it, up to three levels. Each comes in over an
octave of its own cells as the net below it goes, its core from 10 to 20 px and its casing, which
shows only on dark parts, from 24 to 48 px; the first net's core comes in only as the grid's own
is nearly gone, so on a light part the grid covers no more than it does at default density. Edges
are drawn coarsest first, and each draw leaves out the levels whose largest cell is too small on
screen for it to show.

Edges are drawn as screen-space quads (`WarpGrid.tsx`) in two draws over one instanced
geometry: an opaque dark core 1.5 px wide, and a light casing 4 px wide drawn first with MAX
blending, so it lifts only what is darker than itself and leaves light and mid colours alone.
The core is full while cells are 13 px or more on screen (shrunk as the surface turns away),
then thins to 1 px and fades out by 6 px; the casing fades out between 22 and 12 px cells.
Each corner's depth is where its view ray meets the surface's tangent plane at the line, then
nearer by at most a pixel or 0.05 mm, and never more than halfway to the near plane, so any
opaque surface 0.2 mm or more in front hides the line in either projection at working
distance. At overview distance, about 400 mm, the perspective camera's 0.1 mm near plane
leaves depth too coarse to separate surfaces that close, as it does for everything else in the
editor. Segment ends are uploaded when the surface is written; between writes, as when a large
region follows a drag on the grid alone, only a texture of node shifts is, measured from the
node positions in the written surface itself.

Reach dots and seam points are drawn after the grid, among transparent objects by render order,
and each fragment of a dot takes its depth from the surface's tangent plane at its point, drawn
nearer again by as much as the plane turns there but by no more than two pixels, so a whole dot
shows on a slope while a surface 0.2 mm or more in front hides it, or the part of it that it
covers, at working distance. While Interference inspection draws the part see-through, the grid
is hidden.

Acceptance: at about 300 px across at default density, no more than about a third of the
part's pixels change by more than 1.5:1; the core's centre reaches 3:1 over the first 24
Distinct colours and white at that zoom and close up, from two directions; the line reaches
3:1 on a near-black part; at least 90 % of front-facing grid length is visible on the curved
part; the far side, the other sheet of a thin shell and anything 0.2 mm or more behind an
opaque surface do not show through at working distance; the grid stays on the written surface before and after
deformation, no drawn point more than 0.1 mm off it on a coarse grid over a fine mesh from the
first surface written after a pull, and no line moving once it is released; at the
highest density a coarser net still shows as the part is zoomed out, without a sudden change.

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
  samples or gap targets share its nodes, an unmoved one also where it is bound to a free node a
  moved handle's samples are bound to or beside one, and by how firmly guides hold its nodes
  where they do (the nodes a handle moves as one do not count), so the surface stays continuous
  in the radius. A moved point then lands on its target within 0.01 mm at default density and
  0.03 mm on the coarsest grid, unless a point the user placed beside it or the fixed edge holds
  it; its marker shows where the surface is and the gizmo stays on the target. A drag frame
  solves without priority, so it costs what it did.
- **Carry.** A moved handle bound partly to fixed nodes, or whose constraints fight an unmoved
  handle the user placed on or beside its nodes, carries only the share of its offset the
  surface can take; its constraints and guides move by that share, and it stops short. The share
  comes from the solve's linear response to the handle's travel with rotations held (one more
  conjugate-gradient solve on the system the solve builds anyway): no node moves more than 1.25
  times the travel, an unmoved point the user placed moves no more than 0.005 mm, no edge with an
  end on a fixed node, or on such a point that must hold, rises by more than its rest length, and
  no node map beside one loses more than half its determinant. Otherwise the stiff constraint
  reached its target by overdriving the few free nodes it had: on a scan a 1 mm pull beside the
  fixed edge moved a node 4.5 mm and turned node maps inside out. Handles on free surface with no
  such pin beside them are left alone. The panel states a moved handle's shortfall from its
  target, and an unmoved one's drift from its pin, once either exceeds 0.02 mm.
- **Settling.** The end of an edit settles for up to 50 iterations. A solve whose last iteration
  still moved a node by 1 µm or more is marked settling and goes on in idle steps of 8 ms,
  redrawing every 200 ms and counting folds on each redraw, until it converges (or 20,000
  iterations). Beside Apply the panel says the surface is still settling. Undo restores the
  surface exactly as shown, settling on from there if it was. Apply bakes the preview as shown,
  and only a settled one: pressed while settling, the button shows it is applying and the settle
  finishes in the same idle steps, so input goes on, then bakes. Any edit before then (another
  drag, undo, a density change, Edit region), Cancel or leaving the tool drops the waiting Apply.
  Apply and Cancel let go of the session the idle steps were settling. An edit that changes
  nothing settles nothing.

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
  Unmoved becomes moved over the first quarter spacing of travel, so nothing jumps. `κ = 4`,
  of the node's diagonal from its weighted edges.
- **Fixed edge.** Where a radius reaches a fixed edge the paint meets directly, the drive fades
  to it as at the radius: `w` times a smoothstep of the node's distance from that edge over the
  fade. A feathered band between them carries the bend instead.
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

In the Warp stage an **Add** selector in the Control points section chooses what a press on the
surface makes, and says so in a line:

- **Point**: a click adds a control point (today).
- **Line**: press and drag draws a line; release makes one line handle.
- **Area**: press and drag paints with Warp's brush (its radius, cursor and size shortcuts, and a
  radius field under the selector); release makes one area handle from the faces painted in that
  stroke.

**Input.** A stroke is a draft owned by one pointer (`WarpStroke.tsx`). It starts only on an
unmodified primary press on a painted face of the warped part, when no camera navigation (middle
and right buttons, Space, the orbit and pan tools), pivot picking, free transform or exploded view
is in force; a point marker stops the press before it reaches the surface. The camera's controls
are switched off for that press, so a stroke never orbits, and a primary drag that begins off the
region still does. A gizmo handle hears the press after the surface does, so the first pointer move
or the release after a gizmo press discards the draft. The pointer's path is sampled every 2 screen
pixels, whatever the pointer's speed, by a raycast on the warped preview that another part in front
blocks. Release commits once; Escape, pointer cancel, lost pointer capture, window blur, camera
navigation starting and the session changing discard. The click that ends a stroke adds no point
and changes no selection, also when a line is rejected; in Line and Area mode a click adds nothing.
A line shorter than 4 px makes nothing; an area from a press alone is the one dab.

A line breaks where the pointer leaves the paint or jumps to a disconnected spot: two successive
hits are joined when they share a bound node, or when the grid joins their nodes by a path no
longer than 1.5 times the straight line between them plus 2.5 node spacings. Only the longest run,
by length at rest, is kept.

Area painting measures distance on the warped preview, in world space, from the hit to each
triangle, and connectivity on the source mesh: it walks the warp region's own welded triangles
from the hit face through painted faces turned within about 78° of the hit face, as region
painting picks them. It never touches the region or its paint history. The region's triangles
around each welded vertex are listed once per grid: on a 4.2-million-triangle part the first dab
costs 36 ms, where the first region dab builds whole-mesh face adjacency in 4.0 s; later dabs cost
under a millisecond. Dabs are a quarter of the brush radius apart along the stroke.

**Handle.** One selectable object: `kind`, immutable samples (each a surface binding with its pin),
for an area its source `faces`, for a line its drawn `path` (up to 512 spots on faces, for drawing
only), shared radius and falloff, and one target for its centre. A line's `pin` is the surface
halfway along the stroke; an area's is the surface at the face centre nearest its area-weighted
centroid; both are pinned where the surface is shown, as a clicked point is. It is selected,
moved, deleted and undone as one; all its samples move by the same translation. In a multiple
selection, rotate and scale move handle centres about the pivot, as for points, and a single line
or area ignores them. Snap to neighbour snaps the centre and carries the rest with it. Making one
is one session undo step and selects it; a new line or area takes the panel's radius and falloff,
its default radius from the spacing at its samples' nodes.

It is drawn as its line on the written surface, or its faces hatched in diagonal stripes of the
handle colour and a dark tone with their outline, and one marker at the centre. Lines are a dark
5 px casing under a 2.5 px core in the point markers' colours (selected and idle), drawn 4 px
nearer the eye so a line's width does not sink into a surface sloping across it; the stripes leave
the surface showing between them. Shapes are built when a handle's path or faces change; a solve
only rewrites their positions, read from the preview. While drawing, the line so far or the faces
painted so far are drawn the same way on the warped surface, appended in place.

**Samples.** A line's hits are taken about every half local node spacing along the surface at
rest, keeping the first and the last, then one sample is kept for each set of grid nodes the
inner ones are bound to, so pointer speed does not change stiffness; both ends are always kept.
An area takes up to 32 face centres spread by farthest-point sampling at rest from the first hit,
at least 4 and about half a node spacing apart; an area of fewer than 4 faces also offers a spot
toward each corner of each face, so even one face has several samples and lifts a small plateau
rather than a peak. On the 32 mm torso scan, a line drawn across the chest took 35 samples and one
across the shoulder 10; an area painted on the chest took 3,300 to 3,500 faces and 32 samples, and one on
the shoulder 1,501 faces and 13.

**Footprint.** A line or an area moves as one the free nodes within 0.75 node spacings (each
node's own) of the line through its samples in order, or of an area's samples, found by walking
the grid from the nodes the samples are bound to; a sample with none of its nodes among them adds
its most heavily bound one; an area also moves the free nodes on its faces. Every bound free node
seeds the reach's paths, and straight-line distance is measured from the samples and an area's
outline. Taking every node a sample is bound to, as first written, made the ridge's width depend on
which triangles the samples fell in: a binding reaches one to one and a half spacings, unevenly to
either side, and two samplings of one stroke differed by a quarter of the lift. Section 4 applies
with distance measured from the footprint: radius 0 gives a continuous ridge or a rigid patch, and a
radius above 0 adds the smooth skirt.

Acceptance: along a line handle moved by `h`, the written surface between samples stays within
`0.1 h` of `h`, and no local maximum stands more than `0.05 h` above its neighbours; several interior
points of an area do the same, including an area smaller than a cell and a 60-node grid; the same
stroke drawn slowly and quickly gives results within `0.02 h`. Measured: a line within 0.017 h
(radius 0: 0.005 h) with no peak above 0.011 h at default density, within 0.012 h on a 60-node
ball; areas within 0.01 h; slow and quick within 0.002 h. On the 32 mm torso scan, lifted 1.92 mm,
a line across the chest stays between 1.912 and 1.921 mm (default radius: 1.901 and 1.927), where
points placed along the same path range from 0.71 to 2.03 mm.

### Data model

`WarpPoint` is a `WarpHandle`: `kind` (`point`, `line` or `area`), immutable samples, for an area
its source `faces`, for a line its drawn `path`, `radius`, `falloff`, `auto`, one `target` (null
while unmoved), `baseline` (a shared snapshot) and a cached `reach`. `moveWarpPoints` keeps taking one
target per handle.

Each session undo step holds the points, gap targets, the settled grid they held and the
settings new points take, so undo restores the surface exactly without solving. Laying the
same region at the same density and feather keeps the model. A real rebuild carries each
distinct snapshot to the new grid once, writing each new node where the preview's own skinning
wrote its scan vertex, and rebinds samples, dropping those bound exactly as another. A line keeps
its longest unbroken run of painted samples and its drawn path between them; an area keeps its
largest connected piece of painted faces and the samples on it. Either is centred again on what is
left, its target moved by as much as its centre; a line left with fewer than two samples, or an area
with none, is dropped with the notice that points were removed. A vertex in the old feather band that the new region paints is carried
at the position it was written at; where a feather still applies, it stays unblended so the blend
applies once.

A density change that would drop any handle, because every node its samples would be bound to on
the new grid is fixed, is not made: the session keeps its grid and density and says that grid is
too coarse for the points on this region. Laying a new region is not made either when it would
leave a moved handle bound only to fixed nodes; a handle the repaint leaves outside the paint is
dropped with a notice, and so is an unmoved one left on the new region's edge.

A density change is one session undo step, and so is laying the grid on a changed region. The
steps before it stay on the grid they were recorded on: their snapshots name a stand-in for it,
their points let go of their reach and of binding arrays the solver caches against the old grid,
and the step the change records keeps the region as painted, the density and feather that grid was
laid from, with a hash of the model built. Undoing it rebuilds that grid (the build is
deterministic, one build's time), checks the hash, puts every step recorded on it back on the
rebuilt grid and restores the region, the handles and the surface exactly; undoing further restores
each earlier step exactly, and undoing an earlier layout step rebuilds the grid it names in turn.
Steps recorded on still earlier grids keep their own stand-ins and grid steps untouched. A rebuild
that hashed differently would settle those steps again from rest and say so. Only the current
handles are carried to a new grid.

A pure module, `warp-handles.ts`, turns handles and a model into solver input: reach, weights,
guides, snapshots and their transfer, and distribution. It is unit-tested without the store.
`warp-strokes.ts` turns a stroke into samples: line resampling and merging, break detection, the
area brush and area sampling; `addWarpStroke` in the store builds the handle.

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
