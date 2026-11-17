# Mesh Warp (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A desktop Warp tool that lets users stretch one scanned part's surface with control points, close seams against neighbouring parts, and bake the result into the mesh.

**Architecture:** Pure, typed-array geometry modules (`warp-region`, `warp-grid`, `warp-bind`, `warp-solve`, `warp-evaluate`, `warp-neighbour`) do the math and are unit-tested in node. A worker builds the warp model; the store owns one warp session and its preview geometry; transform tools learn to target control points through a small selection abstraction; the viewport and inspector render the session. Phase 1 never changes topology.

**Tech Stack:** TypeScript, React, Three.js, three-mesh-bvh, zustand, vendored meshoptimizer simplifier (WASM), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-17-mesh-warp-design.md`

## Global Constraints

- Work on branch `feature/mesh-warp`. Commit messages are plain sentence case like the existing history ("Add warp region builder"). No AI attribution, trailers or co-author lines.
- Comments only where necessary, direct and short.
- Units are millimeters. Overlap default is `defaultClipSettings.overlap` (0.1 mm, `src/core/clipping.ts:12`); overlap input range is `clipLimits` (0–5, step 0.01).
- Weld with `weldedPositionIndex(geometry)` (1e-5, `src/core/mesh-topology.ts:5`). Every geometry vertex of one interior welded vertex gets identical position bits.
- Vertices outside the region and region-border vertices keep their exact original position bits.
- Never write into `part.geometry` or any array it owns. Preview and applied geometry own new `position` and `normal` attributes and share the source `index` and `color` attributes.
- Apply leaves `pins`, `anchors`, `pivot`, joints and plane constraints unchanged and moves no other part.
- Warp is refused on parts above `maxPaintTriangles` (10,000,000) with: `${part.name} has too many triangles to warp. The limit is 10 million.`
- Desktop only. Starting a headset session cancels any warp session.
- No MCP tools are added or changed. The only `mcp/` change is the history byte budget in `mcp/document.ts`.
- Nothing existing may get slower; exports of unwarped parts stay bit-identical.
- Phase 1 has no topology change: no edge split, no collapse, no "Smooth squeezed areas" control.

## Review Focus

1. Non-indexed (triangle-soup) STL scans: a warp must not crack welded seams. Test in Task 5 asserts `hasClosedEdges` stays true and duplicates share bits.
2. Mirrored or non-uniformly scaled parts (`scale: [1, 2, -1]`): the warp is solved in world space, so a pure translation of all points stays a pure translation in world space. Test in Task 4/5.
3. The part changes under an open session (undo, another editor, delete, scene replaced): the session cancels with a notice and Apply is refused. Tests in Tasks 8 and 9.
4. A painted region that covers the whole closed mesh behaves as "Whole part" (no border, nothing fixed). Test in Task 1.
5. A neighbour still building its surface index (`treeOf` returns null) is skipped with a notice instead of throwing or blocking. Test in Task 6.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/core/warp-region.ts` (new) | Weld map, region roles (outside/border/interior), region triangles, vertex adjacency. |
| `src/core/warp-grid.ts` (new) | Coarse grid from the region via meshoptimizer with `LockBorder`; node adjacency. |
| `src/core/warp-bind.ts` (new) | Surface-distance binding of welded vertices and control points to grid nodes. |
| `src/core/warp-solve.ts` (new) | ARAP local/global solve on the grid with point constraints. |
| `src/core/warp-evaluate.ts` (new) | Dense positions and normals from a solved grid; fold detection. |
| `src/core/warp-model.ts` (new) | `WarpModel` type and `buildWarpModel` combining region, grid, binding. |
| `src/core/warp.worker.ts`, `src/core/warp-job.ts` (new) | Build the model off the main thread; in-thread fallback when `Worker` is undefined. |
| `src/core/warp-neighbour.ts` (new) | Neighbour lookup, snap, Close-gap targets, seam measurement. |
| `src/core/history-budget.ts` (new) | Mesh byte accounting and history trimming. |
| `src/core/store.ts`, `src/core/types.ts` | `'warp'` tool, `WarpSession`, warp actions, budget hook, live settle. |
| `src/core/transform-selection.ts`, `src/core/free-transform.ts` | Transform targets that can be control points. |
| `src/components/CombinedTransform.tsx`, `FreeTransform.tsx`, `TransformAdjustments.tsx` | Dispatch edits to parts or control points. |
| `src/components/WarpControls.tsx`, `src/components/WarpOverlay.tsx` (new) | Inspector panel; viewport region, grid, points, gizmo, seam and fold overlays. |
| `src/components/Viewport.tsx`, `Inspector.tsx`, `src/App.tsx`, `src/core/keybindings.ts`, `src/hooks/useWorkbench.ts`, `src/components/Dialogs.tsx` | Wiring. |
| `src/core/live.ts`, `src/xr/runtime.ts`, `mcp/document.ts` | Live settle, headset cancel, server budget. |

---

### Task 1: Warp region

**Files:**
- Create: `src/core/warp-region.ts`
- Test: `tests/unit/warp-region.test.ts`

**Interfaces:**
- Produces:
```ts
export const enum WarpRole { Outside = 0, Border = 1, Interior = 2 }
export interface WarpRegion {
  /** Welded vertex of each geometry vertex; 0xffffffff when no face uses it. */
  weldOf: Uint32Array;
  weldedCount: number;
  /** Mesh-local rest position per welded vertex (its first-used geometry vertex). */
  rest: Float32Array;
  /** WarpRole per welded vertex. */
  role: Uint8Array;
  /** Region triangles as welded vertex triples, and the geometry face of each. */
  triangles: Uint32Array;
  faces: Uint32Array;
  /** CSR adjacency over welded ids, built from region triangles only. */
  adjacencyStart: Uint32Array;
  adjacency: Uint32Array;
  interiorCount: number;
}
export function buildWarpRegion(geometry: BufferGeometry, faces: readonly number[] | null): WarpRegion;
```

A welded vertex is in the region when a region face uses it. It is `Border` when any face outside the region also uses it, otherwise `Interior`. `faces === null` means every face.

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildWarpRegion', () => {
  it('treats a whole closed mesh as interior with no border', () => {
    const r = buildWarpRegion(new SphereGeometry(10, 16, 12), null);
    expect(r.role.filter((x) => x === WarpRole.Border).length).toBe(0);
    expect(r.interiorCount).toBe(r.weldedCount);
  });
  it('treats painting every face the same as whole', () => {
    const g = new SphereGeometry(10, 16, 12);
    const all = [...Array(triangleCount(g)).keys()];
    expect(buildWarpRegion(g, all).role).toEqual(buildWarpRegion(g, null).role);
  });
  it('marks vertices shared with unpainted faces as border', () => {
    const g = new PlaneGeometry(10, 10, 4, 4); // 32 faces, 25 vertices
    const r = buildWarpRegion(g, [10, 11, 12, 13, 18, 19, 20, 21]); // centre 2x2 quads
    expect(r.interiorCount).toBe(1);
    expect(r.role.filter((x) => x === WarpRole.Border).length).toBe(8);
  });
  it('welds a non-indexed mesh to the same topology as its indexed form', () => {
    const indexed = buildWarpRegion(new BoxGeometry(4, 4, 4, 2, 2, 2), null);
    const soup = buildWarpRegion(new BoxGeometry(4, 4, 4, 2, 2, 2).toNonIndexed(), null);
    expect(soup.weldedCount).toBe(indexed.weldedCount);
    expect(soup.triangles.length).toBe(indexed.triangles.length);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-region.test.ts` — expect FAIL (module not found).
- [ ] **Step 3: Implement `buildWarpRegion`.** Derive `weldOf` from `weldedPositionIndex(geometry).indices` (corner `i` maps geometry vertex `index ? index.getX(i) : i`). Mark outside-face vertices in one pass over non-region faces. Build CSR adjacency from region triangle edges, deduplicated.
- [ ] **Step 4: Run** the test — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add warp region builder"`.

---

### Task 2: Warp grid

**Files:**
- Create: `src/core/warp-grid.ts`
- Test: `tests/unit/warp-grid.test.ts`

**Interfaces:**
- Consumes: `WarpRegion` (Task 1).
- Produces:
```ts
export const warpDensityNodes = [60, 120, 250, 500, 1000, 2000, 4000] as const;
export const defaultWarpDensity = 3;
export interface WarpGrid {
  /** Welded vertex id of each node. */
  nodes: Uint32Array;
  /** Node index of each welded vertex, 0xffffffff when not a node. */
  nodeOf: Uint32Array;
  /** 1 for nodes on the region border; they never move. */
  fixed: Uint8Array;
  /** Node index triples, for drawing. */
  triangles: Uint32Array;
  /** CSR node adjacency from grid triangles. */
  edgeStart: Uint32Array;
  edges: Uint32Array;
}
export async function buildWarpGrid(region: WarpRegion, density: number): Promise<WarpGrid>;
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('buildWarpGrid', () => {
  it('keeps every border vertex as a fixed node', async () => {
    const g = new SphereGeometry(10, 64, 48);
    const faces = [...Array(1500).keys()];
    const region = buildWarpRegion(g, faces);
    const grid = await buildWarpGrid(region, 0);
    for (let v = 0; v < region.weldedCount; v++)
      if (region.role[v] === WarpRole.Border) {
        expect(grid.nodeOf[v]).not.toBe(0xffffffff);
        expect(grid.fixed[grid.nodeOf[v]]).toBe(1);
      }
  });
  it('approaches the requested node count on a whole mesh', async () => {
    const region = buildWarpRegion(new SphereGeometry(10, 128, 96), null);
    const grid = await buildWarpGrid(region, 3);
    expect(grid.nodes.length).toBeGreaterThan(warpDensityNodes[3] * 0.5);
    expect(grid.nodes.length).toBeLessThan(warpDensityNodes[3] * 2);
  });
  it('uses the region itself when it is already coarser than the target', async () => {
    const region = buildWarpRegion(new BoxGeometry(4, 4, 4), null);
    expect((await buildWarpGrid(region, 6)).nodes.length).toBe(region.weldedCount);
  });
});
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-grid.test.ts` — expect FAIL.
- [ ] **Step 3: Implement `buildWarpGrid`.** `await MeshoptSimplifier.ready`; compact region welded vertices to local ids; `MeshoptSimplifier.simplify(indices, positions, 3, warpDensityNodes[density] * 6, 1, ['LockBorder'])`; nodes are the surviving vertices mapped back to welded ids. Clamp `density` to the table.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add warp grid from simplified region"`.

---

### Task 3: Binding to grid nodes

**Files:**
- Create: `src/core/warp-bind.ts`
- Test: `tests/unit/warp-bind.test.ts`

**Interfaces:**
- Consumes: `WarpRegion`, `WarpGrid`.
- Produces:
```ts
export const warpBindingNodes = 4;
export interface WarpBinding {
  /** warpBindingNodes node ids per welded vertex, padded with 0xffffffff. */
  node: Uint32Array;
  weight: Float32Array;
}
/** restWorld: world rest position per welded vertex (3 × weldedCount). */
export function bindRegion(region: WarpRegion, grid: WarpGrid, restWorld: Float32Array): WarpBinding;
export function bindPoint(region: WarpRegion, grid: WarpGrid, binding: WarpBinding, face: number, barycentric: Vec3): { node: number[]; weight: number[] };
```

Distances are measured along region edges in world space with a multi-source Dijkstra that keeps the `warpBindingNodes + 1` nearest distinct nodes per vertex. Weights are Franke–Little, which interpolate nodes exactly and stay continuous:

```
R = distance to the (K+1)th node (if fewer were reached, 1.5 × the largest found)
w_j = ((R − d_j) / (R · d_j))², normalized; a vertex with d_j = 0 binds to node j alone.
```

`bindPoint` merges the three corner bindings of a region face by barycentric weight, keeps the `warpBindingNodes` largest, renormalizes. `face` is the geometry face index; it must be a region face.

- [ ] **Step 1: Write the failing tests**

```ts
it('binds each node vertex to itself alone', ...);           // weight[k*4] === 1 for v = grid.nodes[k]
it('gives every interior vertex weights summing to 1', ...); // |Σw − 1| < 1e-6
it('does not bind across a thin wall', ...);
// Two parallel 20×20 plates 0.5 mm apart joined at one edge (a folded sheet from
// PlaneGeometry pieces merged with mergeVertices). Every vertex on the lower plate
// binds only to nodes whose rest y is on the lower plate.
it('bindPoint at a corner equals that vertex binding', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-bind.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** with a binary heap of `(distance, vertex, node)`; a vertex accepts an entry while it holds fewer than K+1 nodes and not that node.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Bind warp vertices to grid nodes by surface distance"`.

---

### Task 4: ARAP solver

**Files:**
- Create: `src/core/warp-solve.ts`
- Test: `tests/unit/warp-solve.test.ts`

**Interfaces:**
- Consumes: `WarpGrid`.
- Produces:
```ts
export interface WarpConstraint {
  node: ArrayLike<number>;
  weight: ArrayLike<number>;
  /** World rest position of the constrained point. */
  rest: Vec3;
  target: Vec3;
}
export interface WarpState {
  /** World position per node. */
  positions: Float64Array;
  /** Rotation quaternion (x, y, z, w) per node. */
  rotations: Float64Array;
}
export const warpConstraintStrength = 1000;
export function createWarpState(restNodes: Float64Array): WarpState;
/** Warm-starts from and updates `state`. Returns the largest node move in the last iteration, mm. */
export function solveWarp(grid: WarpGrid, restNodes: Float64Array, constraints: WarpConstraint[], state: WarpState, iterations: number): number;
export const warpDragIterations = 3;
export const warpSettleIterations = 50;
export const warpSettleTolerance = 1e-4;
```

Energy, with `g` rest and `g'` solved node positions and edges taken in both directions:

```
Σ_edges ‖(g'_i − g'_j) − R_i (g_i − g_j)‖²
+ warpConstraintStrength · Σ_c ‖Σ_j w_j (R_j (p_c − g_j) + g'_j) − t_c‖²
```

Fixed nodes are eliminated (`g' = g`, `R = I`). Local step: per node, the rotation of the covariance `Σ_j (g_i − g_j)(g'_i − g'_j)ᵀ`, extracted with Müller et al. 2016 ("A Robust Method to Extract the Rotational Part of Deformations"), warm-started from the previous quaternion, 20 inner iterations. Global step: one SPD system shared by x, y, z, solved by Jacobi-preconditioned conjugate gradient warm-started from `state.positions`, relative tolerance 1e-8, at most 200 iterations. Assemble the matrix in CSR once per change of constraint node sets. When there are no constraints and no fixed nodes, return without moving anything.

- [ ] **Step 1: Write the failing tests**

```ts
it('keeps fixed nodes exactly at rest', ...);
it('translates rigidly when every constraint moves by the same offset', ...);
// sphere grid, 3 well-spread constraints all moved by [1, 2, 3]; every node within 1e-4 of rest + offset
it('meets a single moved point within 0.01 mm while others pin', ...);
it('warm start converges below warpSettleTolerance within warpSettleIterations', ...);
it('stays rigid in world space for a mirrored, non-uniform part', ...);
// restNodes built with partMatrix(scale [1, 2, -1]); uniform offset → uniform node offset
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-solve.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** `createWarpState` and `solveWarp`.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add as-rigid-as-possible warp solver"`.

---

### Task 5: Evaluate dense geometry and the warp model

**Files:**
- Create: `src/core/warp-evaluate.ts`, `src/core/warp-model.ts`, `src/core/warp.worker.ts`, `src/core/warp-job.ts`
- Test: `tests/unit/warp-evaluate.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces:
```ts
// warp-model.ts
export interface WarpModelInput {
  positions: Float32Array;      // geometry position array copy (local)
  index: Uint32Array | null;
  normals: Float32Array | null;
  matrix: number[];             // partMatrix(part).elements
  faces: number[] | null;
  density: number;
}
export interface WarpModel {
  region: WarpRegion; grid: WarpGrid; binding: WarpBinding;
  restWorld: Float32Array;      // per welded vertex
  restNodes: Float64Array;      // per node, world
  matrix: number[]; inverse: number[];
  positions: Float32Array;      // original local positions, never mutated
  normals: Float32Array | null;
  indexed: boolean;
}
export async function buildWarpModel(input: WarpModelInput): Promise<WarpModel>;

// warp-job.ts — worker when available, in-thread otherwise
export function buildWarpModelJob(input: WarpModelInput, signal: AbortSignal): Promise<WarpModel>;

// warp-evaluate.ts
export interface WarpOutput { positions: Float32Array; normals: Float32Array | null }
export function createWarpOutput(model: WarpModel): WarpOutput;   // copies of the originals
/** Writes interior vertices (and their normals); returns region triangle ids whose world normal flipped. */
export function evaluateWarp(model: WarpModel, state: WarpState, out: WarpOutput): Uint32Array;
export function deformPoint(model: WarpModel, state: WarpState, binding: { node: number[]; weight: number[] }, restWorld: Vec3): Vec3;
```

Dense rule: for each interior welded vertex `p' = Σ w_j (R_j (p − g_j) + g'_j)` in world space, mapped to local by `inverse` once, then written to every geometry vertex with that weld. Border and outside entries are never written. Normals: non-indexed geometry gets the face normal on each corner of region faces; indexed geometry gets area-weighted normals over region faces for interior vertices; border vertices keep their original normal. A fold is a region triangle whose deformed world normal has a negative dot with its rest world normal.

- [ ] **Step 1: Write the failing tests**

```ts
it('leaves outside and border positions bit-identical', ...);
// compare Uint32Array views of original vs output for every non-interior geometry vertex
it('writes identical bits to all duplicates of a welded vertex in a non-indexed scan', ...);
it('keeps a non-indexed closed scan closed after a warp', ...);
// weldedPositionIndex(output geometry) → hasClosedEdges(indices, vertices) === true
it('reports folded triangles', ...);
// pull one interior node through the surface by 5 mm; folds.length > 0
it('buildWarpModelJob falls back to in-thread when Worker is undefined', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-evaluate.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the four files. `warp.worker.ts` posts the model's typed arrays back as transferables; follow the worker lifecycle in `src/core/mesh-job.ts` (terminate on abort, reject on `onerror`).
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Evaluate warped geometry from the solved grid"`.

---

### Task 6: Neighbour queries

**Files:**
- Create: `src/core/warp-neighbour.ts`
- Test: `tests/unit/warp-neighbour.test.ts`

**Interfaces:**
- Consumes: `treeOf` (`src/core/clipping.ts:73`), `partMatrix`, `WarpModel`, `WarpState`.
- Produces:
```ts
export const warpNeighbourRange = 5;
export interface WarpNeighbour { part: Part; tree: MeshBVH; matrix: Matrix4; inverse: Matrix4 }
export function warpNeighbours(scene: SceneDocument, partId: string, bounds: Box3): { neighbours: WarpNeighbour[]; indexing: string[] };
/** Closest neighbour surface point within range, pushed `overlap` inside along its outward normal. */
export function snapToNeighbour(point: Vector3, neighbours: WarpNeighbour[], overlap: number): Vector3 | null;
export function closeGapTargets(model: WarpModel, state: WarpState, neighbours: WarpNeighbour[], overlap: number): { node: number; target: Vec3 }[];
export interface SeamReport { largestGap: number; vertices: Uint32Array; gaps: Float32Array }
export function measureSeam(model: WarpModel, out: WarpOutput, neighbours: WarpNeighbour[]): SeamReport | null;
```

Neighbours are other visible parts whose world bounds meet `bounds` expanded by `warpNeighbourRange`; those whose `treeOf` is null go to `indexing` by name. For a point `x` with closest neighbour point `c` and outward world normal `n` at `c`, signed gap `d = (x − c)·n`. `closeGapTargets` includes a non-fixed node when `|x − c| ≤ warpNeighbourRange`, `d > −overlap`, and the node's deformed normal faces the neighbour (`node normal · n < 0`); its target is `x − (d + overlap)·n`. `measureSeam` covers border and interior welded vertices within range; `largestGap` is the largest `d`, and the result is null when no vertex is within range.

- [ ] **Step 1: Write the failing tests**

```ts
it('targets facing nodes 0.1 mm inside a neighbour 1 mm away', ...);
// two 20 mm boxes with a 1 mm gap; every targeted node lands at d = −0.1 ± 1e-6
it('ignores nodes on the far side of the part', ...);
it('returns null seam when nothing is within range', ...);
it('skips a neighbour whose surface index is not ready and names it', ...);
// neighbour with > workerIndexTriangles triangles, Worker stubbed defined, no boundsTree
it('closes a test seam: every targeted node within 0.01 mm of its target after solve', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-neighbour.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** using `tree.closestPointToPoint` in neighbour-local space and the hit face normal transformed by the neighbour's normal matrix.
- [ ] **Step 4: Run** — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add warp neighbour snapping, gap targets and seam measurement"`.

---

### Task 7: History byte budget

**Files:**
- Create: `src/core/history-budget.ts`
- Modify: `src/core/store.ts:301-308` (`changed`), `mcp/document.ts` (`record`)
- Test: `tests/unit/history-budget.test.ts`

**Interfaces:**
- Produces:
```ts
export const historyBudgetBytes = 1024 ** 3;
/** Bytes of attribute and index arrays, each array counted once, skipping arrays in `exclude`. */
export function geometryBytes(geometries: Iterable<BufferGeometry>, exclude?: Set<ArrayLike<number>>): number;
export function trimHistory(past: SceneDocument[], future: SceneDocument[], keep: SceneDocument[], budget?: number): { past: SceneDocument[]; future: SceneDocument[]; trimmed: boolean };
```
- Store gains `historyTrimNotified: boolean` (reset by `setScene`).

Counted bytes are arrays reachable from `past`/`future` and not from `keep` (current scene and clipboard). Drop the oldest `past` entry, then the farthest `future` entry, until within budget, but always keep the newest `past` entry. `changed()` runs `trimHistory` only when it checkpoints and some part geometry in the new scene is not in the committed scene, so pure transform edits pay nothing. On the first trim, notify once: `Undo history was shortened to free memory.` In `SharedDocument`, after `record`, apply the same rule to each author's undo/redo stacks and to `versions` (oldest first, never the current version).

- [ ] **Step 1: Write the failing tests**

```ts
it('counts shared arrays once', ...);
it('does not trim below budget', ...);
it('drops oldest past entries first and keeps the newest', ...);
it('leaves history untouched for transform-only checkpoints', ...);  // store: 41 moves → past.length 40, no notify
it('trims the shared document history over budget', ...);           // SharedDocument with budget 1 MB
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/history-budget.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** and wire into `changed()` and `SharedDocument`.
- [ ] **Step 4: Run** this test plus `npx vitest run tests/unit/mcp tests/unit/regressions.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Cap undo history by mesh memory"`.

---

### Task 8: Warp session — lifecycle and region

**Files:**
- Modify: `src/core/types.ts` (add `'warp'` to `Tool`), `src/core/store.ts`
- Test: `tests/unit/warp-session.test.ts`

**Interfaces:**
- Consumes: `buildWarpModelJob`, `facesUnderBrush`, `contiguousRemainder`, `maxPaintTriangles`.
- Produces (store):
```ts
export type WarpGizmo = 'translate' | 'rotate' | 'scale' | 'transform';
export interface WarpPoint {
  id: string;
  face: number;
  barycentric: Vec3;
  binding: { node: number[]; weight: number[] };
  restWorld: Vec3;
  /** Deformed world position when the point was added; an unmoved point holds it. */
  pin: Vec3;
  target: Vec3 | null;          // null: unmoved, acts as a pin
}
export interface WarpSession {
  partId: string;
  source: BufferGeometry;
  epoch: number;
  stage: 'region' | 'building' | 'warp';
  region: 'painted' | 'whole';
  faces: number[];
  density: number;
  model: WarpModel | null;
  state: WarpState | null;
  output: WarpOutput | null;
  preview: BufferGeometry | null;
  points: WarpPoint[];
  selectedPoints: string[];
  gapTargets: { node: number; target: Vec3 }[];
  snap: boolean;
  overlap: number;
  gizmo: WarpGizmo;
  folds: Uint32Array;
  seam: SeamReport | null;
  undo: Pick<WarpSession, 'points' | 'gapTargets'>[];
}
// EditorState
warp: WarpSession | null;
startWarp(): boolean;
setWarpRegion(mode: 'painted' | 'whole'): void;
paintWarpRegion(point: SurfacePoint, face: number, erase?: boolean, begin?: boolean): boolean;
layWarpGrid(): Promise<void>;
setWarpDensity(density: number): Promise<void>;
cancelWarp(notice?: string): void;
```

Behaviour:
- `setTool('warp')` calls `startWarp`. It needs exactly one selected, visible, unlocked part under the triangle limit; otherwise notify `Select one visible, unlocked part to warp.` (or the limit message) and stay on the previous tool.
- Leaving the `'warp'` tool with a session whose points or gap targets exist calls `cancelWarp('Warp discarded. Use Apply to keep a warp.')`; with no edits it cancels silently.
- `paintWarpRegion` mirrors `paintSurface`'s brush logic on `warp.faces` and only on `warp.partId`; it shares `painting`, `brushRadius`, `brushErase`, `brushPlane` and `paintHistory` semantics.
- `layWarpGrid` uses `faces` when `region === 'painted'` and non-empty, else `null`; sets `stage: 'building'`, runs the job with an activity task titled `Preparing warp`, then `stage: 'warp'` with `createWarpState(model.restNodes)` and a preview geometry (`createWarpOutput` arrays as new `position`/`normal` attributes, `source.index` and `source.getAttribute('color')` shared).
- `setWarpDensity` and returning to `region` rebuild the model; points whose face is still in the region are rebound with `bindPoint`, others are dropped with `Some control points were outside the new region and were removed.`; `gapTargets` are cleared.
- A store subscription cancels the session with `The part changed, so the warp was cancelled.` when the part is gone, its `geometry !== warp.source`, or `sceneEpoch !== warp.epoch`.
- Preview geometry is disposed on cancel; it is never added to history.

- [ ] **Step 1: Write the failing tests**

```ts
it('refuses to start without exactly one unlocked part', ...);
it('refuses parts over the triangle limit with the limit message', ...);
it('paints only on the warped part', ...);
it('lays a grid over the whole part when nothing is painted', ...);
it('cancels when the part geometry changes under the session', ...);  // via undo of an earlier mesh edit
it('cancels when the scene is replaced', ...);
it('keeps points inside a rebuilt region and drops the rest with a notice', ...);
it('never writes to the source geometry arrays', ...);                 // snapshot source arrays, compare after edits
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-session.test.ts` — expect FAIL.
- [ ] **Step 3: Implement** the type, state and actions.
- [ ] **Step 4: Run** this test and `npx tsc --noEmit` — expect PASS and no errors (fix exhaustive `Tool` maps that the compiler flags, leaving `'warp'` out of headset tool lists).
- [ ] **Step 5: Commit** `git commit -m "Add warp session with region painting and grid"`.

---

### Task 9: Warp session — points, Close gap, Apply

**Files:**
- Modify: `src/core/store.ts`, `src/core/live.ts`, `src/xr/runtime.ts`
- Test: `tests/unit/warp-session.test.ts` (extend)

**Interfaces:**
- Consumes: Task 8 session; `solveWarp`, `evaluateWarp`, `deformPoint`, `warpNeighbours`, `snapToNeighbour`, `closeGapTargets`, `measureSeam`.
- Produces (store):
```ts
addWarpPoint(point: SurfacePoint, face: number): void;
removeWarpPoints(ids?: string[]): void;               // default: selected
selectWarpPoints(ids: string[], additive?: boolean): void;
moveWarpPoints(moves: { id: string; target: Vec3 }[], gesture: 'drag' | 'end'): void;
setWarpOptions(patch: Partial<Pick<WarpSession, 'snap' | 'overlap' | 'gizmo'>>): void;
closeWarpGap(): void;
undoWarpEdit(): void;
applyWarp(): boolean;
settleWarp(accepted: boolean): void;
warpPending: { partId: string; source: BufferGeometry; applied: BufferGeometry; session: WarpSession } | null;
```

Behaviour:
- `addWarpPoint` accepts only region faces of the warped part (`Click inside the warp region.` otherwise), computes barycentric coordinates in local space, binds with `bindPoint`, stores `restWorld`, selects the new point. Clicking a point marker selects it instead (handled in the overlay, Task 11).
- Constraints passed to `solveWarp`: every point, targeting `target` when moved and `pin` when unmoved; plus each gap target as a single-node constraint (`node: [n], weight: [1], rest: restNodes[n]`).
- `moveWarpPoints('drag')`: with `snap` on, each target passes through `snapToNeighbour` (unchanged when null); solve `warpDragIterations`; evaluate the dense mesh when `model.region.interiorCount <= 250_000`, otherwise only grid nodes and points update until `'end'`. `'end'`: solve to `warpSettleTolerance` or `warpSettleIterations`, evaluate, refresh `folds` and `seam`, push the pre-move `{ points, gapTargets }` onto `undo` (cap 100).
- `closeWarpGap`: neighbours from the region's deformed world bounds; when none, notify `No neighbouring part is within 5 mm of this region.`; when some were skipped, notify `Still preparing ${names}. Try Close gap again when it finishes.`; otherwise set `gapTargets`, settle as `'end'`.
- `undoWarpEdit` restores the last snapshot and re-settles. Scene undo (`Mod+Z`) routes here while a warp session exists and its `undo` is non-empty (Task 10 wires the key).
- `applyWarp` guards like `applyProcessedMesh` (`store.ts:1542`): part present, unlocked, `geometry === warp.source`, same `sceneEpoch`; on failure notify `The part changed, so the warp could not be applied.` It settles, builds a new `BufferGeometry` from the output (new `position`/`normal`, shared `index`/`color`), copies the source BVH when present (`MeshBVH.deserialize(MeshBVH.serialize(source.boundsTree), applied, { setIndex: false })` then `refit()`), and commits one checkpoint patching only `geometry` and `source` (`Warp · ${part.source}`). Pins, anchors, pivot, joints and constraints are untouched. Afterwards the session restarts in `region` stage on the applied geometry.
- Live sessions (`liveStatus === 'connected'`): `applyWarp` also sets `warpPending`. `live.ts` calls `settleWarp(true)` after a successful `live/edit` response and `settleWarp(false)` inside `refused()`. `settleWarp(false)` reopens the stored session when the part's geometry is back to `warpPending.source` and notifies `Your warp could not be combined with another edit. It is open again so you can apply it once more.`
- `src/xr/runtime.ts`: when a headset session starts and `tool === 'warp'`, call `cancelWarp()` then `setTool('select')`.

- [ ] **Step 1: Write the failing tests**

```ts
it('adds points only inside the region', ...);
it('moves a point to its target within 0.01 mm after end', ...);
it('snaps a dragged point 0.1 mm inside a neighbour when snap is on', ...);
it('close gap leaves every targeted node at the overlap depth', ...);
it('undoWarpEdit restores the previous points and surface', ...);
it('apply is one undo step and undo restores the original geometry', ...);
it('apply leaves pins, anchors, pivot and joints unchanged and moves no other part', ...);
it('apply on a pasted copy leaves its sibling on the original geometry', ...);
it('apply shares index and color with the source and refits its BVH', ...);
it('apply is refused after the part changes', ...);
it('settleWarp(false) reopens the session after a live refusal', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/warp-session.test.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement** the actions, the live calls and the headset cancel.
- [ ] **Step 4: Run** the file and `npx vitest run tests/unit/sync.test.ts tests/unit/pins.test.ts` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Move control points, close gaps and apply warps"`.

---

### Task 10: Transform tools on control points

**Files:**
- Modify: `src/core/transform-selection.ts`, `src/core/free-transform.ts`, `src/core/store.ts` (`beginFreeTransform`, `previewFreeTransform`, `finishFreeTransform`), `src/components/CombinedTransform.tsx`, `src/components/FreeTransform.tsx`, `src/components/TransformAdjustments.tsx`, `src/hooks/useWorkbench.ts`, `src/core/keybindings.ts`
- Test: `tests/unit/transform-selection.test.ts`, `tests/unit/free-transform.test.ts` (extend)

**Interfaces:**
- Consumes: `warp` session, `moveWarpPoints`, `undoWarpEdit`, `removeWarpPoints`, `setWarpOptions`.
- Produces:
```ts
export type TransformTarget = Pick<Part, 'id' | 'position' | 'quaternion' | 'scale'>;
// transformSelection now returns { kind: 'parts'; parts: Part[]; ... } | { kind: 'warp'; parts: TransformTarget[]; ... }
export function activeTransformTool(state: Pick<EditorState, 'tool' | 'warp'>): Tool; // warp gizmo while warping
export function warpMovesFromPatches(selection: Extract<ReturnType<typeof transformSelection>, { kind: 'warp' }>, patches: TransformPatch[]): { id: string; target: Vec3 }[];
// FreeTransformMotion.patches(targets: TransformTarget[], ...)
// keybindings: warp: { group: 'Tools', label: 'Warp', keys: ['W'] }
```

Rules:
- `kind: 'warp'` when `tool === 'warp'`, `warp.stage === 'warp'` and `selectedPoints` is non-empty. Targets are the selected points at their current deformed world positions with identity rotation and unit scale. Axes are world; pivot is the targets' centroid; `pivotLabel` is `Control point` for one and `Point center` for several; no joint, no locks.
- `warpMovesFromPatches` uses each patch's `position`; a scale-only patch on a single target yields no move. When the combined tool's scale for several targets carries no position, compute `pivot + (p − pivot) ⊙ (newScale / oldScale)` in the handle frame.
- Every consumer that applied patches with `transformMany` dispatches to `moveWarpPoints(…, settle ? 'end' : 'drag')` when `kind === 'warp'`.
- Free transform on points: `beginFreeTransform` does not call `setTool` when warping; it stores the points as a baseline; preview → `'drag'`; confirm → `'end'`; cancel restores the baseline points and re-settles.
- While warping (`stage === 'warp'`), the Move/Rotate/Scale/Transform shortcuts and the TransformAdjustments mode buttons set `warp.gizmo` instead of changing tool; `Delete`/`Backspace` with selected points calls `removeWarpPoints`; `Mod+Z` calls `undoWarpEdit` when the session's `undo` is non-empty; `W` selects the `warp` tool.
- Parts behave exactly as before when not warping.

- [ ] **Step 1: Write the failing tests**

```ts
it('selects control points as warp targets with a centroid pivot', ...);
it('returns parts selection unchanged outside the warp tool', ...);   // deep-equal to pre-change behaviour on the sample
it('maps translate and rotate patches to point moves', ...);
it('ignores a scale patch on a single point', ...);
it('free move on points confirms one session undo step and cancel restores', ...);
```

- [ ] **Step 2: Run** `npx vitest run tests/unit/transform-selection.test.ts tests/unit/free-transform.test.ts` — expect FAIL on the new cases.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** these plus `tests/unit/combined-transform.test.ts tests/unit/commands.test.ts` and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Let transform tools move warp control points"`.

---

### Task 11: Warp UI

**Files:**
- Create: `src/components/WarpControls.tsx`, `src/components/WarpOverlay.tsx`
- Modify: `src/App.tsx` (tool button after Anchors, status hints, open inspector for `'warp'`), `src/components/Inspector.tsx` (title `Warp`, render `WarpControls`), `src/components/Viewport.tsx` (part mesh draws `warp.preview` for the warped part; full detail while warping; region painting and point clicks; mount `WarpOverlay`), `src/components/Dialogs.tsx:648` (shortcut list), `src/styles.css`
- Test: `tests/e2e/warp.spec.ts`

**Interfaces:**
- Consumes: all store warp actions; `transformSelection`/`activeTransformTool` for the gizmo; `CombinedTransform` for the `transform` gizmo.

UI contract:
- Tool button: icon `Grid3x3` (lucide-react), label `Warp`, title `withShortcut('Warp a scanned surface', keys.warp)`.
- Status hints: region stage `Paint the area to warp, or choose Whole part · Alt erases · ${orbitHint} orbits`; warp stage `Click the surface to add a control point · Drag a handle to warp · Shift for fine adjustment`.
- `WarpControls` region stage: Region radio (`Painted` / `Whole part`), the existing `SurfaceBrushControls` when Painted, `Lay grid` primary button, `Cancel`. Warp stage: Density slider (0–6, labels `Coarse`…`Fine`), gizmo mode buttons (Transform/Move/Rotate/Scale as in `TransformAdjustments`), `Snap to neighbour` checkbox, `Close gap` button with overlap `NumericInput` (mm, `clipLimits`), `Gap to neighbour` readout (`${largestGap.toFixed(2)} mm`, or `Closed` when ≤ 0; hidden when `seam` is null), fold warning (`${n} folded triangles. Apply is still allowed.`) when `folds.length > 0`, `Edit region`, `Cancel`, `Apply`. Numeric X/Y/Z for the selected point(s) via `TransformAdjustments`.
- `WarpOverlay`: painted faces (as contact patches are drawn), grid edges as thin lines at deformed node positions, control points as small spheres (selected in the accent `#ed9b54`), the gizmo (`ManagedTransformControls` on a proxy at the selection pivot for translate/rotate/scale, following the anchor gizmo in `Viewport.tsx:536-560`; `CombinedTransform` for transform), seam vertices coloured from red (gap) to green (closed), folded triangles in red.
- Not shown in the headset.

- [ ] **Step 1: Write the failing e2e test** following `tests/e2e/anchors.spec.ts` fixture loading: two boxes 1 mm apart; select one; press `W`; choose `Whole part`; `Lay grid`; click its face toward the neighbour to add a point; `Close gap`; expect readout `Closed`; `Apply`; expect the part's mesh changed and `Mod+Z` restores it; reopen and confirm `Cancel` leaves the mesh unchanged.
- [ ] **Step 2: Run** `npx playwright test tests/e2e/warp.spec.ts` — expect FAIL.
- [ ] **Step 3: Implement** the components and wiring.
- [ ] **Step 4: Run** the e2e test, `npx playwright test tests/e2e/anchors.spec.ts tests/e2e/surface-paint.spec.ts tests/e2e/transforms.spec.ts`, and `npx tsc --noEmit` — expect PASS.
- [ ] **Step 5: Commit** `git commit -m "Add Warp tool panel and viewport overlays"`.

---

### Task 12: Documentation and full verification

**Files:**
- Modify: `README.md` (new section `## Close gaps with Warp` after `## Inspect contact and interference`; add `W` to the shortcuts table), `docs/design.md` (one bullet under Core behavior)

README content, in the existing voice: what Warp is for; region (painted or whole part, border fixed); grid and Density; adding, selecting, moving and deleting control points with the usual transform tools; Snap to neighbour and overlap; Close gap and the gap readout; folds warn but do not block; Apply is one undo step and links stay as they were; Cancel discards; desktop only; 10 million triangle limit; large regions update the surface when a drag ends.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Run** `npm test` — expect all unit tests PASS.
- [ ] **Step 3: Run** `npm run build` and `npm run format:check` — expect success.
- [ ] **Step 4: Run** `npx playwright test` — expect PASS (report any pre-existing failures separately, unchanged from `main`).
- [ ] **Step 5: Run** the visual regression baseline against `main` per the project's pixel-diff routine — expect no diffs outside the new tool button.
- [ ] **Step 6: Commit** `git commit -m "Document the Warp tool"`.
