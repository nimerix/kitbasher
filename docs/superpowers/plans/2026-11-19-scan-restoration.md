# Refine (scan restoration) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop Refine tool that rebuilds softened edges as idealized ones from line, arc and spline guides, smooths, flattens or shape-snaps painted regions while keeping detail, offers crease, flatten and smooth brushes, and proposes guides and regions automatically.

**Architecture:** Pure typed-array modules in `src/core/refine-*.ts` work on a `RefineMesh`: the part welded into world space, able to move vertices and cut triangles while staying closed. One surface fitter (plane, cylinder, cone, sphere, sweep) serves edge flanks, regions and detection. The store owns one Refine session beside Warp's: a working model that accepted features are baked into, a draft that previews pending ones without cutting, session undo and redo, and Apply. A worker builds the model and runs detection. The viewport and inspector draw the session.

**Tech Stack:** TypeScript, React, Three.js, three-mesh-bvh, zustand, ml-matrix, Vitest, Playwright. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-11-19-scan-restoration-design.md`

## Global Constraints

- Work on branch `feature/scan-restoration`. Commit subjects are `(<type>) <Sentence-case summary>`, for example `(feat) Add the Refine working mesh`. No AI attribution, trailers or co-author lines.
- The four parts ship together as one tool. Do not release or changelog any part alone.
- Run `npm test`, `npm run format:check` and `npm run build` before every commit. CI does not run tests.
- Comments only where necessary: one line stating the reason. Prettier: single quotes, trailing commas, 100 columns.
- Units are millimetres. All Refine math runs in world space, so a non-uniform or mirrored part scale does not distort fits or widths.
- Never write into `part.geometry` or any array it owns.
- Weld with `weldedPositionIndex(geometry)` (1e-5, `src/core/mesh-topology.ts:5`). Every geometry vertex of one moved welded vertex receives identical position bits.
- Vertices outside every feature's footprint keep their exact source position and normal bits.
- A closed input stays closed under `hasClosedEdges`. No zero-area triangle is created.
- Apply is one scene undo step, leaves `pins`, `anchors`, `pivot`, joints and plane constraints unchanged and moves no other part.
- Nothing is applied that the user did not accept. Detection writes nothing to the working model.
- Refine is refused on parts above `maxPaintTriangles` (10,000,000) with: `${part.name} has too many triangles to refine. The limit is 10 million.`
- Desktop only. No MCP tools, nothing under `mcp/` or `native/`, no scene format change.
- Nothing existing may get slower. Exports of unrefined parts stay bit-identical.
- Synthetic-fixture tolerances from the spec, used verbatim in tests: edge vertices within 0.02 mm of the true edge; straightness 0.005 mm; faces within 1 degree of 90; flattened base within 0.005 mm; rivet height kept within 0.01 mm; Smooth removes at least 90 % of ripple amplitude and changes mean radius by less than 0.5 %; re-running a feature moves no vertex more than 0.001 mm.
- The reference scans and photos are never committed. Tests that need them read the directory in `REFINE_SCANS` and skip when it is unset.

## Review Focus

1. Unindexed STL scans (both reference parts): after moves and cuts, welded duplicates share bits and the mesh stays closed. Tests in Tasks 2 and 3 run every case on indexed and unindexed input.
2. A mirrored or non-uniformly scaled part (`scale: [1, 2, -1]`): a refined edge still meets the spec tolerances in world space and normals face outward. Tests in Tasks 2 and 7.
3. A guide placed where there is no edge, or between faces less than 15 degrees apart: nothing changes and the user is told `No edge found under this guide. Move it onto the rounded edge or change Width.` Tests in Tasks 7 and 15.
4. A thin feature, where Width reaches a second softened edge or the far side of a wall: only the edge under the guide is rebuilt. Test in Task 6.
5. Smoothing a region painted across an accepted edge: the edge stays crisp. Test in Task 9.

---

## File Structure

| File | Responsibility |
|---|---|
| `tests/helpers/soft-edges.ts`, `tests/helpers/refine.ts` (new) | Softened fixtures with known answers; test helpers. |
| `src/core/refine-mesh.ts` (new) | `RefineMesh`, topology, clone, folds, write-back to a `BufferGeometry` with bit preservation. |
| `src/core/refine-cut.ts` (new) | Snap or split triangles along a field's zero set. |
| `src/core/refine-fit.ts` (new) | Robust plane, sphere, cylinder and cone fits; auto choice; noise estimate. |
| `src/core/refine-curve.ts` (new) | Line, arc and spline fits; joined paths; closest point. |
| `src/core/refine-band.ts` (new) | The band around a guide: stations, soft zone, flanks, width estimate. |
| `src/core/refine-edge.ts` (new) | Flank fitting, edge solve, rebuild, joints, ends. |
| `src/core/refine-smooth.ts`, `src/core/refine-region.ts` (new) | Non-shrinking smoothing; Smooth, Flatten and Shape with detail and blend. |
| `src/core/refine-sweep.ts` (new) | Sweep fit and projection. |
| `src/core/refine-paint.ts`, `src/core/refine-brush.ts` (new) | Triangles and vertices under a brush; smooth and flatten dabs; crease strokes. |
| `src/core/refine-curvature.ts`, `src/core/refine-detect.ts` (new) | Curvature; proposals. |
| `src/core/refine-model.ts`, `src/core/refine.worker.ts`, `src/core/refine-job.ts` (new) | `RefineModel`; build and detect off the main thread. |
| `src/core/store.ts`, `src/core/types.ts`, `src/core/commands.ts` | `'refine'` tool, `RefineSession`, actions, undo routing. |
| `src/components/RefineControls.tsx`, `RefineOverlay.tsx`, `RefinePointer.tsx` (new) | Panel; feature drawing; guide, paint and brush pointer handling. |
| `src/components/Viewport.tsx`, `Inspector.tsx`, `Dialogs.tsx`, `CameraNavigation.tsx`, `SurfacePainter.tsx`, `src/App.tsx`, `src/core/keybindings.ts`, `src/hooks/useWorkbench.ts`, `src/xr/runtime.ts` | Wiring. |
| `src/docs/assembly-guides.ts`, `src/docs/content.ts`, `src/docs/changelog.ts`, `docs/design.md`, `docs/verification.md` | Documentation. |

Conventions used by every task:

- A function that takes a `mesh` and returns `void` or a list of changed ids mutates that mesh. Callers clone first.
- `Vec3` is `[number, number, number]` from `src/core/types.ts`. Point lists are flat `Float32Array` xyz.
- "Welded id" means an index into `mesh.position / 3`. "Triangle" means an index into `mesh.corners / 3`.
- Test snippets call small helpers named for what they measure (`straightness`, `movedOutside`, `closedMesh` and so on). Write each in `tests/helpers/refine.ts` the first time a task needs it. A test shown as a comment body states its assertion in words; write it out.

---

### Task 1: Softened fixtures

**Files:**
- Create: `tests/helpers/soft-edges.ts`, `tests/helpers/refine.ts`
- Test: `tests/unit/refine-fixtures.test.ts`

**Interfaces:**
- Produces (`tests/helpers/soft-edges.ts`):
```ts
export interface SoftOptions { step?: number; ripple?: number; noise?: number; seed?: number; indexed?: boolean }
export const softDefaults = { step: 0.06, ripple: 0.02, noise: 0.004, seed: 1, indexed: false };
/** Box centred on the origin with every edge filleted. Its true shape is the sharp box of `half`. */
export function softBox(half: Vec3, fillet: number, options?: SoftOptions): BufferGeometry;
/** L profile in XY, extruded z -2..2: polygon (-2,-1.5) (2,-1.5) (2,0) (0,0) (0,1.5) (-2,1.5), every profile corner filleted. The interior edge is the z axis. */
export function softStep(fillet: number, options?: SoftOptions): BufferGeometry;
/** Capped cylinder about Y with filleted rims. */
export function softCylinder(radius: number, halfHeight: number, fillet: number, options?: SoftOptions): BufferGeometry;
/** softBox([3, 0.5, 2], 0.2) with soft domes on the top face (y = 0.5). */
export function rivetedPlate(options?: SoftOptions): { geometry: BufferGeometry; rivets: { x: number; z: number; radius: number; height: number }[] };
export function rippledSphere(radius: number, options?: SoftOptions): BufferGeometry;
/** Quarter torus in the XZ plane about the origin, with flat end caps. */
export function softElbow(bend: number, tube: number, options?: SoftOptions): BufferGeometry;
```
- Produces (`tests/helpers/refine.ts`), filled in by later tasks as their modules appear: `modelOf(geometry, matrix?)` and `modelFrom(mesh)`, both returning `{ mesh, topology, noise }` (noise is 0.004 until Task 4 provides `estimateNoise`); `pointOn(mesh, p: Vec3): GuidePoint` (nearest triangle by brute force); `chainOf(mesh)` (welded ids with `crease`); `maxDistance(points, fn)`.

Rules: triangles about `step` across with random diagonals and in-plane jitter, as `tests/helpers/scan-like.ts` does. Ripple is a smooth displacement along the normal with a wavelength of about 0.4 mm and amplitude `ripple`; `noise` is per-vertex jitter. Fillets are true circular arcs. Rivet domes are 0.25 mm high, 0.4 mm radius, with a soft foot, six on a 3 × 2 grid. Output is non-indexed unless `indexed`.

- [ ] **Step 1: Write the failing tests**

```ts
const closed = (g: BufferGeometry) => {
  const w = weldedPositionIndex(g);
  return hasClosedEdges(w.indices, w.vertices);
};
it.each([
  ['softBox', () => softBox([2, 1.5, 1], 0.3)],
  ['softStep', () => softStep(0.3)],
  ['softCylinder', () => softCylinder(1.5, 1, 0.3)],
  ['rivetedPlate', () => rivetedPlate().geometry],
  ['rippledSphere', () => rippledSphere(3)],
  ['softElbow', () => softElbow(4, 1)],
])('%s is closed, scan-dense and repeatable', (_, make) => {
  const g = make();
  expect(closed(g)).toBe(true);
  expect(medianEdge(g)).toBeGreaterThan(0.04);
  expect(medianEdge(g)).toBeLessThan(0.08);
  expect(make().getAttribute('position').array).toEqual(g.getAttribute('position').array);
});
it('keeps softBox within its fillet and ripple of the sharp box', () => {
  // Farthest point of a filleted corner from the sharp one is fillet * (sqrt(3) - 1).
  expect(maxBoxDistance(softBox([2, 1.5, 1], 0.3), [2, 1.5, 1])).toBeLessThan(0.3 * 0.7321 + 0.03);
});
it('keeps rippledSphere within ripple and noise of its radius', () => {
  const r = radii(rippledSphere(3));
  expect(Math.max(...r) - 3).toBeLessThan(0.025);
  expect(3 - Math.min(...r)).toBeLessThan(0.025);
});
it('makes an indexed form with the same welded topology', () => {
  const a = weldedPositionIndex(softBox([2, 1.5, 1], 0.3));
  const b = weldedPositionIndex(softBox([2, 1.5, 1], 0.3, { indexed: true }));
  expect(b.vertices).toBe(a.vertices);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-fixtures.test.ts`. Expect FAIL (module not found).
- [ ] **Step 3: Implement the fixtures.** `softBox`: subdivide a box, then map each surface point `p` to `q + fillet * normalize(p - q)` where `q` is `p` clamped to the box of `half - fillet`. `softStep`: sample the filleted profile at `step`, extrude, triangulate caps with `ShapeUtils.triangulateShape`. `softCylinder` and `softElbow`: revolve or sweep a filleted profile.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(test) Add softened fixtures for Refine`.

---

### Task 2: Working mesh

**Files:**
- Create: `src/core/refine-mesh.ts`
- Test: `tests/unit/refine-mesh.test.ts`

**Interfaces:**
- Produces:
```ts
export interface RefineMesh {
  /** World position per welded vertex. Grows when triangles are cut. */
  position: Float32Array;
  weldedCount: number;
  /** Geometry vertex -> welded vertex. Grows with new geometry vertices. */
  weldOf: Uint32Array;
  vertexCount: number;
  /** Geometry vertex of each triangle corner. Triangle t of the mesh is face t of the written geometry. */
  corners: Uint32Array;
  triangleCount: number;
  /** Colour per geometry vertex, `colorSize` values each, or null. */
  color: Float32Array | null;
  colorSize: number;
  /** 1 once a welded vertex has moved or was created. */
  touched: Uint8Array;
  /** 1 when a welded vertex lies on a refined edge. */
  crease: Uint8Array;
  /** True when the part's world matrix mirrors, so triangle winding reads reversed. */
  flipped: boolean;
  sourceVertexCount: number;
  sourceTriangleCount: number;
  indexed: boolean;
}
export interface RefineTopology {
  triangleStart: Uint32Array; trianglesOf: Uint32Array;   // CSR: triangles around each welded vertex
  neighbourStart: Uint32Array; neighbours: Uint32Array;   // CSR: welded neighbours of each welded vertex
}
export function buildRefineMesh(geometry: BufferGeometry, matrixWorld: Matrix4): RefineMesh;
/** Copies position, touched and crease; copies weldOf, corners and colour only when `topology` is true. */
export function cloneRefineMesh(mesh: RefineMesh, topology: boolean): RefineMesh;
export function buildTopology(mesh: RefineMesh): RefineTopology;
export function weldedCorner(mesh: RefineMesh, triangle: number, corner: 0 | 1 | 2): number;
/** Outward unit normal of a triangle, honouring `flipped`. */
export function triangleNormal(mesh: RefineMesh, triangle: number, out: Float32Array): void;
export function vertexNormal(mesh: RefineMesh, topology: RefineTopology, welded: number, out: Float32Array): void;
/** Sets a welded vertex's position and marks it touched. */
export function moveVertex(mesh: RefineMesh, welded: number, x: number, y: number, z: number): void;
/** Triangles among those around `vertices` whose normal now opposes its normal at `before`. */
export function foldedTriangles(mesh: RefineMesh, topology: RefineTopology, before: Float32Array, vertices: Uint32Array): Uint32Array;
export function writeRefinedGeometry(source: BufferGeometry, matrixWorld: Matrix4, mesh: RefineMesh): BufferGeometry;
```

`writeRefinedGeometry` rules: the result is indexed exactly when the source is. Geometry vertices below `sourceVertexCount` keep their order. A geometry vertex whose welded vertex is not `touched` copies the source's position and normal bits. A touched one gets the working position through the inverse matrix, computed once per welded vertex and written to every duplicate. Normals of touched vertices are recomputed per corner as the area-weighted mean of the faces in that corner's fan, where a fan stops at any edge whose two ends both have `crease`. On an indexed source a crease vertex gets one geometry vertex per fan (appended). Colour is carried. Bounds are computed. No `boundsTree` is set.

- [ ] **Step 1: Write the failing tests**

```ts
const cases = [['unindexed', {}], ['indexed', { indexed: true }]] as const;
describe.each(cases)('refine mesh, %s', (_, options) => {
  const source = softBox([2, 1.5, 1], 0.3, options);
  const identity = new Matrix4();
  it('writes an untouched mesh back bit for bit', () => {
    const out = writeRefinedGeometry(source, identity, buildRefineMesh(source, identity));
    expect(out.getAttribute('position').array).toEqual(source.getAttribute('position').array);
    expect(out.getAttribute('normal').array).toEqual(source.getAttribute('normal').array);
    expect(!!out.index).toBe(!!source.index);
  });
  it('gives every duplicate of a moved vertex the same bits and leaves the rest alone', () => {
    const mesh = buildRefineMesh(source, identity);
    moveVertex(mesh, 7, mesh.position[21] + 0.1, mesh.position[22], mesh.position[23]);
    const out = writeRefinedGeometry(source, identity, mesh);
    expect(duplicatesAgree(out, mesh)).toBe(true);
    expect(changedVertices(source, out).every((g) => mesh.weldOf[g] === 7)).toBe(true);
    expect(closed(out)).toBe(true);
  });
});
it('has six neighbours and six triangles around a typical vertex', () => { /* median of both CSR degrees is 6 */ });
it('works in world space and returns mesh-local positions', () => {
  const matrix = new Matrix4().compose(new Vector3(5, 0, 0), new Quaternion(), new Vector3(1, 2, -1));
  const mesh = buildRefineMesh(softBox([2, 1.5, 1], 0.3), matrix);
  expect(mesh.flipped).toBe(true);
  expect(extent(mesh.position)).toEqual([4, 6, 2].map((v) => expect.closeTo(v, 1)));
  // Outward normals: every triangle normal points away from the box centre at (5, 0, 0).
  expect(outwardFraction(mesh, [5, 0, 0])).toBeGreaterThan(0.99);
});
it('reports a triangle folded by pushing a vertex through its neighbours', () => { /* foldedTriangles non-empty */ });
it('does not copy topology arrays unless asked', () => {
  const mesh = buildRefineMesh(softBox([2, 1.5, 1], 0.3), new Matrix4());
  expect(cloneRefineMesh(mesh, false).corners).toBe(mesh.corners);
  expect(cloneRefineMesh(mesh, true).corners).not.toBe(mesh.corners);
  expect(cloneRefineMesh(mesh, false).position).not.toBe(mesh.position);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-mesh.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module. Derive `weldOf` from `weldedPositionIndex(geometry).indices` as `buildWarpRegion` does (`src/core/warp-region.ts:33`).
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Add the Refine working mesh`.

---

### Task 3: Cutting triangles along a field

**Files:**
- Create: `src/core/refine-cut.ts`
- Test: `tests/unit/refine-cut.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces:
```ts
export interface CutResult {
  /** Welded ids now on the cut. */
  chain: Uint32Array;
  /** For each triangle that was split: its id and the ids of the triangles that now cover it. */
  children: Map<number, number[]>;
}
/**
 * Puts a chain of mesh edges on the zero set of `field` among `vertices`.
 * `place` maps a point on the zero set to its final position. The mesh must be a topology clone.
 */
export function cutAlongField(
  mesh: RefineMesh, topology: RefineTopology,
  vertices: Uint32Array, field: Float32Array,
  place: (x: number, y: number, z: number, out: Float32Array) => void,
  snap?: number, // default 0.25
): CutResult;
/** Replaces split triangles in a painted set with their children. */
export function remapTriangles(triangles: Uint32Array, children: Map<number, number[]>): Uint32Array;
```

Rules: only edges with both ends in `vertices` are considered. For an edge whose ends have opposite signs, `t = fa / (fa - fb)`. If `t < snap` the first end snaps to the zero set, if `t > 1 - snap` the second does, unless the snap would leave some triangle with all three vertices on the zero set, in which case the edge is split at `t` clamped to 0.1 to 0.9. Snaps are decided before splits. A split triangle keeps its id for one child and appends the others; a quad left by two splits is divided along its shorter diagonal. One geometry vertex is created per distinct pair of end geometry vertices, with colour interpolated at `t`. Chain vertices get `crease = 1` and `touched = 1`.

- [ ] **Step 1: Write the failing tests**

```ts
describe.each(cases)('cutAlongField, %s', (_, options) => {
  // Cut the box by the plane x = 0.013: an awkward offset so snaps and splits both occur.
  const run = () => {
    const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3, options));
    const cut = cloneRefineMesh(mesh, true);
    const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
    const field = Float32Array.from(ids, (i) => cut.position[i * 3] - 0.013);
    const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) => out.set([0.013, y, z]));
    return { mesh, cut, result };
  };
  it('leaves no triangle straddling the cut', () => {
    const { cut } = run();
    expect(straddling(cut, (x) => x - 0.013, 1e-6)).toBe(0);
  });
  it('stays closed with no zero-area triangle and no triangle wholly on the cut', () => {
    const { cut, result } = run();
    expect(closedMesh(cut)).toBe(true);
    expect(minTriangleArea(cut)).toBeGreaterThan(1e-8);
    expect(trianglesWhollyOn(cut, result.chain)).toBe(0);
  });
  it('forms one closed loop of mesh edges', () => {
    const { cut, result } = run();
    expect(loops(cut, result.chain)).toEqual([result.chain.length]);
  });
  it('moves nothing off the cut and marks the chain', () => {
    const { mesh, cut, result } = run();
    expect(movedOutside(mesh, cut, result.chain)).toBe(0);
    expect([...result.chain].every((v) => cut.crease[v] === 1 && cut.touched[v] === 1)).toBe(true);
  });
  it('writes a closed geometry whose duplicates agree', () => {
    const { cut } = run();
    const out = writeRefinedGeometry(softBox([2, 1.5, 1], 0.3, options), new Matrix4(), cut);
    expect(closed(out)).toBe(true);
  });
});
it('interpolates colour at a split', () => { /* x-ramp colour: new vertices' colour equals the ramp at their source point within 1e-4 */ });
it('remaps a painted set through the children map', () => { /* every child of a painted triangle is in the result */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-cut.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `cutAlongField` and `remapTriangles`.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Cut Refine meshes along a field`.

---

### Task 4: Shape fitting

**Files:**
- Create: `src/core/refine-fit.ts`
- Test: `tests/unit/refine-fit.test.ts`

**Interfaces:**
- Consumes: Task 2 (for `estimateNoise`).
- Produces:
```ts
export type ShapeKind = 'plane' | 'cylinder' | 'cone' | 'sphere';
export type Shape =
  | { kind: 'plane'; point: Vec3; normal: Vec3 }
  | { kind: 'sphere'; center: Vec3; radius: number }
  | { kind: 'cylinder'; point: Vec3; axis: Vec3; radius: number }
  | { kind: 'cone'; apex: Vec3; axis: Vec3; angle: number };
export interface ShapeFit { shape: Shape; /** RMS distance of inliers. */ rms: number; /** True when rms <= 2 * noise. */ within: boolean }
/** Robust fit that ignores points standing off the surface. Null when the points cannot define the shape. */
export function fitShape(points: Float32Array, normals: Float32Array, kind: ShapeKind, noise: number): ShapeFit | null;
/** Plane when it is within noise; else the best of cylinder, cone and sphere; else the lowest rms of all. */
export function fitAuto(points: Float32Array, normals: Float32Array, noise: number): ShapeFit;
/** Signed distance, positive on the side the fitted points' normals face. */
export function shapeDistance(shape: Shape, x: number, y: number, z: number): number;
export function projectToShape(shape: Shape, x: number, y: number, z: number, out: Float32Array, offset?: number): void;
/** Median distance of each vertex from the plane fitted to its ring. */
export function estimateNoise(mesh: RefineMesh, topology: RefineTopology, vertices?: Uint32Array): number;
```

Rules: every fit is iteratively reweighted least squares with a Tukey biweight and a scale of 1.4826 × the median absolute residual, floored at `noise`, 10 rounds. Cylinder and cone start from the normals (the axis is the direction the normals vary least along) and refine with Gauss-Newton using `ml-matrix`. In the second tier a cone is chosen over a cylinder only when its rms is less than half the cylinder's.

- [ ] **Step 1: Write the failing tests**

```ts
it('fits a plane under rivets without tilting', () => {
  const { points, normals } = topFace(rivetedPlate().geometry); // every vertex with y > 0.4, rivets included
  const fit = fitShape(points, normals, 'plane', 0.004)!;
  const plane = fit.shape as Extract<Shape, { kind: 'plane' }>;
  expect(angleDeg(plane.normal, [0, 1, 0])).toBeLessThan(0.1);
  expect(Math.abs(plane.point[1] - 0.5)).toBeLessThan(0.002);
});
it('recovers a cylinder axis and radius', () => {
  const { points, normals } = wall(softCylinder(1.5, 1, 0.3)); // |y| < 0.6
  const c = fitShape(points, normals, 'cylinder', 0.004)!.shape as Extract<Shape, { kind: 'cylinder' }>;
  expect(Math.abs(c.radius - 1.5)).toBeLessThan(0.005);
  expect(Math.min(angleDeg(c.axis, [0, 1, 0]), angleDeg(c.axis, [0, -1, 0]))).toBeLessThan(0.2);
});
it('recovers a sphere and a cone', () => { /* rippledSphere(3): radius within 0.005; a ConeGeometry side with 0.004 jitter: angle within 0.2 degrees */ });
it('names the right shape automatically', () => {
  expect(fitAuto(...topFace(softBox([2, 1.5, 1], 0.3)), 0.004).shape.kind).toBe('plane');
  expect(fitAuto(...wall(softCylinder(1.5, 1, 0.3)), 0.004).shape.kind).toBe('cylinder');
  expect(fitAuto(...patch(rippledSphere(3)), 0.004).shape.kind).toBe('sphere');
});
it('says when nothing fits', () => {
  expect(fitAuto(...patch(softElbow(4, 1)), 0.004).within).toBe(false);
});
it('returns null for too few or collinear points', () => {
  expect(fitShape(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), new Float32Array(9), 'plane', 0.004)).toBeNull();
});
it('projects onto each shape and reports signed distance', () => { /* distance of a projected point is 0 within 1e-5; sign flips across the surface */ });
it('estimates noise near the fixture noise', () => {
  const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
  expect(estimateNoise(mesh, topology)).toBeGreaterThan(0.001);
  expect(estimateNoise(mesh, topology)).toBeLessThan(0.02);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-fit.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Fit planes, cylinders, cones and spheres for Refine`.

---

### Task 5: Curves

**Files:**
- Create: `src/core/refine-curve.ts`
- Test: `tests/unit/refine-curve.test.ts`

**Interfaces:**
- Produces:
```ts
export type GuideKind = 'line' | 'arc' | 'spline';
export type GuideJoint = 'sharp' | 'smooth';
export interface EdgeCurve {
  /** Polyline at most `step` apart. */
  points: Float32Array;
  /** Distance along the curve at each point. */
  lengths: Float32Array;
  /** 1 at points that are sharp joints. */
  corner: Uint8Array;
  closed: boolean;
}
/** `controls` is the number of points the user placed; it sets a spline's freedom. */
export function fitCurve(kind: GuideKind, samples: Float32Array, controls: number, step: number): EdgeCurve;
/** Trims or extends neighbours to where they come closest and joins them into one curve. */
export function joinCurves(curves: EdgeCurve[], kinds: GuideKind[], joints: GuideJoint[], closed: boolean, step: number): EdgeCurve;
/** Writes the closest point; returns its distance along the curve. */
export function closestOnCurve(curve: EdgeCurve, x: number, y: number, z: number, out: Float32Array): number;
export function curveTangent(curve: EdgeCurve, station: number, out: Float32Array): void;
/** The guide the user drew, before any fitting: a chord, a circle through three points, or Catmull-Rom. */
export function drawnCurve(kind: GuideKind, points: Float32Array, step: number): EdgeCurve;
```

Rules: a line is the total least squares line over the samples' extent. An arc is a circle fitted in the samples' best plane, over their angular extent, or a full circle when the samples wrap. A spline is a least squares clamped uniform cubic B-spline with `max(4, controls)` control points. A sharp joint extends both neighbours (line as a line, arc as its circle, spline along its end tangent), cuts both at the midpoint of their closest approach and sets `corner`. A smooth joint does the same without setting `corner`.

- [ ] **Step 1: Write the failing tests**

```ts
it('fits a straight line through noisy samples', () => {
  const c = fitCurve('line', noisyLine([0, 0, 0], [10, 0, 0], 0.02), 2, 0.05);
  expect(maxDistance(c.points, (x, y, z) => Math.hypot(y, z))).toBeLessThan(0.005);
  expect(c.lengths[c.lengths.length - 1]).toBeCloseTo(10, 1);
});
it('fits an arc and a full circle', () => {
  const quarter = fitCurve('arc', noisyArc(5, 0, Math.PI / 2, 0.02), 3, 0.05);
  expect(maxDistance(quarter.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 5) + Math.abs(y))).toBeLessThan(0.01);
  expect(fitCurve('arc', noisyArc(5, 0, Math.PI * 2, 0.02), 3, 0.05).closed).toBe(true);
});
it('gives a spline more freedom with more controls', () => {
  const wave = noisyWave(0.02); // y = 0.5 * sin(x), x 0..12
  expect(rms(fitCurve('spline', wave, 12, 0.05), waveDistance)).toBeLessThan(rms(fitCurve('spline', wave, 4, 0.05), waveDistance));
});
it('joins four lines into a closed rectangle with exact corners', () => {
  const sides = rectangleSides(4, 3, 0.02).map((s) => fitCurve('line', s, 2, 0.05));
  const loop = joinCurves(sides, ['line', 'line', 'line', 'line'], ['sharp', 'sharp', 'sharp', 'sharp'], true, 0.05);
  expect(loop.closed).toBe(true);
  expect(cornersOf(loop)).toHaveLength(4);
  for (const c of cornersOf(loop)) expect(nearestRectangleCorner(c, 4, 3)).toBeLessThan(0.01);
});
it('joins a line to an arc smoothly without a corner', () => { /* slot end: corner all zero, no gap > step */ });
it('finds the closest point and station', () => { /* on the fitted line: (3, 1, 0) -> point (3, 0, 0), station 3 */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-curve.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Fit and join Refine guide curves`.

---

### Task 6: The band around a guide

**Files:**
- Create: `src/core/refine-band.ts`
- Test: `tests/unit/refine-band.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5.
- Produces:
```ts
export interface GuidePoint { triangle: number; position: Vec3 }
export const enum BandZone { Soft = 0, Left = 1, Right = 2, Beyond = 3 }
export interface EdgeBand {
  /** Welded vertices within `width` of the drawn guide, connected over the surface to the clicked triangles. */
  vertices: Uint32Array;
  /** Per band vertex: distance along the drawn guide, signed offset across it, and zone. */
  station: Float32Array;
  cross: Float32Array;
  zone: Uint8Array;
  drawn: EdgeCurve;
  /** Half-width of the softened zone, mm. */
  soft: number;
}
/** Null when no softened zone lies under the guide. */
export function buildBand(mesh: RefineMesh, topology: RefineTopology, kind: GuideKind, points: GuidePoint[], width: number, noise: number): EdgeBand | null;
/** A width that leaves flank on both sides: 3 * soft, at least 6 * the local edge length. */
export function estimateWidth(mesh: RefineMesh, topology: RefineTopology, kind: GuideKind, points: GuidePoint[], noise: number): number;
```

Rules: flood from the clicked triangles' vertices over `neighbours`, keeping vertices within `width` of the drawn curve. At each station the frame is the curve tangent, the mean normal of the band's vertices near that station, and their cross product; `cross` is the offset along that last axis. Flanks are found from the outside in: fit each side's outer 40 % with `fitAuto` (or, when that is not `within`, a straight profile per 4-step slice of stations), then grow inward while vertices stay within 3 × noise of the fit. What is left between the flanks and connected to the guide is `Soft`. If a second soft zone appears on a side, vertices from its near boundary outward are `Beyond` and are never moved. Null when the soft zone is empty or either flank has fewer than 12 vertices.

- [ ] **Step 1: Write the failing tests**

```ts
const edgeGuide = (mesh: RefineMesh, x0: number, x1: number) => {
  // The fillet's crest on the box edge y = 1.5, z = 1.
  const c = 0.3 - 0.3 / Math.SQRT2;
  return [pointOn(mesh, [x0, 1.5 - c, 1 - c]), pointOn(mesh, [x1, 1.5 - c, 1 - c])];
};
it('finds the softened zone and both flanks of a box edge', () => {
  const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
  const band = buildBand(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), 0.6, noise)!;
  // A 0.3 mm fillet is a quarter arc 0.47 mm long, so half of it is 0.24 mm.
  expect(band.soft).toBeGreaterThan(0.18);
  expect(band.soft).toBeLessThan(0.32);
  expect(zoneCount(band, BandZone.Left)).toBeGreaterThan(50);
  expect(zoneCount(band, BandZone.Right)).toBeGreaterThan(50);
  // Flank vertices lie on the true faces y = 1.5 and z = 1.
  expect(maxFlankError(mesh, band)).toBeLessThan(0.03);
});
it('estimates a width from the softened zone', () => {
  const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
  const w = estimateWidth(mesh, topology, 'line', edgeGuide(mesh, -1.2, 1.2), noise);
  expect(w).toBeGreaterThan(0.5);
  expect(w).toBeLessThan(1);
});
it('returns null on a flat face', () => {
  const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
  const flat = [pointOn(mesh, [-1, 1.5, 0]), pointOn(mesh, [1, 1.5, 0])];
  expect(buildBand(mesh, topology, 'line', flat, 0.6, noise)).toBeNull();
});
it('keeps to the edge under the guide on a thin plate', () => {
  // softBox([2, 0.25, 1], 0.1): the plate is 0.5 mm thick, so a 0.6 mm band reaches the edge below.
  const { mesh, topology, noise } = modelOf(softBox([2, 0.25, 1], 0.1));
  const c = 0.1 - 0.1 / Math.SQRT2;
  const band = buildBand(mesh, topology, 'line', [pointOn(mesh, [-1.2, 0.25 - c, 1 - c]), pointOn(mesh, [1.2, 0.25 - c, 1 - c])], 0.6, noise)!;
  for (let i = 0; i < band.vertices.length; i++)
    if (mesh.position[band.vertices[i] * 3 + 1] < -0.1) expect(band.zone[i]).toBe(BandZone.Beyond);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-band.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Read the softened band around a Refine guide`.

---

### Task 7: Rebuilding one edge

**Files:**
- Create: `src/core/refine-edge.ts`
- Test: `tests/unit/refine-edge.test.ts`

**Interfaces:**
- Consumes: Tasks 2 to 6.
- Produces:
```ts
export interface Flank {
  kind: ShapeKind | 'swept';
  distance(x: number, y: number, z: number): number; // unsigned
  project(x: number, y: number, z: number, out: Float32Array): void;
}
export interface EdgeSegment { kind: GuideKind; points: GuidePoint[] }
export interface EdgeInput {
  segments: EdgeSegment[];
  /** One per joint between consecutive segments, plus one closing joint when `closed`. */
  joints: GuideJoint[];
  closed: boolean;
  /** Null uses `estimateWidth`. */
  width: number | null;
  /** 0 to 1; 1 is fully sharp. */
  strength: number;
}
export interface EdgeSolve {
  bands: EdgeBand[];
  flanks: [Flank, Flank][];
  /** The solved edge, all segments joined. */
  curve: EdgeCurve;
  /** +1 exterior, -1 interior, per segment. */
  sign: Int8Array;
  width: number;
}
export const edgeFade = (width: number) => width;
export const minEdgeAngle = 15; // degrees between the flanks
export function solveEdge(mesh: RefineMesh, topology: RefineTopology, input: EdgeInput, noise: number): EdgeSolve | null;
/** Moves the band onto the flanks. With `cut`, also puts mesh edges on the solved edge (mesh must be a topology clone). */
export function applyEdge(mesh: RefineMesh, topology: RefineTopology, solve: EdgeSolve, strength: number, cut: boolean): { changed: Uint32Array; cut: CutResult | null };
```

Algorithm for one segment (this task handles `segments.length === 1`; Task 8 adds joints):

1. `buildBand`. Null gives null.
2. Each flank: `fitAuto` over that side's flank vertices. If `within`, the flank is that shape. Otherwise it is swept: per 4-step slice of stations fit a straight profile in the cross-section, then smooth the profiles' offsets and directions along the stations with a cubic least squares fit.
3. Null when the flanks' normals at the guide are less than `minEdgeAngle` apart.
4. At each station find the point on both flanks in that station's cross-section plane (Newton on the two distances). Fit those points with `fitCurve(kind, …, controls = points.length, step)`. That is the solved edge.
5. Sign: +1 when the solved edge lies on the outward side of the soft zone's surface, else -1.
6. `applyEdge`: a band vertex in `Soft`, `Left` or `Right` belongs to the flank it is nearer. Its target is its projection onto that flank, plus `(solved edge − the flanks' own intersection) at its station`, faded linearly from the edge to the flank's start. The field for the cut is `distance to left − distance to right` and `place` is `closestOnCurve` on the solved edge. Displacement is scaled by `strength`, and by a smoothstep over `edgeFade(width)` from each free end. `Beyond` vertices and vertices outside the band are never written.

- [ ] **Step 1: Write the failing tests**

```ts
const refineBoxEdge = (options: SoftOptions = {}, matrix = new Matrix4()) => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3, options), matrix);
  const input: EdgeInput = { segments: [{ kind: 'line', points: edgeGuide(model.mesh, -1.6, 1.6) }], joints: [], closed: false, width: 0.6, strength: 1 };
  const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
  const out = cloneRefineMesh(model.mesh, true);
  const result = applyEdge(out, model.topology, solve, 1, true);
  return { model, solve, out, result };
};
// Chain vertices clear of both fades: |x| <= 1.6 - edgeFade(0.6).
const core = (out: RefineMesh, chain: Uint32Array) => [...chain].filter((v) => Math.abs(out.position[v * 3]) <= 1);

it('puts an exterior edge on the true edge, straight, at 90 degrees', () => {
  const { out, result, solve } = refineBoxEdge();
  expect(solve.sign[0]).toBe(1);
  const chain = core(out, result.cut!.chain);
  expect(chain.length).toBeGreaterThan(20);
  for (const v of chain) expect(Math.hypot(out.position[v * 3 + 1] - 1.5, out.position[v * 3 + 2] - 1)).toBeLessThan(0.02);
  expect(straightness(out, chain)).toBeLessThan(0.005);
  expect(Math.abs(dihedralAcross(out, chain) - 90)).toBeLessThan(1);
});
it('does the same for an interior edge', () => {
  const model = modelOf(softStep(0.3));
  const c = 0.3 - 0.3 / Math.SQRT2;
  const points = [pointOn(model.mesh, [c, c, -1.6]), pointOn(model.mesh, [c, c, 1.6])];
  const solve = solveEdge(model.mesh, model.topology, { segments: [{ kind: 'line', points }], joints: [], closed: false, width: 0.6, strength: 1 }, model.noise)!;
  expect(solve.sign[0]).toBe(-1);
  const out = cloneRefineMesh(model.mesh, true);
  const chain = [...applyEdge(out, model.topology, solve, 1, true).cut!.chain].filter((v) => Math.abs(out.position[v * 3 + 2]) <= 1);
  for (const v of chain) expect(Math.hypot(out.position[v * 3], out.position[v * 3 + 1])).toBeLessThan(0.02);
});
it('puts an arc guide on a cylinder rim on the true circle', () => {
  // softCylinder(1.5, 1, 0.3), three points a third of a turn apart on the top rim's crest.
  // Chain vertices clear of the fades: |radius - 1.5| and |y - 1| combined < 0.02.
});
it('leaves no triangle straddling the edge and keeps the mesh closed', () => {
  const { out, solve } = refineBoxEdge();
  expect(straddlingCurve(out, solve)).toBe(0);
  expect(closedMesh(out)).toBe(true);
});
it('moves nothing outside the band', () => {
  const { model, out, solve } = refineBoxEdge();
  expect(movedOutside(model.mesh, out, solve.bands[0].vertices)).toBe(0);
});
it('changes nothing visible when run again over its own result', () => {
  const { out } = refineBoxEdge();
  const again = modelFrom(out);
  const input: EdgeInput = { segments: [{ kind: 'line', points: [pointOn(out, [-1.6, 1.5, 1]), pointOn(out, [1.6, 1.5, 1])] }], joints: [], closed: false, width: 0.6, strength: 1 };
  const solve = solveEdge(again.mesh, again.topology, input, again.noise);
  if (solve) {
    const twice = cloneRefineMesh(again.mesh, true);
    applyEdge(twice, again.topology, solve, 1, true);
    expect(maxMove(again.mesh, twice)).toBeLessThan(0.001);
  }
});
it('previews without cutting', () => {
  const { model, solve } = refineBoxEdge();
  const draft = cloneRefineMesh(model.mesh, false);
  expect(applyEdge(draft, model.topology, solve, 1, false).cut).toBeNull();
  expect(draft.triangleCount).toBe(model.mesh.triangleCount);
});
it('does nothing at strength 0 and grows steadily with strength', () => { /* maxMove at 0 is 0; at 0.25 < 0.5 < 1 */ });
it('returns null on a flat face and between faces under 15 degrees apart', () => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3));
  const flat = [pointOn(model.mesh, [-1, 1.5, 0]), pointOn(model.mesh, [1, 1.5, 0])];
  expect(solveEdge(model.mesh, model.topology, { segments: [{ kind: 'line', points: flat }], joints: [], closed: false, width: 0.6, strength: 1 }, model.noise)).toBeNull();
});
it('meets the tolerances on a mirrored, non-uniformly scaled part', () => {
  const matrix = new Matrix4().makeScale(1, 2, -1);
  // The world-space box is half [2, 3, 1]; its edge y = 3, z = -1 is refined to within 0.02.
});
it('meets the tolerances on an indexed mesh', () => {
  const { out, result } = refineBoxEdge({ indexed: true });
  for (const v of core(out, result.cut!.chain)) expect(Math.hypot(out.position[v * 3 + 1] - 1.5, out.position[v * 3 + 2] - 1)).toBeLessThan(0.02);
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-edge.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** `solveEdge` and `applyEdge` for one segment.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Real-scan probe (local, not committed).** With `REFINE_SCANS` set, load `45.stl` in a scratch test, place a line guide along one long edge of the riveted plate's raised border, run `solveEdge` and `applyEdge`, and write the before and after crops as STL to the OS temp directory. Open both in Kitbasher and look. If the solved edge is visibly wrong, fix the cause here before going on; the fixtures are only a model of the scans.
- [ ] **Step 6: Commit** `(feat) Rebuild a softened edge from a guide`.

---

### Task 8: Edge paths, joints and ends

**Files:**
- Modify: `src/core/refine-edge.ts`
- Test: `tests/unit/refine-edge-path.test.ts`

**Interfaces:**
- Consumes: Task 7. No signature changes: `solveEdge` now accepts any number of segments, `closed`, and `joints`.

Rules:

- Each segment is solved as in Task 7, then the solved curves are joined with `joinCurves`. A segment's start point is the previous segment's last point.
- A band vertex belongs to the segment whose solved curve is nearest.
- Two flanks of neighbouring segments are the **same surface** when each one's flank vertices lie within 2 × noise (mean) of the other's fit. They are then refitted together as one flank.
- At a sharp joint, vertices on a flank that is not shared are faded out by a smoothstep over `soft` of their distance from the neighbouring segment's unshared flank. The edge between those two faces is a separate edge for the user to guide.
- An end is **tied**, and gets no fade, when a band vertex within 2 steps of it has `crease`. Closed paths have no ends.

- [ ] **Step 1: Write the failing tests**

```ts
// The four edges around the top face (y = 1.5) of softBox([2, 1.5, 1], 0.3), drawn on their crests.
const perimeter = (mesh: RefineMesh): EdgeInput => ({
  segments: topCrestCorners(mesh).map((from, i, all) => ({ kind: 'line', points: [from, all[(i + 1) % 4]] })),
  joints: ['sharp', 'sharp', 'sharp', 'sharp'], closed: true, width: 0.6, strength: 1,
});
it('closes a four-segment path with four corners and no gap', () => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3));
  const solve = solveEdge(model.mesh, model.topology, perimeter(model.mesh), model.noise)!;
  const out = cloneRefineMesh(model.mesh, true);
  const chain = applyEdge(out, model.topology, solve, 1, true).cut!.chain;
  expect(loops(out, chain)).toEqual([chain.length]);
  for (const corner of [[2, 1.5, 1], [2, 1.5, -1], [-2, 1.5, 1], [-2, 1.5, -1]])
    expect(nearestChainDistance(out, chain, corner)).toBeLessThan(0.02);
  expect(closedMesh(out)).toBe(true);
});
it('treats the face inside the path as one flat surface', () => {
  // After the perimeter is applied, every touched vertex with y > 1.4 and inside the path is within 0.005 of y = 1.5.
});
it('leaves the edges between the outer faces soft', () => {
  // Vertices near the vertical edge x = 2, z = 1 and more than `soft` below the top are unmoved.
});
it('runs a third guide into an existing corner without fading', () => {
  // Apply the perimeter, then a line guide down the vertical edge x = 2, z = 1 ending at the corner.
  // Its chain reaches within 0.02 of (2, 1.5, 1).
});
it('joins a line to an arc smoothly', () => {
  // softSlot's top rim: a line guide continued by an arc guide around one end, joint 'smooth'.
  // No corner is set at the joint and the chain is one path.
});
```

Add `softSlot(fillet, options)` to `tests/helpers/soft-edges.ts` for the last test: a stadium profile (two 1 mm semicircles joined by 3 mm lines) extruded 1 mm along Y, with the top rim filleted.

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-edge-path.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** paths, shared flanks, joint fades and tied ends.
- [ ] **Step 4: Run** this test and `tests/unit/refine-edge.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Join Refine guides into paths with corners and loops`.

---

### Task 9: Smoothing and regions

**Files:**
- Create: `src/core/refine-smooth.ts`, `src/core/refine-region.ts`
- Test: `tests/unit/refine-region.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4.
- Produces:
```ts
// refine-smooth.ts
/** Non-shrinking low-pass passes over `vertices`, each scaled by its weight (0 holds a vertex). */
export function smoothVertices(mesh: RefineMesh, topology: RefineTopology, vertices: Uint32Array, weight: Float32Array, passes: number): void;
export const smoothPasses = (strength: number) => Math.round(strength * 40);

// refine-region.ts
export type Treatment = 'smooth' | 'flatten' | 'shape';
export type RegionShape = 'auto' | 'cylinder' | 'cone' | 'sphere' | 'sweep';
export interface RegionInput {
  triangles: Uint32Array;
  treatment: Treatment;
  shape: RegionShape;       // used when treatment is 'shape'
  strength: number;         // 0 to 1
  keepDetail: boolean;
  /** mm off the surface that counts as detail. Null uses 6 * noise. */
  detail: number | null;
  /** mm over which the change fades in from the border. Null uses 4 * the local edge length. */
  blend: number | null;
}
export interface RegionSolve {
  vertices: Uint32Array;
  /** Per region vertex: target position, 0-1 weight, and 1 where it is kept detail. */
  target: Float32Array;
  weight: Float32Array;
  detail: Uint8Array;
  /** What the surface was fitted as; null for Smooth. */
  fitted: ShapeKind | 'sweep' | null;
}
/** Null when the region is too small to fit or is all detail. */
export function solveRegion(mesh: RefineMesh, topology: RefineTopology, input: RegionInput, noise: number): RegionSolve | null;
export function applyRegion(mesh: RefineMesh, solve: RegionSolve): Uint32Array;
```

Rules:

- Region vertices are the welded vertices of `triangles`. A vertex also used by a triangle outside the region is a border vertex with weight 0, and is never written.
- Weight rises by smoothstep from 0 at the border to 1 at surface distance `blend` (Dijkstra over `neighbours`), then is multiplied by `strength`.
- Flatten fits a plane, Shape fits the chosen kind with `fitShape`, or `fitAuto` (`'sweep'` is added in Task 10; Auto never picks it). Base vertices' targets are their projections.
- Detail, when `keepDetail`: vertices farther than `detail` from the fitted surface, on either side. Each connected island of them is moved rigidly by the mean displacement of the base vertices ringing it.
- Smooth: targets come from `smoothVertices` with `smoothPasses(1)` on a copy; weight carries strength. With `keepDetail`, detail is whatever stands off a copy smoothed with 4 × the passes by more than `detail`, and is carried the same way. Vertices with `crease` have weight 0.

- [ ] **Step 1: Write the failing tests**

```ts
const topRegion = (mesh: RefineMesh): Uint32Array => trianglesWhere(mesh, (x, y, z) => y > 0.42 && Math.abs(x) < 2.6 && Math.abs(z) < 1.6);

it('flattens a plate and keeps its rivets', () => {
  const { geometry, rivets } = rivetedPlate();
  const model = modelOf(geometry);
  const input: RegionInput = { triangles: topRegion(model.mesh), treatment: 'flatten', shape: 'auto', strength: 1, keepDetail: true, detail: null, blend: null };
  const solve = solveRegion(model.mesh, model.topology, input, model.noise)!;
  expect(solve.fitted).toBe('plane');
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  // Base: fully weighted, not detail.
  for (const i of indicesWhere(solve, (w, d) => w === 1 && d === 0))
    expect(Math.abs(out.position[solve.vertices[i] * 3 + 1] - 0.5)).toBeLessThan(0.005);
  for (const rivet of rivets)
    expect(Math.abs(heightAt(out, rivet.x, rivet.z) - 0.5 - heightAbovePlate(model.mesh, rivet))).toBeLessThan(0.01);
});
it('flattens rivets too when Keep detail is off', () => { /* heightAt each rivet centre within 0.01 of 0.5 */ });
it('keeps recessed detail like raised detail', () => { /* a plate with 0.25 mm dimples: dimple depth kept within 0.01 */ });
it('smooths a sphere without shrinking it', () => {
  const model = modelOf(rippledSphere(3));
  const all = Uint32Array.from({ length: model.mesh.triangleCount }, (_, i) => i);
  const solve = solveRegion(model.mesh, model.topology, { triangles: all, treatment: 'smooth', shape: 'auto', strength: 1, keepDetail: false, detail: null, blend: null }, model.noise)!;
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  expect(rippleAmplitude(out, 3)).toBeLessThan(0.1 * rippleAmplitude(model.mesh, 3));
  expect(Math.abs(meanRadius(out) - meanRadius(model.mesh)) / 3).toBeLessThan(0.005);
});
it('recovers a cylinder with Shape and names it with Auto', () => {
  // softCylinder(1.5, 1, 0.3) wall region, shape 'auto': fitted is 'cylinder'; base vertices within 0.005 of radius 1.5.
});
it('does nothing at strength 0 and grows steadily with strength', () => { /* maxMove 0; 0.25 < 0.5 < 1 */ });
it('leaves the border and everything outside bit-identical', () => {
  // movedOutside(model.mesh, out, interior region vertices) === 0
});
it('fades in across the blend band', () => { /* weight is 0 at the border, strictly between 0 and 1 inside the band, 1 beyond it */ });
it('changes nothing visible when run again over its own result', () => { /* maxMove < 0.001 for flatten and shape */ });
it('keeps an accepted edge crisp when a region across it is smoothed', () => {
  const { out } = refineBoxEdge(); // from Task 7's test helpers, moved to tests/helpers/refine.ts
  const model = modelFrom(out);
  const across = trianglesWhere(out, (x, y, z) => Math.abs(x) < 1 && y > 1 && z > 0.5);
  const solve = solveRegion(model.mesh, model.topology, { triangles: across, treatment: 'smooth', shape: 'auto', strength: 1, keepDetail: false, detail: null, blend: null }, model.noise)!;
  const smoothed = cloneRefineMesh(model.mesh, false);
  applyRegion(smoothed, solve);
  for (const v of chainOf(out)) expect(distanceMoved(out, smoothed, v)).toBe(0);
});
it('gives a flat face with a crisp border when flattened first and edged second', () => {
  // softBox: flatten the top face region, then refineBoxEdge on the result.
  // Top-face vertices stay within 0.005 of y = 1.5 and the chain is within 0.02 of the true edge.
});
it('returns null for a region too small to fit', () => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3));
  expect(solveRegion(model.mesh, model.topology, { triangles: new Uint32Array([0]), treatment: 'flatten', shape: 'auto', strength: 1, keepDetail: true, detail: null, blend: null }, model.noise)).toBeNull();
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-region.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** both modules. Use Taubin smoothing (λ = 0.5, μ = −0.53) with uniform weights.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Smooth, flatten and shape painted Refine regions`.

---

### Task 10: Sweep

**Files:**
- Create: `src/core/refine-sweep.ts`
- Modify: `src/core/refine-region.ts` (accept `shape: 'sweep'`)
- Test: `tests/unit/refine-sweep.test.ts`

**Interfaces:**
- Consumes: Tasks 4, 5, 9.
- Produces:
```ts
export interface Sweep {
  /** The centre line: an arc when one fits within noise, else a spline. */
  path: EdgeCurve;
  pathKind: 'arc' | 'spline';
  /** Radius of the cross-section at 64 evenly spaced angles about the path, in the path's rotation-minimising frame. */
  profile: Float32Array;
  /** True when the profile is a circle within noise; it is then replaced by its mean. */
  round: boolean;
}
export function fitSweep(points: Float32Array, normals: Float32Array, noise: number): { sweep: Sweep; rms: number } | null;
export function projectToSweep(sweep: Sweep, x: number, y: number, z: number, out: Float32Array): void;
```

Rules: split the points into slabs along their longest principal axis, each about 8 × the local edge length thick; fit a cylinder to each with `fitShape`; chain the cylinders' axis points by nearest neighbour into an ordered centre line; fit it with `fitCurve('arc', …)` and fall back to `'spline'` when the arc's rms exceeds 2 × noise. The profile is the robust median radius per angle bin over all stations. Null with fewer than three slabs.

- [ ] **Step 1: Write the failing tests**

```ts
it('recovers an elbow as a round tube on an arc', () => {
  const { points, normals } = patch(softElbow(4, 1), (x, y, z) => true, { skipCaps: true });
  const { sweep } = fitSweep(points, normals, 0.004)!;
  expect(sweep.pathKind).toBe('arc');
  expect(sweep.round).toBe(true);
  expect(Math.abs(mean(sweep.profile) - 1)).toBeLessThan(0.01);
  expect(maxDistance(sweep.path.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 4) + Math.abs(y))).toBeLessThan(0.04);
});
it('snaps an elbow region onto the true torus', () => {
  const model = modelOf(softElbow(4, 1));
  const solve = solveRegion(model.mesh, model.topology, { triangles: tubeTriangles(model.mesh), treatment: 'shape', shape: 'sweep', strength: 1, keepDetail: true, detail: null, blend: null }, model.noise)!;
  expect(solve.fitted).toBe('sweep');
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  for (const i of indicesWhere(solve, (w, d) => w === 1 && d === 0))
    expect(torusDistance(out, solve.vertices[i], 4, 1)).toBeLessThan(0.005);
});
it('follows a spline when the centre line is not an arc', () => { /* an S-bend tube from softElbow halves: pathKind 'spline', rms within 2 * noise */ });
it('returns null for a patch with no tube in it', () => { /* a flat face */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-sweep.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the module and the `'sweep'` branch in `solveRegion`.
- [ ] **Step 4: Run** this test and `tests/unit/refine-region.test.ts`. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Snap Refine regions to a sweep along an arc or spline`.

---

### Task 11: Brushes

**Files:**
- Create: `src/core/refine-paint.ts`, `src/core/refine-brush.ts`
- Test: `tests/unit/refine-brush.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 5, 7, 9.
- Produces:
```ts
// refine-paint.ts
/** Triangles connected to `seed` with a vertex within `radius` of `center`. */
export function trianglesUnderBrush(mesh: RefineMesh, topology: RefineTopology, seed: number, center: Vec3, radius: number): Uint32Array;
/** Welded vertices connected to `seed`'s triangle within `radius`, with a (1 - (d/r)^2)^2 falloff each. */
export function verticesUnderBrush(mesh: RefineMesh, topology: RefineTopology, seed: number, center: Vec3, radius: number): { vertices: Uint32Array; falloff: Float32Array };

// refine-brush.ts
export type RefineBrush = 'crease' | 'flatten' | 'smooth';
export interface Dab { triangle: number; center: Vec3; radius: number; strength: number }
export function smoothDab(mesh: RefineMesh, topology: RefineTopology, dab: Dab): Uint32Array;
export function flattenDab(mesh: RefineMesh, topology: RefineTopology, dab: Dab): Uint32Array;
/** A freehand stroke as a spline guide: jitter removed, width = radius. Null for a stroke shorter than the radius. */
export function creaseInput(stroke: GuidePoint[], radius: number, strength: number): EdgeInput | null;
```

Rules: `smoothDab` moves each vertex toward the mean of its neighbours by `strength × falloff`. `flattenDab` fits a least squares plane to the vertices under the brush and moves each toward it along the plane normal by `strength × falloff`. `creaseInput` resamples the stroke every `radius`, giving one spline segment whose point count is `ceil(length / (4 × radius)) + 3`, capped at 32.

- [ ] **Step 1: Write the failing tests**

```ts
it('selects only connected surface under the brush', () => {
  // softBox([2, 0.25, 1], 0.1): a 0.4 mm brush on the top face reaches no bottom-face triangle.
});
it('smooths under the brush and nowhere else', () => {
  const model = modelOf(rippledSphere(3));
  const out = cloneRefineMesh(model.mesh, false);
  const dab = { ...dabAt(out, [0, 3, 0]), radius: 0.8, strength: 1 };
  for (let i = 0; i < 20; i++) smoothDab(out, model.topology, dab);
  expect(rippleAmplitude(out, 3, capAt([0, 3, 0], 0.4))).toBeLessThan(0.5 * rippleAmplitude(model.mesh, 3, capAt([0, 3, 0], 0.4)));
  expect(movedOutsideRadius(model.mesh, out, [0, 3, 0], 0.8)).toBe(0);
});
it('flattens under the brush, rivets included', () => {
  // rivetedPlate: 20 flatten dabs centred on a rivet with radius 0.8 bring its height within 0.03 of the plate.
});
it('turns a freehand stroke into a guide that sharpens the edge', () => {
  const model = modelOf(softBox([2, 1.5, 1], 0.3));
  const stroke = jitteredCrest(model.mesh, -1.2, 1.2, 0.05); // points every 0.1 mm, 0.05 mm of hand jitter
  const input = creaseInput(stroke, 0.6, 1)!;
  expect(input.segments[0].kind).toBe('spline');
  const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
  const out = cloneRefineMesh(model.mesh, true);
  const chain = [...applyEdge(out, model.topology, solve, 1, true).cut!.chain].filter((v) => Math.abs(out.position[v * 3]) <= 0.6);
  for (const v of chain) expect(Math.hypot(out.position[v * 3 + 1] - 1.5, out.position[v * 3 + 2] - 1)).toBeLessThan(0.03);
});
it('ignores a stroke shorter than the radius', () => { expect(creaseInput(shortStroke, 0.6, 1)).toBeNull(); });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-brush.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Add crease, flatten and smooth brushes for Refine`.

---

### Task 12: Detection

**Files:**
- Create: `src/core/refine-curvature.ts`, `src/core/refine-detect.ts`
- Test: `tests/unit/refine-detect.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 5, 7, 9.
- Produces:
```ts
// refine-curvature.ts
export interface Curvature {
  /** Principal curvatures per welded vertex, |k1| >= |k2|, 1/mm. */
  k1: Float32Array; k2: Float32Array;
  /** Unit direction of k2 per welded vertex: along an edge. */
  along: Float32Array;
}
/** Curvature from the change of normals over the ring of radius `scale` around each vertex. */
export function vertexCurvature(mesh: RefineMesh, topology: RefineTopology, scale: number, vertices?: Uint32Array): Curvature;

// refine-detect.ts
export type RefineProposal = { type: 'edge'; input: EdgeInput } | { type: 'region'; input: RegionInput };
export interface DetectOptions {
  /** Triangles to look in; null is the whole part. */
  triangles: Uint32Array | null;
  /** 0 to 1. Higher proposes softer edges. */
  sensitivity: number;
  /** mm. Shorter edges, and surfaces smaller than its square, are not proposed. */
  minLength: number;
}
export const detectDefaults = { sensitivity: 0.5, minLength: 1.5 };
export function detectFeatures(
  mesh: RefineMesh, topology: RefineTopology, noise: number, options: DetectOptions,
  report?: (fraction: number) => void, signal?: AbortSignal,
): RefineProposal[];
```

Rules:

- Edges. Curvature scale is 4 × the median edge length. A vertex is on an edge when `|k1| >= kMin` and `|k2| <= 0.3 × |k1|`, with `kMin = 1 / (0.15 + 1.35 × sensitivity)` per mm, so higher sensitivity admits gentler rounding. Corners fail the second test, which separates the bands. For each connected band take its two farthest vertices and the path between them that prefers high `|k1|`; split it where it turns more than 30 degrees within twice the band's half-width; drop pieces shorter than `minLength`. Fit each piece as a line, then an arc, accepting the first whose rms is within 2 × noise, else a spline. The proposal's points are 2 for a line, 3 for an arc, one per 8 × band half-width for a spline; `width` is null; `strength` is 1.
- Surfaces. Grow regions from the flattest unassigned vertices, adding neighbours within 3 × noise of the region's `fitAuto` shape, refitting as it grows. Keep regions larger than `minLength²` whose fit is `within`. A plane becomes `{ treatment: 'flatten' }`, anything else `{ treatment: 'shape', shape: its kind }`, with `strength: 1`, `keepDetail: true`, `detail: null`, `blend: null`.
- The mesh is read only. `report` is called at least every 5 % and `signal` is checked as often; an aborted run throws `new DOMException('Detection cancelled', 'AbortError')`.

- [ ] **Step 1: Write the failing tests**

```ts
it('measures curvature across a fillet and none along it', () => {
  // softBox fillet 0.3: at crest vertices away from corners, |k1| is within 30 % of 1 / 0.3 and |k2| < 0.5.
});
it('proposes the 12 edges and 6 faces of a box', () => {
  const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
  const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
  const edges = found.filter((p) => p.type === 'edge');
  expect(edges).toHaveLength(12);
  expect(edges.every((e) => e.input.segments[0].kind === 'line')).toBe(true);
  expect(matchedBoxEdges(edges, [2, 1.5, 1], 0.15)).toBe(12); // each within 0.15 mm of a distinct true edge
  const faces = found.filter((p) => p.type === 'region');
  expect(faces).toHaveLength(6);
  expect(faces.every((f) => f.input.treatment === 'flatten')).toBe(true);
});
it('proposes nothing on rivets', () => {
  const { geometry, rivets } = rivetedPlate();
  const { mesh, topology, noise } = modelOf(geometry);
  const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
  for (const p of found.filter((p) => p.type === 'edge'))
    for (const point of p.input.segments.flatMap((s) => s.points))
      for (const r of rivets) expect(Math.hypot(point.position[0] - r.x, point.position[2] - r.z)).toBeGreaterThan(r.radius);
});
it('proposes a rim as an arc and a wall as a cylinder', () => { /* softCylinder(1.5, 1, 0.3): two arc edges, one 'shape'/'cylinder' region, two 'flatten' */ });
it('looks only where asked', () => { /* triangles = the top face: every proposal's points have y > 1 */ });
it('leaves the mesh bit-identical', () => {
  const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
  const before = mesh.position.slice();
  detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
  expect(mesh.position).toEqual(before);
  expect(mesh.touched.some((t) => t === 1)).toBe(false);
});
it('every edge proposal solves', () => { /* solveEdge is non-null for each of the box's 12 */ });
it('stops when aborted and reports progress', () => { /* abort after the first report: rejects with AbortError; report was called with increasing fractions */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-detect.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Real-scan probe (local, not committed).** With `REFINE_SCANS` set, run `detectFeatures` on `45.stl` and `57.stl` in a scratch test and log the proposal counts by kind and the run time. Look at where the proposals land (write the guides' points as a small STL of markers). Adjust the thresholds named in the rules if the long plate and strap edges are missed or rivets are proposed, and keep the fixture tests passing.
- [ ] **Step 6: Commit** `(feat) Propose Refine guides and regions automatically`.

---

### Task 13: Model, worker and jobs

**Files:**
- Create: `src/core/refine-model.ts`, `src/core/refine.worker.ts`, `src/core/refine-job.ts`
- Test: `tests/unit/refine-job.test.ts`

**Interfaces:**
- Consumes: Tasks 2, 4, 12.
- Produces:
```ts
// refine-model.ts
export interface RefineModel { mesh: RefineMesh; topology: RefineTopology; noise: number; /** Median edge length, mm. */ step: number }
export interface RefineModelInput { positions: Float32Array; index: Uint32Array | null; color: Float32Array | null; colorSize: number; matrix: number[] }
export function refineModelInput(geometry: BufferGeometry, matrixWorld: Matrix4): RefineModelInput; // copies, so the buffers can be transferred
export function buildRefineModel(input: RefineModelInput): RefineModel;
export function modelFromMesh(mesh: RefineMesh): RefineModel; // after a cut: rebuilds topology, keeps noise and step from the caller

// refine-job.ts
export function buildRefineModelJob(input: RefineModelInput, signal: AbortSignal): Promise<RefineModel>;
export function detectRefineJob(model: RefineModel, options: DetectOptions, signal: AbortSignal, report: (fraction: number) => void): Promise<RefineProposal[]>;
```

Copy `src/core/warp-job.ts` and `src/core/warp.worker.ts`: an aborted signal rejects at once with an `AbortError`; without `Worker` (Vitest) the work runs in-thread; otherwise one module worker per job, with typed-array buffers transferred both ways and `{ error }` or the result posted back. `detectRefineJob` posts copies of the mesh arrays and also relays `{ type: 'progress', fraction }` messages to `report`.

- [ ] **Step 1: Write the failing tests**

```ts
it('builds the same model in a job as directly', async () => {
  const geometry = softBox([2, 1.5, 1], 0.3);
  const direct = buildRefineModel(refineModelInput(geometry, new Matrix4()));
  const job = await buildRefineModelJob(refineModelInput(geometry, new Matrix4()), new AbortController().signal);
  expect(job.mesh.position).toEqual(direct.mesh.position);
  expect(job.step).toBeCloseTo(0.06, 1);
});
it('does not detach the source geometry', async () => {
  const geometry = softBox([2, 1.5, 1], 0.3);
  await buildRefineModelJob(refineModelInput(geometry, new Matrix4()), new AbortController().signal);
  expect(geometry.getAttribute('position').array.length).toBeGreaterThan(0);
});
it('rejects at once when already aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(buildRefineModelJob(refineModelInput(softBox([2, 1.5, 1], 0.3), new Matrix4()), controller.signal)).rejects.toThrow('cancelled');
});
it('detects through the job and reports progress', async () => { /* 12 edge proposals; report called */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-job.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the three files.
- [ ] **Step 4: Run** the test. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Build the Refine model and detect in a worker`.

---

### Task 14: Session lifecycle in the store

**Files:**
- Modify: `src/core/types.ts:7-18` (add `'refine'` to `Tool`), `src/core/store.ts`, `src/core/commands.ts:43-65,117-133`, `src/xr/runtime.ts:230-235`
- Test: `tests/unit/refine-session.test.ts`

**Interfaces:**
- Consumes: Task 13.
- Produces (in `src/core/store.ts`):
```ts
export type RefineMode = 'edge' | 'region' | 'brush' | 'detect';
export interface RefineFeature {
  id: string;
  state: 'pending' | 'accepted';
  origin: 'hand' | 'detected';
  feature: RefineProposal;
  /** The solved edge of an accepted or previewed edge feature, for drawing. */
  curve?: EdgeCurve;
}
export interface RefineStep { model: RefineModel; features: RefineFeature[]; selected: string[]; triangles: number[] }
export interface RefineSession {
  id: string; partId: string; source: BufferGeometry; epoch: number;
  stage: 'building' | 'ready';
  /** The model the session started with. */
  start: RefineModel | null;
  /** The working surface: the scan with everything accepted. */
  model: RefineModel | null;
  /** The working surface with the selected pending features previewed, uncut. Null when nothing is selected. */
  draft: RefineMesh | null;
  /** Never in the scene or history. Face t is triangle t of the working surface. */
  preview: BufferGeometry | null;
  mode: RefineMode;
  features: RefineFeature[];
  selected: string[];
  /** Painted triangles of the working surface: the region being made, or where Detect looks. */
  triangles: number[];
  edge: { kind: GuideKind; width: number | null; joint: GuideJoint; strength: number };
  region: Omit<RegionInput, 'triangles'>;
  brush: { kind: RefineBrush; strength: number };
  detect: { where: 'part' | 'painted'; sensitivity: number; minLength: number; running: boolean };
  folds: Uint32Array;
  undo: RefineStep[]; redo: RefineStep[];
}
export const refineUndoLimit = 50;
// EditorState gains: refine: RefineSession | null;
// Actions:
startRefine(): boolean;
cancelRefine(notice?: string): void;
applyRefine(): boolean;
undoRefine(): void;
redoRefine(): void;
// Helpers:
export const refineEdited: (refine: RefineSession) => boolean; // model !== start
export const shownRefinePreview: (refine: RefineSession | null, partId: string) => BufferGeometry | null;
```

Behaviour, following Warp's (`startWarp` 2416, `cancelWarp` 2544, `applyWarp` 2978, subscriber 4469):

- `setTool('refine')` calls `startRefine()` (`store.ts:1970`). `startRefine` refuses in an XR session, needs exactly one selected part that is visible and unlocked (`Select one visible, unlocked part to refine.`), refuses above `maxPaintTriangles` with the Global Constraints message, then sets `stage: 'building'`, runs `buildRefineModelJob` under a task titled `Preparing to refine` (the `layWarp` pattern at `store.ts:4244-4278`: abort controller, `startTask`, stale-build check, `completeTask`) and sets `stage: 'ready'`, `model`, and `preview = writeRefinedGeometry(source, matrix, model.mesh)` with `refitWarpTree(source, preview)`.
- Defaults: `mode: 'edge'`, `edge: { kind: 'line', width: null, joint: 'sharp', strength: 1 }`, `region: { treatment: 'smooth', shape: 'auto', strength: 1, keepDetail: true, detail: null, blend: null }`, `brush: { kind: 'smooth', strength: 0.5 }`, `detect: { where: 'part', ...detectDefaults, running: false }`.
- A private `commitRefine(next: Partial<RefineSession>)` pushes a `RefineStep` of the current state onto `undo` (trimmed to `refineUndoLimit`), clears `redo`, sets the new state, and refreshes the preview. Position-only changes write the changed vertices into the preview's attributes and call `refitWarpTree`; a model with a different `triangleCount` replaces the preview with a new `writeRefinedGeometry`, disposes the old one, and calls `prepareForPicking(preview)`. On a large part the new preview cannot be clicked until that index is built; its task shows in the activity centre.
- `undoRefine` and `redoRefine` swap steps and refresh the preview the same way.
- `applyRefine`, guards in order: no session or not `ready` or not `refineEdited` gives false; part missing, `part.geometry !== refine.source` or `sceneEpoch !== refine.epoch` gives `The part changed, so the refinement could not be applied.`; `part.locked` gives `Unlock ${part.name} to apply the refinement.`. Then it writes `{ ...part, geometry: writeRefinedGeometry(source, matrix, model.mesh), source: \`Refine · ${part.source}\` }` through `changed(state, scene)` (`store.ts:1695`), calls `prepareForPicking` on the new geometry, and starts a fresh session on the refined part. Pins, anchors, pivot, joints and constraints are not touched. In a live session the edit goes through `changed` like `applyProcessedMesh`'s; there is no recovery state.
- `cancelRefine` aborts a running build or detection, disposes the preview, sets `refine: null` and notifies if given a notice. It does not change the tool.
- A subscriber cancels the session with `The part changed, so the refinement was cancelled.` when the part is missing, its geometry is not `refine.source`, the epoch differs or its transform changed, and with `Refinement discarded. Use Apply to keep it.` when the tool leaves `'refine'`. Each notice shows only when `refineEdited`.
- `releaseGeometries` (`store.ts:4001`) treats `refine.preview` as in use.
- `commands.ts`: add `'refine'` to `undoTarget` when the tool is `'refine'` with a session whose `undo` is not empty; `redoAvailable` is true when `redo` is not empty; `cut` is disabled as it is for Warp.
- `src/xr/runtime.ts:232`: leave Refine for `'select'` as Warp does.

- [ ] **Step 1: Write the failing tests** (set up as `tests/unit/warp-session.test.ts` does: `setup(parts, selected)`, `afterEach` restoring `initial` and clearing `useActivity`)

```ts
const boxPart = (overrides: Partial<Part> = {}): Part => ({ id: 'box', name: 'Box', geometry: softBox([2, 1.5, 1], 0.3), position: [0, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1], color: '#ccc', locked: false, visible: true, source: 'box.stl', ...overrides });
const ready = async () => { editor().setTool('refine'); await vi.waitFor(() => expect(session().stage).toBe('ready')); };

it('starts on one selected part and builds a preview that matches the source', async () => {
  setup([boxPart()], ['box']);
  await ready();
  expect(session().preview!.getAttribute('position').array).toEqual(session().source.getAttribute('position').array);
  expect(useActivity.getState().tasks.some((t) => t.title === 'Preparing to refine')).toBe(true);
});
it('refuses with nothing selected, a locked part, or a hidden part', () => { /* startRefine() false, notice text exact */ });
it('refuses a part over the triangle limit with the exact message', () => { /* stub triangle count */ });
it('applies nothing and adds no history when nothing was accepted', async () => {
  setup([boxPart()], ['box']);
  await ready();
  const past = editor().past.length;
  expect(editor().applyRefine()).toBe(false);
  expect(editor().past.length).toBe(past);
});
it('cancels when the part moves, is replaced, or the scene is replaced', async () => { /* each: refine becomes null */ });
it('cancels when the tool changes and leaves part.geometry untouched', async () => {
  setup([boxPart()], ['box']);
  await ready();
  const geometry = editor().scene.parts[0].geometry;
  const bits = geometry.getAttribute('position').array.slice();
  editor().setTool('select');
  expect(editor().refine).toBeNull();
  expect(geometry.getAttribute('position').array).toEqual(bits);
});
it('routes undo to the session only while it has steps', async () => { /* undoTarget(state) is 'scene' before any accept */ });
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-session.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the session lifecycle.
- [ ] **Step 4: Run** this test, then `npm test`. Expect PASS, with no existing test changed.
- [ ] **Step 5: Commit** `(feat) Add the Refine session to the store`.

---

### Task 15: Session features: guides, regions, brushes and detection

**Files:**
- Modify: `src/core/store.ts`
- Test: `tests/unit/refine-session.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 7 to 14.
- Produces (store actions):
```ts
setRefineMode(mode: RefineMode): void;
setRefineEdge(options: Partial<RefineSession['edge']>): void;     // also updates the selected pending edge
setRefineRegion(options: Partial<RefineSession['region']>): void; // also updates the selected pending region
setRefineBrush(options: Partial<RefineSession['brush']>): void;
setRefineDetect(options: Partial<Omit<RefineSession['detect'], 'running'>>): void;
/** Adds a point to the guide being drawn, starting one if none is selected. `close` is set when the point is the path's first point. */
addRefinePoint(point: GuidePoint, close?: boolean): void;
moveRefinePoint(feature: string, segment: number, index: number, point: GuidePoint): void;
removeRefinePoint(feature: string, segment: number, index: number): void;
/** Ends the spline segment being drawn. */
finishRefineGuide(): void;
paintRefineRegion(point: SurfacePoint, triangle: number, erase?: boolean, begin?: boolean): boolean;
/** Turns the painted triangles into a pending region with the current region settings, and selects it. */
makeRefineRegion(): void;
selectRefine(ids: string[]): void;
/** Accepts the given pending features, or the selected ones. */
acceptRefine(ids?: string[]): void;
dismissRefine(ids?: string[]): void;
beginRefineStroke(point: GuidePoint): void;
moveRefineStroke(point: GuidePoint): void;
endRefineStroke(): void;
detectRefine(): Promise<void>;
cancelRefineDetect(): void;
refineBrushRadius(state: EditorState): number;      // exported helper, per part, from the warpBrush map
setRefineBrushRadius(radius: number): void;
paintingRefine(state: EditorState): boolean;        // exported: region mode, or detect mode with where 'painted'
brushingRefine(state: EditorState): boolean;        // exported: brush mode
```

Behaviour:

- **Guide entry.** In `edge` mode with no pending edge selected, `addRefinePoint` creates a pending hand feature with one segment of `edge.kind`, `edge.width` and `edge.strength`, and selects it. A line segment is complete at 2 points and an arc at 3; the next point starts a new segment of the current `edge.kind` from the last point, with `edge.joint` between them. A spline keeps taking points until `finishRefineGuide()`. A point added with `close` completes the current segment on the path's first point and sets `closed`, with `edge.joint` as the closing joint. Each point added, moved (once per drag) or removed, each `makeRefineRegion` and each dismiss is one session undo step.
- **Draft.** Whenever the selected pending features or their settings change, rebuild `draft`: clone `model.mesh` without topology and, for each selected pending feature in list order, `solveEdge` + `applyEdge(…, cut = false)` or `solveRegion` + `applyRegion`. Store each edge's solved `curve` on its feature. Write the draft's changed positions into the preview. The rebuild is coalesced to one per animation frame in a browser and runs synchronously without a window.
- **No edge.** When `solveEdge` returns null for a complete guide, keep the guide, clear its `curve`, and notify once: `No edge found under this guide. Move it onto the rounded edge or change Width.` When `solveRegion` returns null: `This area is too small to fit a surface. Paint more of it.`
- **Accept.** For each feature in list order: solve against the current model, apply to a topology clone with `cut = true` for edges, build the next model with `modelFromMesh`, and after a cut pass `triangles` and every pending region's `triangles` through `remapTriangles`. Mark the feature accepted, clear the selection and `draft`, set `folds` from `foldedTriangles`, and `commitRefine` once for the whole call. A feature that fails to solve stays pending and is reported with its notice.
- **Region paint.** `paintRefineRegion` unions or, when erasing, subtracts `trianglesUnderBrush(model.mesh, model.topology, triangle, worldPoint, refineBrushRadius(state))`. A `begin` call is one session undo step. In `region` mode `makeRefineRegion` turns the paint into a pending region and clears the paint.
- **Brushes.** `beginRefineStroke` clones `model.mesh` without topology into a stroke-local mesh. For `smooth` and `flatten`, each `moveRefineStroke` applies one dab every quarter radius of pointer travel and writes the changed vertices into the preview; `endRefineStroke` commits the stroke as one step. For `crease`, points are collected and `endRefineStroke` runs `creaseInput`, then the Accept path with the brush's strength, adding an accepted hand feature. A crease stroke that is too short or finds no edge changes nothing and notifies as above.
- **Detection.** `detectRefine` sets `running`, runs `detectRefineJob` under a task titled `Finding edges and surfaces` with progress and a cancel that aborts, then appends the proposals as pending `detected` features without selecting them and without a session undo step. `where: 'painted'` passes the painted triangles. If the model changed while it ran, the result is dropped with `The surface changed, so detection was stopped.`
- **Brush radius.** Stored per part in the existing `warpBrush` map, defaulting to `fittedWarpBrushRadius(part)`.

- [ ] **Step 1: Write the failing tests**

```ts
const crest = (x: number): GuidePoint => pointOn(session().model!.mesh, [x, 1.5 - 0.0879, 1 - 0.0879]); // 0.3 - 0.3 / sqrt(2)

it('previews a line guide without changing the model, then bakes it on accept', async () => {
  setup([boxPart()], ['box']);
  await ready();
  const model = session().model!;
  editor().addRefinePoint(crest(-1.6));
  editor().addRefinePoint(crest(1.6));
  expect(session().model).toBe(model);
  expect(session().draft).not.toBeNull();
  expect(session().features[0].curve).toBeDefined();
  editor().acceptRefine();
  expect(session().features[0].state).toBe('accepted');
  expect(session().model!.mesh.triangleCount).toBeGreaterThan(model.mesh.triangleCount);
  expect(triangleCount(session().preview!)).toBe(session().model!.mesh.triangleCount);
});
it('steps back and forward through accepts', async () => {
  // accept, undoRefine: model is the original and the feature is pending again; redoRefine: accepted again.
});
it('applies as one undo step, keeps links, and scene undo restores the source geometry', async () => {
  setup([boxPart({ pins: [pin], anchors: [anchor] }), other], ['box'], { joints: [joint] });
  await ready();
  /* accept one edge */
  const before = editor().scene;
  const past = editor().past.length;
  expect(editor().applyRefine()).toBe(true);
  const part = editor().scene.parts[0];
  expect(editor().past.length).toBe(past + 1);
  expect(part.source).toBe('Refine · box.stl');
  expect(part.pins).toEqual(before.parts[0].pins);
  expect(part.anchors).toEqual(before.parts[0].anchors);
  expect(editor().scene.joints).toEqual(before.joints);
  expect(editor().scene.parts[1]).toBe(before.parts[1]);
  expect(closed(part.geometry)).toBe(true);
  editor().undo();
  expect(editor().scene.parts[0].geometry).toBe(before.parts[0].geometry);
});
it('keeps a guide that finds no edge, changes nothing, and says why', async () => {
  // two points on a flat face: draft equals the model's positions; the notice text is exact.
});
it('paints a region, makes it pending, and flattens on accept', async () => { /* riveted plate part; base within 0.005 */ });
it('remaps a pending region when an edge is accepted through it', async () => { /* every triangle id in the region is < triangleCount and covers the same area within 1 % */ });
it('brushes as one undo step per stroke', async () => { /* begin, 5 moves, end: undo.length grows by 1; undoRefine restores positions exactly */ });
it('adds an accepted edge from a crease stroke', async () => { /* features gains one accepted hand edge; model has crease vertices */ });
it('adds detected proposals without touching the model or the undo stack', async () => {
  setup([boxPart()], ['box']);
  await ready();
  const model = session().model, undo = session().undo.length;
  await editor().detectRefine();
  expect(session().features.filter((f) => f.origin === 'detected' && f.state === 'pending')).toHaveLength(18);
  expect(session().model).toBe(model);
  expect(session().undo.length).toBe(undo);
});
it('accepts several selected proposals together as one step', async () => { /* select 3 detected edges, acceptRefine(): 3 accepted, undo.length + 1 */ });
it('drops a detection that finished after the model changed', async () => { /* accept during detection: no detected features, notice exact */ });
it('never applies a proposal that was not accepted', async () => {
  // detect, then applyRefine(): false, and part.geometry is unchanged.
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-session.test.ts`. Expect the new tests to FAIL.
- [ ] **Step 3: Implement** the actions.
- [ ] **Step 4: Run** this test, then `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Add guides, regions, brushes and detection to the Refine session`.

---

### Task 16: Tool wiring and the panel

**Files:**
- Create: `src/components/RefineControls.tsx`
- Modify: `src/core/keybindings.ts:27`, `src/hooks/useWorkbench.ts:149-195,243-247`, `src/App.tsx:374,478-486,620-660,797`, `src/components/Inspector.tsx:947-982`, `src/components/Dialogs.tsx:650`, `src/styles.css`
- Test: `tests/unit/refine-wiring.test.ts`

**Interfaces:**
- Consumes: Tasks 14, 15.
- Produces: `export function RefineControls()` (no props; reads `useEditor((s) => s.refine)` as `WarpControls` does).

Wiring, each beside its Warp counterpart:

- `keybindings.ts`: `refine: { group: 'Tools', label: 'Refine', keys: ['E'] }`.
- `useWorkbench.ts`: add `refine: 'refine'` to `tools`. `brushSmaller` and `brushLarger` call `setRefineBrushRadius` when `paintingRefine(state) || brushingRefine(state)`. `delete` calls `dismissRefine()` when the tool is Refine and something is selected. `apply` (Enter) calls `finishRefineGuide()` while a spline segment is open, otherwise `acceptRefine()`. `cancel` (Escape) dismisses the guide being drawn, otherwise falls through.
- `App.tsx`: `refine: useShortcut('refine')`; a toolbar button after Warp's, `className="tool-button refine-tool …"`, `title={withShortcut('Refine edges and surfaces on a scan', keys.refine)}`, icon `Sparkles` from `lucide-react`; `'refine'` in the list at line 797; status hints by mode:
  - building: `Preparing the surface…`
  - edge: `Click along a rounded edge to place a guide. Enter accepts, Esc dismisses.`
  - region: `Paint the area to treat. Alt erases.`
  - brush: `Drag across the surface. [ and ] change the brush size.`
  - detect: `Find edges and surfaces, then accept the proposals you want.`
- `Inspector.tsx`: title `Refine`, body `<RefineControls />`.
- `Dialogs.tsx`: help row `['Refine a scanned surface', \`${key('refine')} · guide edges, treat regions, then Apply\`]`.

Panel, as the spec's sketch:

- Not started: a Start button and the reason it cannot start, as `WarpControls` does.
- A four-way mode switch: Edge, Region, Brush, Detect (`RadioGroup` from `ui.tsx`).
- **Edge:** kind (Line, Arc, Spline); Width as a `LogRangeInput` 0.1 to 5 mm with an Auto toggle (null); Strength 0 to 100 %, how loosely the edge follows the guide's line, arc or spline; Joints (Sharp, Smooth); Dismiss and Accept.
- **Region:** `SurfaceBrushControls` with `fitted={{ radius: refineBrushRadius, range: fittedSizeRange(partSize(part)), set: setRefineBrushRadius }}`; a `Make region` button, enabled when triangles are painted; treatment (Smooth, Flatten, Shape); for Shape a select of Auto, Cylinder, Cone, Sphere, Sweep, and the fitted name when Auto (`Fits a cylinder`); Strength 0 to 100 %; Keep detail switch with an Offset field in mm and an Auto toggle (how far a feature must deviate from the surface, raised or recessed, to be preserved); Blend in mm with an Auto toggle; Dismiss and Accept.
- **Brush:** Crease, Flatten, Smooth; radius (same fitted control); Strength 0 to 100 %.
- **Detect:** Whole part or Painted area; Sensitivity 0 to 100 %; Minimum length in mm; `Find edges and surfaces`, which becomes `Cancel` with progress while running; with proposals present, `Accept selected` and `Dismiss selected`.
- Footer: `${accepted} accepted · ${pending} proposed`; a fold warning when `folds.length > 0` (`${n} triangles fold over. Undo the last step or reduce Width.`); Cancel (calls `cancelRefine()` then `setTool('select')`) and Apply (disabled unless `refineEdited`).

- [ ] **Step 1: Write the failing tests**

```ts
it('gives Refine a key no other action uses', () => {
  const used = Object.entries(keyActions).filter(([id]) => id !== 'refine').flatMap(([, a]) => a.keys);
  expect(keyActions.refine.keys).toEqual(['E']);
  expect(used).not.toContain('E');
});
it('maps the key action to the tool', () => {
  // The `tools` map in useWorkbench.ts has refine: 'refine' (export it for this test).
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/refine-wiring.test.ts`. Expect FAIL.
- [ ] **Step 3: Implement** the wiring and the panel.
- [ ] **Step 4: Run** the test and `npm run build`. Expect PASS and a clean type check. Unit tests do not render components here; the panel is covered end to end in Tasks 17 and 18.
- [ ] **Step 5: Commit** `(feat) Add the Refine tool button, shortcut and panel`.

---

### Task 17: Viewport: preview, pointer handling and overlay

**Files:**
- Create: `src/components/RefineOverlay.tsx`, `src/components/RefinePointer.tsx`
- Modify: `src/components/Viewport.tsx:162-189,207-221,243-254,297-341,1145-1151,1277-1279`, `src/components/CameraNavigation.tsx:32-37`, `src/components/SurfacePainter.tsx` (`PaintCursor` radius)
- Create: `tests/e2e/refine.spec.ts`, `tests/e2e/helpers/refine.ts` (the fixture, helpers and first test described in Task 18)
- Test: `tests/e2e/refine.spec.ts`, test `guides a straight edge, accepts it and applies it`

**Interfaces:**
- Consumes: Tasks 14 to 16.
- Produces:
```ts
// RefineOverlay.tsx
export function RefineOverlay(): JSX.Element | null;
// RefinePointer.tsx
/** Starts a brush stroke or a guide-point drag from a pointer-down on the part. True when it took the event. */
export function beginRefinePointer(event: ThreeEvent<PointerEvent>, partId: string): boolean;
export function RefinePointerController({ pressed }: { pressed: () => boolean }): null;
```

- `PartMesh`: draw `shownRefinePreview(s.refine, part.id) ?? shownWarpPreview(…) ?? …`. Raycast as for a Warp preview: when the preview's position `version` changed, `refitWarpTree(part.geometry, preview)` first. Set `polygonOffset` while refining.
- `onClick`: in `edge` mode a click on the part calls `addRefinePoint({ triangle: event.faceIndex, position: world point })`; a click on the open path's first handle calls `addRefinePoint(thatPoint, true)`; a click on a proposal's overlay calls `selectRefine` (Shift adds to the selection).
- `onPointerDown`: `paintingRefine` → `paintRefineRegion(toSurface(e), faceIndex, altKey, true)`; otherwise `beginRefinePointer`. `onPointerMove`: set `brushHit` while painting or brushing, and paint while the left button is held.
- `RefinePointer.tsx` follows `WarpStroke.tsx`: pointer capture, window listeners, Escape and blur discard, its own first-hit raycast against this part's mesh, a sample every 2 px. A drag that starts on a guide point's handle moves it with `moveRefinePoint`; in `brush` mode a drag calls `beginRefineStroke`, `moveRefineStroke`, `endRefineStroke`.
- `CameraNavigation.tsx`: `brushOwnsLeftDrag` also holds when `paintingRefine(state) || brushingRefine(state)`.
- `PaintCursor`: use `refineBrushRadius(s)` when `paintingRefine(s) || brushingRefine(s)`.
- `onPointerMissed`: with a Refine session, clear the Refine selection instead of the part selection.
- `RefineOverlay` draws, in front of the surface:
  - each guide's points as handles and its drawn curve as a thin line; the selected one brighter;
  - each edge feature's solved `curve`: solid for accepted, dashed for pending;
  - the band of the selected pending edge as a tint over its triangles;
  - painted triangles and each pending region's triangles as a tint (`warpRegionColor` for paint, a second hue for regions), and kept detail outlined in the selected region;
  - folded triangles in the warning colour Warp uses.
  Mount it beside `WarpOverlay` (`Viewport.tsx:1145`), inside the non-headset block, with `<RefinePointerController pressed={gizmoWasPressed} />`.

- [ ] **Step 1: Write the failing test**: the fixture, `openRefine`, `clickSurface` and the first test from Task 18.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/refine.spec.ts`. Expect FAIL (clicks place no points).
- [ ] **Step 3: Implement** the preview swap and raycast in `PartMesh`; click, paint and pointer routing; `RefinePointer.tsx`; `RefineOverlay.tsx`.
- [ ] **Step 4: Run** the spec, `npm run build` and `npm test`. Expect PASS.
- [ ] **Step 5: Commit** `(feat) Draw and drive Refine in the viewport`.

---

### Task 18: End-to-end tests

**Files:**
- Modify: `tests/e2e/refine.spec.ts`, `tests/e2e/helpers/refine.ts` (started in Task 17)
- Test: itself.

**Interfaces:**
- Consumes: the whole tool. Reuses `open`, `screen`, `inStore`, `drag` and the error hooks from `tests/e2e/warp-strokes.spec.ts:120-194` and `tests/e2e/helpers/warp-grid.ts` (`failOnBrowserErrors`).

Fixture: an inline `kitbasher` version 1 scene with one part, `softBox([4, 3, 2], 0.6, { step: 0.2, ripple: 0.04, noise: 0.008 })` serialized with `serializeGeometry`, named `Scanned block`. `tests/e2e/helpers/refine.ts` exports `openRefine(page)` (opens the scene, selects the part, presses `1`, `Home`, `e`, and waits for the panel's mode switch) and `clickSurface(page, world)`.

- [ ] **Step 1: Write the remaining tests** (the first is already in place from Task 17)

```ts
test('guides a straight edge, accepts it and applies it', async ({ page }) => {
  await openRefine(page);
  await clickSurface(page, crest(-3));
  await clickSurface(page, crest(3));
  await expect(page.getByText('0 accepted · 1 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Accept' }).click();
  await expect(page.getByText('1 accepted · 0 proposed')).toBeVisible();
  await page.getByRole('button', { name: 'Apply' }).click();
  const part = await inStore(page, (s) => ({ source: s.scene.parts[0].source, past: s.past.length }));
  expect(part.source).toBe('Refine · Scanned block');
  expect(await chainStraightness(page)).toBeLessThan(0.02);
});
test('places an arc and a closed path', async ({ page }) => { /* Arc: three clicks; Line: four clicks, then a click on the first handle closes; both accept */ });
test('paints a region and runs each treatment', async ({ page }) => { /* paint by drag on the top face, Make region, Smooth / Flatten / Shape each accept */ });
test('strokes with each brush', async ({ page }) => { /* Crease along an edge, Flatten and Smooth on a face: the session's undo count grows by one per stroke */ });
test('detects, adjusts a proposal and accepts it', async ({ page }) => {
  await openRefine(page);
  await page.getByRole('radio', { name: 'Detect' }).click();
  await page.getByRole('button', { name: 'Find edges and surfaces' }).click();
  await expect(page.getByText(/0 accepted · \d+ proposed/)).toBeVisible();
  const before = await inStore(page, (s) => s.scene.parts[0].geometry.getAttribute('position').count);
  /* click one proposal, change Width, Accept selected */
  await expect(page.getByText(/1 accepted · \d+ proposed/)).toBeVisible();
  expect(await inStore(page, (s) => s.scene.parts[0].geometry.getAttribute('position').count)).toBe(before);
});
test('undoes and redoes inside the session, then cancels', async ({ page }) => { /* Mod+Z returns to proposed; Mod+Shift+Z accepts again; Cancel leaves part.geometry untouched */ });
test('scene undo after Apply restores the original mesh', async ({ page }) => { /* after Apply, leave the tool, Mod+Z: source is 'Scanned block' */ });
test('says so when a guide finds no edge', async ({ page }) => {
  /* two clicks on the top face */
  await expect(page.getByText('No edge found under this guide.')).toBeVisible();
});
```

- [ ] **Step 2: Run** `npx playwright test tests/e2e/refine.spec.ts`. Fix what fails in the tool, not the test.
- [ ] **Step 3: Run** `npm run test:e2e`. Expect PASS with no existing spec changed.
- [ ] **Step 4: Commit** `(test) Cover Refine end to end`.

---

### Task 19: Documentation

**Files:**
- Modify: `src/docs/assembly-guides.ts`, `src/docs/content.ts:80-111`, `src/docs/changelog.ts`, `docs/design.md:56-61`
- Test: `tests/unit/changelog.test.ts` (existing; it checks that a changelog `guide` exists in `articleById`).

- [ ] **Step 1: Add the guide.** A `DocArticle` with `id: 'refine'`, `title: 'Refine edges and surfaces on a scan'`, `group: 'Build & assemble'`, placed after `contact-paint` in `order`, with one section per part of the tool (guide an edge; treat a painted region; use the brushes; let Refine propose; apply or cancel), written from the spec's User experience section in the existing guides' voice. No image.
- [ ] **Step 2: Add the changelog entry** at the top of `releases`, without `commit`:

```ts
{
  date: '<the day this merges, YYYY-MM-DD>',
  title: 'Refine edges and surfaces on scans',
  changes: [
    {
      kind: 'new',
      text: 'Refine rebuilds softened edges from a line, arc or spline laid along them, smooths, flattens or shape-snaps a painted area while keeping rivets and other detail, adds crease, flatten and smooth brushes, and can propose guides for you to accept or adjust.',
      guide: 'refine',
    },
  ],
},
```

- [ ] **Step 3: Add the design line** to `docs/design.md` after Warp's bullet: `Offer a Refine tool (E) that rebuilds softened edges on a scanned part from line, arc and spline guides, treats painted regions (smooth, flatten or snap to a shape) while keeping detail, offers crease, flatten and smooth brushes, and proposes guides and regions for review. Apply bakes the result as one undo step without modifying pins, anchors, joints, or any other part. Cancel discards it.`
- [ ] **Step 4: Run** `npm test` and `npm run format:check`. Expect PASS.
- [ ] **Step 5: Commit** `(docs) Describe Refine in the guide, changelog and design`.

---

### Task 20: Performance and the reference parts

**Files:**
- Create: `tests/unit/refine-benchmark.test.ts`, `tests/e2e/refine-reference.spec.ts`
- Modify: `docs/verification.md` (a Refine row set under "Tools on dense meshes")

**Interfaces:**
- Consumes: the whole tool.

- [ ] **Step 1: Write the benchmark**, gated like `tests/unit/warp-benchmark.test.ts:12` with `it.skipIf(!process.env.KITBASHER_REFINE_BENCH)`. On a 3-million-triangle unindexed sphere with ripples it times: `buildRefineModel`; one 40 mm line guide's `solveEdge` + uncut `applyEdge` (a preview update); the same with `cut` plus `modelFromMesh` and `writeRefinedGeometry` (an accept); `solveRegion` + `applyRegion` Smooth over 200,000 triangles; one `smoothDab`; `detectFeatures` over the whole mesh. It writes the timings as JSON to the OS temp directory, as the Warp benchmark does, and asserts nothing about wall-clock time.
- [ ] **Step 2: Run** `KITBASHER_REFINE_BENCH=m4 npx vitest run tests/unit/refine-benchmark.test.ts`. A preview update over 50 ms or a dab over 16 ms is a stall the user will feel: profile and fix before going on. Record the numbers in `docs/verification.md`.
- [ ] **Step 3: Check nothing existing got slower.** Run `KITBASHER_WARP_BENCH`, `KITBASHER_BENCH` and `KITBASHER_MESH_BENCH` benchmarks on `main` and on this branch and compare the JSON. Run the export tests and confirm an unrefined part's export bytes are unchanged.
- [ ] **Step 4: Write the reference spec**, skipped unless `REFINE_SCANS` is set. For `45.stl` and `57.stl` in that directory: import the STL, frame it, and screenshot the top and bottom views to `test-results/refine-reference/<part>-<view>-before.png`. Then read `<part>.refine.json` from the same directory (a list of `RefineProposal`s in world coordinates), add each through the store, accept, Apply, and screenshot the same two views as `-after.png`. With no JSON file, only the before images are written.
- [ ] **Step 5: Author the two JSON files (local, outside the repo).** Open each scan in `npm run dev`, refine it by hand with the tool until it matches its reference photo by eye, and save the accepted features with a small in-page export from the store. Cover at least: on 45, the riveted plate (flatten, rivets kept) and its raised border (a closed path), the strap across both barrels, and the barrel rings (arcs); on 57, both tanks (smooth), the strap edges, the buckle, and the rectangular pockets on the back. Note anything the tool could not do well.
- [ ] **Step 6: Run** `REFINE_SCANS=<dir> npx playwright test tests/e2e/refine-reference.spec.ts` with a persistent Chrome profile, as large-file runs need. Hand the eight images and the notes to the product owner: their judgement against the reference photos is the acceptance test.
- [ ] **Step 7: Commit** `(test) Benchmark Refine and render the reference parts`.
