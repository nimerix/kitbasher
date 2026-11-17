import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, Matrix4, SphereGeometry } from 'three';
import { bindPoint } from '../../src/core/warp-bind';
import { weldedPositionIndex, hasClosedEdges } from '../../src/core/mesh-topology';
import { buildWarpModelJob } from '../../src/core/warp-job';
import { buildWarpModel, type WarpModel, type WarpModelInput } from '../../src/core/warp-model';
import { createWarpOutput, deformPoint, evaluateWarp } from '../../src/core/warp-evaluate';
import { WarpRole } from '../../src/core/warp-region';
import {
  createWarpState,
  solveWarp,
  warpSettleIterations,
  type WarpConstraint,
} from '../../src/core/warp-solve';
import type { Vec3 } from '../../src/core/types';

const cap = [...Array(1500).keys()];

function inputOf(
  geometry: BufferGeometry,
  faces: number[] | null,
  matrix = new Matrix4(),
  density = 2,
): WarpModelInput {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  return {
    positions: new Float32Array(position.array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: normal ? new Float32Array(normal.array) : null,
    matrix: matrix.elements.slice(),
    faces,
    density,
  };
}

function nodeConstraint(model: WarpModel, node: number, move: Vec3): WarpConstraint {
  const rest: Vec3 = [0, 0, 0];
  for (let a = 0; a < 3; a++) rest[a] = model.restNodes[node * 3 + a];
  return {
    node: [node],
    weight: [1],
    rest,
    target: [rest[0] + move[0], rest[1] + move[1], rest[2] + move[2]],
  };
}

/** A free node nearest the region centroid. */
function centreNode(model: WarpModel) {
  const { grid, restNodes } = model;
  let c: Vec3 = [0, 0, 0],
    count = 0;
  for (let n = 0; n < grid.nodes.length; n++) {
    if (grid.fixed[n]) continue;
    for (let a = 0; a < 3; a++) c[a] += restNodes[n * 3 + a];
    count++;
  }
  c = [c[0] / count, c[1] / count, c[2] / count];
  let best = -1,
    bestD = Infinity;
  for (let n = 0; n < grid.nodes.length; n++) {
    if (grid.fixed[n]) continue;
    const d = Math.hypot(
      restNodes[n * 3] - c[0],
      restNodes[n * 3 + 1] - c[1],
      restNodes[n * 3 + 2] - c[2],
    );
    if (d < bestD) [best, bestD] = [n, d];
  }
  return best;
}

function warp(model: WarpModel, move: Vec3) {
  const state = createWarpState(model.restNodes);
  solveWarp(
    model.grid,
    model.restNodes,
    [nodeConstraint(model, centreNode(model), move)],
    state,
    warpSettleIterations,
  );
  return state;
}

const bits = (array: Float32Array) => new Uint32Array(array.buffer, array.byteOffset, array.length);

function sameBits(a: Float32Array, b: Float32Array, g: number) {
  const x = bits(a),
    y = bits(b);
  return x[g * 3] === y[g * 3] && x[g * 3 + 1] === y[g * 3 + 1] && x[g * 3 + 2] === y[g * 3 + 2];
}

describe('evaluateWarp', () => {
  it('leaves outside and border positions bit-identical', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48), cap));
    const out = createWarpOutput(model);
    evaluateWarp(model, warp(model, [0, 0, 2]), out);
    const { weldOf, role } = model.region;
    let moved = 0,
      kept = 0;
    for (let g = 0; g < weldOf.length; g++) {
      const interior = weldOf[g] !== 0xffffffff && role[weldOf[g]] === WarpRole.Interior;
      if (interior) {
        if (!sameBits(model.positions, out.positions, g)) moved++;
      } else {
        expect(sameBits(model.positions, out.positions, g)).toBe(true);
        kept++;
      }
    }
    expect(moved).toBeGreaterThan(0);
    expect(kept).toBeGreaterThan(0);
  });

  it('writes identical bits to all duplicates of a welded vertex in a non-indexed scan', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48).toNonIndexed(), cap));
    const out = createWarpOutput(model);
    evaluateWarp(model, warp(model, [0, 0, 2]), out);
    const { weldOf, role } = model.region;
    const first = new Map<number, number>();
    let changed = 0;
    for (let g = 0; g < weldOf.length; g++) {
      const w = weldOf[g];
      if (w === 0xffffffff || role[w] !== WarpRole.Interior) continue;
      const f = first.get(w);
      if (f === undefined) first.set(w, g);
    }
    for (const [w, f] of first) {
      for (let g = 0; g < weldOf.length; g++) {
        if (weldOf[g] !== w) continue;
        const a = bits(out.positions);
        expect([a[g * 3], a[g * 3 + 1], a[g * 3 + 2]]).toEqual([
          a[f * 3],
          a[f * 3 + 1],
          a[f * 3 + 2],
        ]);
      }
      if (!sameBits(model.positions, out.positions, f)) changed++;
    }
    expect(changed).toBeGreaterThan(0);
  });

  it('keeps a non-indexed closed scan closed after a warp', async () => {
    const source = new SphereGeometry(10, 64, 48).toNonIndexed();
    const model = await buildWarpModel(inputOf(source, cap));
    const out = createWarpOutput(model);
    evaluateWarp(model, warp(model, [0, 0, 2]), out);
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(out.positions, 3));
    const { indices, vertices } = weldedPositionIndex(geometry);
    expect(hasClosedEdges(indices, vertices, true)).toBe(true);
  });

  it('reports folded triangles', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48), cap));
    const calm = evaluateWarp(model, createWarpState(model.restNodes), createWarpOutput(model));
    expect(calm.length).toBe(0);
    const state = warp(model, [5, 0, 0]);
    const folds = evaluateWarp(model, state, createWarpOutput(model));
    expect(folds.length).toBeGreaterThan(0);
  });

  it('leaves a vertex with no valid node unmoved', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48), cap));
    const { weldOf, role } = model.region;
    const g = weldOf.findIndex((w) => w !== 0xffffffff && role[w] === WarpRole.Interior);
    const K = model.binding.node.length / model.region.weldedCount;
    model.binding.node.fill(0xffffffff, weldOf[g] * K, weldOf[g] * K + K);
    const out = createWarpOutput(model);
    evaluateWarp(model, warp(model, [0, 0, 2]), out);
    expect(sameBits(model.positions, out.positions, g)).toBe(true);
  });

  it('leaves a vertex whose weights sum to zero unmoved', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48), cap));
    const { weldOf, role } = model.region;
    const g = weldOf.findIndex((w) => w !== 0xffffffff && role[w] === WarpRole.Interior);
    const K = model.binding.node.length / model.region.weldedCount;
    model.binding.weight.fill(0, weldOf[g] * K, weldOf[g] * K + K);
    const out = createWarpOutput(model);
    evaluateWarp(model, warp(model, [0, 0, 2]), out);
    expect(sameBits(model.positions, out.positions, g)).toBe(true);
  });

  it('keeps hard-edge normals on indexed geometry and null normals as null', async () => {
    const box = new BoxGeometry(10, 10, 10, 4, 4, 4);
    const model = await buildWarpModel(inputOf(box, null));
    const out = createWarpOutput(model);
    evaluateWarp(model, createWarpState(model.restNodes), out);
    const { weldOf, role } = model.region;
    for (let g = 0; g < weldOf.length; g++) {
      if (role[weldOf[g]] !== WarpRole.Interior) continue;
      for (let a = 0; a < 3; a++)
        expect(out.normals![g * 3 + a]).toBeCloseTo(model.normals![g * 3 + a], 4);
    }
    const bare = inputOf(box, null);
    bare.normals = null;
    const plain = await buildWarpModel(bare);
    const plainOut = createWarpOutput(plain);
    evaluateWarp(plain, createWarpState(plain.restNodes), plainOut);
    expect(plainOut.normals).toBeNull();
  });

  it('writes world-space results through the part matrix', async () => {
    const matrix = new Matrix4()
      .makeTranslation(5, 6, 7)
      .multiply(new Matrix4().makeScale(2, 2, 2));
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 32, 24), null, matrix));
    const out = createWarpOutput(model);
    evaluateWarp(model, createWarpState(model.restNodes), out);
    for (let i = 0; i < out.positions.length; i++)
      expect(out.positions[i]).toBeCloseTo(model.positions[i], 3);
  });
});

describe('deformPoint', () => {
  it('returns the constrained target in world space', async () => {
    const model = await buildWarpModel(inputOf(new SphereGeometry(10, 64, 48), cap));
    const node = centreNode(model);
    const state = createWarpState(model.restNodes);
    const c = nodeConstraint(model, node, [0, 0, 3]);
    solveWarp(model.grid, model.restNodes, [c], state, warpSettleIterations);
    const p = deformPoint(model, state, { node: [node], weight: [1] }, c.rest);
    expect(p[2] - c.rest[2]).toBeGreaterThan(2.5);
    const { node: bn, weight } = bindPoint(model.region, model.grid, model.binding, 0, [
      1 / 3,
      1 / 3,
      1 / 3,
    ]);
    const idle = deformPoint(model, createWarpState(model.restNodes), { node: bn, weight }, c.rest);
    expect(idle[0]).toBeCloseTo(c.rest[0], 6);
  });
});

describe('buildWarpModelJob', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('falls back to in-thread when Worker is undefined', async () => {
    vi.stubGlobal('Worker', undefined);
    const model = await buildWarpModelJob(
      inputOf(new SphereGeometry(10, 32, 24), null),
      new AbortController().signal,
    );
    expect(model.grid.nodes.length).toBeGreaterThan(0);
    expect(model.indexed).toBe(true);
  });

  it('rejects with AbortError when aborted', async () => {
    vi.stubGlobal('Worker', undefined);
    const controller = new AbortController();
    const job = buildWarpModelJob(inputOf(new SphereGeometry(10, 32, 24), null), controller.signal);
    controller.abort();
    await expect(job).rejects.toMatchObject({ name: 'AbortError', message: 'Warp cancelled' });
  });
});
