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

## Where the build falls short of this spec

Measured on the branch on 2026-11-20. None of this was approved by the product owner.

- **The acceptance test is not met.** Both reference scans were refined by hand, feature by
  feature, keeping only what looked better. 6 of 35 attempts were kept. Part 45's riveted
  plate face is flatter with its fasteners kept, and one strap lip and one frame rail are
  straighter. Part 57's two tank domes are less blotchy and one hose span is smoother. The
  plate border, barrel rings and fin on 45, and the buckle, belt, flanges and pocket on 57,
  were not restored. At whole-part scale the before and after renders are hard to tell
  apart.
- **Why.** An edge guide is refused unless it finds enough surface on both sides of the
  edge, and narrow lips and rims give too little. Some guides that pass their checks are
  cut in several pieces or leave a seam. Keep detail cannot tell molded relief from scan
  roughness. Sweep refused the cable and both elbows.
- **Performance.** A preview update takes 74 to 87 ms on the reference scans and 640 ms on
  a 3 million triangle part. A smooth dab takes about 20 ms on part 45. Detect takes about
  24 s on each scan and Accept about 0.35 to 0.4 s, followed by a pause of about 0.4 s
  while picking is rebuilt. The tool is not usable for live preview at 3 million triangles.

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
