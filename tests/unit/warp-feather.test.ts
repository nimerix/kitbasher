import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Matrix3,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { treeOf } from '../../src/core/clipping';
import { partMatrix } from '../../src/core/geometry';
import { hasClosedEdges, weldedPositionIndex } from '../../src/core/mesh-topology';
import { bindPoint } from '../../src/core/warp-bind';
import {
  createWarpOutput,
  evaluateWarp,
  warpUpdateRanges,
  writtenNodePositions,
} from '../../src/core/warp-evaluate';
import {
  buildWarpModel,
  isPaintedFace,
  isPaintedNode,
  warpNodeBlend,
  type WarpModel,
} from '../../src/core/warp-model';
import { closeGapTargets, measureSeam } from '../../src/core/warp-neighbour';
import { WarpRole } from '../../src/core/warp-region';
import { createWarpState, solveWarp, warpSettleIterations } from '../../src/core/warp-solve';
import type { Part, Vec3 } from '../../src/core/types';

function inputOf(
  geometry: BufferGeometry,
  faces: number[] | null,
  feather = 0,
  matrix?: Matrix4,
  density = 3,
) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  return {
    positions: new Float32Array(position.array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: normal ? new Float32Array(normal.array) : null,
    matrix: (matrix ?? new Matrix4()).elements.slice(),
    faces,
    density,
    feather,
  };
}

const faceCount = (g: BufferGeometry) => (g.index ?? g.getAttribute('position')).count / 3;

function centroid(g: BufferGeometry, f: number): Vector3 {
  const position = g.getAttribute('position');
  const c = new Vector3();
  for (let k = 0; k < 3; k++) {
    const v = g.index ? g.index.getX(f * 3 + k) : f * 3 + k;
    c.x += position.getX(v) / 3;
    c.y += position.getY(v) / 3;
    c.z += position.getZ(v) / 3;
  }
  return c;
}

/** Faces whose centroid lies within `radius` of (x, y) on a z = 0 sheet. */
function disc(g: BufferGeometry, radius: number, x = 0, y = 0) {
  const faces: number[] = [];
  for (let f = 0; f < faceCount(g); f++) {
    const c = centroid(g, f);
    if (Math.hypot(c.x - x, c.y - y) <= radius) faces.push(f);
  }
  return faces;
}

/** Lifts control points on the painted faces nearest each (x, y) by `lift` along the sheet's normal. */
function lift(
  model: WarpModel,
  g: BufferGeometry,
  lift: number,
  at: [number, number][] = [[0, 0]],
) {
  const m = new Matrix4().fromArray(model.matrix);
  const up = new Vector3(0, 0, 1).applyNormalMatrix(new Matrix3().getNormalMatrix(m));
  up.multiplyScalar(lift * Math.sign(m.determinant()));
  const constraints = at.map(([x, y]) => {
    let face = -1,
      best = Infinity;
    for (let f = 0; f < faceCount(g); f++) {
      if (!isPaintedFace(model, f)) continue;
      const c = centroid(g, f);
      const d = Math.hypot(c.x - x, c.y - y);
      if (d < best) [face, best] = [f, d];
    }
    const barycentric: Vec3 = [1 / 3, 1 / 3, 1 / 3];
    const binding = bindPoint(model.region, model.binding, model.restWorld, face, barycentric);
    const rest = centroid(g, face).applyMatrix4(m).toArray() as Vec3;
    return { ...binding, rest, target: [rest[0] + up.x, rest[1] + up.y, rest[2] + up.z] as Vec3 };
  });
  const state = createWarpState(model.restNodes);
  solveWarp(model.grid, model.restNodes, constraints, state, warpSettleIterations);
  const out = createWarpOutput(model);
  const folds = evaluateWarp(model, state, out);
  return { state, out, folds };
}

/** A centre point and six around it 2.5 mm out, moved together. */
const cluster: [number, number][] = [
  [0, 0],
  ...[...Array(6).keys()].map((i): [number, number] => [
    2.5 * Math.cos((i * Math.PI) / 3),
    2.5 * Math.sin((i * Math.PI) / 3),
  ]),
];

/** Welded edges of a mesh with the two faces on each, and the welded corner of every face. */
function faceAdjacency(g: BufferGeometry) {
  const { indices, vertices } = weldedPositionIndex(g);
  const edges = new Map<number, number[]>();
  for (let f = 0; f < indices.length / 3; f++)
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k],
        b = indices[f * 3 + ((k + 1) % 3)];
      const key = Math.min(a, b) * vertices + Math.max(a, b);
      edges.set(key, [...(edges.get(key) ?? []), f]);
    }
  return { indices, vertices, edges };
}

function faceNormal(positions: Float32Array, g: BufferGeometry, f: number, m: Matrix4) {
  const p = [0, 1, 2].map((k) => {
    const v = g.index ? g.index.getX(f * 3 + k) : f * 3 + k;
    return new Vector3().fromArray(positions, v * 3).applyMatrix4(m);
  });
  return new Vector3()
    .subVectors(p[1], p[0])
    .cross(new Vector3().subVectors(p[2], p[0]))
    .normalize();
}

/**
 * For each face membership, the largest change in angle in degrees between two adjacent faces
 * on either side of it: one face in, the other out.
 */
function creases(
  g: BufferGeometry,
  model: WarpModel,
  positions: Float32Array,
  sides: Uint8Array[],
): number[] {
  const { edges } = faceAdjacency(g);
  const m = new Matrix4().fromArray(model.matrix);
  const largest = sides.map(() => 0);
  for (const faces of edges.values()) {
    if (faces.length !== 2) continue;
    const [f, h] = faces;
    if (!sides.some((side) => side[f] !== side[h])) continue;
    const rest = faceNormal(model.positions, g, f, m).angleTo(faceNormal(model.positions, g, h, m));
    const now = faceNormal(positions, g, f, m).angleTo(faceNormal(positions, g, h, m));
    const change = (Math.abs(now - rest) * 180) / Math.PI;
    sides.forEach((side, i) => {
      if (side[f] !== side[h] && change > largest[i]) largest[i] = change;
    });
  }
  return largest;
}

const membership = (g: BufferGeometry, faces: ArrayLike<number>) => {
  const side = new Uint8Array(faceCount(g));
  for (let i = 0; i < faces.length; i++) side[faces[i]] = 1;
  return side;
};

/** Welded vertices (by the geometry's own weld) on both a painted and an unpainted face. */
function paintedEdge(g: BufferGeometry, faces: number[]) {
  const { indices, vertices } = weldedPositionIndex(g);
  const painted = membership(g, faces);
  const on = new Uint8Array(vertices),
    off = new Uint8Array(vertices);
  for (let f = 0; f < painted.length; f++)
    for (let k = 0; k < 3; k++) (painted[f] ? on : off)[indices[f * 3 + k]] = 1;
  return on.map((x, v) => x & off[v]);
}

const bits = (array: Float32Array) => new Uint32Array(array.buffer, array.byteOffset, array.length);

/** Geometry vertices outside the region or on its border keep their position and normal bits. */
function expectOutsideKept(model: WarpModel, out: ReturnType<typeof createWarpOutput>) {
  const { weldOf, role } = model.region;
  const p0 = bits(model.positions),
    p1 = bits(out.positions);
  const n0 = model.normals ? bits(model.normals) : null,
    n1 = out.normals ? bits(out.normals) : null;
  let kept = 0;
  for (let g = 0; g < weldOf.length; g++) {
    if (weldOf[g] !== 0xffffffff && role[weldOf[g]] === WarpRole.Interior) continue;
    for (let a = g * 3; a < g * 3 + 3; a++) {
      expect(p1[a]).toBe(p0[a]);
      if (n0) expect(n1![a]).toBe(n0[a]);
    }
    kept++;
  }
  expect(kept).toBeGreaterThan(0);
}

const sheet = () => new PlaneGeometry(60, 60, 120, 120);

describe('feathered region growth', () => {
  it('builds exactly the painted region with feathering off or width 0', async () => {
    const g = sheet();
    const faces = disc(g, 10);
    const plain = await buildWarpModel(inputOf(g, faces));
    const zero = await buildWarpModel(inputOf(g, faces, 0));
    const absent = await buildWarpModel({ ...inputOf(g, faces), feather: undefined });
    for (const model of [zero, absent]) {
      expect(model.region).toEqual(plain.region);
      expect(model.grid).toEqual(plain.grid);
      expect(model.binding).toEqual(plain.binding);
      expect(model.restWorld).toEqual(plain.restWorld);
      expect(model.feather).toBeNull();
      expect(model.blend).toBeNull();
      expect(model.painted).toBeNull();
    }
  });

  it('joins unpainted faces within the width and frees the painted edge', async () => {
    const g = sheet();
    const faces = disc(g, 10);
    const model = await buildWarpModel(inputOf(g, faces, 3));
    expect(model.feather!.joined).toBeGreaterThan(0);
    expect(model.feather!.fixedEdge).toBe(0);
    const painted = new Set(faces);
    for (const f of model.region.faces) {
      const r = Math.hypot(centroid(g, f).x, centroid(g, f).y);
      expect(r).toBeLessThan(10 + 3 + 0.5);
      expect(isPaintedFace(model, f)).toBe(painted.has(f));
    }
    for (let f = 0; f < faceCount(g); f++)
      if (Math.hypot(centroid(g, f).x, centroid(g, f).y) < 12)
        expect(model.region.faces).toContain(f);
    const edge = paintedEdge(g, faces);
    const { blend, region } = model;
    for (let v = 0; v < region.weldedCount; v++) {
      if (edge[v]) expect(region.role[v]).toBe(WarpRole.Interior);
      if (region.role[v] === WarpRole.Border) expect(blend![v]).toBe(0);
    }
  });

  it('blends 1 on painted vertices, 0 on the outer border and smoothly between', async () => {
    const g = sheet();
    const faces = disc(g, 10);
    const model = await buildWarpModel(inputOf(g, faces, 4));
    const { blend, region, restWorld } = model;
    const painted = new Uint8Array(region.weldedCount);
    for (const f of faces)
      for (let k = 0; k < 3; k++) painted[region.weldOf[g.index!.getX(f * 3 + k)]] = 1;
    for (let v = 0; v < region.weldedCount; v++) {
      if (region.role[v] === WarpRole.Outside) continue;
      const b = blend![v];
      if (painted[v]) expect(b).toBe(1);
      else if (region.role[v] === WarpRole.Border) expect(b).toBe(0);
      else {
        expect(b).toBeGreaterThan(0);
        expect(b).toBeLessThan(1);
      }
    }
    // Along a ray out of the disc the blend falls monotonically.
    const ray = [...Array(region.weldedCount).keys()]
      .filter((v) => Math.abs(restWorld[v * 3 + 1]) < 1e-6 && restWorld[v * 3] > 9)
      .filter((v) => region.role[v] !== WarpRole.Outside)
      .sort((a, b) => restWorld[a * 3] - restWorld[b * 3]);
    expect(ray.length).toBeGreaterThan(6);
    for (let i = 1; i < ray.length; i++)
      expect(blend![ray[i]]).toBeLessThanOrEqual(blend![ray[i - 1]]);
  });

  it('keeps a fixed edge and says so when the mesh is too coarse for the width', async () => {
    const g = new PlaneGeometry(60, 60, 6, 6);
    const faces = disc(g, 12);
    expect(faces.length).toBeGreaterThan(0);
    const model = await buildWarpModel(inputOf(g, faces, 1));
    const plain = await buildWarpModel(inputOf(g, faces));
    expect(model.feather).toEqual({
      width: 1,
      joined: 0,
      edge: expect.any(Number),
      fixedEdge: expect.any(Number),
      anchored: 0,
    });
    expect(model.feather!.edge).toBeGreaterThan(0);
    expect(model.feather!.fixedEdge).toBeGreaterThan(0);
    expect(model.blend).toBeNull();
    expect(model.region).toEqual(plain.region);
  });
});

const digest = (a: ArrayBufferView) =>
  createHash('sha256')
    .update(new Uint8Array(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex')
    .slice(0, 16);

describe('unfeathered compatibility', () => {
  // Digests of what the code before feathering (546ba27) built and wrote for these fixtures.
  const before = {
    'sheet-unindexed':
      'region=96b8571dbd2ea695 roles=b1dc4f7868c16b9f grid=f2834a39d082f587 w=64652a942de79b72 pos=93788da80c737447 nrm=37c8f785f3306fc2',
    'sheet-indexed':
      'region=96b8571dbd2ea695 roles=b1dc4f7868c16b9f grid=f2834a39d082f587 w=64652a942de79b72 pos=5355ed9b2801e55d nrm=2cfdd28f8c7b529d',
    'sphere-unindexed':
      'region=8815ae43cbf7507a roles=a90fc269e8abbc4f grid=000512a8cde285bd w=10a5d61f75ac62aa pos=fac839ef4ae1d70e nrm=6ae738973e47a580',
  };
  const fixtures = {
    'sheet-unindexed': () => new PlaneGeometry(40, 40, 20, 20).toNonIndexed(),
    'sheet-indexed': () => new PlaneGeometry(40, 40, 20, 20),
    'sphere-unindexed': () => new SphereGeometry(10, 32, 24).toNonIndexed(),
  };

  it('writes the bytes it wrote before feathering, when absent, 0 or joining nothing', async () => {
    for (const [name, make] of Object.entries(fixtures)) {
      const g = make();
      const faces: number[] = [];
      for (let f = 0; f < faceCount(g); f++) {
        const c = centroid(g, f);
        if (name.startsWith('sphere') ? c.y > 4 : c.length() < 10) faces.push(f);
      }
      // 0.1 mm is far below the 2 mm spacing, so nothing joins.
      for (const feather of [undefined, 0, 0.1]) {
        const input = {
          ...inputOf(g, faces, feather, new Matrix4().makeTranslation(1, 2, 3)),
          feather,
        };
        const model = await buildWarpModel(input);
        expect(model.blend).toBeNull();
        if (feather) expect(model.feather).toMatchObject({ joined: 0, edge: expect.any(Number) });
        const face = faces[Math.floor(faces.length / 2)];
        const binding = bindPoint(model.region, model.binding, model.restWorld, face, [
          1 / 3,
          1 / 3,
          1 / 3,
        ]);
        const triangle = model.region.faces.indexOf(face);
        const rest: Vec3 = [0, 0, 0];
        for (let k = 0; k < 3; k++)
          for (let a = 0; a < 3; a++)
            rest[a] += model.restWorld[model.region.triangles[triangle * 3 + k] * 3 + a] / 3;
        const state = createWarpState(model.restNodes);
        const target: Vec3 = [rest[0] + 0.3, rest[1] - 0.2, rest[2] + 1];
        solveWarp(
          model.grid,
          model.restNodes,
          [{ ...binding, rest, target }],
          state,
          warpSettleIterations,
        );
        const out = createWarpOutput(model);
        evaluateWarp(model, state, out);
        expect(
          [
            `region=${digest(model.region.faces)}`,
            `roles=${digest(model.region.role)}`,
            `grid=${digest(model.grid.nodes)}`,
            `w=${digest(model.binding.weight)}`,
            `pos=${digest(out.positions)}`,
            `nrm=${digest(out.normals!)}`,
          ].join(' '),
        ).toBe(before[name as keyof typeof before]);
      }
    }
  });
});

/** The fewest edges from the painted edge to the outer border across the band. */
function bandRings(model: WarpModel) {
  const { region, blend } = model;
  const hops = new Int32Array(region.weldedCount).fill(-1);
  let frontier: number[] = [];
  for (let v = 0; v < region.weldedCount; v++)
    if (blend![v] === 1 && region.role[v] === WarpRole.Interior) {
      hops[v] = 0;
      frontier.push(v);
    }
  for (let ring = 1; frontier.length; ring++) {
    const next: number[] = [];
    for (const u of frontier)
      for (let e = region.adjacencyStart[u]; e < region.adjacencyStart[u + 1]; e++) {
        const w = region.adjacency[e];
        if (hops[w] >= 0) continue;
        if (region.role[w] === WarpRole.Border) return ring;
        hops[w] = ring;
        next.push(w);
      }
    frontier = next;
  }
  return Infinity;
}

/** A sheet with every interior vertex moved in its plane by up to a fifth of the spacing. */
function irregularSheet() {
  const g = new PlaneGeometry(60, 60, 120, 120);
  const position = g.getAttribute('position');
  let seed = 7;
  const random = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648 - 0.5;
  for (let v = 0; v < position.count; v++) {
    const x = position.getX(v),
      y = position.getY(v);
    if (Math.abs(x) >= 30 || Math.abs(y) >= 30) continue;
    position.setXY(v, x + 0.2 * random(), y + 0.2 * random());
  }
  return g;
}

/** The written surface with feathering off and on for the same drag, and their creases. */
async function compareCreases(g: BufferGeometry, faces: number[], width: number, matrix?: Matrix4) {
  const painted = membership(g, faces);
  const off = await buildWarpModel(inputOf(g, faces, 0, matrix, 6));
  const on = await buildWarpModel(inputOf(g, faces, width, matrix, 6));
  // Every region vertex is a node, so the measurement sees the written surface, not skinning.
  expect(on.grid.nodes.length).toBe(on.region.weldedCount - countOutside(on));
  const hard = lift(off, g, 1, cluster);
  const soft = lift(on, g, 1, cluster);
  const [offEdge] = creases(g, off, hard.out.positions, [painted]);
  const [onEdge, onOuter] = creases(g, on, soft.out.positions, [
    painted,
    membership(g, on.region.faces),
  ]);
  return { off, on, hard, soft, offEdge, onEdge, onOuter, rings: bandRings(on) };
}

const countOutside = (model: WarpModel) =>
  model.region.role.reduce((n, r) => n + (r === WarpRole.Outside ? 1 : 0), 0);

describe('feathered surface', () => {
  it('leaves no crease at the painted edge or the outer border of a band over six rings wide', async () => {
    const g = sheet();
    const { on, soft, offEdge, onEdge, onOuter, rings } = await compareCreases(g, disc(g, 10), 7);
    expect(rings).toBeGreaterThan(6);
    expect(offEdge).toBeGreaterThan(1);
    expect(onEdge).toBeLessThan(offEdge / 5);
    expect(onOuter).toBeLessThan(offEdge / 5);
    expectOutsideKept(on, soft.out);
  });

  it('does the same on an irregular mesh', async () => {
    const g = irregularSheet();
    const { on, soft, offEdge, onEdge, onOuter, rings } = await compareCreases(g, disc(g, 10), 7);
    expect(rings).toBeGreaterThan(6);
    expect(onEdge).toBeLessThan(offEdge / 5);
    expect(onOuter).toBeLessThan(offEdge / 5);
    expectOutsideKept(on, soft.out);
  });

  it('does the same on a mirrored, non-uniformly scaled part, measured in world space', async () => {
    const g = sheet();
    const matrix = new Matrix4().compose(
      new Vector3(3, -2, 5),
      new Quaternion().setFromAxisAngle(new Vector3(1, 1, 0).normalize(), 0.4),
      new Vector3(1.4, -0.8, 1),
    );
    const { on, soft, offEdge, onEdge, onOuter, rings } = await compareCreases(
      g,
      disc(g, 9),
      7,
      matrix,
    );
    expect(rings).toBeGreaterThan(6);
    expect(onEdge).toBeLessThan(offEdge / 5);
    expect(onOuter).toBeLessThan(offEdge / 5);
    expectOutsideKept(on, soft.out);
  });

  it('works with a one-ring band and keeps everything beyond it', async () => {
    const g = sheet();
    const faces = disc(g, 10);
    const model = await buildWarpModel(inputOf(g, faces, 0.5));
    expect(model.feather!.joined).toBeGreaterThan(0);
    expect(bandRings(model)).toBe(1);
    const { out, folds } = lift(model, g, 1);
    expect(folds.length).toBe(0);
    for (const value of out.positions) expect(Number.isFinite(value)).toBe(true);
    expectOutsideKept(model, out);
    // The painted edge is free now: some of it moves.
    const edge = paintedEdge(g, faces);
    let moved = 0;
    for (let v = 0; v < g.getAttribute('position').count; v++)
      if (edge[model.region.weldOf[v]] && out.positions[v * 3 + 2] !== 0) moved++;
    expect(moved).toBeGreaterThan(0);
  });
});

describe('feathered written surface', () => {
  const sphere = () => new SphereGeometry(10, 96, 64);
  const cap = (g: BufferGeometry) => {
    const faces: number[] = [];
    for (let f = 0; f < faceCount(g); f++) if (centroid(g, f).y > 6) faces.push(f);
    return faces;
  };

  it('writes identical bits to welded duplicates and keeps a closed unindexed mesh closed', async () => {
    const g = sphere().toNonIndexed();
    const model = await buildWarpModel(inputOf(g, cap(g), 2));
    expect(model.feather!.joined).toBeGreaterThan(0);
    const state = createWarpState(model.restNodes);
    for (let n = 0; n < model.grid.nodes.length; n++)
      if (!model.grid.fixed[n]) state.positions[n * 3 + 1] += 1.5;
    const out = createWarpOutput(model);
    evaluateWarp(model, state, out);
    const { weldOf, role } = model.region;
    const first = new Map<number, number>();
    const p = bits(out.positions);
    for (let v = 0; v < weldOf.length; v++) {
      if (role[weldOf[v]] !== WarpRole.Interior) continue;
      const f = first.get(weldOf[v]);
      if (f === undefined) first.set(weldOf[v], v);
      else for (let a = 0; a < 3; a++) expect(p[v * 3 + a]).toBe(p[f * 3 + a]);
    }
    expectOutsideKept(model, out);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(out.positions, 3));
    const { indices, vertices } = weldedPositionIndex(geometry);
    expect(hasClosedEdges(indices, vertices, true)).toBe(true);
  });

  it('keeps outer border normal bits on indexed and unindexed meshes', async () => {
    for (const g of [sphere(), sphere().toNonIndexed()]) {
      const model = await buildWarpModel(inputOf(g, cap(g), 2));
      const state = createWarpState(model.restNodes);
      for (let n = 0; n < model.grid.nodes.length; n++)
        if (!model.grid.fixed[n]) state.positions[n * 3 + 1] += 1;
      const out = createWarpOutput(model);
      evaluateWarp(model, state, out);
      expectOutsideKept(model, out);
      let changed = 0;
      for (let i = 0; i < out.normals!.length; i++)
        if (out.normals![i] !== model.normals![i]) changed++;
      expect(changed).toBeGreaterThan(0);
    }
  });

  it('bounds, folds and upload ranges follow the blended surface', async () => {
    for (const g of [sphere(), sphere().toNonIndexed()]) {
      const model = await buildWarpModel(inputOf(g, cap(g), 2));
      const state = createWarpState(model.restNodes);
      for (let n = 0; n < model.grid.nodes.length; n++)
        if (!model.grid.fixed[n]) state.positions[n * 3] += 3;
      const out = createWarpOutput(model);
      const folds = evaluateWarp(model, state, out);
      const min = [Infinity, Infinity, Infinity],
        max = [-Infinity, -Infinity, -Infinity];
      for (const v of model.region.interiorVertices)
        for (let a = 0; a < 3; a++) {
          min[a] = Math.min(min[a], out.positions[v * 3 + a]);
          max[a] = Math.max(max[a], out.positions[v * 3 + a]);
        }
      expect([...out.moved]).toEqual([...min, ...max]);
      // Folds are measured on the written surface.
      const { triangles } = model.region;
      const m = new Matrix4().fromArray(model.matrix);
      const expected: number[] = [];
      for (let t = 0; t < triangles.length / 3; t++) {
        const face = model.region.faces[t];
        const before = faceNormal(model.positions, g, face, m),
          after = faceNormal(out.positions, g, face, m);
        if (before.dot(after) < 0) expected.push(t);
      }
      expect([...folds]).toEqual(expected);
      const ranges = warpUpdateRanges(model);
      for (const [name, changed, original] of [
        ['positions', out.positions, model.positions],
        ['normals', out.normals!, model.normals!],
      ] as const) {
        const covered = new Uint8Array(changed.length);
        const list = ranges[name];
        for (let i = 0; i < list.length; i += 2) covered.fill(1, list[i], list[i] + list[i + 1]);
        for (let i = 0; i < changed.length; i++)
          if (changed[i] !== original[i]) expect(covered[i]).toBe(1);
      }
    }
  });

  it('reports painted faces and nodes, node blends and written node positions', async () => {
    const g = sheet();
    const faces = disc(g, 10);
    const model = await buildWarpModel(inputOf(g, faces, 3));
    const painted = new Set(faces);
    for (const f of model.region.faces) expect(isPaintedFace(model, f)).toBe(painted.has(f));
    expect(isPaintedFace(model, 0)).toBe(false);
    const blend = warpNodeBlend(model)!;
    let band = 0;
    for (let n = 0; n < model.grid.nodes.length; n++) {
      expect(blend[n]).toBe(model.blend![model.grid.nodes[n]]);
      expect(isPaintedNode(model, n)).toBe(blend[n] === 1);
      if (blend[n] < 1 && !model.grid.fixed[n]) band++;
    }
    expect(band).toBeGreaterThan(0);
    const { state, out } = lift(model, g, 2);
    const written = writtenNodePositions(model, state);
    const point = new Vector3();
    const m = new Matrix4().fromArray(model.matrix);
    for (let n = 0; n < model.grid.nodes.length; n++) {
      const v = model.region.weldOf.indexOf(model.grid.nodes[n]);
      point.fromArray(out.positions, v * 3).applyMatrix4(m);
      for (let a = 0; a < 3; a++) expect(written[n * 3 + a]).toBeCloseTo(point.getComponent(a), 4);
    }
  });

  it('reports every face and node as painted, and solved node positions, without a feather', async () => {
    const g = sheet();
    const model = await buildWarpModel(inputOf(g, disc(g, 10)));
    expect(warpNodeBlend(model)).toBeNull();
    for (let n = 0; n < model.grid.nodes.length; n++) expect(isPaintedNode(model, n)).toBe(true);
    for (const f of model.region.faces) expect(isPaintedFace(model, f)).toBe(true);
    const { state } = lift(model, g, 2);
    expect([...writtenNodePositions(model, state)]).toEqual([
      ...Float32Array.from(state.positions),
    ]);
  });
});

/** Area-weighted world normal of the written surface at geometry vertex `v`'s welded vertex. */
function faceNormalAround(model: WarpModel, positions: Float32Array, v: number) {
  const { region } = model;
  const w = region.weldOf[v];
  const first = region.weldOf.indexOf.bind(region.weldOf);
  const sum = new Vector3();
  const m = new Matrix4().fromArray(model.matrix);
  for (let t = 0; t < region.triangles.length; t += 3) {
    if (![0, 1, 2].some((k) => region.triangles[t + k] === w)) continue;
    const p = [0, 1, 2].map((k) =>
      new Vector3().fromArray(positions, first(region.triangles[t + k]) * 3).applyMatrix4(m),
    );
    sum.add(new Vector3().subVectors(p[1], p[0]).cross(new Vector3().subVectors(p[2], p[0])));
  }
  return sum.normalize();
}

describe('feathered readouts', () => {
  /** A cube with a disc painted on its +X face, facing a wall 1 mm away. */
  async function seam() {
    const box = new BoxGeometry(20, 20, 20, 32, 32, 32);
    const faces: number[] = [];
    for (let f = 0; f < faceCount(box); f++) {
      const c = centroid(box, f);
      if (c.x > 9.99 && Math.hypot(c.y, c.z) < 5) faces.push(f);
    }
    const model = await buildWarpModel(inputOf(box, faces, 3));
    const geometry = new BoxGeometry(20, 20, 20);
    const wall: Part = {
      id: 'wall',
      name: 'wall',
      geometry,
      position: [21, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'test',
    };
    const matrix = partMatrix(wall);
    const neighbour = {
      part: wall,
      tree: treeOf(geometry)!,
      matrix,
      inverse: matrix.clone().invert(),
    };
    return { model, neighbours: [neighbour] };
  }

  it('measures the seam on painted vertices only', async () => {
    const { model, neighbours } = await seam();
    let facingBand = 0;
    for (let v = 0; v < model.region.weldedCount; v++)
      if (model.restWorld[v * 3] > 9.99 && model.blend![v] > 0 && model.blend![v] < 1) facingBand++;
    expect(facingBand).toBeGreaterThan(0);
    const report = measureSeam(model, createWarpOutput(model), neighbours)!;
    expect(report.vertices.length).toBeGreaterThan(0);
    for (const v of report.vertices) expect(model.blend![v]).toBe(1);
    expect(report.largestGap).toBeCloseTo(1, 5);
  });

  it('decides which painted nodes face the neighbour as the seam readout does, after a drag', async () => {
    // A sphere cap facing a wall at x = 4.5, its nodes turned up to 75° from it, all in range.
    const g = new SphereGeometry(4, 64, 48);
    const faces: number[] = [];
    for (let f = 0; f < faceCount(g); f++) if (centroid(g, f).x > 1) faces.push(f);
    const model = await buildWarpModel(inputOf(g, faces, 0.8));
    const geometry = new BoxGeometry(20, 40, 40);
    const wall: Part = {
      id: 'wall',
      name: 'wall',
      geometry,
      position: [14.5, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'test',
    };
    const matrix = partMatrix(wall);
    const neighbours = [
      { part: wall, tree: treeOf(geometry)!, matrix, inverse: matrix.clone().invert() },
    ];
    const { state, out } = pull(model, g, new Vector3(3, 2, 0), new Vector3(0.3, 1.2, 0));
    const seam = new Set(measureSeam(model, out, neighbours)!.vertices);
    const targeted = new Set(closeGapTargets(model, state, neighbours, 0.05).map((t) => t.node));
    let near = 0,
      compared = 0;
    const written = writtenNodePositions(model, state);
    for (let n = 0; n < model.grid.nodes.length; n++) {
      if (model.grid.fixed[n] || !isPaintedNode(model, n)) continue;
      // Well within range, so a rounding difference in position cannot cross it.
      if (4.5 - written[n * 3] > 4) continue;
      compared++;
      expect(targeted.has(n)).toBe(seam.has(model.grid.nodes[n]));
      const v = model.region.weldOf.indexOf(model.grid.nodes[n]);
      const normal = faceNormalAround(model, out.positions, v);
      if (Math.abs(normal.x - 0.5) < 0.05) near++;
    }
    expect(compared).toBeGreaterThan(20);
    expect(near).toBeGreaterThan(0);
  });

  it('closes the gap at painted nodes only', async () => {
    const { model, neighbours } = await seam();
    let facingBand = 0;
    for (let n = 0; n < model.grid.nodes.length; n++)
      if (!model.grid.fixed[n] && !isPaintedNode(model, n) && model.restNodes[n * 3] > 9.99)
        facingBand++;
    expect(facingBand).toBeGreaterThan(0);
    const targets = closeGapTargets(model, createWarpState(model.restNodes), neighbours, 0.1);
    expect(targets.length).toBeGreaterThan(0);
    for (const { node } of targets) expect(isPaintedNode(model, node)).toBe(true);
  });
});

/** Moves a control point on the painted face nearest `at` by `by`, settled. */
function pull(model: WarpModel, g: BufferGeometry, at: Vector3, by: Vector3) {
  const m = new Matrix4().fromArray(model.matrix);
  let face = -1,
    best = Infinity;
  for (let f = 0; f < faceCount(g); f++) {
    if (!isPaintedFace(model, f)) continue;
    const d = centroid(g, f).distanceTo(at);
    if (d < best) [face, best] = [f, d];
  }
  const binding = bindPoint(model.region, model.binding, model.restWorld, face, [
    1 / 3,
    1 / 3,
    1 / 3,
  ]);
  const rest = centroid(g, face).applyMatrix4(m).toArray() as Vec3;
  const target: Vec3 = [rest[0] + by.x, rest[1] + by.y, rest[2] + by.z];
  const state = createWarpState(model.restNodes);
  solveWarp(
    model.grid,
    model.restNodes,
    [{ ...binding, rest, target }],
    state,
    warpSettleIterations,
  );
  const out = createWarpOutput(model);
  evaluateWarp(model, state, out);
  return { state, out };
}

/** Largest distance any geometry vertex matching `select` moved. */
function largestMove(
  g: BufferGeometry,
  before: Float32Array,
  after: Float32Array,
  select: (p: Vector3) => boolean,
) {
  const p = new Vector3();
  let largest = 0;
  for (let v = 0; v < before.length / 3; v++) {
    if (!select(p.fromArray(before, v * 3))) continue;
    largest = Math.max(largest, p.distanceTo(new Vector3().fromArray(after, v * 3)));
  }
  void g;
  return largest;
}

describe('feathered band limits', () => {
  it('keeps the farthest ring fixed when the band would cover the rest of a closed part', async () => {
    const g = new SphereGeometry(10, 64, 48);
    // All but the top four rows: 448 faces stay unpainted, about 2.6 mm across the cap.
    const faces: number[] = [];
    for (let f = 0; f < faceCount(g); f++) if (centroid(g, f).y < 9.6) faces.push(f);
    expect(faceCount(g) - faces.length).toBe(448);
    const model = await buildWarpModel(inputOf(g, faces, 4));
    expect(model.feather!.anchored).toBe(1);
    expect(model.grid.fixed.reduce((n, x) => n + x, 0)).toBeGreaterThan(0);
    const drag = [new Vector3(10, 0, 0), new Vector3(1, 0, 0)] as const;
    const { out } = pull(model, g, ...drag);
    // The pole is in the anchor and keeps its bits. The far side swings about the fixed cap
    // about as much as it does with the painted edge fixed, rather than translating with the drag.
    expect(largestMove(g, model.positions, out.positions, (p) => p.y > 9.9)).toBe(0);
    const plain = await buildWarpModel(inputOf(g, faces));
    const fixedEdge = pull(plain, g, ...drag).out;
    const far = (p: Vector3) => p.x < -9;
    expect(largestMove(g, model.positions, out.positions, far)).toBeLessThan(
      1.25 * largestMove(g, plain.positions, fixedEdge.positions, far),
    );
    expectOutsideKept(model, out);
  });

  it('keeps an unpainted rim inside the band fixed and feathers toward it', async () => {
    const g = sheet();
    // The band reaches the sheet's open edge at x = 30.
    const faces = disc(g, 4, 25, 0);
    const model = await buildWarpModel(inputOf(g, faces, 3));
    expect(model.feather!.joined).toBeGreaterThan(0);
    const { region, blend } = model;
    let rim = 0;
    for (let v = 0; v < region.weldedCount; v++)
      if (region.role[v] !== WarpRole.Outside && model.restWorld[v * 3] > 29.99 && !blend![v]) {
        expect(region.role[v]).toBe(WarpRole.Border);
        rim++;
      }
    expect(rim).toBeGreaterThan(0);
    const { out } = lift(model, g, 1, [[26, 0]]);
    expect(largestMove(g, model.positions, out.positions, (p) => p.x > 29.99)).toBe(0);
    expectOutsideKept(model, out);
  });

  it('keeps a hole rim inside the band fixed', async () => {
    const plane = sheet();
    const kept: number[] = [];
    for (let f = 0; f < faceCount(plane); f++)
      if (centroid(plane, f).distanceTo(new Vector3(6, 0, 0)) > 2) kept.push(f);
    const index = plane.index!;
    const g = new BufferGeometry();
    g.setAttribute('position', plane.getAttribute('position'));
    g.setAttribute('normal', plane.getAttribute('normal'));
    g.setIndex(kept.flatMap((f) => [0, 1, 2].map((k) => index.getX(f * 3 + k))));
    const faces = disc(g, 3);
    const model = await buildWarpModel(inputOf(g, faces, 3));
    expect(model.feather!.joined).toBeGreaterThan(0);
    // Rim vertices: on a kept face and on a removed one.
    const removed = new Set<number>();
    for (let f = 0; f < faceCount(plane); f++)
      if (!kept.includes(f)) for (let k = 0; k < 3; k++) removed.add(index.getX(f * 3 + k));
    const rim = new Set([...g.index!.array].filter((v) => removed.has(v)));
    const inBand = [...rim].filter((v) => model.region.role[model.region.weldOf[v]] !== 0);
    expect(inBand.length).toBeGreaterThan(0);
    for (const v of inBand) expect(model.region.role[model.region.weldOf[v]]).toBe(WarpRole.Border);
    const { out } = lift(model, g, 1, [[1, 0]]);
    for (const v of rim)
      for (let a = 0; a < 3; a++) expect(out.positions[v * 3 + a]).toBe(model.positions[v * 3 + a]);
    expectOutsideKept(model, out);
  });

  it('does not grow onto another surface through one shared vertex', async () => {
    const a = new PlaneGeometry(10, 10, 20, 20).toNonIndexed();
    const b = new PlaneGeometry(10, 10, 20, 20).toNonIndexed().translate(10, 10, 0);
    const g = mergeGeometries([a, b])!;
    // Paint the corner of the first sheet that touches the second.
    const faces: number[] = [];
    for (let f = 0; f < faceCount(g); f++) {
      const c = centroid(g, f);
      if (c.x < 5 && c.y < 5 && Math.hypot(c.x - 5, c.y - 5) < 3) faces.push(f);
    }
    const model = await buildWarpModel(inputOf(g, faces, 2));
    expect(model.feather!.joined).toBeGreaterThan(0);
    for (const f of model.region.faces) {
      const c = centroid(g, f);
      expect(c.x < 5 && c.y < 5).toBe(true);
    }
    // The contact vertex is fixed, since the second sheet's fan there stays outside.
    const contact = [...Array(model.region.weldedCount).keys()].find(
      (v) => Math.hypot(model.restWorld[v * 3] - 5, model.restWorld[v * 3 + 1] - 5) < 1e-6,
    )!;
    expect(model.region.role[contact]).toBe(WarpRole.Border);
    const { out } = lift(model, g, 1, [[3.5, 3.5]]);
    expect(largestMove(g, model.positions, out.positions, (p) => p.x >= 5 && p.y >= 5)).toBe(0);
    expectOutsideKept(model, out);
  });

  it('reports no edge to feather when the paint borders nothing', async () => {
    const g = new SphereGeometry(10, 32, 24);
    const model = await buildWarpModel(inputOf(g, [...Array(faceCount(g)).keys()], 2));
    expect(model.feather).toMatchObject({ joined: 0, edge: 0, anchored: 0 });
  });

  it('gives finite blends far from the origin', async () => {
    const g = sheet();
    const matrix = new Matrix4().makeTranslation(1e17, -1e17, 1e17);
    const model = await buildWarpModel(inputOf(g, disc(g, 10), 3, matrix));
    expect(model.feather!.joined).toBeGreaterThan(0);
    for (const b of model.blend!) expect(Number.isFinite(b)).toBe(true);
    const near = await buildWarpModel(inputOf(g, disc(g, 10), 3));
    expect([...model.blend!]).toEqual([...near.blend!]);
  });
});
