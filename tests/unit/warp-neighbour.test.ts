import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BufferAttribute,
  Quaternion,
  BoxGeometry,
  BufferGeometry,
  ExtrudeGeometry,
  Shape,
  Matrix4,
  PlaneGeometry,
  SphereGeometry,
  Vector3,
} from 'three';
import { workerIndexTriangles } from '../../src/core/spatial-index';
import { buildWarpModel } from '../../src/core/warp-model';
import { createWarpOutput, evaluateWarp } from '../../src/core/warp-evaluate';
import {
  closeGapTargets,
  measureSeam,
  snapToNeighbour,
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
    // Vertices outside the finite plate also have a lateral gap.
    expect(report.largestGap).toBeGreaterThan(1);
    expect(targets.every(({ target }) => Math.abs(target[2]) <= 5 + 1e-6)).toBe(true);
  });

  it('reports lateral gaps between finite coplanar faces and targets their real edge', async () => {
    const source = new PlaneGeometry(2, 2, 2, 2);
    const target = new PlaneGeometry(2, 2).rotateY(Math.PI);
    const neighbours = [neighbourOf(partOf('target', target, [3, 0, 0]))];
    const model = await modelOf(source, new Matrix4());
    const report = measureSeam(model, createWarpOutput(model), neighbours)!;
    expect(Math.min(...report.gaps)).toBeCloseTo(1, 6);
    expect(report.largestGap).toBeCloseTo(3, 6);
    const targets = closeGapTargets(model, createWarpState(model.restNodes), neighbours, overlap);
    expect(targets.length).toBeGreaterThan(0);
    for (const { target } of targets) {
      expect(target[0]).toBeCloseTo(2, 6);
      expect(target[2]).toBeCloseTo(overlap, 6);
    }
  });

  it('keeps a seated ball closed at the concave socket edges', async () => {
    const socket = new SphereGeometry(10, 48, 32);
    const index = socket.index!;
    for (let i = 0; i < index.count; i += 3) {
      const a = index.getX(i);
      index.setX(i, index.getX(i + 1));
      index.setX(i + 1, a);
    }
    socket.computeVertexNormals();
    const neighbours = [neighbourOf(partOf('socket', socket, [0, 0, 0]))];
    const model = await modelOf(new SphereGeometry(10.1, 40, 30), new Matrix4());
    const report = measureSeam(model, createWarpOutput(model), neighbours)!;
    expect(report.vertices.length).toBeGreaterThan(1000);
    expect(report.largestGap).toBeLessThan(0);
  });

  it('reports penetration inside a deep concave corner', async () => {
    const step = new Shape();
    step.moveTo(-20, -20);
    step.lineTo(20, -20);
    step.lineTo(20, 20);
    step.lineTo(0, 20);
    step.lineTo(0, 0);
    step.lineTo(-20, 0);
    step.closePath();
    const neighbour = neighbourOf(
      partOf(
        'step',
        new ExtrudeGeometry(step, {
          depth: 40,
          bevelEnabled: false,
        }),
        [0, 0, 0],
      ),
    );
    const rotation = new Quaternion().setFromUnitVectors(
      new Vector3(0, 0, 1),
      new Vector3(1, -1, 0).normalize(),
    );
    const matrix = new Matrix4().makeRotationFromQuaternion(rotation).setPosition(0.3, -0.3, 20);
    const model = await modelOf(new PlaneGeometry(0.1, 0.1), matrix);
    const report = measureSeam(model, createWarpOutput(model), [neighbour])!;
    expect(report.vertices).toHaveLength(4);
    expect(report.largestGap).toBeLessThan(0);
  });

  it('finds the nearest world surface of a non-uniformly scaled neighbour', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute(
      'position',
      new BufferAttribute(
        new Float32Array([0.15, -2, -2, 0.15, 2, -2, 0.15, 0, 2, -2, 1, -2, 0, 1, 2, 2, 1, -2]),
        3,
      ),
    );
    const part = partOf('scaled', geometry, [0, 0, 0]);
    part.scale = [10, 1, 1];
    const target = snapToNeighbour(new Vector3(), [neighbourOf(part)], 0)!;
    expect(target.toArray()).toEqual([0, 1, 0]);
  });

  it('uses the imported affine transform even when the quaternion is nearly unit length', () => {
    const part = partOf('target', new PlaneGeometry(1, 1), [0, 0, 0]);
    part.quaternion = [0, 0, 0.7001, 0.7001];
    part.scale = [1, 1, 2];
    const neighbour = neighbourOf(part);
    const edge = new Vector3(0.5, 0, 0).applyMatrix4(neighbour.matrix);
    const query = edge.clone().normalize().multiplyScalar(4.94).add(edge);
    expect(snapToNeighbour(query, [neighbour], 0)?.distanceTo(edge)).toBeLessThan(1e-8);
  });

  it('counts only surface within 60 degrees of facing the neighbour', async () => {
    const wall = neighbourOf(partOf('wall', new BoxGeometry(20, 40, 40), [21, 0, 0]));
    /** A plate centred at x whose normal leans from +Y toward the wall's -X face at x = 11. */
    const plate = async (lean: number, x: number) => {
      const part = partOf('plate', new PlaneGeometry(4, 4, 4, 4), [x, 0, 0]);
      const angle = (lean * Math.PI) / 180;
      const normal = new Vector3(Math.sin(angle), Math.cos(angle), 0);
      part.quaternion = new Quaternion()
        .setFromUnitVectors(new Vector3(0, 0, 1), normal)
        .toArray() as Quat;
      const model = await modelOf(part.geometry, partMatrix(part));
      const state = createWarpState(model.restNodes);
      return {
        model,
        targets: closeGapTargets(model, state, [wall], overlap),
        seam: measureSeam(model, createWarpOutput(model), [wall]),
      };
    };

    // A side wall leaning 10° toward the neighbour, all of it in range, runs alongside it.
    const side = await plate(10, 8.5);
    for (let i = 0; i < side.model.restWorld.length; i += 3) {
      expect(side.model.restWorld[i]).toBeGreaterThan(6);
      expect(side.model.restWorld[i]).toBeLessThan(11);
    }
    expect(side.targets).toEqual([]);
    expect(side.seam).toBeNull();

    // A face 30° off directly facing it, in range and short of it, is part of the seam.
    const face = await plate(60, 9);
    expect(face.targets.length).toBe(face.model.grid.nodes.length);
    expect(face.seam!.vertices.length).toBe(face.model.region.weldedCount);
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
    // The side faces that run up to the wall, up to 5 mm from it, are not counted.
    expect(report.largestGap).toBeCloseTo(1, 5);
    expect(report.largestGap).toBe(Math.max(...report.gaps));
    expect(report.gaps.length).toBe(report.vertices.length);
    for (const v of report.vertices) expect(model.restWorld[v * 3]).toBeGreaterThan(9.99);
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
