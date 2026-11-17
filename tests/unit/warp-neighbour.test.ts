import { afterEach, describe, expect, it, vi } from 'vitest';
import { Box3, Quaternion, BoxGeometry, BufferGeometry, Matrix4, Vector3 } from 'three';
import { workerIndexTriangles } from '../../src/core/spatial-index';
import { buildWarpModel } from '../../src/core/warp-model';
import { createWarpOutput, evaluateWarp } from '../../src/core/warp-evaluate';
import {
  closeGapTargets,
  measureSeam,
  warpNeighbours,
  type WarpNeighbour,
} from '../../src/core/warp-neighbour';
import {
  createWarpState,
  solveWarp,
  warpConstraintStrength,
  warpSettleIterations,
  type WarpConstraint,
} from '../../src/core/warp-solve';
import { partMatrix } from '../../src/core/geometry';
import { treeOf } from '../../src/core/clipping';
import type { Part, Quat, SceneDocument } from '../../src/core/types';

const overlap = 0.1;

function partOf(
  id: string,
  geometry: BufferGeometry,
  position: [number, number, number],
  visible = true,
): Part {
  return {
    id,
    name: id,
    geometry,
    position,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#fff',
    visible,
    locked: false,
    source: 'test',
  };
}

function modelOf(geometry: BufferGeometry, matrix: Matrix4, faces: number[] | null = null) {
  const position = geometry.getAttribute('position');
  const normal = geometry.getAttribute('normal');
  return buildWarpModel({
    positions: new Float32Array(position.array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: normal ? new Float32Array(normal.array) : null,
    matrix: matrix.elements.slice(),
    faces,
    density: 2,
  });
}

function neighbourOf(part: Part): WarpNeighbour {
  const matrix = partMatrix(part);
  return { part, tree: treeOf(part.geometry)!, matrix, inverse: matrix.clone().invert() };
}

/** Warped box at the origin facing a fixed box whose -X face is `gap` mm from its +X face. */
async function seam(gap: number) {
  const box = new BoxGeometry(20, 20, 20, 12, 12, 12);
  const warped = partOf('warped', box, [0, 0, 0]);
  const wall = partOf('wall', new BoxGeometry(20, 20, 20), [20 + gap, 0, 0]);
  const model = await modelOf(box, partMatrix(warped));
  return { model, warped, wall, neighbours: [neighbourOf(wall)] };
}

const turn = (axis: Vector3, degrees: number) =>
  new Quaternion().setFromAxisAngle(axis, (degrees * Math.PI) / 180).toArray() as Quat;

/** Cubes with the warped one mirrored and rotated, and a rotated plate neighbour. */
async function transformedSeam() {
  const box = new BoxGeometry(20, 20, 20, 12, 12, 12);
  const warped = partOf('warped', box, [0, 0, 0]);
  warped.scale = [1, 1, -1];
  warped.quaternion = turn(new Vector3(0, 1, 0), 90);
  const wall = partOf('wall', new BoxGeometry(20, 40, 10), [31, 0, 0]);
  wall.quaternion = turn(new Vector3(0, 0, 1), 90);
  const model = await modelOf(box, partMatrix(warped));
  return { model, neighbours: [neighbourOf(wall)] };
}

describe('warp neighbours', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('targets facing nodes 0.1 mm inside a neighbour 1 mm away', async () => {
    const { model, neighbours } = await seam(1);
    const state = createWarpState(model.restNodes);
    const targets = closeGapTargets(model, state, neighbours, overlap);
    expect(targets.length).toBeGreaterThan(0);
    for (const { node, target } of targets) {
      expect(model.grid.fixed[node]).toBe(0);
      expect(target[0]).toBeCloseTo(11.1, 6);
      expect(target[1]).toBeCloseTo(state.positions[node * 3 + 1], 9);
    }
  });

  it('ignores nodes on the far side of the part', async () => {
    const { model, neighbours } = await seam(1);
    const state = createWarpState(model.restNodes);
    const targets = closeGapTargets(model, state, neighbours, overlap);
    for (const { node } of targets) expect(state.positions[node * 3]).toBeGreaterThan(9);
  });

  it('skips a back-facing node that is in range and not past the surface', async () => {
    const { model } = await seam(1);
    const plate = partOf('plate', new BoxGeometry(0.2, 20, 20), [9.5, 0, 0]);
    const state = createWarpState(model.restNodes);
    expect(closeGapTargets(model, state, [neighbourOf(plate)], overlap)).toEqual([]);
  });

  it('targets the facing side of a mirrored, rotated part and a rotated neighbour', async () => {
    const { model, neighbours } = await transformedSeam();
    const state = createWarpState(model.restNodes);
    const targets = closeGapTargets(model, state, neighbours, overlap);
    expect(targets.length).toBeGreaterThan(0);
    for (const { target } of targets) expect(target[0]).toBeCloseTo(11.1, 5);
    const report = measureSeam(model, createWarpOutput(model), neighbours)!;
    expect(report.gaps.some((gap) => Math.abs(gap - 1) < 1e-5)).toBe(true);
  });

  it('returns null seam when nothing is within range', async () => {
    const { model, neighbours } = await seam(30);
    const out = createWarpOutput(model);
    expect(measureSeam(model, out, neighbours)).toBeNull();
    expect(closeGapTargets(model, createWarpState(model.restNodes), neighbours, overlap)).toEqual(
      [],
    );
  });

  it('reports the gap of the facing surface', async () => {
    const { model, neighbours } = await seam(1);
    const report = measureSeam(model, createWarpOutput(model), neighbours)!;
    expect(Math.min(...report.gaps)).toBeCloseTo(1, 5);
    expect(report.largestGap).toBe(Math.max(...report.gaps));
    expect(report.gaps.length).toBe(report.vertices.length);
  });

  it('skips a neighbour whose surface index is not ready and names it', () => {
    vi.stubGlobal('Worker', class {});
    const side = Math.ceil(Math.sqrt(workerIndexTriangles / 12)) + 1;
    const dense = partOf('dense', new BoxGeometry(10, 10, 10, side, side, side), [0, 0, 0]);
    const ready = partOf('ready', new BoxGeometry(10, 10, 10), [0, 0, 0]);
    const hidden = partOf('hidden', new BoxGeometry(10, 10, 10), [0, 0, 0], false);
    const self = partOf('self', new BoxGeometry(10, 10, 10), [0, 0, 0]);
    const scene: SceneDocument = {
      name: 'test',
      parts: [self, dense, ready, hidden],
      joints: [],
    };
    const bounds = new Box3(new Vector3(-5, -5, -5), new Vector3(5, 5, 5));
    const { neighbours, indexing } = warpNeighbours(scene, 'self', bounds);
    expect(indexing).toEqual(['dense']);
    expect(neighbours.map((n) => n.part.id)).toEqual(['ready']);
  });

  it('closes a test seam: every targeted node within 0.01 mm of its target after solve', async () => {
    const { model, neighbours } = await seam(1);
    const state = createWarpState(model.restNodes);
    const targets = closeGapTargets(model, state, neighbours, overlap);
    const constraints: WarpConstraint[] = targets.map(({ node, target }) => ({
      node: [node],
      weight: [1],
      rest: [
        model.restNodes[node * 3],
        model.restNodes[node * 3 + 1],
        model.restNodes[node * 3 + 2],
      ],
      target,
    }));
    solveWarp(model.grid, model.restNodes, constraints, state, warpSettleIterations);
    let worst = 0;
    for (let i = 0; i < targets.length; i++) {
      const { node, target } = targets[i];
      for (let a = 0; a < 3; a++)
        worst = Math.max(worst, Math.abs(state.positions[node * 3 + a] - target[a]));
    }
    expect(warpConstraintStrength).toBe(1000);
    expect(worst).toBeLessThan(0.01);
    const out = createWarpOutput(model);
    evaluateWarp(model, state, out);
    const report = measureSeam(model, out, neighbours)!;
    expect(Math.min(...report.gaps)).toBeCloseTo(-0.1, 1);
  });
});
