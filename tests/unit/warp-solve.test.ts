import { describe, expect, it } from 'vitest';
import { BoxGeometry, Euler, Matrix3, Matrix4, Quaternion, SphereGeometry, Vector3 } from 'three';
import { partMatrix } from '../../src/core/geometry';
import type { Part, Vec3 } from '../../src/core/types';
import { bindPoint, bindRegion } from '../../src/core/warp-bind';
import { buildWarpGrid } from '../../src/core/warp-grid';
import { buildWarpRegion } from '../../src/core/warp-region';
import {
  createWarpState,
  skinMapOf,
  solveWarp,
  warpDragIterations,
  warpSettleIterations,
  warpSettleTolerance,
  type WarpConstraint,
  type WarpState,
} from '../../src/core/warp-solve';

const cap = [...Array(1500).keys()];
const offset: Vec3 = [1, 2, 3];

async function sphere(faces: number[] | null, matrix = new Matrix4()) {
  const region = buildWarpRegion(new SphereGeometry(10, 64, 48), faces);
  const restWorld = new Float32Array(region.rest.length);
  const v = new Vector3();
  for (let i = 0; i < region.weldedCount; i++)
    v.fromArray(region.rest, i * 3)
      .applyMatrix4(matrix)
      .toArray(restWorld, i * 3);
  const grid = await buildWarpGrid(region, 2);
  const binding = bindRegion(region, grid, restWorld);
  const restNodes = new Float64Array(grid.nodes.length * 3);
  grid.nodes.forEach((w, n) => restNodes.set(restWorld.subarray(w * 3, w * 3 + 3), n * 3));

  /** A point at the centre of the region triangle nearest a mesh-local direction. */
  const point = (direction: Vec3, move: Vec3 = [0, 0, 0]): WarpConstraint => {
    const d = new Vector3(...direction).normalize();
    const centre = new Vector3();
    let best = 0,
      bestDot = -Infinity;
    for (let t = 0; t < region.faces.length; t++) {
      centre.set(0, 0, 0);
      for (let k = 0; k < 3; k++)
        centre.add(v.fromArray(region.rest, region.triangles[t * 3 + k] * 3));
      const dot = centre.normalize().dot(d);
      if (dot > bestDot) [best, bestDot] = [t, dot];
    }
    const rest: Vec3 = [0, 0, 0];
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++) rest[a] += restWorld[region.triangles[best * 3 + k] * 3 + a] / 3;
    const pointBinding = bindPoint(region, binding, restWorld, region.faces[best], [
      1 / 3,
      1 / 3,
      1 / 3,
    ]);
    return {
      ...pointBinding,
      rest,
      target: [rest[0] + move[0], rest[1] + move[1], rest[2] + move[2]],
    };
  };
  const deformed = (c: WarpConstraint, state: WarpState) => deformedOn(grid, restNodes, c, state);
  return { grid, restNodes, point, deformed, state: createWarpState(restNodes) };
}

/** Where skinning puts a constrained point: each node's skin map applied to its offset. */
function deformedOn(
  grid: Awaited<ReturnType<typeof buildWarpGrid>>,
  restNodes: Float64Array,
  c: WarpConstraint,
  state: WarpState,
): Vec3 {
  const out = new Vector3(...(c.fixed ?? [0, 0, 0])),
    map = new Matrix3(),
    v = new Vector3();
  const m = new Float64Array(9);
  for (let k = 0; k < c.node.length; k++) {
    const n = c.node[k];
    const rest = c.restByNode?.[k] ?? c.rest;
    skinMapOf(grid, restNodes, state, n, m);
    map.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8]);
    v.set(
      rest[0] - restNodes[n * 3],
      rest[1] - restNodes[n * 3 + 1],
      rest[2] - restNodes[n * 3 + 2],
    )
      .applyMatrix3(map)
      .add(new Vector3().fromArray(state.positions, n * 3));
    out.addScaledVector(v, c.weight[k]);
  }
  return out.toArray();
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

function expectTranslated(restNodes: Float64Array, state: WarpState) {
  let worst = 0;
  for (let n = 0; n < restNodes.length / 3; n++)
    for (let a = 0; a < 3; a++)
      worst = Math.max(
        worst,
        Math.abs(state.positions[n * 3 + a] - restNodes[n * 3 + a] - offset[a]),
      );
  expect(worst).toBeLessThan(1e-4);
}

describe('solveWarp', () => {
  it('keeps fixed nodes exactly at rest', async () => {
    const { grid, restNodes, point, state } = await sphere(cap);
    const constraints = [point([0, 1, 0], [3, 0, 0])];
    solveWarp(grid, restNodes, constraints, state, warpSettleIterations);

    let fixed = 0,
      moved = 0;
    for (let n = 0; n < grid.nodes.length; n++) {
      const position = Array.from(state.positions.subarray(n * 3, n * 3 + 3));
      if (grid.fixed[n]) {
        fixed++;
        expect(position).toEqual(Array.from(restNodes.subarray(n * 3, n * 3 + 3)));
        expect(Array.from(state.rotations.subarray(n * 4, n * 4 + 4))).toEqual([0, 0, 0, 1]);
      } else if (distance(position, restNodes.subarray(n * 3)) > 0.5) moved++;
    }
    expect(fixed).toBeGreaterThan(0);
    expect(moved).toBeGreaterThan(0);
  });

  it('translates rigidly when every constraint moves by the same offset', async () => {
    const { grid, restNodes, point, state } = await sphere(null);
    expect(grid.fixed.includes(1)).toBe(false);
    const constraints = [
      point([1, 0, 0], offset),
      point([-0.5, 0.8, 0], offset),
      point([-0.5, -0.6, 0.7], offset),
    ];
    solveWarp(grid, restNodes, constraints, state, warpDragIterations);
    expectTranslated(restNodes, state);
  });

  it('meets a single moved point within 0.01 mm while others pin', async () => {
    const { grid, restNodes, point, deformed, state } = await sphere(null);
    const moved = point([1, 0, 0], [0, 2, 0]);
    const pins = [point([-1, 0, 0]), point([0, 0.6, -0.8]), point([0, -0.6, 0.8])];
    solveWarp(grid, restNodes, [moved, ...pins], state, warpSettleIterations);
    expect(distance(deformed(moved, state), moved.target)).toBeLessThan(0.01);
    for (const pin of pins) expect(distance(deformed(pin, state), pin.target)).toBeLessThan(0.01);
  });

  it('warm start converges below warpSettleTolerance within warpSettleIterations', async () => {
    const { grid, restNodes, point, deformed, state } = await sphere(cap);
    const handle = point([0, 1, 0]);
    const pin = point([0.5, 0.8, 0]);
    for (let frame = 1; frame <= 30; frame++) {
      const f = frame / 30;
      handle.target = [handle.rest[0], handle.rest[1] + 2 * f, handle.rest[2] + f];
      solveWarp(grid, restNodes, [handle, pin], state, warpDragIterations);
    }
    let move = Infinity;
    for (let i = 0; i < warpSettleIterations && move >= warpSettleTolerance; i++)
      move = solveWarp(grid, restNodes, [handle, pin], state, 1);
    expect(move).toBeLessThan(warpSettleTolerance);
    expect(distance(deformed(handle, state), handle.target)).toBeLessThan(0.01);
  });

  it('stays rigid in world space for a mirrored, non-uniform part', async () => {
    const part: Part = {
      id: 'part',
      name: 'Mirrored part',
      geometry: new BoxGeometry(),
      position: [20, -5, 7],
      quaternion: new Quaternion()
        .setFromEuler(new Euler(0.3, -0.4, 0.5))
        .toArray() as Part['quaternion'],
      scale: [1, 2, -1],
      color: '#aabbcc',
      visible: true,
      locked: false,
      source: 'test',
    };
    const { grid, restNodes, point, state } = await sphere(null, partMatrix(part));
    const constraints = [
      point([1, 0, 0], offset),
      point([-0.5, 0.8, 0], offset),
      point([-0.5, -0.6, 0.7], offset),
    ];
    solveWarp(grid, restNodes, constraints, state, warpDragIterations);
    expectTranslated(restNodes, state);
  });
});
