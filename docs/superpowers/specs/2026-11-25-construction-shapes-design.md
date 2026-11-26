# Construction shapes

Added 2026-11-25.

## Intent

The user wants shapes placed in the scene that limit what editing tools can do. A plane offset
from a surface sets the maximum height of any modification; another plane below sets the
minimum. Curves drawn on a plane constrain things further, for features like flat curves, and
can guide the brush along a path.

## What the user asked for (product owner)

1. **Construction shapes:** planes, and curves drawn on a plane.
2. **Planes as limits:** a plane offset from a surface controls the maximum height of any
   modification; another below controls the minimum.
3. **Curves as boundaries:** a curve is a face normal to its plane, going to infinity. The mesh
   cannot cross it.
4. **Curves as brush guides:** with a curve selected as the guide, the user places the brush and
   presses a key. The brush moves along the curve, starting from where the brush is. The path
   is parallel to the curve at the brush's distance from it: for an arc, the same centre and a
   radius larger or smaller by that distance. While a curve is the guide it is not a boundary.
5. **Saved with the scene and attached to a part.** Shapes move with their part, last after the
   tool closes, and any tool can use them.
6. **Tools constrained:** Sculpt, Warp and Move.
7. **Two methods, togglable, for Move:** Follow, where the shape sets the path you can travel
   from where you are now, and Boundary, where the shape stops you.
8. **Approach:** new construction shapes stored on parts, reusing Refine's sketch code. Refine's
   own session sketch planes stay as they are.

## Goals

- A plane placed a set distance above a surface stops every Sculpt brush, the Warp tool and a
  Move drag from taking the mesh past it, so a built-up area comes out flat at that height.
- A curve's wall stops the mesh from crossing it, in the same tools.
- A brush stroke can run exactly along a curve, or parallel to it at a chosen distance.
- A part can be moved along a plane or curve, or up to it and no farther.
- Shapes are part of the scene: saved, undone, copied and shared like a part's pins.

## Non-goals

- Constraining Rotate, Scale, Refine, Pins or Anchors.
- Follow for Warp handles. Warp gets Boundary only.
- Shapes other than planes and curves on planes (spheres, cylinders, offset copies of a curved
  surface).
- Cutting triangles along a boundary to make the edge where the mesh meets it sharper than the
  mesh's density allows. Sculpt's automatic detail still applies.
- Typed dimensions (lengths, radii, angles).
- Moving Refine's sketch planes into the scene. Refine keeps its session planes.

## Anti-goals

- An edit that leaves any point of the mesh on the far side of a boundary from where it started.
- A guide run that drifts off its parallel path.
- A Move that jumps through a thin boundary because one drag frame stepped over it.

## Decisions

Marked **(product owner)** where the user decided; the rest are the designer's calls.

### Shapes

- A part keeps its shapes in a new optional field, next to `pins` and `anchors`, in mesh-local
  coordinates, so they move, rotate and scale with the part **(product owner)**. A shape is
  attached to the part it was made on.
- **Plane:** an id, a name (Plane 1, Plane 2, in the order the part's shapes were made), an
  origin, a unit normal, in-plane axes `u` and `v` (as `SketchPlane` in
  `src/core/refine-sketch.ts`), an **Offset** in mm along the normal, and **On**.
- **Curve:** an id, a name (Curve 1, ...), the plane it lies on, its segments, open or closed,
  its constraints, and **On**. A curve is a chain of segments of Refine's guide kinds (line,
  arc, spline; `GuideKind` in `src/core/refine-curve.ts`). Its points are stored in the plane's
  (u, v), so changing the plane's Offset carries the curve with it.
- A shape that is off is hidden and constrains nothing. A plane that is off still carries its
  curves; each curve has its own On.
- Deleting a plane deletes its curves.

### Making and drawing shapes

- A new toolbar tool, **Construct**, works on the selected part, as Pins does. Its panel lists the
  part's shapes with On, rename and delete, and holds the making and drawing controls.
- **New plane:** click 3 points on the part, or click once on a flat face to fit a plane to the
  surface around the click (`planeThrough` and `planeOfFace` in `src/core/refine-sketch.ts`).
  Then set **Offset** in mm, positive away from the surface on the side the click was made from
  **(product owner: offset from a surface)**. Offset stays editable.
- **New curve:** choose a plane and draw as a Refine guide is drawn on a sketch plane: a click
  places a point where the cursor's ray meets the plane, whether or not the ray hits the part.
  Line, arc and spline segments, open or closed. Points have the move widget, the point menu
  (Lock, Align, Constrain, Delete) and the segment constraints of the Refine sketch guides
  design, solved by `solveGuide` in `src/core/refine-constraints.ts`.
- While Construct is open, the selected part's shapes are drawn: a plane as a grid square with
  its `u` and `v` axes, sized to the part, and a curve as a line on its plane with its wall shown
  faintly a short way either side of the plane. In Sculpt, Warp and Move, shapes that are on are
  drawn faintly.

### Boundaries

- Every shape that is on, on any visible part, is a boundary for Sculpt, Warp and Move. The
  exceptions: the guide curve during a guide run, the shape being followed in Follow, and a
  moving part's own shapes.
- A plane is infinite. A curve's wall is every point whose projection onto the curve's plane lies
  on the curve, infinite along the plane's normal both ways **(product owner)** and as long as
  the curve along it. An open curve's wall has ends that the mesh can go around.
- **The rule:** each edit moves a point in a straight line from where it was to where the tool
  sends it. If that line crosses a boundary, the point stops on its own side of the boundary, a
  small margin short of it (0.0001 mm, or more where float precision at the part's size needs
  it). Because no point is ever left exactly on a boundary, the side a point is on is always
  known from its position, and no per-point state is kept between edits.
- Boundaries are two-sided. A plane above a surface caps it from below; points of the part that
  already lie above the plane cannot be pushed down through it.
- Several boundaries: the point stops at the first one its line meets.
- A curve's wall is crossed when the line's projection onto the curve's plane crosses the curve,
  so the crossing test is two-dimensional in the plane's (u, v).

### Sculpt

- Every brush that moves the mesh is bounded, including Grab and Smooth, and mirrored dabs under
  symmetry. Mask is unchanged.
- The bound is applied where each dab sets a vertex's new position, in `dabWork` in
  `src/core/sculpt-mesh.ts`, from the vertex's position before the dab to the displaced one.
- **Guide run (product owner):**
  - The Sculpt panel has a **Guide** choice: None, or one of the scene's curves that are on.
    Clicking a curve in the viewport while Guide is open also chooses it.
  - With a guide chosen, a key runs the brush along it; Shift with the key runs it the other
    way. The builder picks a key free in Sculpt.
  - The path is the curve offset in its plane by the brush's distance from the curve when the key
    is pressed, measured in the plane (option 2, product owner). The run starts at the point of
    the path nearest the brush, follows the curve's drawn direction (or the reverse with Shift),
    and stops at the curve's end, or after one lap of a closed curve.
  - Where two segments of the curve meet at an angle, the outside of the corner is joined by an
    arc round the corner point and the inside is trimmed where the offsets cross.
  - Each dab lands on the part where the line through the path point along the plane's normal
    meets it, at the brush's spacing. The run plays over successive frames at a steady pace so
    the user sees the brush move. It is one stroke: one undo step, Escape cancels it, and the
    current brush settings apply. Pressure is steady, as with a mouse. Crease and Ridge take
    their direction from the path.
  - A path point where the line along the normal misses the part places no dab; the run carries
    on.

### Warp

- The warped surface is bounded: each vertex's line runs from its rest position to its warped
  position, so the bound is applied after evaluation, where warped world positions are written
  (`evaluateWarp` in `src/core/warp-evaluate.ts`), and before they are shown or committed.
- Warp handles move freely. The surface they drive stops at boundaries.

### Move

- Covers the Move tool, the move handles of the combined transform, and Free move.
- **Boundary / Follow toggle (product owner)** in the Move panel. Boundary is the default.
- **Boundary:** a drag into a boundary slides the selection along it: only the part of the
  movement that would take a point across is blocked **(product owner)**, the way No clip
  (`placeClear` in `src/core/clipping.ts`) slides a part along another part. The check covers the
  whole drag from the last allowed position, so a fast drag cannot step through a thin shape.
- Boundaries are one more limit inside No clip's solve, and they win over it: No clip never pushes
  a part across a boundary, and parts No clip carries along (joint children, plane constraints,
  pin corrections) are bounded too. With No clip off, boundaries still apply.
- **Follow:** the user chooses a plane or curve to follow (from a list in the Move panel, or by
  clicking it). The drag then moves the selection's pivot only along the path the shape sets from
  where the pivot is now:
  - a plane: the drag is held parallel to the plane, keeping the pivot's distance from it;
  - a curve: the pivot moves along the curve offset in its plane by the pivot's distance from the
    curve, keeping its height above the plane, the same parallel path a guide run uses.
- In Follow, other shapes that are on still act as boundaries.
- Move translates only; the part does not turn to follow a curve.
- The boundary check runs at 60 Hz during a drag for a part of about 700k vertices.

### Saving, undo and sharing

- Shapes are saved in the scene file, validated on open like pins (`src/core/scene-file.ts`), and
  documented in `docs/scene-format.md`.
- Every change to a shape is one scene undo step, through the same part patch path pins use.
- Copy and paste of a part carries its shapes (`src/core/clipboard.ts`). Shared sessions sync them
  (`src/core/sync.ts`).
- A geometry edit (Sculpt, Warp, Refine, mesh processing) keeps the part's shapes, as it keeps
  pins and anchors. Merging parts carries each part's shapes into the merged part's coordinates.

### Reuse from Refine

- Plane math (`planeOf`, `planeThrough`, `planeOfFace`, `rayOnPlane`, `planeCoordinates`,
  `planePoint`) and the constraint solver are reused. Their types tie points to mesh triangles
  (`GuidePoint`); the builder generalizes what a construction curve needs, without changing
  Refine's behaviour or tests.
- The drawing, point menu and move widget UI in `RefinePointer.tsx`, `RefineSketch.tsx` and
  `RefinePointMenu.tsx` are tied to the Refine session. The builder extracts what Construct
  needs so both tools share it.

## Approaches considered

1. **New construction shapes on each part, reusing Refine's sketch code.** Chosen
   **(product owner)**. Reuses the plane math, segments and solver without reworking Refine. Two
   kinds of plane exist in the app until Refine is moved over.
2. **Move Refine's sketch planes into the scene and share them.** One plane system, but Refine's
   session undo and many of its tests change, and Refine's guides are edges to solve, not
   boundaries, so only the planes would be shared.
3. **Make construction shapes parts**, like the reference planes. Selection, moving, hiding and
   saving come free, but boundaries need the exact plane and curve anyway, they would clutter
   the parts list, and sketch constraints between curves would not fit.

## Builder's discretion

- The guide run key, and the pace of the run.
- How the Move boundary check is made fast enough (hull, BVH, or a 2D index of the projected
  vertices for curve walls).
- Panel layout, keeping the existing panel patterns, and the look of planes, walls and the
  followed shape.
- How the shared sketch types are split out of Refine.
- Status line wording, following `docs/documentation.md`.

## Build order

Each step ends with its tests passing and a commit.

1. Shape model on parts: saving, undo, copy, sync, merge.
2. Construct tool: planes from 3 points and from a face, Offset, On, rename, delete, drawing.
3. Curves on planes: drawing, point editing and constraints, shared with Refine.
4. Boundaries in Sculpt.
5. Guide run in Sculpt.
6. Boundaries in Warp.
7. Move: Boundary and Follow.
8. Docs: a Construct page in `src/docs`, and an entry at the top of `src/docs/changelog.ts`.

## Verification

Unit tests (`tests/unit`):

- Boundary rule: a point moving through a plane stops 0.0001 mm short on its side; a point
  already past the plane moves freely on that side; a point crossing a curve's wall (line, arc,
  spline, open and closed) stops at it; an open wall can be gone around; two boundaries, the
  first met wins.
- Sculpt, on a flat plate with a plane 1 mm above it: Draw, Clay, Inflate, Grab and Smooth
  strokes leave no vertex above the plane; a long Draw stroke leaves a plateau flat to the
  margin. A plane below: an inverted Draw leaves none below. Symmetry is bounded too. Positions
  outside the brush are bit-identical, as today.
- Guide run: a line guide with the brush 2 mm off runs a path 2 mm off the line; an arc guide runs
  a concentric arc 2 mm larger; Shift runs the other way; a closed curve stops after one lap; the
  run is one undo step and Escape leaves the mesh untouched.
- Warp: a warp that would lift a region through a plane leaves it at the plane.
- Move: a drag toward a plane stops with the nearest vertex at the margin; a fast drag past a
  thin wall stops at it; Follow on a plane keeps the pivot's distance; Follow on an arc keeps the
  pivot's radius and height.
- Shapes survive save and reopen, undo and redo, copy and paste, a Sculpt stroke and a merge.

End to end (`tests/e2e`): make a plane from a face with an offset, sculpt against it, and check
the cap; draw an arc and run the brush along it with the key; toggle Move between Boundary and
Follow and drag.

Existing unit and end-to-end tests keep passing.
