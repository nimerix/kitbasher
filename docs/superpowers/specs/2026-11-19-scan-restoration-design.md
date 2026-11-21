# Refine: sharp edges and clean surfaces on scanned parts

Status: approved 2026-11-19, then revised the same day with the product owner's answers to
its four questions. Date: 2026-11-19.

Lines marked (product owner) record what the product owner said in the intent interview
or in answer to the draft's questions.
Everything else is proposed here and open to change.

The section "Changes made while building" lists where the tool as built differs from the
text approved on 2026-11-19. The affected lines below are brought in line with it.

## Intent

3D scans of small parts lose sharpness and defined detail. A feature with a sharp 90 degree
edge comes back with a fillet around the edge, and surfaces that were continuous come back
with ripples. People usually fix this with a crease brush for interior and exterior edges
and a flatten or smooth brush for surfaces. That handles simple problems, but continuous
features, such as long straight edges or edges that follow a curve, end up looking
distorted. (product owner)

Refine is one tool in Kitbasher for this job. It has four parts that work together
(product owner):

- **Guided edges.** Lay a line, arc or spline along a softened edge. The tool rebuilds the
  edge as an idealized one.
- **Painted regions.** Brush-select an area, then smooth it, flatten it or snap it to a
  shape.
- **Freehand brushes.** Crease, flatten and smooth, for local fixes.
- **Automatic proposals.** The tool detects edges and surfaces and proposes them as
  editable guides and regions to accept or adjust.

### Reference parts

Two scans and a reference photo of each original (top and bottom) came with the request.
Measured from the STL files:

| Part | Triangles | Size (mm)          | Median triangle edge |
| ---- | --------- | ------------------ | -------------------- |
| 45   | 861,910   | 42.7 × 18.8 × 8.6  | 0.057 mm             |
| 57   | 827,970   | 20.0 × 31.7 × 16.7 | 0.058 mm             |

Both are closed: every edge is shared by exactly two triangles. At about 0.06 mm per
triangle, a fillet a few tenths of a millimetre wide spans several triangles, so the mesh
is dense enough to hold a sharp edge.

## Goals

- A softened edge becomes a crisp, idealized edge that is straight, an arc or a smooth
  curve along its whole length, with no distortion along it. (product owner)
- A painted surface becomes a true shape, or loses its ripples and imperfections while
  keeping the scan's curvature, as the user chooses. (product owner)
- Detail that stands off a surface, such as the rivets on part 45, survives when the
  surface around it is flattened. (product owner)
- Automatic detection saves placing every guide by hand, without changing anything the
  user did not accept. (product owner)
- The whole job is done in Kitbasher. Nothing needs finishing in another program.
  (product owner)

## Non-goals

- One-click sharpening of a whole part with no review. (product owner)
- Checking dimensional accuracy against a CAD original. Success is judged by eye.
  (product owner)
- General sculpting beyond the three brushes named here (inflate, grab, clay and so on).
- Headset support and MCP tools. Refine is desktop only, as Warp is
  (`src/xr/runtime.ts:230`).
- Guides and regions that are saved with the scene and can be re-edited after Apply.
- Changing Warp, Align or the remesher.

## Anti-goals

- Moving a vertex outside the footprint the user can see. Each guide, region and brush
  shows the band it will change. Everything beyond it keeps its exact position bits.
- Applying a proposal the user has not accepted.
- Flattening or smoothing away detail the user did not ask to remove.
- Opening a hole or leaving a crack. A closed scan stays closed.
- Making existing features slower, or changing export bytes for parts that were not
  refined.

## Assumptions

These fill gaps the interview did not cover. Correct any that are wrong.

1. Refine works on one part at a time in a session with Apply and Cancel. Apply bakes the
   result into the mesh as one undo step. This follows Warp.
2. Apply leaves pins, anchors, pivot, joints and plane constraints as they were, and moves
   no other part. This follows Warp (`docs/design.md:60`).
3. "Laying out a line along a perimeter" means guides chain into paths: segments joined end
   to end, with corners, and closed loops.
4. A refined edge is fully sharp. There is no option to leave a small radius.
5. The detail offset measures deviation in either direction, so detail recessed into a
   surface (a groove, a dent) is kept in the same way as detail that protrudes from it.
6. The crease brush is a freehand guide: the dragged path marks the edge and its direction,
   and the same edge rebuild runs along it. The flatten and smooth brushes behave as in
   other apps and do not protect detail under them.
7. A refined edge may add triangles along itself. Elsewhere the triangle count does not
   change.
8. The two scans and reference photos stay outside the repository.

## Constraints

- The four parts ship together as one tool, not as separate features or phases.
  (product owner)
- Meshes are immutable and shared between pasted copies, undo history, the clipboard and
  caches. The preview must never write into `part.geometry`. Apply follows `applyWarp`
  (`src/core/store.ts:2978`) and its guards.
- Geometry can be indexed or non-indexed. Welding uses `weldedPositionIndex` at 1e-5
  (`src/core/mesh-topology.ts:5`), and every duplicate of a welded vertex must receive
  identical bits, or unindexed scans crack.
- Undo history has a byte budget of 1 GiB (`src/core/history-budget.ts:4`). A refined part
  is one step in it.
- `faceAdjacency` (`src/core/surfaces.ts:22`) runs on the main thread and is slow on very
  large meshes (12.6 s at 10 million triangles, `docs/verification.md`). Session setup
  belongs in a worker, as Warp's is (`src/core/warp-job.ts`).
- Warp does not change topology today, so nothing in the editor yet inserts vertices into a
  mesh while keeping it closed. Refine is the first tool that needs to.
- The browser build has no general sparse solver. `ml-matrix` is dense and suits small
  fits. Warp's conjugate gradient solver (`src/core/warp-solve.ts:480`) is specific to its
  grid.
- CI checks formatting and the build only. Tests run locally.

## Approaches considered

**What a guide controls.** (1) The guide is the edge: the surface is pulled to the drawn
line. (2) The guide is a hint: it marks which edge and its direction, and the edge is
solved from the surfaces on either side. **Chosen: 2 (product owner).** A guide sits on the
scan's rounded surface, which is inset from where a sharp exterior edge would be and outset
from where an interior edge would be, so the drawn position is never the answer.

**The surfaces on either side (flanks).** (1) One plane per side. (2) An independent fit at
every cross-section along the guide. (3) The simplest surface that fits each side within
the scan's noise: a plane, then a cylinder, cone or sphere, then a smooth surface swept
along the guide. **Chosen: 3.** Option 1 fails where an edge runs around a barrel or along
a tank. Option 2 lets each cross-section wander, which is the distortion along the edge
that brushes already give. Option 3 gives exact planes for a straight edge between flat
faces and still handles curved ones, and it shares one fitter with painted regions and
detection.

**Holding a sharp edge in the mesh.** (1) Move vertices only. (2) Move vertices, and where
a triangle would straddle the edge, snap a nearby vertex onto it or split the triangle, so
a chain of mesh edges lies exactly on the edge. (3) Remesh the band. **Chosen: 2.** With
option 1 the edge zigzags by up to a triangle's width, about 0.06 mm on these scans, and
shades as a sawtooth. Option 3 resamples the scan and softens detail nearby.

**Fitting a surface under detail.** (1) Least squares over every painted vertex. (2) A
robust fit that ignores vertices standing off the surface. **Chosen: 2.** With option 1 the
rivets on part 45 lift and tilt the plane fitted to their plate.

**Removing ripples.** (1) Plain Laplacian smoothing. (2) Low-pass smoothing that does not
shrink, run as repeated passes. (3) An implicit fairing solve. **Chosen: 2.** Option 1
shrinks the part and flattens curvature the user asked to keep. Option 3 needs a sparse
solver the browser build lacks.

**How long a guide or region stays editable.** (1) Editable with a live preview until
accepted, then baked into the session's working surface, with session undo to step back.
(2) A stack of features re-evaluated from the scan on every change. (3) Features saved with
the scene. **Chosen: 1.** Brush strokes cannot be re-evaluated in a stack without an order
that surprises the user, and every edit would cost the whole stack. Option 3 needs a scene
format change and doubles a refined scan's share of the file, as the Warp design found.

**The crease brush.** (1) A classic pinch that pulls vertices toward the stroke. (2) A
freehand guide that runs the edge rebuild along the stroke. **Chosen: 2.** Option 1 is the
brush that distorts today, and the product owner described dragging the tool as indicating
the edge and its direction, the same as a line does.

## Design

### User experience

Refine is a tool in the tool strip with an inspector panel. Select one part and choose it.

```
  ┌ Refine ───────────────────────────────┐
  │ [Edge] [Region] [Brush] [Detect]       │
  │                                        │
  │ Edge     ◉ Line  ○ Arc  ○ Spline       │
  │ Width    ───●──────────  0.60 mm       │
  │ Strength ──────────●───  100 %         │
  │ Joints   ◉ Sharp ○ Smooth              │
  │ [Dismiss]                   [Accept]   │
  │────────────────────────────────────────│
  │ 3 accepted · 5 proposed                │
  │ [Cancel]                     [Apply]   │
  └────────────────────────────────────────┘
```

The session keeps a **working surface**: the scan with everything accepted so far. A guide
or region being drawn or adjusted previews live over it. **Accept** bakes that one feature
into the working surface. **Apply** writes the working surface to the part as one undo step
and **Cancel** discards the session. Inside the session, Ctrl/⌘+Z steps back through
accepts, brush strokes and edits. These steps are session-local, as in Warp.

#### Edge

1. Choose Line, Arc or Spline and click points on the surface, along the rounded edge. A
   line takes two points, an arc three, a spline any number. The points only need to be
   near the edge, within Width.
2. Continuing from an end point adds a segment, and ending on the first point closes a
   loop. Each joint between segments is Sharp (a corner) or Smooth.
3. The preview shows the band that will change, the edge the tool solved, and the rebuilt
   surface. The solved edge is offset from the drawn points: outward on an exterior edge,
   inward on an interior one. The tool tells the two apart itself.
4. Points can be dragged along the surface, added and deleted. Width sets how far to either
   side the tool reads and rebuilds. It starts from the tool's own estimate of how wide the
   softened band is.
5. **Strength** sets how loosely the edge follows the guide's line, arc or spline, from no
   change to fully on it. (product owner)
6. Accept, or Dismiss.

#### Region

1. Paint the area with the surface brush Warp uses for its region, with its per-part
   radius. Painting can be erased.
2. Choose a treatment:
   - **Smooth** removes ripples and imperfections and keeps the scan's curvature, like a
     smooth brush in other apps.
   - **Flatten** snaps the area to a true plane.
   - **Shape** snaps the area to a cylinder, cone or sphere. Auto picks the one that fits
     best and names it, and the user can override it.
   - **Sweep**, also under Shape, snaps the area to a constant cross-section carried along
     an arc or spline, for pipe elbows and hoses. The user chooses it; Auto does not.
     (product owner)
3. **Strength** sets how loosely the area follows the treatment, from no change to fully
   on the shape.
4. **Keep detail** is on by default. Detail standing off the fitted surface is outlined in
   the preview and survives. **Offset** sets how far a feature must deviate from the
   surface to be preserved. (product owner) Erasing paint from a spot leaves that spot
   untouched.
5. **Blend** sets the width of the band at the region's border where the change fades out,
   so the region does not end in a step.
6. Accept, or Dismiss.

#### Brush

Crease, Flatten and Smooth, each with a radius and a strength. A stroke changes the working
surface directly and is one session undo step. A crease stroke sharpens the edge under it,
interior or exterior, along the path dragged.

#### Detect

1. Choose where to look: the whole part or a painted area. Sensitivity sets how soft an
   edge must be to count, and a minimum length keeps rivets and other small features from
   being proposed as edges.
2. Detect runs in the background with progress and can be cancelled.
3. Proposals appear on the part, drawn differently from accepted features: edges as line,
   arc or spline guides, and surfaces as regions with a treatment already chosen.
4. Selecting a proposal previews it. It can be adjusted exactly like a hand-placed feature,
   then accepted or dismissed. Several selected proposals can be accepted together. A
   proposal that is never accepted changes nothing.

### How an edge is rebuilt

1. **Read the band.** The guide is sampled along the surface. At each sample the tool walks
   outward on both sides until the surface stops turning. That marks where the softened
   band ends and each flank begins.
2. **Fit the flanks.** Each side's flank, beyond the softened band and within Width, is
   fitted with the simplest surface that matches it within the scan's noise: a plane, then
   a cylinder, cone or sphere, then a smooth surface swept along the guide.
3. **Solve the edge.** The two fitted flanks are extended to where they meet. That
   intersection is fitted to the guide's kind: a straight line, a circular arc, or a smooth
   curve with as much freedom as the spline's points give it.
4. **Rebuild.** Every vertex in the band moves onto the flank on its side of the solved
   edge. A chain of mesh edges is placed exactly on the solved edge by snapping nearby
   vertices onto it and splitting triangles where none is near enough. Vertex colors are
   interpolated at new vertices.
5. **Ends and joints.** At a free end the change fades out over a short length, so the
   sharpened edge runs back into the scan. Guides and segments that share an end are solved
   together and meet at one point, the intersection of their flanks.

A flank that lies in an area already flattened or shaped fits that same surface again, so a
plate flattened first and edged second comes out flat with a crisp border. Running a guide
again over its own result changes nothing visible.

### How a region is rebuilt

- **Flatten and Shape.** The shape is fitted robustly, so detail does not pull it off the
  base surface. Vertices within the detail threshold of the fitted shape move onto it,
  scaled by Strength. Vertices beyond the threshold, and those connected to them above it,
  are detail: each island keeps its form and is carried with the surface under it, so a
  rivet stays seated on its plate.
- **Smooth.** Each vertex moves onto a smooth surface fitted to the scan around it, within
  Reach along the surface, scaled by Strength. With Keep detail on, detail is whatever stands off the smoothed base by more
  than the threshold, and it is carried in the same way.
- **Border.** Vertices on the region's outer border and beyond keep their exact bits. The
  change fades in across the Blend band.

### Brushes

- **Smooth** relaxes the surface under the brush, and **Flatten** moves it toward the plane
  fitted under the brush, both with a falloff to the brush's rim.
- **Crease** takes the stroke as a freehand guide, smooths out hand jitter, and runs the
  edge rebuild along it with the brush radius as its width. It is accepted on release. When
  the edge is wider than the brush, the guide falls back to the automatic width and waits,
  selected, to be accepted or dismissed.

### Detection

- Edges: measure curvature at the scale of the softened band, find bands that turn sharply
  across and little along, thin them to paths, split the paths at corners and junctions,
  and classify each as a line, arc or spline by how well it fits. Paths shorter than the
  minimum length are dropped.
- Surfaces: grow areas whose vertices fit one plane, cylinder, cone or sphere within the
  scan's noise, using the same fitter regions and flanks use.
- Every proposal is an ordinary guide or region in the proposed state. Detection writes
  nothing to the working surface.

### Data flow and state

- The session lives in the store beside Warp's, with its own state: target part, source
  geometry reference, working surface, features (proposed, editing, accepted), brush
  settings and session undo.
- Starting a session builds the welded topology, adjacency and curvature in a worker.
- The preview draws a session geometry. `part.geometry` is untouched until Apply.
- Apply follows `applyWarp`: it refuses if the part changed or is locked or the scene epoch
  changed, bakes one undo step, and leaves every link as it was. If the part changes during
  a session, the session is cancelled with a notice, as Warp's is.
- Vertex positions change while working, and an accepted edge changes topology. Picking
  stays correct throughout: the BVH is refitted for position changes and rebuilt in a
  worker after a topology change.
- Triangles that fold over are highlighted with a warning, as in Warp.

## Builder's discretion

- The keyboard shortcut and icon for the tool.
- Default Width, Blend, Strength and detail threshold, and how each is estimated from the
  scan.
- Noise estimate, fit tolerances and the order of fit for swept flanks.
- How close a vertex must be to snap instead of split, and how slivers are avoided.
- Fade length at a guide's free end.
- Smoothing weights and pass counts.
- Curvature scale, thinning and classification thresholds in detection.
- How proposed, editing and accepted features are drawn.

## Commands

```sh
npm run dev            # workbench at the Vite dev server
npm run build          # type check, app build and MCP builds
npm test               # unit tests (vitest)
npm run test:e2e       # Playwright
npm run format:check   # prettier
PR_TITLE='<title>' PR_BODY_FILE='<body-file>' node scripts/check-pull-request.mjs
```

## Project structure

```
src/core/refine-*.ts          fitting, edge rebuild, regions, brushes, detection, session
src/core/refine-*.worker.ts   session setup and detection off the main thread
src/components/Refine*.tsx    panel, guide and region drawing, overlays
src/core/store.ts              session state and actions, beside Warp's
src/core/types.ts              'refine' added to Tool
tests/unit/refine-*.test.ts   unit tests
tests/e2e/refine*.spec.ts     Playwright
tests/helpers/soft-edges.ts    synthetic softened fixtures
src/docs/                      a guide, and a changelog entry in changelog.ts
docs/design.md                 the acceptance line for the tool
```

## Code style

Follow the surrounding code: pure functions on typed arrays in `src/core`, a one-line doc
comment that states the reason, errors written for the user, and prettier with single
quotes, trailing commas and 100 columns. From `src/core/mesh-topology.ts`:

```ts
/** Numeric edge keys avoid allocating a string and a Map entry for every edge. */
export function hasClosedEdges(
  indices: ArrayLike<number>,
  vertexCount: number,
  skipDegenerate = false,
) {
  if (vertexCount * vertexCount > Number.MAX_SAFE_INTEGER)
    throw new Error('This mesh is too large to check its edges safely.');
```

## Boundaries

- **Always:** run `npm test`, the Refine Playwright specs, `npm run format:check` and
  `npm run build` before each commit, since CI does not run tests. Add a changelog entry.
  Keep existing benchmarks no slower and exports of unrefined parts bit-identical.
- **Ask first:** adding a dependency; changing the scene format; changing anything under
  `mcp/` or `native/`; changing how Warp or Align behave while sharing their code.
- **Never:** write into `part.geometry` before Apply; move a vertex outside a shown
  footprint; apply a proposal that was not accepted; commit the scans or reference photos.

## Verification

### Success criteria

The acceptance test is the product owner's eye (product owner): parts 45 and 57, refined
entirely in Kitbasher, compared with their reference photos. Long straight edges are
straight, curved edges are clean, flat plates are flat, the tanks have no ripples, and
rivets and other small detail are intact. No tolerance is measured on the real parts.

To support that judgement, the work delivers before and after renders of both parts from
the reference photos' top and bottom views.

### Unit tests on synthetic fixtures

The fixtures are shapes with known answers, softened the way a scan is: a box with filleted
edges, a capped cylinder with a filleted rim, a plate with rivets, and a sphere, each with
seeded ripples and noise at about the density of the reference scans. Tolerances below
apply to these fixtures only and are proposed values.

- A line guide laid on the fillet of an exterior 90 degree edge puts every edge vertex
  within 0.02 mm of the box's true edge, the edge deviates from a straight line by less
  than 0.005 mm, and the faces meet within 1 degree of 90. The same holds for an interior
  edge.
- An arc guide on the cylinder's rim puts every edge vertex within 0.02 mm of the true
  circle.
- A closed four-segment path around a box face meets at four corners with no gap.
- No triangle straddles a refined edge.
- Flatten on the riveted plate at full strength puts base vertices within 0.005 mm of the
  true plane, and each rivet keeps its height above the plate within 0.01 mm.
- Smooth on the sphere removes at least 75 % of the ripple amplitude at the default reach,
  and 88 % at a 2.2 mm reach, and changes the mean radius by less than 0.5 %.
- Shape recovers the cylinder's axis and radius, and Auto names the right shape for each
  fixture.
- Strength 0 changes nothing, and the change grows steadily with Strength.
- Running a guide or region again over its own result moves no vertex by more than
  0.001 mm, with these exceptions: 0.002 mm in an edge's full-strength core, 0.005 mm for a
  sweep along a spline path, and none for Smooth, which is cumulative.
- Vertices outside every footprint keep their exact bits. Welded duplicates stay identical.
  A closed input stays closed under `hasClosedEdges`.
- Detection on the box proposes its 12 edges and 6 faces, and proposes nothing on the
  plate's rivets. Detection alone leaves the working surface bit-identical.
- Apply is one undo step, leaves pins, anchors, pivot, joints and plane constraints
  unchanged, and moves no other part.

### End to end

Playwright: place a line, an arc and a closed path and accept them; paint a region and run
each treatment; make a stroke with each brush; run Detect, adjust a proposal and accept it;
session undo and redo; Apply, scene undo, Cancel.

### Performance

- No regression in existing benchmarks.
- On the two reference scans: adjusting a guide or a region setting updates the preview
  without stalling the viewport, brush strokes follow the pointer, and Detect and session
  setup keep the viewport drawing while they run.
- The tool stays usable on a 3 million triangle scan, the bar Warp set.

## Changes made while building

None of these came from the product owner. Each can be overruled.

- **Ends on edge guides.** Each open end of a guide has a setting: Auto, Fade or Hold. Fade
  runs the sharpened edge back into the scan, as the approved text describes. Hold runs the
  edge sharp into a corner. Auto chooses one of the two for that end.
- **Reach for Smooth.** Smooth has a Reach setting, the distance along the surface over
  which ripples are removed. It defaults to the larger of 0.9 mm and 15 triangle edges.
- **Smooth is cumulative.** Running Smooth again smooths further, so it has no re-run
  criterion. Its test target is 75 % of the ripple amplitude at the default reach and 88 %
  at 2.2 mm, in place of 90 %.
- **Re-run tolerances.** 0.002 mm in an edge's full-strength core and 0.005 mm for a sweep
  along a spline path, in place of 0.001 mm. A sweep along an arc path keeps 0.001 mm.
- **Detect.** Select all proposed selects every pending guide and region. Running Detect again replaces
  proposals the user has not touched and keeps edited ones, and it proposes nothing that
  duplicates a feature already there.
- **Preview limit.** With more than 8 features selected the preview is off, and the panel
  says so.
- **Crease wider than the brush.** The guide waits to be accepted instead of being accepted
  on release, with the notice: The edge is wider than the brush. Check the preview, then
  accept it.
- **Escape.** Escape does not leave the tool while the session holds work the user made.
  The status line shows: Apply to keep your changes, or Cancel to discard them.
- **Region joining removed.** Detection had a pass that joined neighbouring regions on one
  surface. Removing it left the proposals on both reference scans identical, so it was
  removed.
- **How Smooth works.** The approved text chose low-pass smoothing in repeated passes. As
  built, Smooth fits a local quadratic surface around each vertex and moves the vertex onto
  it.
- **What the preview shows.** The preview shows the selected pending features of the
  current mode's kind. Detect shows any kind.
- **Preview while dragging.** While a guide point is dragged, the preview is rebuilt when
  the pointer rests and on release, not on every move. Accept waits until that preview has
  been shown.
- **Re-run tolerances are fixture figures.** On a real hose a second Sweep over its own
  result moved the surface by up to 0.037 mm, so the guide says to apply a Sweep once.

## Narrow flanks and guides laid beside the edge

Added 2026-11-20, after the build. It changes how an edge is read, steps 1 to 3 of "How an
edge is rebuilt". It comes from replaying the hand study's refused and damaged guides on the
two reference scans and prototyping each change against them.

**What was wrong.** A guide on a narrow lip, rim or border was refused, or solved and cut in
pieces, for five measured reasons:

- Width was measured from the drawn guide. A guide laid 0.3 mm to one side of the edge left
  the far flank almost none of the band.
- A flank accepted at 3 edge lengths between its zone boundaries was measured again from its
  outermost vertices, which loses 1 to 1.5 edge lengths, and failed the same 3.
- One slice across the guide without a long enough flank left a hole in the band, and the
  cut broke there.
- A flank was looked for only within reach of the guide, 0.35 mm, even where the rounding
  itself is wider than that.
- A Line guide over an edge that curves dragged the edge onto its chord.

**The rules.** Lengths are in mm. An edge length is the mesh's local edge length.

1. **Width is measured from the solved edge.** The band keeps the vertices whose distance
   across the surface from the solved edge is at most Width. The guide stays what points at
   the edge: the solved edge must lie within reach of it, the larger of 0.35 and 6 edge
   lengths, in at least half of the slices. A band is built at the requested Width or at what
   it read, whichever is smaller. In a slice where the edge was not found on both sides, its
   offset counts as no farther from the guide than the farthest offset seen where the edge
   was found on both sides. Only how far the band covers and which vertices it keeps read
   that offset. Automatic width is
   soft + max(2 x soft, 6 edge lengths), where soft is the width of the rounding. It is held
   to 1 unless the edge cannot be read within 1. It no longer adds the guide's distance from
   the edge.
2. **A flank's run is read between its zone boundaries.** In each slice the run is from
   where the flank starts to the nearest of where it ends, how far the slice reaches, and
   Width. Each side needs a run of 3 edge lengths in at least half of the slices, as before.
3. **A slice without a run is filled from its neighbours.** Once the edge is solved, a slice
   that has no flank on one side takes that flank's start and end interpolated from the
   nearest slices that have one, before and after it along the guide. This happens only when
   at least half of the slices on that side have a flank of their own, and never before the
   first or after the last slice that has one. In a filled slice the rounding is taken to
   lie no farther from the edge than where that side's own flanks typically start, plus one
   edge length. A vertex farther out that is off the flank's fitted surface by more than the
   flank's tolerance is neither soft nor flank, so filling leaves a rivet or other detail
   there where it is. In every slice, a vertex standing off its flank's surface on the side
   away from the other flank, as a rivet beside a convex edge does, is never soft. Measured
   on a 90 degree edge rounded 0.08 with domes 0.05 and 0.1 high on four seeds: beside a
   convex edge, with their feet 0.005 to 0.06 from the corner, no dome vertex standing 0.03
   or more off the face moves. Beside a concave edge, with their feet 0.02 to 0.2 from the
   corner, filling moves none; a slice's own reading still moves some, as described below.
   The edge is found, fitted and oriented, and its free ends decided, from the slices' own
   zones. Filled zones only decide what moves and what is cut. The check that a sharp core
   remains in what will be moved reads the filled zones, because it checks that move. It
   needs a vertex of full weight on each side; one already on both corrected surfaces, as
   on an edge refined before, counts for both.
4. **A flank may start past the reach.** A flank's seed may start anywhere in the seed
   window: the reach plus one seed span, which is up to twice the reach. Pairs of flanks
   whose seeds both start within the reach are tried first, so a guide whose flanks start
   within the reach keeps the pair of flanks it was seeded from. The solved edge must still
   lie within reach.
5. **A Line guide follows an edge that clearly curves.** When there are at least 9 points
   where the flanks meet, and they leave the fitted line by more than one edge length, clear
   of the fading ends, they are fitted as an arc. The arc is kept only when it does not
   close on itself and its own largest gap is under half the line's. The choice is made
   again at each refit, including at joints, from the kind as drawn. The guide as stored and
   shown stays a line.

**What still refuses.** A guide on a flat face with no edge within its reach (0.35, or 6
edge lengths on a coarser mesh). A guide on one
smooth surface, such as a cylinder wall, with one exception below. Flanks less than 10
degrees apart, and flanks that turn too much themselves (flatness under 2.2). These checks
are unchanged.

**A false edge on a narrow cylinder.** A Line laid slanting across a cylinder wall of radius
0.7 can be taken as an edge and creased. Measured on four seeds: on one seed a slant from
angle 1.1 at the bottom to 1.5 at the top, and on another the opposite slant, fit two planes
52.5 and 61.5 degrees apart and cut the wall in one piece, moving it up to 0.064 and 0.097.
Every other seed and slant is refused, as are slanting lines on walls of radius 1 to 2, and
lines and arcs on walls of radius 3 to 12, at Width 0.5 and automatic width. Rules 2 and 4 admit it: each flank's run is 3.6 to 4 edge
lengths, as long as a narrow wall's, and its flatness of 2.5 to 2.7 passes. Before these
rules both were refused.

**What changes for a guide beside an edge.** A guide on a clean face 0.3 mm from a rounded
edge used to be refused. It now finds that edge. On a coarse mesh the reach is 6 edge
lengths, so on a box with 0.23 mm edges a guide in the middle of a face finds an edge 1 mm
away.

**Measured on the reference scans with the build.** Measured 2026-11-21, replaying the hand
study's 20 edge guides. 13 solve, against 6 before these rules. 12 solve in one piece with
nothing skipped or folded: newly, the upper plate border (as a line, before and after
Flatten), the fin edge, the buckle lip (two widths), the belt's lower edge and the lighter
outlet arc; the valve rim, cut in 3 pieces before, is now one piece. The two edges the study
kept solve as before and look the same, and the barrel ring and Detect's buckle guide solve
as before. Still refused: the closed plate border (two widths), the cross strap line, the
neck collar arc (two widths), the cable support spline and the pocket wall. Still damaged:
the outlet arc, cut in 3 pieces with 31 triangles skipped (21 before).

Judged by eye against the photos:

- The plate border, belt edge and valve rim each become one cleaner line.
- The middle of the fin's edge becomes a hard straight line, with a small notch where the
  line starts; the last stretch to the rear corner stays round.
- The buckle lip gains a crisp line with a small step where the guide starts, and does not
  read as the flat frame in the photo.
- The lighter outlet arc shows nothing.
- The outlet arc's hard line now tilts across the collar with a bump at each end, which
  looks slightly worse than before.
- At whole-part scale neither part looks closer to its photos.

Every guide that solves leaves a closed mesh after Apply with no zero-area triangle. Scene
Undo restores the part's vertex arrays element for element, and Redo the applied ones. The
total solve time of the 20 guides went from 1254 ms to 1738 ms (median of three runs).

**Not covered by these rules.**

- A closed path still fails whole when one span fails, so the plate border is restored one
  span at a time and only where the guide lies within reach.
- A rib rounded right over (the left strap lip, the collars) has no top face to fit. It
  needs a solve with three surfaces and a decision on the wanted shape.
- A shallow bend of about 30 degrees with no rounding still passes as an edge and adds a
  line or changes nothing (the outlet flange, Detect's seam inside the buckle).
- A refusal still does not say which check failed or on which span.
- A tied end's cut runs along the existing crease for up to the band's width, as it did
  before these rules.
- Which slices find the edge can depend on how far the band is read, so a band is not
  identical across widths at a guide's ends.
- A Line slanting across a cylinder wall of radius 0.7 can be creased, as described above.
  Telling it from an edge needs a check of whether one curved surface explains the cross
  section, which these rules do not make.
- Beside a concave edge, a rivet whose foot reaches into the rounding can still be moved by
  a slice's own reading, as before these rules: the rounding and the rivet both stand off
  the flank toward the other flank. Measured with domes 0.02 from the corner: 0.053 to
  0.064 for domes 0.05 high, and 0.0082 on one of four seeds for domes 0.1 high.

## Where the build falls short of this spec

Measured on the branch on 2026-11-20; the edge results and the preview update measured again
on 2026-11-21, after "Narrow flanks and guides laid beside the edge". None of this was
approved by the product owner.

- **The acceptance test is not met.** Both reference scans were refined by hand, feature by
  feature, keeping only what looked better. 6 of 35 attempts were kept. Part 45's riveted
  plate face is flatter with its fasteners kept, and one strap lip and one frame rail are
  straighter. Part 57's two tank domes are less blotchy and one hose span is smoother. On
  replaying the study's edge guides with the narrow-edge rules, one span of the plate border
  on 45 and the belt edge and valve rim on 57 each gain one cleaner line. The fin's edge on
  45 is hard and straight in its middle, with a small notch where the line starts, and round
  over its last stretch. The buckle lip on 57 gains a crisp line with a small step where the
  guide starts. The outlet arc on 57 looks slightly worse than before. The rest of the
  plate border, the barrel rings and collars on 45, and the outlet flange and pocket on 57,
  were not restored. At whole-part scale the renders, with or without those lines, are hard
  to tell apart.
- **Why.** 7 of the study's 20 edge guides are still refused: the closed plate border, the
  cross strap line, the neck collar arcs, the cable support spline and the pocket wall.
  Of the guides that now solve, the seven that gain a line each rebuild one edge, with a
  band 0.38 to 0.64 wide on either side of it, which does not show at whole-part scale.
  The outlet arc is still cut in 3 pieces, now with 31 triangles skipped where 21 were
  before, and its line tilts across the collar with a bump at each end. Keep detail cannot
  tell molded relief from scan roughness. Sweep refused the cable and both elbows.
- **Running a guide again.** The spec says that running a guide again over its own result
  changes nothing visible, with a re-run tolerance of 0.002 in an edge's full-strength core
  ("Verification", "Changes made while building"). On the reference scans this does not
  hold. Measured with both passes at full strength, against 0.005 away from the guide's
  ends (the last 0.5 at each end) and 0.02 anywhere, these guides fail:
  - The plate border, as a line before and after Flatten, moves 0.051 and is cut in 4
    pieces (3 after Flatten).
  - The belt edge moves 0.11 and is cut in 2 pieces with 8 triangles skipped.
  - The buckle lip moves 0.0114 away from the ends.
  - The valve rim moves 0.0221 away from the ends and 0.0249 anywhere, and is cut in 3
    pieces with 10 triangles skipped.
  - The outlet arc moves 0.0398 and is cut in 4 pieces with 6 triangles skipped.
  - Detect's buckle guide moves 0.0159 away from the ends and 0.0223 anywhere, about as
    before these rules.
  - The kept frame rail moves 0.0054 away from the ends, where it moved 0.0036 before.

  Only the kept strap lip and the barrel ring stay within both limits. On the fin edge, the
  wider buckle lip and the lighter outlet arc the second pass is refused. It moves nothing,
  but the guide does not solve on its own result, which is not a stable result either.

  The study ran every guide but Detect's buckle guide below full strength. Below full
  strength each pass moves the surface part of the way again, so a move over 0.005 there is
  expected and is not counted as falling short. Run again at their own strength, every one
  of those guides that solves again moves more than 0.005 away from the ends, except the
  barrel ring, as expected. The plate border, for one, moves 0.0711 (0.0714 after Flatten).
  What is a fault at any strength:
  - The outlet arc's second pass is refused. Before these rules it solved in 3 pieces with
    28 triangles skipped.
  - The buckle lip is cut in 2 pieces.

  The synthetic fixtures show the same faults. Measured on eight seeds, both passes at full
  strength, the guide placed again on the first result:
  - A Line guide along the rim of a cylinder of radius 5, fitted as an arc: at Width 0.52
    and 0.45 the second pass is cut in 2 pieces with 6 triangles skipped on one seed, and at
    0.52 in 3 pieces with 8 triangles folded on another. On three seeds it moves 0.0092 to
    0.0200 away from the ends. The broken cuts come with the second pass being a Line,
    whatever the first pass was, need a cut made before, and lie in the last 0.5 of the
    guide, where the cut tapers. Their cause was not found.
  - An Arc guide on the same rim stays in one piece, but on one seed moves 0.0134 away from
    the ends.
  - On the narrow wall at Width 0.45 the second pass solves in one piece on every seed, but
    on one seed moves 0.0076 away from the ends. The first pass fits the wall 46 degrees
    from the plate, where it is at 50, and the second refits it at 47.4.

  Elsewhere a second pass moves a few cut-line vertices near a guide's free ends by about
  0.01, and on the rim by up to 0.023.

- **Performance.** A preview update takes 92 to 106 ms for a strap lip guide on part 45
  and 139 to 165 ms for the valve rim on part 57 (80 to 96 ms and 150 to 163 ms before the
  narrow-edge rules), and 640 ms on a 3 million triangle part. Over the study's 20 edge
  guides the total solve time rose 39 %, from 1254 ms to 1738 ms. A smooth dab takes about
  20 ms on part 45. Detect takes about 24 s on each scan and Accept about 0.35 to 0.4 s,
  followed by a pause of about 0.4 s while picking is rebuilt. In one run each, Detect's
  check that each edge proposal solves went from 13.8 s to 14.9 s on part 45 and from
  14.3 s to 15.9 s on part 57. The tool is not usable for live preview at 3 million
  triangles.

## Out of scope (deferred)

- Guides and regions saved with the scene and re-editable after Apply. Needs a scene format
  change.
- Leaving a chosen radius or chamfer on a refined edge. Not asked for.
- Headset and MCP support. Follows Warp.
- Refining several parts in one session. One part at a time keeps Apply's guards simple.

## Open questions

None open. The product owner answered the four questions the draft raised:

1. **"Follow an arc"** is about edges, not regions: it is a constant spline that represents
   the edge of the corner. The guide's arc and spline kinds cover it, and Strength is its
   looseness. The Sweep shape the draft proposed for regions is kept as an additional
   feature, at the product owner's request.
2. **Preserved detail** is controlled by an offset: how far a feature deviates from the
   surface decides whether it is preserved.
3. **After Apply**, guides and regions are baked and gone, as with Warp.
4. **Name.** The tool is called Refine.
