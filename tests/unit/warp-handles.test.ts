import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Matrix4,
  PlaneGeometry,
  SphereGeometry,
  Triangle,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { treeOf } from '../../src/core/clipping';
import { partMatrix, triangleCount } from '../../src/core/geometry';
import { readFace } from '../../src/core/surfaces';
import type { Part, Vec3 } from '../../src/core/types';
import { bindPoint } from '../../src/core/warp-bind';
import { createWarpOutput, deformPoint, evaluateWarp } from '../../src/core/warp-evaluate';
import {
  distributionNodes,
  handleConstraints,
  handleReachNodes,
  nodeSample,
  reachHandle,
  reachWeight,
  warpGuides,
  type WarpHandle,
} from '../../src/core/warp-handles';
import { buildWarpModel, type WarpModel } from '../../src/core/warp-model';
import { closeGapTargets, type WarpNeighbour } from '../../src/core/warp-neighbour';
import { WarpRole } from '../../src/core/warp-region';
import {
  createWarpState,
  solveWarp,
  warpSettleIterations,
  warpSettleTolerance,
  type WarpConstraint,
  type WarpGuides,
  type WarpState,
} from '../../src/core/warp-solve';

const identity = new Matrix4().elements.slice();

function modelOf(
  geometry: BufferGeometry,
  density: number,
  faces: number[] | null,
  matrix = identity,
) {
  return buildWarpModel({
    positions: new Float32Array(geometry.getAttribute('position').array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: new Float32Array(geometry.getAttribute('normal').array),
    matrix,
    faces,
    density,
  });
}

/** Faces of a mesh-local plane whose centre lies within `radius` of the origin. */
function disc(geometry: BufferGeometry, radius: number) {
  const triangle = new Triangle(),
    centre = new Vector3();
  const faces: number[] = [];
  for (let face = 0; face < triangleCount(geometry); face++)
    if (readFace(geometry, face, triangle).getMidpoint(centre).length() < radius) faces.push(face);
  return faces;
}

/** A dense sheet painted in a disc, with a far fixed border. */
const sheets = new Map<string, Promise<{ geometry: BufferGeometry; model: WarpModel }>>();
function sheet(density: number, segments = 200, painted = 40) {
  const key = `${density}:${segments}:${painted}`;
  if (!sheets.has(key))
    sheets.set(
      key,
      (async () => {
        const geometry = new PlaneGeometry(100, 100, segments, segments);
        return { geometry, model: await modelOf(geometry, density, disc(geometry, painted)) };
      })(),
    );
  return sheets.get(key)!;
}

/** An unmoved point handle at a mesh-local point of a plane, pinned where `state` holds it. */
function pointHandle(
  model: WarpModel,
  geometry: BufferGeometry,
  at: Vec3,
  state: WarpState,
  radius: number,
  falloff = 1,
  id = 'a',
  present: WarpHandle[] = [],
): WarpHandle {
  const point = new Vector3(...at),
    triangle = new Triangle();
  let face = -1;
  for (let f = 0; f < triangleCount(geometry) && face < 0; f++)
    if (readFace(geometry, f, triangle).containsPoint(point)) face = f;
  const barycentric = readFace(geometry, face, triangle)
    .getBarycoord(point, new Vector3())!
    .toArray() as Vec3;
  const binding = bindPoint(model.region, model.binding, model.restWorld, face, barycentric);
  const restWorld = point.clone().applyMatrix4(new Matrix4().fromArray(model.matrix)).toArray();
  const pin = deformPoint(model, state, binding, restWorld);
  const handle: WarpHandle = {
    id,
    kind: 'point',
    samples: [{ face, barycentric, binding, restWorld, pin }],
    pin,
    target: null,
    radius,
    falloff,
    auto: false,
    reach: null,
  };
  return reachHandle(model, handle, state.positions, null, warpGuides(model, present));
}

const moved = (handle: WarpHandle, by: Vec3): WarpHandle => ({
  ...handle,
  target: [handle.pin[0] + by[0], handle.pin[1] + by[1], handle.pin[2] + by[2]],
});

/** Settles as the session does, returning the iterations used. */
function settle(
  model: WarpModel,
  state: WarpState,
  constraints: WarpConstraint[],
  guides?: WarpGuides,
  iterations = warpSettleIterations,
) {
  for (let i = 0; i < iterations; i++)
    if (solveWarp(model.grid, model.restNodes, constraints, state, 1, guides) < warpSettleTolerance)
      return i + 1;
  return iterations;
}

function solveHandles(
  model: WarpModel,
  state: WarpState,
  handles: WarpHandle[],
  iterations?: number,
) {
  return settle(model, state, handleConstraints(handles), warpGuides(model, handles), iterations);
}

/** World position of every welded region vertex on the written surface, keyed by welded id. */
function written(model: WarpModel, state: WarpState) {
  const output = createWarpOutput(model);
  const folds = evaluateWarp(model, state, output);
  const world = new Float64Array(model.region.weldedCount * 3);
  const m = new Matrix4().fromArray(model.matrix),
    v = new Vector3();
  model.region.weldOf.forEach((welded, g) => {
    if (welded !== 0xffffffff)
      v.fromArray(output.positions, g * 3)
        .applyMatrix4(m)
        .toArray(world, welded * 3);
  });
  return { world, folds, output };
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const tipOf = (model: WarpModel, state: WarpState, handle: WarpHandle) =>
  deformPoint(model, state, handle.samples[0].binding, handle.samples[0].restWorld);

/** Largest node and written-surface change between two solved states. */
function change(model: WarpModel, a: WarpState, b: WarpState) {
  let nodes = 0;
  for (let i = 0; i < a.positions.length; i++)
    nodes = Math.max(nodes, Math.abs(a.positions[i] - b.positions[i]));
  const wa = written(model, a).world,
    wb = written(model, b).world;
  let surface = 0;
  for (let i = 0; i < wa.length; i++) surface = Math.max(surface, Math.abs(wa[i] - wb[i]));
  return { nodes, surface };
}

/** The written surface of a lifted flat sheet against the section 4 figures. */
function profile(model: WarpModel, state: WarpState, centre: Vec3, radius: number, h: number) {
  const { world } = written(model, state);
  const bins = 40,
    sums = new Float64Array(bins),
    counts = new Uint32Array(bins);
  let inside = 0,
    beyond = 0,
    atTenth = Infinity;
  for (const v of model.region.interior) {
    const d = Math.hypot(world[v * 3] - centre[0], world[v * 3 + 1] - centre[1]);
    const rest = Math.hypot(
      model.restWorld[v * 3] - centre[0],
      model.restWorld[v * 3 + 1] - centre[1],
    );
    const z = world[v * 3 + 2];
    if (rest <= radius) inside = Math.max(inside, Math.abs(z - h * reachWeight(rest, radius, 1)));
    else beyond = Math.max(beyond, Math.abs(z));
    if (Math.abs(rest - radius / 10) < radius / 40) atTenth = Math.min(atTenth, z);
    const bin = Math.floor((rest / (1.5 * radius)) * bins);
    if (bin < bins) {
      sums[bin] += z;
      counts[bin]++;
    }
    void d;
  }
  let rises = 0;
  for (let b = 1, last = Infinity; b < bins; b++) {
    if (!counts[b]) continue;
    const mean = sums[b] / counts[b];
    rises = Math.max(rises, mean - last);
    last = mean;
  }
  return { inside: inside / h, beyond: beyond / h, atTenth: atTenth / h, rises: rises / h };
}

describe('reach weight', () => {
  it('is 1 inside the plateau, a smoothstep to 0 at the radius, and 0 beyond', () => {
    expect(reachWeight(0, 10, 1)).toBe(1);
    expect(reachWeight(5, 10, 1)).toBeCloseTo(0.5, 12);
    expect(reachWeight(10, 10, 1)).toBe(0);
    expect(reachWeight(10.01, 10, 1)).toBe(0);
    expect(reachWeight(4, 10, 0.5)).toBe(1);
    expect(reachWeight(7.5, 10, 0.5)).toBeCloseTo(0.5, 12);
    // Falloff 0 is a hard-edged plateau with no division by a zero width.
    expect(reachWeight(10, 10, 0)).toBe(1);
    expect(reachWeight(10.0001, 10, 0)).toBe(0);
  });
});

describe('guides in the solver', () => {
  it('pull a free node to its target and leave fixed nodes at rest', async () => {
    const { model } = await sheet(2, 60);
    const free = model.grid.fixed.indexOf(0),
      fixed = model.grid.fixed.indexOf(1);
    const state = createWarpState(model.restNodes);
    const target = [free, fixed].flatMap((n) => [
      model.restNodes[n * 3],
      model.restNodes[n * 3 + 1],
      model.restNodes[n * 3 + 2] + 2,
    ]);
    settle(model, state, [], { node: [free, fixed], stiffness: [1e6, 1e6], target }, 200);
    expect(state.positions[free * 3 + 2]).toBeCloseTo(2, 3);
    expect(Array.from(state.positions.subarray(fixed * 3, fixed * 3 + 3))).toEqual(
      Array.from(model.restNodes.subarray(fixed * 3, fixed * 3 + 3)),
    );
  });

  it('reuse the system when only targets change, and match a fresh solve', async () => {
    const { geometry, model } = await sheet(3, 80);
    const rest = createWarpState(model.restNodes);
    const handle = moved(pointHandle(model, geometry, [0.3, 0.2, 0], rest, 8), [0, 0, 1]);
    const constraints = handleConstraints([handle]);
    const guides = warpGuides(model, [handle])!;
    const warm = createWarpState(model.restNodes);
    settle(model, warm, constraints, guides);
    // A different set of targets in between must not leave its system behind.
    const other = moved(handle, [0, 0, -2]);
    solveWarp(
      model.grid,
      model.restNodes,
      handleConstraints([other]),
      createWarpState(model.restNodes),
      1,
      warpGuides(model, [other]),
    );
    const again = createWarpState(model.restNodes);
    settle(model, again, constraints, { ...guides, target: Float64Array.from(guides.target) });
    expect(Array.from(again.positions)).toEqual(Array.from(warm.positions));
  });
});

describe('point handles', () => {
  it('radius 0 and a radius below the node spacing solve exactly as a bare point', async () => {
    const { geometry, model } = await sheet(1, 60);
    const rest = createWarpState(model.restNodes);
    const bare = pointHandle(model, geometry, [0.7, -0.4, 0], rest, 0);
    expect(bare.reach!.effective).toBe(false);
    expect(bare.reach!.node.length).toBe(bare.reach!.own);
    expect(warpGuides(model, [bare])).toBeUndefined();
    const small = pointHandle(model, geometry, [0.7, -0.4, 0], rest, 0.5);
    expect(small.reach!.effective).toBe(false);
    expect(handleReachNodes(model, small).node.length).toBe(small.reach!.own);
    expect(warpGuides(model, [small])).toBeUndefined();

    // The constraint a point has always made.
    const sample = bare.samples[0];
    const target: Vec3 = [0.7, -0.4, 3];
    expect(handleConstraints([{ ...bare, target }])).toEqual([
      { ...sample.binding, rest: sample.restWorld, target },
    ]);
    expect(handleConstraints([bare])[0].target).toBe(sample.pin);

    const before = createWarpState(model.restNodes),
      after = createWarpState(model.restNodes);
    settle(model, before, [{ ...sample.binding, rest: sample.restWorld, target }]);
    solveHandles(model, after, [{ ...small, target }]);
    expect(Array.from(after.positions)).toEqual(Array.from(before.positions));
    expect(Array.from(after.rotations)).toEqual(Array.from(before.rotations));
  });

  it('lifts a fine flat sheet in a smoothstep that stays inside the radius', async () => {
    const { geometry, model } = await sheet(6);
    const centre: Vec3 = [0.13, 0.07, 0];
    for (const [radius, h] of [
      [10, 1],
      [10, 4],
      [20, 3],
    ]) {
      const state = createWarpState(model.restNodes);
      const handle = moved(pointHandle(model, geometry, centre, state, radius), [0, 0, h]);
      solveHandles(model, state, [handle]);
      expect(distance(tipOf(model, state, handle), handle.target!)).toBeLessThan(0.01 * h);
      const result = profile(model, state, centre, radius, h);
      expect(result.rises).toBeLessThan(0.005);
      expect(result.atTenth).toBeGreaterThanOrEqual(0.9);
      expect(result.inside).toBeLessThan(0.1);
      expect(result.beyond).toBeLessThan(0.03);
      expect(written(model, state).folds.length).toBe(0);
    }
  });

  it('falloff 0 lifts a plateau with as sharp an edge as the grid holds', async () => {
    const { geometry, model } = await sheet(6);
    const state = createWarpState(model.restNodes);
    const handle = moved(pointHandle(model, geometry, [0, 0, 0], state, 10, 0), [0, 0, 2]);
    solveHandles(model, state, [handle], 300);
    const { world } = written(model, state);
    for (const v of model.region.interior) {
      const d = Math.hypot(model.restWorld[v * 3], model.restWorld[v * 3 + 1]);
      if (d < 7) expect(world[v * 3 + 2]).toBeGreaterThan(1.9);
      if (d > 13) expect(Math.abs(world[v * 3 + 2])).toBeLessThan(0.03 * 2);
    }
  });

  it('on a coarse 60-node grid an off-grid point reaches its target and bends a broad area', async () => {
    // A whole closed part, so no border adds nodes; a pin on the far side holds it.
    const geometry = new SphereGeometry(16, 48, 32);
    const model = await modelOf(geometry, 0, null);
    expect(model.grid.nodes.length).toBeLessThan(80);
    const state = createWarpState(model.restNodes);
    const far = nodeSample(model, nearestNode(model, [0, -16, 0]), state.positions);
    const pin: WarpHandle = {
      id: 'pin',
      kind: 'point',
      samples: [far],
      pin: far.pin,
      target: null,
      radius: 0,
      falloff: 1,
      auto: false,
      reach: null,
    };
    // Off the grid: the centre of a scan triangle near the top.
    const face = nearestFace(geometry, [3, 15.5, 2]);
    const triangle = readFace(geometry, face);
    const barycentric: Vec3 = [1 / 3, 1 / 3, 1 / 3];
    const rest = triangle.getMidpoint(new Vector3()).toArray();
    const binding = bindPoint(model.region, model.binding, model.restWorld, face, barycentric);
    expect(binding.node.length).toBeGreaterThan(2);
    const sample = {
      face,
      barycentric,
      binding,
      restWorld: rest,
      pin: deformPoint(model, state, binding, rest),
    };
    const free: WarpHandle = { ...pin, id: 'a', samples: [sample], pin: sample.pin, radius: 12 };
    const handle = moved(
      reachHandle(model, free, state.positions, null, warpGuides(model, [pin])),
      [0, 3, 0],
    );
    expect(handle.reach!.effective).toBe(true);
    solveHandles(model, state, [pin, handle], 200);
    expect(distance(tipOf(model, state, handle), handle.target!)).toBeLessThan(0.03);
    expect(distance(tipOf(model, state, pin), pin.pin)).toBeLessThan(0.01);
    const { world, folds } = written(model, state);
    expect(folds.length).toBe(0);
    // Around the point, the cap rises with it rather than in a spike.
    let lifted = 0,
      near = 0;
    for (const v of model.region.interior) {
      const at = model.restWorld.subarray(v * 3, v * 3 + 3);
      if (distance(at, rest) > 4) continue;
      near++;
      if (world[v * 3 + 1] - at[1] > 2) lifted++;
    }
    expect(lifted / near).toBeGreaterThan(0.9);
  });

  it('near the fixed border keeps the border and outside exact and still reaches its target', async () => {
    const { geometry, model } = await sheet(4, 120);
    const state = createWarpState(model.restNodes);
    const handle = moved(pointHandle(model, geometry, [36, 0.3, 0], state, 8), [0, 0, 1.5]);
    expect(Array.from(handle.reach!.node).some((n) => model.grid.fixed[n])).toBe(false);
    solveHandles(model, state, [handle]);
    expect(distance(tipOf(model, state, handle), handle.target!)).toBeLessThan(0.02);
    for (let n = 0; n < model.grid.nodes.length; n++)
      if (model.grid.fixed[n])
        expect(Array.from(state.positions.subarray(n * 3, n * 3 + 3))).toEqual(
          Array.from(model.restNodes.subarray(n * 3, n * 3 + 3)),
        );
    const { output } = written(model, state);
    const source = geometry.getAttribute('position').array;
    model.region.weldOf.forEach((v, g) => {
      if (model.region.role[v] === WarpRole.Interior) return;
      for (let a = 0; a < 3; a++) expect(output.positions[g * 3 + a]).toBe(source[g * 3 + a]);
    });
  });

  it('a handle added after a deformation, pinned where the surface is, changes nothing', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const lift = moved(pointHandle(model, geometry, [0, 0, 0], state, 12), [0, 0, 3]);
    solveHandles(model, state, [lift], 200);
    const before = { positions: state.positions.slice(), rotations: state.rotations.slice() };
    // On the slope of the bump, wider than the bump itself.
    for (const radius of [0, 4, 20]) {
      const after = { positions: before.positions.slice(), rotations: before.rotations.slice() };
      const pin = pointHandle(model, geometry, [6.2, 1.1, 0], after, radius, 1, 'b', [lift]);
      expect(pin.pin[2]).toBeGreaterThan(0.5);
      solveHandles(model, after, [lift, pin], 200);
      const { nodes, surface } = change(model, before, after);
      expect(nodes).toBeLessThan(0.001);
      expect(surface).toBeLessThan(0.001);
    }
  });

  it('two overlapping handles moved opposite ways both reach their targets without folds', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const up = moved(pointHandle(model, geometry, [-4, 0, 0], state, 9), [0, 0, 2]);
    const down = moved(pointHandle(model, geometry, [4, 0.5, 0], state, 9, 1, 'b'), [0, 0, -2]);
    const shared = Array.from(up.reach!.node).filter((n) => down.reach!.node.includes(n));
    expect(shared.length).toBeGreaterThan(10);
    solveHandles(model, state, [up, down], 200);
    expect(distance(tipOf(model, state, up), up.target!)).toBeLessThan(0.02);
    expect(distance(tipOf(model, state, down), down.target!)).toBeLessThan(0.02);
    const { world, folds } = written(model, state);
    expect(folds.length).toBe(0);
    // Between them the surface passes from one to the other.
    let high = -Infinity,
      low = Infinity;
    for (const v of model.region.interior)
      if (Math.abs(model.restWorld[v * 3 + 1]) < 1 && Math.abs(model.restWorld[v * 3]) < 1) {
        high = Math.max(high, world[v * 3 + 2]);
        low = Math.min(low, world[v * 3 + 2]);
      }
    expect(high).toBeLessThan(1.5);
    expect(low).toBeGreaterThan(-1.5);
  });

  it('an unmoved handle inside a moved handle’s reach holds its spot and its own area', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const lift = pointHandle(model, geometry, [0, 0, 0], state, 12);
    const hold = pointHandle(model, geometry, [6, 0.4, 0], state, 2, 1, 'b');
    const lifted = moved(lift, [0, 0, 3]);
    solveHandles(model, state, [lifted, hold], 200);
    expect(distance(tipOf(model, state, lifted), lifted.target!)).toBeLessThan(0.02);
    expect(distance(tipOf(model, state, hold), hold.pin)).toBeLessThan(0.01);
    const { world } = written(model, state);
    for (const v of model.region.interior) {
      const d = Math.hypot(model.restWorld[v * 3] - 6, model.restWorld[v * 3 + 1] - 0.4);
      if (d < 1) expect(Math.abs(world[v * 3 + 2])).toBeLessThan(0.25);
    }
    // Without it, that spot rises with the bump.
    const free = createWarpState(model.restNodes);
    solveHandles(model, free, [lifted], 200);
    expect(tipOf(model, free, hold)[2]).toBeGreaterThan(1);
  });
});

describe('rebuilding a reach', () => {
  it('a radius or falloff change keeps the guides of nodes still in reach', async () => {
    const { geometry, model } = await sheet(4, 120);
    const state = createWarpState(model.restNodes);
    const handle = moved(pointHandle(model, geometry, [0, 0, 0], state, 8), [0, 0, 2]);
    solveHandles(model, state, [handle]);
    const wider = reachHandle(model, { ...handle, radius: 12 }, state.positions, handle);
    const index = new Map(Array.from(wider.reach!.node, (n, i) => [n, i]));
    let kept = 0;
    handle.reach!.node.forEach((n, i) => {
      const j = index.get(n)!;
      kept++;
      expect(Array.from(wider.reach!.base.subarray(j * 3, j * 3 + 3))).toEqual(
        Array.from(handle.reach!.base.subarray(i * 3, i * 3 + 3)),
      );
    });
    expect(kept).toBe(handle.reach!.node.length);
    expect(wider.reach!.node.length).toBeGreaterThan(kept);
    solveHandles(model, state, [wider], 200);
    expect(distance(tipOf(model, state, wider), wider.target!)).toBeLessThan(0.02);
    const result = profile(model, state, [0, 0, 0], 12, 2);
    expect(result.inside).toBeLessThan(0.15);
    expect(result.beyond).toBeLessThan(0.06);
  });

  it('on a new grid, the current surface less each node’s share of the offset keeps the shape', async () => {
    const geometry = new PlaneGeometry(100, 100, 160, 160);
    const faces = disc(geometry, 40);
    const coarse = await modelOf(geometry, 4, faces),
      fine = await modelOf(geometry, 5, faces);
    const state = createWarpState(coarse.restNodes);
    const pin = pointHandle(coarse, geometry, [8, 0, 0], state, 6, 1, 'b');
    const lift = moved(pointHandle(coarse, geometry, [0, 0, 0], state, 10), [0, 0, 2]);
    solveHandles(coarse, state, [lift, pin], 200);
    const before = written(coarse, state).world;
    const surface = new Float64Array(fine.grid.nodes.length * 3);
    fine.grid.nodes.forEach((v, n) => surface.set(before.subarray(v * 3, v * 3 + 3), n * 3));

    const rebind = (handle: WarpHandle) => {
      const samples = handle.samples.map((sample) => ({
        ...sample,
        binding: bindPoint(
          fine.region,
          fine.binding,
          fine.restWorld,
          sample.face,
          sample.barycentric,
        ),
      }));
      return reachHandle(fine, { ...handle, samples, reach: null }, surface, handle);
    };
    const next = createWarpState(fine.restNodes);
    solveHandles(fine, next, [rebind(lift), rebind(pin)], 200);
    const after = written(fine, next).world;
    const errors = Array.from(fine.region.interior, (v) =>
      Math.abs(after[v * 3 + 2] - before[v * 3 + 2]),
    ).sort((a, b) => a - b);
    // The shape comes back everywhere but right beside the point, where the old grid was coarse.
    expect(errors[Math.floor(errors.length * 0.99)]).toBeLessThan(0.05 * 2);
    expect(errors.at(-1)).toBeLessThan(0.2 * 2);
  });
});

describe('close gap under a guide', () => {
  it('still pulls the seam nodes onto the neighbour under a handle’s weak outer guides', async () => {
    const box = new BoxGeometry(20, 20, 20, 12, 12, 12);
    const model = await modelOf(box, 3, null);
    const part = (id: string, geometry: BufferGeometry, position: Vec3): Part => ({
      id,
      name: id,
      geometry,
      position,
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'test',
    });
    const wall = part('wall', new BoxGeometry(20, 20, 20), [21, 0, 0]);
    const matrix = partMatrix(wall);
    const neighbours: WarpNeighbour[] = [
      { part: wall, tree: treeOf(wall.geometry)!, matrix, inverse: matrix.clone().invert() },
    ];
    const state = createWarpState(model.restNodes);
    // A pin on the far face, and a handle on the top face whose radius ends short of the seam.
    const far = nodeSample(model, nearestNode(model, [-10, 0, 0]), state.positions);
    const pin: WarpHandle = {
      id: 'pin',
      kind: 'point',
      samples: [far],
      pin: far.pin,
      target: null,
      radius: 0,
      falloff: 1,
      auto: false,
      reach: null,
    };
    const top = nodeSample(model, nearestNode(model, [2, 10, 0]), state.positions);
    const guide = reachHandle(
      model,
      { ...pin, id: 'top', samples: [top], pin: top.pin, radius: 6 },
      state.positions,
    );
    const handles = [pin, guide];
    const gapTargets = closeGapTargets(model, state, neighbours, 0.1);
    const covered = gapTargets.filter(({ node }) => guide.reach!.node.includes(node));
    expect(covered.length).toBeGreaterThan(0);
    const constraints = [
      ...handleConstraints(handles),
      ...gapTargets.map(({ node, target }) => ({
        node: [node],
        weight: [1],
        rest: Array.from(model.restNodes.subarray(node * 3, node * 3 + 3)) as Vec3,
        target,
      })),
    ];
    settle(
      model,
      state,
      constraints,
      warpGuides(
        model,
        handles,
        gapTargets.map(({ node }) => node),
      ),
      200,
    );
    for (const { node, target } of gapTargets)
      expect(distance(state.positions.subarray(node * 3, node * 3 + 3), target)).toBeLessThan(0.01);
  });
});

function nearestFace(geometry: BufferGeometry, at: Vec3) {
  const triangle = new Triangle(),
    centre = new Vector3(),
    point = new Vector3(...at);
  let best = -1,
    bestDistance = Infinity;
  for (let face = 0; face < triangleCount(geometry); face++) {
    const d = readFace(geometry, face, triangle).getMidpoint(centre).distanceTo(point);
    if (d < bestDistance) [best, bestDistance] = [face, d];
  }
  return best;
}

function nearestNode(model: WarpModel, at: Vec3) {
  let best = -1,
    bestDistance = Infinity;
  for (let n = 0; n < model.grid.nodes.length; n++) {
    if (model.grid.fixed[n]) continue;
    const d = distance(model.restNodes.subarray(n * 3, n * 3 + 3), at);
    if (d < bestDistance) [best, bestDistance] = [n, d];
  }
  return best;
}

describe('distribution', () => {
  it('spreads distinct free nodes evenly and deterministically, away from the border', async () => {
    const { model } = await sheet(3, 80);
    const nodes = distributionNodes(model, 8);
    expect(nodes).toEqual(distributionNodes(model, 8));
    expect(new Set(nodes).size).toBe(8);
    for (const n of nodes) expect(model.grid.fixed[n]).toBe(0);
    // Farthest-point sampling keeps every pair apart.
    let closest = Infinity;
    for (let i = 0; i < nodes.length; i++)
      for (let j = i + 1; j < nodes.length; j++)
        closest = Math.min(
          closest,
          distance(model.restNodes.subarray(nodes[i] * 3), model.restNodes.subarray(nodes[j] * 3)),
        );
    expect(closest).toBeGreaterThan(12);
    // The first goes to the middle, farthest from the fixed border.
    expect(
      Math.hypot(model.restNodes[nodes[0] * 3], model.restNodes[nodes[0] * 3 + 1]),
    ).toBeLessThan(5);
  });

  it('starts from the handles already present and stops at the free node count', async () => {
    const { model } = await sheet(1, 60, 48);
    const free = model.grid.fixed.reduce((sum, fixed) => sum + (fixed ? 0 : 1), 0);
    const all = distributionNodes(model, 1000);
    expect(all.length).toBe(free);
    expect(new Set(all).size).toBe(free);

    const state = createWarpState(model.restNodes);
    const first = distributionNodes(model, 1)[0];
    const sample = nodeSample(model, first, state.positions);
    expect(sample.binding.node).toEqual([first]);
    expect(sample.binding.weight).toEqual([1]);
    expect(deformPoint(model, state, sample.binding, sample.restWorld)).toEqual(sample.pin);
    const existing = [{ samples: [sample] }];
    const next = distributionNodes(model, free, existing);
    expect(next).not.toContain(first);
    expect(next.length).toBe(free - 1);
  });

  it('gives each disconnected piece a node before any piece gets a second', async () => {
    const pieces = mergeGeometries([
      new PlaneGeometry(10, 10, 10, 10).translate(-20, 0, 0),
      new PlaneGeometry(10, 10, 10, 10),
      new PlaneGeometry(10, 10, 10, 10).translate(20, 0, 0),
    ])!;
    const model = await modelOf(pieces, 2, null);
    const nodes = distributionNodes(model, 3);
    const piece = (n: number) => Math.round(model.restNodes[n * 3] / 20);
    expect(new Set(nodes.map(piece)).size).toBe(3);
  });
});
