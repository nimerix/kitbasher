import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4, PlaneGeometry, Quaternion, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  bindPoint,
  bindRegion,
  bindTrianglePoint,
  warpBindingNodes,
} from '../../src/core/warp-bind';
import { createWarpOutput, deformPoint, evaluateWarp } from '../../src/core/warp-evaluate';
import { buildWarpGrid } from '../../src/core/warp-grid';
import { buildWarpModel, type WarpModel } from '../../src/core/warp-model';
import { buildWarpRegion, WarpRole } from '../../src/core/warp-region';
import { createWarpState, solveWarp, warpSettleIterations } from '../../src/core/warp-solve';
import type { Vec3 } from '../../src/core/types';

const K = warpBindingNodes;

async function sphere() {
  const region = buildWarpRegion(new SphereGeometry(10, 64, 48), [...Array(1500).keys()]);
  const grid = await buildWarpGrid(region, 0);
  return { region, grid, binding: bindRegion(region, grid, region.rest) };
}

describe('bindRegion', () => {
  it('binds each node vertex to itself alone', async () => {
    const { grid, binding } = await sphere();
    for (let k = 0; k < grid.nodes.length; k++) {
      const v = grid.nodes[k];
      expect(binding.node[v * K]).toBe(k);
      expect(binding.weight[v * K]).toBe(1);
      for (let j = 1; j < K; j++) {
        expect(binding.node[v * K + j]).toBe(0xffffffff);
        expect(binding.weight[v * K + j]).toBe(0);
      }
    }
  });

  it('gives every interior vertex weights summing to 1', async () => {
    const { region, binding } = await sphere();
    let checked = 0;
    for (let v = 0; v < region.weldedCount; v++) {
      if (region.role[v] !== WarpRole.Interior) continue;
      let sum = 0;
      for (let j = 0; j < K; j++) sum += binding.weight[v * K + j];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('leaves outside vertices unbound', async () => {
    const { region, binding } = await sphere();
    for (let v = 0; v < region.weldedCount; v++)
      if (region.role[v] === WarpRole.Outside)
        for (let j = 0; j < K; j++) {
          expect(binding.node[v * K + j]).toBe(0xffffffff);
          expect(binding.weight[v * K + j]).toBe(0);
        }
  });

  it('does not bind across a thin wall', async () => {
    const lower = new PlaneGeometry(20, 20, 10, 10).rotateX(-Math.PI / 2);
    const upper = new PlaneGeometry(20, 20, 10, 10).rotateX(-Math.PI / 2).translate(0, 0.5, 0);
    const strip = new PlaneGeometry(20, 0.5, 10, 1).rotateY(Math.PI / 2).translate(10, 0.25, 0);
    const sheet = mergeVertices(mergeGeometries([lower, upper, strip]));
    const region = buildWarpRegion(sheet, null);
    const grid = await buildWarpGrid(region, 0);
    const binding = bindRegion(region, grid, region.rest);

    const lowerNodes = new Set<number>();
    const upperNodes = new Set<number>();
    for (let k = 0; k < grid.nodes.length; k++)
      (region.rest[grid.nodes[k] * 3 + 1] < 0.25 ? lowerNodes : upperNodes).add(k);
    expect(lowerNodes.size).toBeGreaterThan(0);
    expect(upperNodes.size).toBeGreaterThan(0);

    const bad: number[] = [];
    let lowerVertices = 0;
    for (let v = 0; v < region.weldedCount; v++) {
      if (region.rest[v * 3 + 1] > 1e-4 || region.rest[v * 3] > 0) continue;
      lowerVertices++;
      for (let j = 0; j < K; j++) {
        const n = binding.node[v * K + j];
        if (n !== 0xffffffff && !lowerNodes.has(n)) bad.push(v);
      }
    }
    expect(bad).toEqual([]);
    expect(lowerVertices).toBeGreaterThan(0);
  });
});

describe('bindPoint', () => {
  it('at a corner equals that vertex binding', async () => {
    const { region, binding } = await sphere();
    let t = 0;
    for (; t < region.faces.length; t++) {
      const v = region.triangles[t * 3];
      if (region.role[v] === WarpRole.Interior) break;
    }
    const v = region.triangles[t * 3];
    const point = bindPoint(region, binding, region.rest, region.faces[t], [1, 0, 0]);
    const expected = new Map<number, number>();
    for (let j = 0; j < K; j++)
      if (binding.node[v * K + j] !== 0xffffffff)
        expected.set(binding.node[v * K + j], binding.weight[v * K + j]);
    expect(point.node.length).toBe(expected.size);
    point.node.forEach((n, i) => expect(point.weight[i]).toBeCloseTo(expected.get(n)!, 6));
  });

  it('throws for a face outside the region', async () => {
    const { region, binding } = await sphere();
    expect(() => bindPoint(region, binding, region.rest, 3000, [1, 0, 0])).toThrow(
      'Face is not in the warp region.',
    );
  });
});

describe('equidistant nodes', () => {
  // A regular box puts some vertices exactly as far from all of their nearest nodes.
  async function box() {
    const region = buildWarpRegion(new BoxGeometry(20, 20, 20, 20, 20, 20), null);
    const grid = await buildWarpGrid(region, 3);
    return { region, grid, binding: bindRegion(region, grid, region.rest) };
  }

  it('gives every bound vertex finite weights summing to 1', async () => {
    const { region, binding } = await box();
    for (let v = 0; v < region.weldedCount; v++) {
      let sum = 0;
      for (let j = 0; j < K; j++) {
        expect(Number.isFinite(binding.weight[v * K + j])).toBe(true);
        sum += binding.weight[v * K + j];
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
    }
  });

  it('never binds a triangle point to non-finite weights', async () => {
    const { region, binding } = await box();
    for (let t = 0; t < region.faces.length; t++) {
      const point = bindTrianglePoint(region, binding, region.rest, t, [1 / 3, 1 / 3, 1 / 3]);
      expect(point.node.length).toBeGreaterThan(0);
      for (const w of point.weight) expect(Number.isFinite(w)).toBe(true);
    }
  });
});

describe('skinning', () => {
  /** A cap on a mirrored, non-uniformly scaled sphere, with many vertices between grid nodes. */
  async function cap() {
    const g = new SphereGeometry(10, 96, 64);
    const matrix = new Matrix4().compose(
      new Vector3(4, -3, 7),
      new Quaternion().setFromAxisAngle(new Vector3(1, 2, 0).normalize(), 0.7),
      new Vector3(1.3, -0.9, 1.1),
    );
    const model = await buildWarpModel({
      positions: new Float32Array(g.getAttribute('position').array),
      index: new Uint32Array(g.index!.array),
      normals: null,
      matrix: matrix.elements.slice(),
      faces: [...Array(3000).keys()],
      density: 1,
    });
    expect(model.grid.nodes.length * 4).toBeLessThan(model.region.interiorCount);
    return { model, matrix };
  }

  /** A settled solve with one free node pulled 2 mm, so node rotations differ. */
  function bent(model: WarpModel) {
    const node = model.grid.fixed.findIndex((fixed, n) => !fixed && n > 20);
    const rest: Vec3 = [0, 1, 2].map((a) => model.restNodes[node * 3 + a]) as Vec3;
    const state = createWarpState(model.restNodes);
    solveWarp(
      model.grid,
      model.restNodes,
      [{ node: [node], weight: [1], rest, target: [rest[0] + 2, rest[1] - 1, rest[2]] }],
      state,
      warpSettleIterations,
    );
    const out = createWarpOutput(model);
    evaluateWarp(model, state, out);
    return { state, out };
  }

  const world = (out: Float32Array, v: number, matrix: Matrix4) =>
    new Vector3().fromArray(out, v * 3).applyMatrix4(matrix);

  it('moves every vertex rigidly when every node moves rigidly', async () => {
    const { model, matrix } = await cap();
    const turn = new Quaternion().setFromAxisAngle(new Vector3(0.3, 1, -0.2).normalize(), 0.9);
    const shift = new Vector3(2, -5, 1);
    const state = createWarpState(model.restNodes);
    for (let n = 0; n < model.grid.nodes.length; n++) {
      const p = new Vector3()
        .fromArray(model.restNodes, n * 3)
        .applyQuaternion(turn)
        .add(shift);
      p.toArray(state.positions, n * 3);
      turn.toArray(state.rotations, n * 4);
    }
    const out = createWarpOutput(model);
    evaluateWarp(model, state, out);
    for (const v of model.region.interiorVertices) {
      const expected = world(model.positions, v, matrix).applyQuaternion(turn).add(shift);
      expect(world(out.positions, v, matrix).distanceTo(expected)).toBeLessThan(1e-4);
    }
  });

  it('puts a grid node’s own vertex exactly on the node', async () => {
    const { model } = await cap();
    const { state, out } = bent(model);
    const inv = model.inverse;
    let checked = 0;
    for (const v of model.region.interiorVertices) {
      const n = model.grid.nodeOf[model.region.weldOf[v]];
      if (n === 0xffffffff) continue;
      const [x, y, z] = [0, 1, 2].map((a) => state.positions[n * 3 + a]);
      for (let a = 0; a < 3; a++)
        expect(out.positions[v * 3 + a]).toBe(
          Math.fround(inv[a] * x + inv[a + 4] * y + inv[a + 8] * z + inv[a + 12]),
        );
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('binds a control point to where its face is written', async () => {
    const { model, matrix } = await cap();
    const { state, out } = bent(model);
    const { region } = model;
    let checked = 0;
    for (let t = 0; t < region.faces.length; t += 37) {
      if ([0, 1, 2].some((k) => region.role[region.triangles[t * 3 + k]] !== WarpRole.Interior))
        continue;
      const barycentric: Vec3 = [0.2, 0.5, 0.3];
      const binding = bindTrianglePoint(region, model.binding, model.restWorld, t, barycentric);
      const point = new Vector3(...deformPoint(model, state, binding, [0, 0, 0]));
      const expected = new Vector3();
      for (let k = 0; k < 3; k++) {
        const g = model.index![region.faces[t] * 3 + k];
        expected.addScaledVector(world(out.positions, g, matrix), barycentric[k]);
      }
      expect(point.distanceTo(expected)).toBeLessThan(1e-4);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });
});
