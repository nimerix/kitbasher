# Construction shapes implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Planes and curves stored on parts that stop Sculpt, Warp and Move from taking the mesh
across them, a Sculpt guide run along a curve, and a Move Follow mode that holds a drag to a shape.

**Architecture:** Shapes live on `Part.constructions` in mesh-local coordinates and travel through
the existing part paths (save, undo, copy, sync). One pure module, `construction-bounds.ts`, answers
"where does a point moving from A to B stop", and each tool calls it at the single place it sets
new positions: `dabWork` in Sculpt, `evaluateWarp` in Warp, and the `place` closure of
`transformMany` in Move. Curves reuse Refine's plane math, segment drawing and constraint solver.

**Tech stack:** TypeScript, three.js, react-three-fiber, Zustand, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-25-construction-shapes-design.md`. Background:
`docs/superpowers/specs/2026-11-24-refine-sketch-guides-design.md` (sketch planes, point menu,
constraints) and `docs/superpowers/specs/2026-11-23-browser-sculpting-design.md`.

## Global constraints

- Shapes are stored in mesh-local coordinates of the part they were made on. A plane's Offset is
  in the part's local units (mm at scale 1). Curve points are stored in their plane's (u, v).
- **The rule:** a point moving in a straight line that crosses a boundary stops on its own side, a
  margin short of it: `boundaryMargin(extent) = Math.max(1e-4, extent * 2 ** -21)` mm, where
  `extent` is the largest absolute world coordinate of the owning part's bounds. Boundaries are
  two-sided; the first boundary met wins; no per-point state is kept between edits.
- Boundaries are every shape with `on: true` on a visible part, except: the guide curve during a
  guide run, the shape followed in Follow, and shapes on any part the current Move carries.
- A curve's wall is infinite along its plane's normal both ways and as long as the curve.
- Sculpt, Warp and Move results with no shapes on are bit-identical to today.
- Refine's behaviour and tests are unchanged. Refine keeps its own session planes.
- Copy follows `docs/documentation.md`. Commit subjects `(<type>) <Sentence-case summary>`, no
  attribution.
- Checks per task: `npx tsc --noEmit`, the task's `npx vitest run <files>`, the task's
  `npx playwright test <specs>`, and `npm run format:check`. The final task runs `npm test`,
  `npm run test:e2e` and `npm run build`.

## Review focus

1. **A guide run with the brush inside an arc by more than its radius:** the parallel path
   vanishes. Expect the run to refuse with a status message and leave the mesh untouched. Test in
   Task 8.
2. **A plane at Offset 0 made through mesh vertices:** those vertices lie exactly on it. Expect a
   point exactly on a plane to count as behind it (the side opposite the normal), so Draw on a face
   with a plane at Offset 0 raises nothing. On a curve's wall, a point exactly on it counts as
   inside a closed curve, or to the left of an open curve's drawn direction. Test in Task 6.
3. **Shapes on a part with non-uniform or mirrored scale:** boundaries must hold in world space.
   Test in Task 6 with a part scaled `[1, 2, -1]`.
4. **The Sculpt guide or the Move follow shape is deleted, switched off or undone away:** expect
   the choice to clear, with no crash. A Move falls back to Boundary. Tests in Tasks 8 and 10.
5. **A part carried by a joint or a pin correction into a plane during a Move, with No clip on:**
   expect the carried part to be bounded too. Test in Task 10.

---

### Task 1: Shared sketch plane module

**Files:**

- Create: `src/core/sketch-plane.ts`
- Modify: `src/core/refine-sketch.ts` (move the pure exports out, re-export them),
  `src/core/refine-constraints.ts:4`, `src/core/refine-band.ts:10` (import from the new module)
- Test: `tests/unit/sketch-plane.test.ts`

**Interfaces:**

- Produces, unchanged signatures, from `src/core/sketch-plane.ts`: `SketchPlane`, `planeOf`,
  `planeThrough`, `ontoPlane`, `planeCoordinates`, `planePoint`, `rayOnPlane`, `bestPlaneNormal`,
  `closestOnTriangle`, `PointLock`, `ontoLine`, `lineThrough`, `lineNearRay`, `heldPoint`. The
  module imports only `./types`. `nearestOnSurface`, `nearestTriangle`, `pointAt` and
  `planeOfFace` stay in `refine-sketch.ts`.

- [ ] **Step 1: Write the failing tests**

```ts
describe('sketch plane', () => {
  const plane = planeOf('p', 'Plane 1', [1, 2, 3], [0, 0, 2], [1, 1, 0])!;
  it('meets a ray', () => {
    expect(rayOnPlane(plane, [0, 0, 10], [0, 0, -1])).toEqual([0, 0, 3]);
    expect(rayOnPlane(plane, [0, 0, 10], [1, 0, 0])).toBeNull(); // along the plane
    expect(rayOnPlane(plane, [0, 0, 10], [0, 0, 1])).toBeNull(); // plane behind
  });
  it('round-trips (u, v)', () => {
    const [u, v] = planeCoordinates(plane, planePoint(plane, 0.7, -1.2));
    expect(u).toBeCloseTo(0.7, 12);
    expect(v).toBeCloseTo(-1.2, 12);
  });
  it('refuses 3 collinear points', () =>
    expect(planeThrough('p', 'P', [0, 0, 0], [1, 0, 0], [2, 0, 0])).toBeNull());
  it('fits the normal of noisy flat points', () => {
    const points = Array.from({ length: 50 }, (_, i) => [
      i % 7,
      Math.floor(i / 7),
      0.01 * Math.sin(i * 12.9898),
    ]).flat();
    expect(Math.abs(bestPlaneNormal(points)![2])).toBeGreaterThan(0.999);
  });
  it('holds a point by its lock', () => {
    expect(heldPoint({ kind: 'fixed' }, null, [1, 1, 1], [5, 5, 5])).toEqual([1, 1, 1]);
    const line = lineThrough([0, 0, 0], [1, 0, 0])!;
    expect(heldPoint(line, null, [0, 0, 0], [4, 2, 1])).toEqual([4, 0, 0]);
    expect(heldPoint(undefined, plane, [0, 0, 0], [4, 2, 9])).toEqual([4, 2, 3]);
  });
});
```

- [ ] **Step 2: Run to verify it fails** - `npx vitest run tests/unit/sketch-plane.test.ts`:
      FAIL, module not found.
- [ ] **Step 3: Move the pure functions** into `src/core/sketch-plane.ts` and re-export them from
      `refine-sketch.ts`.
- [ ] **Step 4: Run** `npx vitest run tests/unit/sketch-plane.test.ts tests/unit/refine-constraints.test.ts tests/unit/refine-sketch-session.test.ts tests/unit/refine-guide-edge.test.ts`:
      PASS.
- [ ] **Step 5: Commit** `(refactor) Move sketch plane math out of Refine`

### Task 2: Construction shapes on parts

**Files:**

- Modify: `src/core/types.ts` (types below, `Part.constructions?`)
- Create: `src/core/construction.ts`
- Modify: `src/core/scene-file.ts:356-384` (validate), `src/core/sync.ts:25-37`
  (`['constructions']` in `fieldGroups.parts`), `src/core/clipboard.ts:68-122` (deep copy),
  `src/core/merge.ts:240-262` and `src/core/store.ts:5388` (carry into the merged part),
  `src/core/store.ts:5351-5387` (`applyProcessedMesh` keeps shapes; shapes do not count as
  `linked`), `mcp/session.ts:739-748` (pattern copy keeps them), `docs/scene-format.md:31-38`
- Test: `tests/unit/construction.test.ts`, `tests/unit/scene-format.test.ts`

**Interfaces:**

- Consumes: Task 1's `SketchPlane`, `planePoint`, `planeCoordinates`; `GuideKind`
  (`src/core/refine-curve.ts`), `GuideConstraint`, `GuideShape`, `solvedSegments`
  (`src/core/refine-constraints.ts`).
- Produces, in `src/core/types.ts`:

```ts
export interface ConstructionPlane {
  kind: 'plane';
  id: string;
  name: string; // 'Plane 1', in the order the part's planes were made
  origin: Vec3; // at Offset 0
  normal: Vec3; // unit
  u: Vec3; // unit, in the plane
  v: Vec3; // normal x u
  offset: number; // along normal
  on: boolean;
}
export type ConstructionLock =
  { kind: 'fixed' } | { kind: 'line'; origin: [number, number]; direction: [number, number] };
export interface ConstructionPoint {
  at: [number, number]; // (u, v) on the curve's plane; a shared joint repeats the same value
  lock?: ConstructionLock;
}
export interface ConstructionCurve {
  kind: 'curve';
  id: string;
  name: string; // 'Curve 1'
  plane: string; // a plane id on the same part
  segments: { kind: GuideKind; points: ConstructionPoint[] }[];
  closed: boolean;
  constraints: GuideConstraint[];
  on: boolean;
}
export type ConstructionShape = ConstructionPlane | ConstructionCurve;
export interface ShapeRef {
  partId: string;
  shapeId: string;
}
```

- Produces, in `src/core/construction.ts`:
  - `planeFrame(plane: ConstructionPlane): SketchPlane` - the frame at its Offset, local.
  - `curvePlane(shapes: ConstructionShape[], curve: ConstructionCurve): ConstructionPlane | null`
  - `curveShape(curve: ConstructionCurve, plane: ConstructionPlane): GuideShape` - points as
    `{ triangle: -1, position: planePoint(frame, ...at), lock }` for the solver.
  - `fromShape(curve, plane, segments: GuideShape['segments']): ConstructionCurve['segments']`
  - `findShape(parts: Part[], ref: ShapeRef): { part: Part; shape: ConstructionShape } | null`
  - `nextShapeName(shapes: ConstructionShape[], kind: 'plane' | 'curve'): string`
  - `validConstructions(value: unknown): ConstructionShape[]` - throws
    `Error('The scene contains invalid construction shapes.')` on a missing or duplicate id, a
    non-finite number, a zero normal, a curve whose plane is missing, or a segment with the wrong
    point count for its kind.
  - `carriedConstructions(shapes: ConstructionShape[], from: Matrix4, to: Matrix4): ConstructionShape[]`
    - re-expresses shapes from one part frame in another: transform the plane origin, the offset
      origin and every curve point in 3D by `to⁻¹ · from`, rebuild the frame from the transformed
      normal and `u`, and read the new Offset and (u, v) from it. An arc's 3 points stay its 3
      points.

- [ ] **Step 1: Write the failing tests** in `tests/unit/construction.test.ts`:
  - `'saves and reopens shapes'`: a part with a plane (Offset 1.5, off) and a closed curve of a
    line and an arc with a Parallel constraint survives `sceneFileBlob` then `parseSceneDocument`
    with `toEqual`.
  - `'refuses invalid shapes'`: a curve with `plane: 'missing'` and a plane with `normal: [0,0,0]`
    each make opening throw `'The scene contains invalid construction shapes.'`.
  - `'copies shapes with the part'`: `duplicateSelected` gives an equal but not identical
    `constructions` array.
  - `'shares shapes'`: `diffScenes` of two scenes differing only in `constructions` is non-empty.
  - `'carries shapes into a merged part'`: after `replaceWithMerged` of two parts, one rotated 30
    degrees and translated, each plane's world origin, normal and offset point, and each curve
    point's world position, match within `1e-9`.
  - `'keeps shapes through mesh processing and a sculpt stroke'`, and an in-place
    `applyProcessedMesh` is not refused for a part whose only link is shapes.
  - `'undoes a shape change'`: `patchParts([id], { constructions })` then `undo` restores the
    previous array.
- [ ] **Step 2: Run to verify they fail** - `npx vitest run tests/unit/construction.test.ts`.
- [ ] **Step 3: Implement** the types, `construction.ts`, and the listed file changes. Document
      the field in `docs/scene-format.md` next to pins.
- [ ] **Step 4: Run** `npx vitest run tests/unit/construction.test.ts tests/unit/scene-format.test.ts tests/unit/pins.test.ts tests/unit/merge-job.test.ts`:
      PASS.
- [ ] **Step 5: Commit** `(feat) Store construction shapes on parts`

### Task 3: Construct tool and planes

**Files:**

- Modify: `src/core/types.ts:7-20` (`'construct'`), `src/core/keybindings.ts` (`construct:
{ group: 'Tools', label: 'Construction shapes', keys: ['C'] }`), `src/hooks/useWorkbench.ts:22-30`,
  `src/App.tsx` (toolbar button titled `Make construction shapes` after Pins, shortcut label,
  status hint, right panel list), `src/components/Inspector.tsx:951-994`,
  `src/components/Dialogs.tsx:646-653`, `src/components/Viewport.tsx` (`toolsPicking`, click
  routing at :263-272, overlay mount, `onPointerMissed` exclusions)
- Modify: `src/core/store.ts` (state, actions, `toolChange` clears picking)
- Create: `src/components/ConstructControls.tsx`, `src/components/ConstructOverlay.tsx`
- Modify: `src/core/construction.ts` (`planeOfPartFace`)
- Test: `tests/unit/construct-session.test.ts`

**Interfaces:**

- Consumes: Task 2's types, `nextShapeName`, `planeFrame`; Task 1's `planeThrough`, `planeOf`,
  `bestPlaneNormal`.
- Produces, store state `construct: { partId: string; selected: string | null; picking:
ConstructPicking | null } | null` (set while the tool is open), with
  `ConstructPicking = { kind: 'plane'; from: 'points' | 'face'; points: (SurfacePoint & { face: number })[] }`
  for now (Task 5 adds members), and actions:

```ts
startConstructPlane: (from: 'points' | 'face') => void;
pickConstruct: (point: SurfacePoint & { face: number }) => void; // world point on the part
cancelConstructPicking: () => void;
selectConstructionShape: (shapeId: string | null) => void;
setConstructionShape: (
  shapeId: string,
  patch: { name?: string; on?: boolean; offset?: number },
  checkpoint?: boolean,
) => void;
removeConstructionShape: (shapeId: string) => void; // a plane takes its curves
```

- Produces `planeOfPartFace(part: Part, face: number, point: Vec3, radius: number): ConstructionPlane | null`
  (local `point`): fit `bestPlaneNormal` to the vertices of triangles within `radius` of `point`
  whose normals are within 30 degrees of the clicked triangle's; null when any is farther than
  `radius / 10` from the fit. The normal points the way the clicked triangle faces; `u` runs along
  the longest spread. `radius = Math.max(0.5, 0.02 * partSize(part))`.
- A plane from 3 points has its normal turned to agree with the first pick's surface normal.
- Every shape change is one `patchParts` call; an Offset field commits once per edit, like the pin
  priority slider (`checkpoint` false while typing, true on commit).
- `ConstructOverlay` draws, inside each part's `<group>`: with Construct open, the selected part's
  shapes (plane as a grid square sized to the part with `u` and `v` marked, curve as a line with
  its wall shown faintly a short way either side); in Sculpt, Warp and Move, every shape that is
  on, faintly. The plane grid reuses `PlaneGrid` from `RefineSketch.tsx` (moved in Task 4; import
  it from its current place here).

- [ ] **Step 1: Write the failing tests** (store level, fixture as in `tests/unit/pins.test.ts`,
      part = `softBox` from `tests/helpers/refine-session.ts`):
  - `'makes a plane from 3 points'`: 3 picks on the top face give a plane through them, normal
    `[0, 0, 1]` within `1e-9`, named `'Plane 1'`, `on: true`, Offset 0, one undo step.
  - `'makes a plane from a flat face and offsets it'`: a face pick then `offset: 1` puts
    `planeFrame(plane).origin[2]` at top + 1.
  - `'refuses a curved face'`: a pick on the rounded edge makes no shape and notifies.
  - `'deletes a plane with its curves'` and `'switches a shape off'`.
  - `'leaving the tool clears picking'`.
- [ ] **Step 2: Run to verify they fail** - `npx vitest run tests/unit/construct-session.test.ts`.
- [ ] **Step 3: Implement** the tool wiring, store actions, panel (shape list with On, rename,
      delete; New plane with 3 points or face; Offset field) and overlay.
- [ ] **Step 4: Run** the test file, `npx vitest run tests/unit/commands.test.ts`, and
      `npx playwright test tests/e2e/pins.spec.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Add the Construct tool with planes`

### Task 4: Drawing curves on a plane

**Files:**

- Create: `src/components/SketchWidgets.tsx` - moved from `RefineSketch.tsx:33-202, 250-348`:
  `squareOf`, `PlaneGrid`, `anchorOf`, `Picked`, and `PointWidget` taking
  `{ frame, lock, position, onBegin(), onMove(position: Vec3, first: boolean), onEnd(), onCancel() }`;
  and from `RefineOverlay.tsx:50-174, 455-580`: `lineMaterials`, `guidePolyline`, and
  `SketchHandles({ items: { key: string; position: Vec3; normal?: Vec3; selected: boolean; first: boolean; chosen: boolean }[] })`.
  `RefineSketch.tsx` and `RefineOverlay.tsx` use them.
- Create: `src/core/sketch-chain.ts` - `takesPoints` and `pointsNeeded` moved from
  `store.ts:7506`, used by Refine and Construct.
- Create: `src/components/ConstructPointer.tsx` - capture-phase click, handle drag, and Escape,
  modelled on `RefinePointer.tsx:1372-1501` but only for curves: rays go to part-local space with
  the inverse of `partMatrix(part)` before `rayOnPlane`.
- Modify: `src/core/store.ts`, `src/components/ConstructControls.tsx`
- Test: `tests/unit/construct-session.test.ts`, `tests/e2e/construct.spec.ts` (new)

**Interfaces:**

- Consumes: Task 2's `ConstructionCurve`, `curveShape`, `fromShape`; Task 3's `construct` state.
- Produces, store actions:

```ts
startConstructCurve: (planeId: string, kind: GuideKind) => void; // next segment's kind
setConstructSegmentKind: (kind: GuideKind) => void;
addConstructPoint: (at: [number, number]) => void; // (u, v) on the drawing plane
finishConstructCurve: () => void; // Enter; clicking the first point closes the curve instead
chooseConstructPoint: (ref: ConstructPointRef | null) => void;
beginConstructDrag: () => void;
moveConstructPoint: (ref: ConstructPointRef, at: [number, number]) => void;
endConstructDrag: () => void;
cancelConstructDrag: () => void; // restores the point
// ConstructPointRef = { curveId: string; segment: number; index: number }
```

- A drag is one undo step (checkpoint on the first move). A fixed point does not drag; a point
  with a line lock slides along it.
- Clicking a point chooses it and shows `PointWidget` at it: two arrows along `u` and `v` and a
  square handle for the plane, or one arrow along a line lock; none for a fixed point. Its drag
  uses the same begin, move, end and cancel actions.

- [ ] **Step 1: Write the failing tests:**
  - `'draws a line and an arc'`: 2 points as line, kind arc, 2 more points: one curve, segments
    `['line', 'arc']`, the arc's first point equal to the line's last.
  - `'closes a curve by clicking its first point'`: `closed: true`.
  - `'places points off the part'`: `addConstructPoint([500, 500])` works.
  - `'a point drag is one undo step'` and `'Escape restores a dragged point'`.
  - e2e `'moves a point with the widget'`: the chosen point's `u` arrow moves it along `u` and it
    stays on the plane.
  - e2e `'draws a closed curve on a plane'`: make a plane from a face, choose New curve, click 4
    screen points (2 off the part), click the first: the part has one closed curve of 4 lines.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement** the shared components, chain module, pointer and actions.
- [ ] **Step 4: Run** the new tests and `npx playwright test tests/e2e/refine.spec.ts`,
      `npx vitest run tests/unit/refine-sketch-session.test.ts tests/unit/refine-viewport-pointer.test.ts`:
      PASS.
- [ ] **Step 5: Commit** `(feat) Draw construction curves on a plane`

### Task 5: Point menu and constraints for curves

**Files:**

- Create: `src/components/SketchMenu.tsx` - `Item`, `Group`, `ConstraintGlyph`, `meeting` from
  `RefinePointMenu.tsx`, and `PairItems({ shape: GuideShape, target, onAdd(kind, pair), onPick(kind, segment) })`.
  `RefinePointMenu.tsx` uses them.
- Create: `src/components/ConstructPointMenu.tsx` - point menu (Lock > To line, Fixed, Unlock;
  Align > Horizontal, Vertical; Constrain; Delete), segment menu, constraint menu; and
  `ConstraintIcons` from `RefineSketch.tsx:113` taking `onConstraintMenu(id, e)` and
  `onFixedMenu(segment, index, e)` props.
- Modify: `src/core/store.ts:240-252` (`constructPoint`, `constructSegment`,
  `constructConstraint` on `EditorContextMenu`), `src/components/EditorContextMenu.tsx:290-313`,
  store actions below
- Test: `tests/unit/construct-session.test.ts`

**Interfaces:**

- Consumes: `solveGuide`, `solvedSegments`, `constraintRefusal`, `pairFits` from
  `refine-constraints.ts` via Task 2's `curveShape` and `fromShape`.
- Produces, store actions (each refusal notifies with `constraintRefusal`'s text and changes
  nothing):

```ts
lockConstructPoint: (ref: ConstructPointRef, lock: ConstructionLock | null) => void;
addConstructConstraint: (curveId: string, constraint: GuideConstraint, heavy?: ConstructPointRef[]) => void;
removeConstructConstraint: (curveId: string, id: string) => void;
removeConstructPoint: (ref: ConstructPointRef) => void;
startConstructPicking: (picking: ConstructPicking) => void;
```

- `ConstructPicking` (Task 3 has only the `plane` member) becomes:

```ts
type ConstructPicking =
  | { kind: 'plane'; from: 'points' | 'face'; points: (SurfacePoint & { face: number })[] }
  | { kind: 'line'; point: ConstructPointRef; picked: [number, number][] } // 2 clicks on the plane
  | { kind: 'align'; axis: LineKind; point: ConstructPointRef } // then click another point
  | { kind: 'constrain'; curveId: string; constraint: PairKind | LineKind; segment: number };
```

- Constraints are solved on every point move, added or removed constraint, and plane Offset
  change, as in Refine.

- [ ] **Step 1: Write the failing tests:** `'keeps two lines parallel through a drag'`;
      `'refuses a conflicting constraint with nothing changed'` (Parallel then Perpendicular on the
      same pair); `'aligns a point horizontally'`; `'keeps constraints through undo and save'`;
      `'deletes a point'`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the test file, `npx vitest run tests/unit/refine-sketch-session.test.ts`,
      `npx playwright test tests/e2e/refine.spec.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Lock, align and constrain construction curve points`

### Task 6: Boundaries

**Files:**

- Create: `src/core/construction-bounds.ts`
- Test: `tests/unit/construction-bounds.test.ts`

**Interfaces:**

- Consumes: Task 2's types, `planeFrame`, `curvePlane`; `drawnCurve` from `refine-curve.ts` (feed
  `[u, v, 0]` points; step `0.02` local units with a display limit of 20,000 samples).
- Produces:

```ts
export function boundaryMargin(extent: number): number;
export class Boundaries {
  static fromParts(parts: Part[], skip?: (ref: ShapeRef) => boolean): Boundaries;
  readonly empty: boolean;
  /** Where a point moving straight from `from` to `to` (world) stops. */
  limit(from: Vector3, to: Vector3, out?: Vector3): Vector3;
}
```

- How `limit` works: each boundary keeps its owning part's matrix and inverse, and tests in that
  part's local frame, where the plane and wall are exact. The point's side comes from its signed
  distance (plane) or its side of the curve in (u, v) (wall), with the tie rules in Review focus 2. At the first crossing along the line, the point is placed at the crossing, moved back onto its
  own side along the boundary's normal by the margin (for a wall, the curve's in-plane normal at
  the crossing), and transformed back to world. The result is checked again against every
  boundary, up to 4 rounds; if it still crosses, `limit` returns `from`.

- [ ] **Step 1: Write the failing tests:**
  - `'stops a point at a plane'`: plane at z = 1, from `(0,0,0)` to `(0,0,2)` gives z =
    `1 - 1e-4` within `1e-9`.
  - `'lets a point past the plane move on that side'`: from z = 3 to z = 5 returns z = 5.
  - `'keeps a point at the margin from crossing'`: from z = `1 - 1e-4` to z = 2 stays at
    `1 - 1e-4`.
  - `'treats a point on a plane as behind it'`: plane z = 0 normal +z, from z = 0 to z = 1 stays
    at `-1e-4`. A point exactly on a closed curve's wall moving outward stays inside by the
    margin; on an open curve's wall, it counts as left of the drawn direction.
  - `'stops a point at a curve wall'` for a line, an arc and a spline, each open and closed, at any
    height above or below the plane.
  - `'lets a point go round an open wall'`: a move that passes beyond the line's end returns `to`.
  - `'stops at the first boundary met'`: two planes, z = 1 and z = 2.
  - `'bounds a scaled part'`: the owning part scaled `[1, 2, -1]` and rotated; the world result
    lies on the right side by at least the margin.
  - `'ignores off shapes, hidden parts and skipped shapes'`.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement `construction-bounds.ts`.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/construction-bounds.test.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Stop points at construction shapes`

### Task 7: Sculpt against boundaries

**Files:**

- Modify: `src/core/sculpt-mesh.ts:32-44` (`SculptDab.bounds?: Boundaries`), `:1314` (limit the
  world target from the vertex's world position before `applyMatrix4(this.inverse)`)
- Modify: `src/components/SculptPointer.tsx:612-657` (build `Boundaries.fromParts` at stroke
  start, cached by scene revision; pass it in every dab, mirrored dabs included)
- Test: `tests/unit/sculpt-bounds.test.ts`, `tests/e2e/construct.spec.ts`

**Interfaces:**

- Consumes: Task 6's `Boundaries`.

- [ ] **Step 1: Write the failing tests**, on a dense flat plate (`PlaneGeometry(10, 10, 80, 80)`)
      with a plane 1 mm above it, helpers as in `tests/unit/sculpt-mesh.test.ts:15-35`:
  - `'caps every brush at a plane'`: 40 dabs each of Draw, Clay, Inflate, Grab (grab vector
    `(0,0,3)`) and Smooth leave no vertex with z > `1 - 1e-4 + 1e-6`.
  - `'flattens a long Draw stroke at the cap'`: after 200 Draw dabs, every vertex with z > 0.9 has
    z within `1e-6` of `1 - 1e-4`.
  - `'floors an inverted Draw at a plane below'` (plane at z = -1).
  - `'bounds mirrored dabs'` with symmetry.
  - `'leaves positions outside the brush bit-identical'` with a plane present.
  - e2e `'sculpts up to a plane'`: make a plane from the top face with Offset 0.5, open Sculpt,
    drag Draw across the face 20 times: no vertex higher than the plane.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/sculpt-bounds.test.ts tests/unit/sculpt-mesh.test.ts tests/unit/sculpt-session.test.ts`
      and `npx playwright test tests/e2e/construct.spec.ts tests/e2e/sculpt.spec.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Stop Sculpt brushes at construction shapes`

### Task 8: Guide run in Sculpt

**Files:**

- Create: `src/core/construction-path.ts`
- Modify: `src/core/sculpt-session.ts` (`SculptSession.guide: ShapeRef | null`,
  `runRequest: { id: number; reverse: boolean } | null`), `src/core/store.ts` (actions below;
  clear `guide` when its shape is gone or off after any scene change),
  `src/core/keybindings.ts` (`sculptGuideRun: { group: 'Tools', label: 'Run the brush along the guide', keys: ['L'] }`
  and `sculptGuideRunBack` with `['Shift+L']`), `src/hooks/useWorkbench.ts`,
  `src/components/SculptControls.tsx` (a Guide section between :141 and :142: None or a curve),
  `src/components/ConstructOverlay.tsx` (click a curve to choose it while Sculpt is open),
  `src/components/SculptPointer.tsx` (the run)
- Test: `tests/unit/construction-path.test.ts`, `tests/unit/sculpt-guide-run.test.ts`,
  `tests/e2e/construct.spec.ts`

**Interfaces:**

- Consumes: Task 2's `findShape`, `curvePlane`, `planeFrame`; Task 6's `Boundaries` (with the
  guide skipped); `drawnCurve`, `closestOnCurve`.
- Produces, in `src/core/construction-path.ts` (all in the plane's (u, v)):

```ts
export interface PlanarPath {
  points: Float64Array;
  closed: boolean;
} // u, v pairs
export function curvePath(curve: ConstructionCurve, step: number): PlanarPath;
/** Distance from the path, positive to the left of the drawn direction. */
export function signedOffset(path: PlanarPath, u: number, v: number): number;
/** The path moved sideways by `offset`; null when it vanishes. */
export function offsetPath(path: PlanarPath, offset: number): PlanarPath | null;
/** Points from the one nearest (u, v) to the end, or one lap, spaced by `spacing`. */
export function runFrom(
  path: PlanarPath,
  u: number,
  v: number,
  reverse: boolean,
  spacing: number,
): Float64Array;
```

- `offsetPath`: move each sample along its in-plane normal; where segments meet at an angle,
  join the outside of the corner with an arc round the corner point and trim the inside where the
  two offsets cross; drop loops the offset makes; return null when nothing is left.
- Store actions: `setSculptGuide(ref: ShapeRef | null)`, `requestSculptGuideRun(reverse: boolean)`.
- The run, in `SculptPointer`: from the last hover hit, offset = `signedOffset` in the guide's
  plane; path = `offsetPath`; points = `runFrom` with spacing `radius * aspect * spacing` (world
  mm); each point is raycast on the draft along the plane's normal both ways and the hit nearest
  the point is used; misses place no dab. Dabs run through the same drain, 6 ms per frame, as a
  stroke. Pressure 1, current settings, Crease and Ridge tangent from the path. One commit on
  completion; Escape cancels like a stroke. With no guide, no hover hit, or a null path, notify
  and do nothing.

- [ ] **Step 1: Write the failing tests:**
  - `'runs parallel to a line'`: line from (0,0) to (10,0), brush at (3, 2): every run point has
    v = 2 within `1e-9`, u from 3 to 10.
  - `'runs a concentric arc'`: arc of radius 5 centred at the origin, brush 2 outside: every point
    at radius 7 within `1e-6`; brush 2 inside: radius 3.
  - `'runs back with Shift'`, `'stops after one lap of a closed curve'`.
  - `'joins a corner round the outside and trims the inside'`: an L of two lines, offset 1 out
    gives a quarter arc of radius 1 at the corner; offset 1 in meets at (1, 1).
  - `'refuses a path inside an arc by more than its radius'`: `offsetPath` of the radius-5 arc by
    -6 is null; the store run notifies and the mesh is unchanged.
  - `'a run is one undo step and Escape leaves the mesh untouched'` (store level).
  - `'clears the guide when its curve is deleted, switched off or undone away'`.
  - e2e `'runs the brush along an arc'`: draw an arc, choose it as Guide, hover 1 mm outside, press
    L: one new undo step and the changed vertices lie near the concentric arc.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the new unit files and `npx playwright test tests/e2e/construct.spec.ts tests/e2e/sculpt.spec.ts`:
      PASS.
- [ ] **Step 5: Commit** `(feat) Run the Sculpt brush along a construction curve`

### Task 9: Warp against boundaries

**Files:**

- Modify: `src/core/warp-evaluate.ts:292-374` (a trailing `bounds?: Boundaries` on every
  `evaluateWarp` overload; limit each moved vertex in `scratch.world` from `model.restWorld`
  before the local conversion at :347, so positions, normals and folds agree), `:239-284`
  (`writtenLocalPositions` takes `bounds?` and limits the same way)
- Modify: `src/core/store.ts:1533-1559, 1624, 1641, 1730, 3424` (build `Boundaries.fromParts`
  once per warp session and scene revision; pass it to every evaluation and to apply),
  `src/core/warp-neighbour.ts:288`
- Test: `tests/unit/warp-bounds.test.ts`

**Interfaces:**

- Consumes: Task 6's `Boundaries`. `skinnedWorldPositions` stays unbounded (handles move freely).

- [ ] **Step 1: Write the failing tests**, with the model setup of
      `tests/unit/warp-evaluate.test.ts:25-42`: `'stops a warp at a plane'` (a handle lifting the
      region 3 mm with a plane at 1 mm leaves no vertex above `1 - 1e-4`);
      `'writtenLocalPositions agrees with evaluateWarp when bounded'`;
      `'is unchanged with no bounds'` (bit-identical output).
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/warp-bounds.test.ts tests/unit/warp-evaluate.test.ts`
      and `npx playwright test tests/e2e/warp*.spec.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Stop Warp at construction shapes`

### Task 10: Move with Boundary and Follow

**Files:**

- Modify: `src/core/types.ts:320-338` (`ViewSettings.construction: { mode: 'boundary' | 'follow'; follow: ShapeRef | null }`),
  `src/core/store.ts:2201-2225` (default `{ mode: 'boundary', follow: null }`), `:5193-5199`
  (wrap `transformMany`'s `place`), `:5129-5135` (the same for typed moves in `transform`)
- Modify: `src/core/clipping.ts:641` (export `smallestStep`)
- Modify: `src/core/construction-bounds.ts` (`limitTranslation`), `src/core/construction-path.ts`
  (`followPoint`)
- Modify: `src/components/TransformAdjustments.tsx:210-289` (Boundary / Follow toggle, followed
  shape list), `src/components/ConstructOverlay.tsx` (click a shape to follow it in Follow)
- Test: `tests/unit/construction-move.test.ts`, `tests/e2e/construct.spec.ts`

**Interfaces:**

- Consumes: Task 6's `Boundaries`, Task 8's `offsetPath`, `signedOffset`, `findShape`;
  `transformSelection` (`src/core/transform-selection.ts:82`) for the pivot.
- Produces:

```ts
/** The correction to add to every moved part's translation so none of its vertices crosses. */
export function limitTranslation(
  bounds: Boundaries,
  current: Part[],
  proposed: Part[],
): Vec3 | null;
/** Where the pivot may go along the followed shape from `current`, nearest `proposed`. */
export function followPoint(
  parts: Part[],
  ref: ShapeRef,
  current: Vec3,
  proposed: Vec3,
): Vec3 | null;
```

- The `place` wrapper: `out = place(poses)`; parts whose pose changed only by translation are
  bounded (others are not); `c = limitTranslation(...)`, null when nothing crosses; when `c` is
  set, return `place(poses shifted by c)`, re-check, up to 3 rounds; if still crossing, return the
  current poses. Bounds skip shapes on every part whose pose changed, and in Follow the followed
  shape. In Follow, before `place`, shift the target poses by `followPoint(...) - proposedPivot`;
  a missing or off followed shape does nothing.
- `limitTranslation` builds rows `a · c ≥ b` and solves them with `smallestStep` (rows with
  `b ≤ 0` already hold), so only the blocked part of the move is removed and the rest slides. For
  a plane at height `h` along world normal `n`, with margin `m` and a part's world vertices `p`
  moving by `d`: the vertices behind it give `-n · c ≥ max(n · (p + d)) - h + m`; the vertices in
  front give `n · c ≥ h + m - min(n · (p + d))`. For a curve wall, the earliest vertex crossing
  along `d` gives one row with the wall's in-plane normal at that crossing and that vertex's
  distance to the wall. Per drag, cache each part's extreme `n · (R S p)` per plane and a 2D
  bucket grid of its vertices in each wall's (u, v), keyed by geometry, quaternion and scale.
- `followPoint`: a plane keeps the current pivot's distance; a curve keeps its height above the
  plane and its offset from the curve, and takes the point of `offsetPath` nearest `proposed`.
- Translate only: the part does not turn.

- [ ] **Step 1: Write the failing tests:**
  - `'stops a drag at a plane'`: a box dragged 5 mm toward a plane 2 mm away ends with its nearest
    vertex `1e-4` short, with No clip on and off.
  - `'slides along a plane'`: a diagonal drag keeps the component along the plane.
  - `'stops a fast drag at a thin wall'`: one 50 mm step across a line wall stops at it.
  - `'bounds a part carried by a joint'`: dragging the parent pushes the child into the plane; the
    child stops at it, No clip on.
  - `'ignores the moving part's own shapes'`.
  - `'follows a plane'` (pivot keeps its distance) and `'follows an arc'` (pivot keeps radius
    and height).
  - `'falls back to Boundary when the followed shape is gone'`.
  - `'keeps up with a dense part'`: a 700k-vertex part against one plane and one closed 4-line
    curve: after the first call of a drag, each `limitTranslation` call takes under 1 ms (median of
    50).
  - e2e `'moves along and up to shapes'`: Boundary drag stops at a plane; switch to Follow, choose
    an arc, drag: the pivot stays at its radius.
- [ ] **Step 2: Run to verify they fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `npx vitest run tests/unit/construction-move.test.ts tests/unit/clipping.test.ts tests/unit/assembly.test.ts tests/unit/pins.test.ts`
      and `npx playwright test tests/e2e/construct.spec.ts`: PASS.
- [ ] **Step 5: Commit** `(feat) Move parts up to or along construction shapes`

### Task 11: Documentation

**Files:**

- Modify: `src/docs/assembly-guides.ts` (new `construct` article after `pins`: making planes,
  Offset, drawing curves, constraints, On, how boundaries work; a `guide-run` section in the
  `sculpt` article; Boundary and Follow in the `transforms` article's `blocked-movement`
  section), `src/docs/content.ts:80-113` (order), `src/docs/main.tsx:46-71, 445-454` (icon, tool
  directory), `src/docs/changelog.ts` (new top entry, `kind: 'new'`, `guide: 'construct'`, no
  `commit`)
- Test: `tests/unit/changelog.test.ts`

- [ ] **Step 1: Write the docs** following `docs/documentation.md`.
- [ ] **Step 2: Run** `npm test`, `npm run test:e2e`, `npm run build`, `npm run format:check`: all
      PASS.
- [ ] **Step 3: Commit** `(docs) Explain construction shapes`
