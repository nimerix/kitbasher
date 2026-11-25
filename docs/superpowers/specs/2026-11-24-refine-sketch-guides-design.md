# Refine: guides you can place exactly

Added 2026-11-24. Changes the Edge mode of Refine described in
[2026-11-19-scan-restoration-design.md](2026-11-19-scan-restoration-design.md).

## Intent

Outlining a feature with an Edge guide is hard to do cleanly, and the solve then ignores the
outline. On a slot in a scanned plate (part 7), a closed guide of two lines and two arcs solved
to a curve that loops back on itself and lands well off the slot. The user places a guide where
the feature's edge is, or should be, so the guide's path and shape are what the result should
follow.

The goal of Refine is unchanged: trade the scan's noise for smoother curves, flatter surfaces
and consistent splines, with sharp edges where the guides say.

## What the user asked for (product owner)

1. **The guide is the edge.** The user can adjust how far the solve may move it to fit the scan.
2. **Locks on the solve:** use the guide's path; use the guide's plane.
3. **Wall angle:** the user can give the rough angle between the wall and the surface.
4. **Where the guide sits on a filleted edge:** along the fillet, at the top of the fillet, at
   the bottom of the fillet, or at the projected right-angle corner the fillet rounds off.
5. **The result on a filleted edge is a sharp corner.**
6. **Sketch planes:** lock a guide's points to a plane the user defines, for example from 3
   points.
7. **Line lock:** a point slides along a line.
8. **Move widget:** clicking an existing point shows a widget to move it.
9. **Point menu:** right-click a point to Lock, Align, Constrain or Delete it.
10. **Align** moves a point level with another point the user clicks, along one of the plane's
    axes, like Fusion 360's horizontal and vertical constraints.
11. **Constraints between segments,** as in Fusion 360 sketches, for example parallel.

## Goals

- A guide placed on a sketch plane, at the corner, with the solve locked to it, produces a
  sharp edge exactly on the guide.
- The user can tell the solve which parts of the answer come from the guide and which from the
  scan.
- Points can be placed and moved precisely: on a plane, along a line, by a widget, and held in
  place by constraints.
- Today's behaviour stays available for guides that only mark an edge (Detect and the crease
  brush).

## Non-goals

- Leaving a fillet or chamfer on the refined edge. The result is a sharp corner.
- Typed dimensions (lengths, radii, angles between segments).
- Thinning the mesh. Refine keeps moving vertices onto the fitted surfaces, as today.
- Saving sketch planes or constraints with the scene. They live in the Refine session.
- Constraints on spline segments. Points of a spline can still be locked, aligned and fixed.

## Anti-goals

- A solve that moves the edge farther from the guide than the user allowed.
- A guide whose locks or constraints silently stop holding after a drag, an undo or a solve.

## Decisions

Marked **(product owner)** where the user decided; the rest are the designer's calls.

### Solve settings

Per edge guide, shown in the Edge section of the Refine panel and stored with the guide like
Width, Strength and Ends (`RefineSession.edge` holds the values for the next guide;
`EdgeInput` carries each guide's own):

| Setting             | Values                                         | Default for a hand-placed guide |
| ------------------- | ---------------------------------------------- | ------------------------------- |
| **Position**        | Corner, Top of fillet, Bottom of fillet, Along | Corner                          |
| **Fit**             | mm, from 0                                     | 0                               |
| **Use guide path**  | on, off                                        | on                              |
| **Use guide plane** | on, off; only for a guide on a sketch plane    | on when the guide has a plane   |
| **Wall angle**      | Automatic, or degrees                          | Automatic                       |

The two faces either side of the edge are named as the user named them: the **surface** and the
**wall**. With a sketch plane, the surface is the face more nearly parallel to the plane.
Without one, the builder picks a deterministic rule (for example the face more nearly parallel
to the best-fit plane of the guide's points, falling back to the larger flank) and documents it.

What each setting does:

- **Position** says where the guide lies relative to the rounded edge on the scan.
  - **Corner** (product owner): the guide is the sharp edge itself.
  - **Top of fillet**: the guide lies on the surface, where the rounding starts. The edge is
    where the surface meets the wall.
  - **Bottom of fillet**: the guide lies on the wall, where the rounding ends. The edge is
    where the wall meets the surface.
  - **Along**: the guide lies somewhere on the rounding. The edge is where the two faces meet,
    found from both sides. This is today's solve.
- **Fit** (product owner) is how far, in mm, the solved edge may move off the edge the guide
  sets. At 0 the edge is exactly the guide (Corner) or exactly the guide carried across the
  rounding (Top, Bottom).
- **Use guide path** (product owner) keeps the guide's shape. A line stays a line in its
  direction, an arc keeps its centre and plane, a spline keeps its shape. Any move is one
  offset for the whole segment, within Fit. Off, each place along the edge may move on its
  own, within Fit, and the segment is refitted to its kind, as today.
- **Use guide plane** (product owner) makes the surface the sketch plane itself, not a fit to
  the scan, when Position is Corner or Top. With Bottom or Along, the surface is fitted from
  the scan but held parallel to the plane. The edge then stays in the plane.
- **Wall angle** (product owner) is the angle between the surface and the wall, 90 for a
  square edge whether it is an outside corner or the rim of a slot. Automatic reads it from the
  scan. Set, the wall's fit is
  held within 5 degrees of it. With the edge on the guide and the surface known, a set angle
  fixes a straight wall as a plane through the edge and an arc's wall as a cylinder or cone
  round the arc's axis; the scan only says which side the wall is on.

How the solve runs with these (replacing steps 2 and 3 of "How an edge is rebuilt"):

1. Read the band as today, but measure Width from the guide's edge (below), not from a solved
   edge, so a narrow slot's band does not reach the far wall.
2. Fit the surface: the sketch plane (Use guide plane), or the flank on the surface side.
3. Fit the wall from the flank on the wall side, through the edge when the edge is known
   (Corner), and held to Wall angle when it is set.
4. The guide's edge: Corner, the guide; Top or Bottom, the guide carried across the rounding
   onto where the faces meet, as one offset per segment when Use guide path is on; Along,
   where the faces meet, as today.
5. Move toward where the faces meet by at most Fit, keeping the guide's shape when Use guide
   path is on, then rebuild as today: band vertices onto their side's face, a chain of mesh
   edges cut onto the edge.

**Today's solve stays as a setting.** Along, Use guide path off, and Fit at today's reach (the
larger of 0.35 mm and 6 edge lengths) reproduces the current solve. Detect's proposals and the
crease brush use exactly these settings, so their tests and behaviour do not change. Existing
solve tests run with these settings.

A solve that cannot hold the user's settings (no wall on either side, Fit too small for the
faces to meet the edge, a wall that cannot be fitted within 5 degrees of Wall angle) refuses
as today and the status line says which setting to change.

### Sketch planes

- A sketch plane is a session object: an origin, a normal, and in-plane axes `u` and `v`. The
  session keeps a list; the panel names them Plane 1, Plane 2, and so on.
- **Making one:** in the Edge section, Plane > New plane, then either click 3 points on the
  mesh, or click once on a flat face to fit a plane to the surface around the click (reuse the
  plane fitting in `src/core/planes.ts` or `fitShape`). `u` runs from the first point to the
  second, or along the face fit's longer extent.
- **Using one:** Plane chooses the plane the next guide is drawn on (None by default). A
  guide's plane can also be set from the point menu (Lock > To plane), which projects all of
  that guide's points onto it. Every point of a guide shares its plane; a guide is on one plane
  or none.
- **Drawing on a plane:** while drawing a guide on a plane, a click places the point where the
  cursor's ray meets the plane, not where it meets the mesh, including where the ray misses the
  part. This is what lets a point sit on the true corner of a rounded scan.
- The plane is drawn as a faint grid square around the guide while that guide is selected, with
  its `u` and `v` axes marked.
- Planes last until Apply or Cancel, and are part of the session's undo steps.

### Points

- Every guide point keeps a `triangle` because the band search starts from it
  (`refine-band.ts:433-441`). A point off the surface takes the triangle nearest it, looked up
  with the part's BVH.
- **Locks per point:** To line (slides along a line through two points the user clicks, guide
  points or mesh points), Fixed (does not move), or none. A point on a plane is locked to the
  plane through its guide. Unlock clears a point's own lock.
- **Dragging a point** keeps today's gesture: free points slide along the mesh, as now. A point
  on a plane slides on the plane (ray meets plane). A point on a line slides along the line. A
  fixed point does not drag.
- **Move widget:** clicking a point (the existing choose-a-point click) shows a translate widget
  at it. Free point: three arrows along the world axes. On a plane: two arrows along `u` and `v`
  and a square handle for the plane. On a line: one arrow along the line. Fixed: no widget.
  Follow the Warp point handle (`WarpOverlay.tsx:436-520`, proxy object and `PrecisionDrag`).
  One widget drag is one undo step, like a handle drag today, and Escape during it restores the
  point.
- **Point menu** (right-click a point handle; today `RefinePointer` ignores buttons other than
  0):
  - **Lock** > To plane (pick a plane or New plane), To line, Fixed, Unlock.
  - **Align** > Horizontal, Vertical, then click another point: this point takes that point's
    `v` (Horizontal) or `u` (Vertical) coordinate in the plane. It is kept as a constraint.
    Disabled on a guide with no plane, with the reason shown.
  - **Constrain** > the segment constraints (below) between the two segments that meet at this
    point. Disabled at an open end or where neither segment is a line or arc.
  - **Delete** removes the point, as Remove point does today.
- The menu uses the editor's context menu component and keyboard handling
  (`EditorContextMenu.tsx`), with its own item list for points.

### Constraints

- Constraints hold only on a guide on a sketch plane and are solved in that plane's `u`, `v`
  coordinates.
- **Kinds:** Parallel, Perpendicular, Collinear, Equal (length of two lines, or radius of two
  arcs), Tangent (a line and an arc, or two arcs, that share a point), Concentric (two arcs),
  Horizontal and Vertical (a line along `u` or `v`; between two points, Align), and Fixed (Lock
  > Fixed).
- **Adding one:** right-click a segment's guide line for the segment menu, Constrain, pick the
  kind, then click the other segment. Horizontal and Vertical on a line need no second click.
  From a point menu, Constrain applies to the two segments meeting there with no second click.
- **Seeing and removing:** each constraint shows a small icon beside its segment or point, as in
  Fusion. Right-click the icon to delete the constraint.
- **Solving:** the guide's points are solved together whenever a point moves, a constraint is
  added or removed, or a plane changes: the moved point follows the cursor, the rest move as
  little as possible, and every constraint holds within 1e-6 mm. Arcs keep their three points;
  constraints on an arc read its centre and radius from them.
- **Conflicts:** a constraint that cannot be met with the existing ones is refused, nothing
  changes, and the status line says so, as Fusion does. A drag that cannot be followed stops
  at the nearest position that keeps every constraint.
- Constraints stay with the guide until it is accepted, and are part of undo steps.

## Approaches considered

**What a guide controls** reverses "What a guide controls" in the 2026-11-19 design, where the
guide was a hint and the edge was solved from the flanks (product owner, then and now).
(1) Keep the hint and cap how far the edge may move. (2) The guide is the edge, with settings
that say which parts come from the scan. **Chosen: 2 (product owner).** With 1 the edge still
comes from flank fits, which is what fails on the slot.

**Constraint solver.** (1) A sketch solver library (for example FreeCAD's planegcs built to
WebAssembly). (2) A small damped least-squares solver written here. **Chosen: 2.** A guide
has at most a few dozen points, so a Levenberg-Marquardt solve with a numeric Jacobian runs in
well under a millisecond, and it adds no dependency or WebAssembly build to the app.

**Where a plane lives.** (1) Per point. (2) Per guide, chosen from session planes. **Chosen: 2.** Constraints need every point of a guide in one plane, and several guides sharing a plane
is how a Fusion sketch works.

## Builder's discretion

- How the surface and wall are told apart without a plane.
- Exact UI layout of the new settings, keeping the panel's existing patterns (`AutoSetting` for
  Wall angle, the segmented control for Position).
- Constraint icon art and placement.
- How the plane grid is drawn.
- Status line wording, following `docs/documentation.md` and the existing Refine copy.

## Build order

Each step ends with its tests passing and a commit.

1. **Solve settings:** Position, Fit, Use guide path, Wall angle, with today's solve as the
   Along preset for Detect and the crease brush.
2. **Sketch planes and points:** planes, drawing on a plane, Use guide plane, line lock, Fixed,
   the move widget, the point menu with Lock, Align and Delete.
3. **Constraints:** the solver, segment and point Constrain menus, icons, conflict refusal.
4. **Docs:** the Refine page in `src/docs`, and an entry at the top of `src/docs/changelog.ts`.

## Verification

Unit tests on synthetic fixtures (`tests/unit`, alongside the `refine-*` tests):

- A plate with a slot whose walls are rounded at the top: a closed guide of two lines and two
  arcs on a plane on the plate's top face, Position Corner, Fit 0, Use guide plane, Wall angle 90. The cut edge lies within 0.002 mm of the guide everywhere, has no loops and is in one
  piece; the plate's top within the band is flat to 0.002 mm.
- The same with Wall angle Automatic: the edge still lies on the guide.
- A 90 degree edge filleted at a known radius: guides at Top and at Bottom of the fillet, Fit
  0, produce the edge at the true corner within 0.005 mm. Along with Fit at today's reach
  matches today's result.
- Fit: with Position Corner and the guide placed 0.2 mm off the true corner, Fit 0 keeps the
  edge on the guide; Fit 0.3 moves it to the corner; Fit 0.1 moves it 0.1 and no farther.
- Use guide path: a line guide stays straight and parallel to itself after the solve.
- Constraint solver: each kind alone; the slot (two parallel lines, two tangent arcs, equal
  radii) under a drag; a conflicting constraint refused with nothing changed.
- Session: plane from 3 points and from a face; drawing on a plane; line lock; Fixed; Align;
  Delete; undo and redo of each; constraints kept through undo.

End to end (`tests/e2e/refine.spec.ts`): right-click a point opens the point menu; the widget
moves a point on a plane and the point stays in the plane; adding Parallel then dragging keeps
the lines parallel; deleting a constraint from its icon.

Existing refine unit and end-to-end tests keep passing.
