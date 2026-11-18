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
  handleGuides,
  nodeSample,
  reachActivation,
  reachHandle,
  reachWeight,
  snapshotOf,
  transferSnapshot,
  bandWidth,
  warpGuides,
  warpPathStretch,
  warpTailSpacings,
  type WarpHandle,
  type WarpSnapshot,
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

/** The face of a mesh containing a mesh-local point. */
function faceContaining(geometry: BufferGeometry, at: Vec3) {
  const point = new Vector3(...at),
    triangle = new Triangle();
  for (let f = 0; f < triangleCount(geometry); f++)
    if (readFace(geometry, f, triangle).containsPoint(point)) return f;
  return nearestFace(geometry, at);
}

/**
 * An unmoved point handle at a mesh-local point, pinned where `state` holds it. Its guides start
 * from `baseline`, by default the state as it is.
 */
function pointHandle(
  model: WarpModel,
  geometry: BufferGeometry,
  at: Vec3,
  state: WarpState,
  radius: number,
  falloff = 1,
  id = 'a',
  baseline: WarpSnapshot = snapshotOf(model.grid, state),
): WarpHandle {
  const face = faceContaining(geometry, at);
  const triangle = readFace(geometry, face);
  const point = triangle.closestPointToPoint(new Vector3(...at), new Vector3());
  const barycentric = triangle.getBarycoord(point, new Vector3())!.toArray() as Vec3;
  const binding = bindPoint(model.region, model.binding, model.restWorld, face, barycentric);
  const restWorld = point.clone().applyMatrix4(new Matrix4().fromArray(model.matrix)).toArray();
  const pin = deformPoint(model, state, binding, restWorld);
  return reachHandle(model, {
    id,
    kind: 'point',
    samples: [{ face, barycentric, binding, restWorld, pin }],
    pin,
    target: null,
    radius,
    falloff,
    auto: false,
    baseline,
    reach: null,
  });
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
  const guides = warpGuides(model, handles);
  return settle(model, state, handleConstraints(handles, model, guides), guides, iterations);
}

/** Solves until the grid stops moving: the fixed point of the handles' law. */
function converge(model: WarpModel, state: WarpState, handles: WarpHandle[]) {
  const guides = warpGuides(model, handles),
    constraints = handleConstraints(handles, model, guides);
  for (let i = 0; i < 4000; i++)
    if (solveWarp(model.grid, model.restNodes, constraints, state, 1, guides) < 1e-9) return;
}

const copy = (state: WarpState): WarpState => ({
  positions: state.positions.slice(),
  rotations: state.rotations.slice(),
});

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

/** An unmoved radius-0 handle on a node's own scan vertex. */
function nodePin(model: WarpModel, node: number, state: WarpState, id = 'pin'): WarpHandle {
  const sample = nodeSample(model, node, state.positions);
  return {
    id,
    kind: 'point',
    samples: [sample],
    pin: sample.pin,
    target: null,
    radius: 0,
    falloff: 1,
    auto: false,
    baseline: snapshotOf(model.grid, state),
    reach: null,
  };
}

/** Largest change of the written surface between two states, mm. */
const surfaceChange = (model: WarpModel, a: WarpState, b: WarpState) => change(model, a, b).surface;

/**
 * A strip folded into a U, faces 1 mm apart with the fold at x = 0, painted all but a margin at
 * its far ends and sides so its border is fixed.
 */
async function foldedSheet() {
  const L = 20,
    W = 16,
    gap = 1;
  const arc = Math.PI * (gap / 2);
  const total = 2 * L + arc;
  const geometry = new PlaneGeometry(total, W, Math.round(total / 0.2), Math.round(W / 0.2));
  const p = geometry.getAttribute('position');
  for (let i = 0; i < p.count; i++) {
    const s = p.getX(i) + total / 2,
      z = p.getY(i);
    let x: number, y: number;
    if (s <= L) [x, y] = [L - s, gap / 2];
    else if (s <= L + arc) {
      const a = (s - L) / (gap / 2);
      [x, y] = [-(gap / 2) * Math.sin(a), (gap / 2) * Math.cos(a)];
    } else [x, y] = [s - L - arc, -gap / 2];
    p.setXYZ(i, x, y, z);
  }
  geometry.computeVertexNormals();
  const centre = new Vector3();
  const faces: number[] = [];
  for (let f = 0; f < triangleCount(geometry); f++) {
    readFace(geometry, f).getMidpoint(centre);
    if (centre.x < 18 && Math.abs(centre.z) < 7) faces.push(f);
  }
  return { geometry, model: await modelOf(geometry, 3, faces), arc };
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

  it('fades over the narrowest edge the grid holds at falloff 0, and every step of falloff counts', () => {
    // Falloff 0 fades over the edge width alone.
    expect(reachWeight(8, 10, 0, 2)).toBe(1);
    expect(reachWeight(9, 10, 0, 2)).toBeCloseTo(0.5, 12);
    // The fade grows from the edge to the whole radius, so no part of the slider is inert.
    let last = -1;
    for (let falloff = 0; falloff <= 1; falloff += 0.01) {
      const w = reachWeight(8.5, 10, falloff, 2);
      expect(w).toBeLessThan(last < 0 ? 2 : last);
      last = w;
    }
    // Never more than 1.
    for (let d = 0; d < 12; d += 0.1) expect(reachWeight(d, 10, 0.3, 1)).toBeLessThanOrEqual(1);
  });
});

describe('reach', () => {
  it('switches on smoothly between one and two node spacings', () => {
    expect(reachActivation(1, 1)).toBe(0);
    expect(reachActivation(0.5, 1)).toBe(0);
    expect(reachActivation(1.5, 1)).toBeCloseTo(0.5, 12);
    expect(reachActivation(2, 1)).toBe(1);
    expect(reachActivation(5, 1)).toBe(1);
    expect(reachActivation(1 + 1e-6, 1)).toBeLessThan(1e-11);
  });

  it('is round on a flat sheet, free nodes only, and measured along the surface', async () => {
    const { geometry, model } = await sheet(4, 120);
    const state = createWarpState(model.restNodes);
    const handle = pointHandle(model, geometry, [30, 0.3, 0], state, 9);
    const reach = handle.reach!;
    expect(reach.activation).toBe(1);
    const centre = handle.samples[0].restWorld;
    const inside = new Set(Array.from(reach.node));
    for (const n of reach.node) expect(model.grid.fixed[n]).toBe(0);
    // Every free node well inside the radius in a straight line is reached, near the border too.
    for (let n = 0; n < model.grid.nodes.length; n++) {
      if (model.grid.fixed[n]) continue;
      const d = distance(model.restNodes.subarray(n * 3, n * 3 + 3), centre);
      if (d < (9 + bandWidth(1, reach.spacing)) / warpPathStretch - reach.spacing)
        expect(inside.has(n)).toBe(true);
    }
    reach.node.forEach((n, i) => {
      const d = distance(model.restNodes.subarray(n * 3, n * 3 + 3), centre);
      expect(reach.distance[i]).toBeGreaterThanOrEqual(d - 1e-9);
      expect(reach.distance[i]).toBeLessThan(d * 1.25 + 1e-9);
    });
  });

  it('does not cross a fold to the face behind it', async () => {
    const { geometry, model, arc } = await foldedSheet();
    const state = createWarpState(model.restNodes);
    const handle = pointHandle(model, geometry, [4, 0.5, 0.1], state, 5);
    const { reach } = handle;
    expect(reach!.activation).toBe(1);
    reach!.node.forEach((n, i) => {
      if (model.restNodes[n * 3 + 1] > -0.4) return;
      // On the face behind, only nodes near the fold, by way of it.
      const along = 4 + arc + model.restNodes[n * 3];
      expect(along).toBeLessThan(
        (5 + bandWidth(0, reach!.spacing) + warpTailSpacings * reach!.spacing) * warpPathStretch,
      );
      if (reach!.distance[i] < 5) expect(model.restNodes[n * 3]).toBeLessThan(1);
    });
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
  it('radius 0 and a radius within one spacing solve exactly as a bare point did', async () => {
    const { geometry, model } = await sheet(1, 60);
    const rest = createWarpState(model.restNodes);
    const bare = pointHandle(model, geometry, [0.7, -0.4, 0], rest, 0);
    expect(handleGuides(bare)).toBe(false);
    expect(warpGuides(model, [bare])).toBeUndefined();
    const small = pointHandle(model, geometry, [0.7, -0.4, 0], rest, 0.5);
    expect(small.reach!.spacing).toBeGreaterThan(0.5);
    expect(handleGuides(small)).toBe(false);
    expect(small.reach!.node.length).toBe(0);
    expect(warpGuides(model, [small])).toBeUndefined();

    // The constraint a point has always made, with automatic pins among them.
    const sample = bare.samples[0];
    const target: Vec3 = [0.7, -0.4, 3];
    const pin = { ...nodePin(model, nearestNode(model, [8, 3, 0]), rest), auto: true };
    expect(handleConstraints([{ ...bare, target }, pin], model, undefined)).toEqual([
      { ...sample.binding, rest: sample.restWorld, target },
      { ...pin.samples[0].binding, rest: pin.samples[0].restWorld, target: pin.samples[0].pin },
    ]);
    expect(handleConstraints([bare], model, undefined)[0].target).toBe(sample.pin);

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
      converge(model, state, [handle]);
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
    converge(model, state, [handle]);
    const { world } = written(model, state);
    for (const v of model.region.interior) {
      const d = Math.hypot(model.restWorld[v * 3], model.restWorld[v * 3 + 1]);
      if (d < 7) expect(world[v * 3 + 2]).toBeGreaterThan(1.9);
      if (d > 13) expect(Math.abs(world[v * 3 + 2])).toBeLessThan(0.03 * 2);
    }
  });

  it('never targets a node farther from its baseline than the handle moved, alone or together', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const up = moved(pointHandle(model, geometry, [-2, 0, 0], state, 9, 0.6), [0, 0, 2]);
    const side = moved(pointHandle(model, geometry, [2, 0.5, 0], state, 6, 1, 'b'), [1.5, 0, 1]);
    for (const handles of [[up], [up, side]]) {
      const guides = warpGuides(model, handles)!;
      const limit = Math.max(...handles.map((handle) => Math.hypot(...handleOffsetOf(handle))));
      for (let g = 0; g < guides.node.length; g++) {
        const n = guides.node[g];
        const offset = distance(
          Array.from(guides.target).slice(g * 3, g * 3 + 3),
          state.positions.subarray(n * 3),
        );
        expect(offset).toBeLessThanOrEqual(limit + 1e-9);
      }
    }
    // The grid never rises above the point. Between nodes, skinning lifts a sharp shoulder a
    // little more.
    converge(model, state, [up]);
    let node = 0;
    for (let n = 0; n < model.grid.nodes.length; n++)
      node = Math.max(node, state.positions[n * 3 + 2]);
    expect(node).toBeLessThan(2 * 1.01);
    const { world } = written(model, state);
    let top = 0;
    for (const v of model.region.interior) top = Math.max(top, world[v * 3 + 2]);
    expect(top).toBeLessThan(2 * 1.15);
  });

  it('switches on continuously as the radius passes the first node', async () => {
    const { geometry, model } = await sheet(4, 120);
    const rest = createWarpState(model.restNodes);
    const probe = pointHandle(model, geometry, [0.4, 0.3, 0], rest, 0);
    const { spacing } = probe.reach!;
    const surfaceAt = (radius: number) => {
      const state = createWarpState(model.restNodes);
      converge(model, state, [moved(reachHandle(model, { ...probe, radius }), [0, 0, 1.5])]);
      return state;
    };
    // Across the first node the surface does not jump.
    expect(surfaceChange(model, surfaceAt(spacing), surfaceAt(spacing + 1e-5))).toBeLessThan(1e-3);
    // Anywhere in the range, a small change of radius makes a small change of surface.
    for (const at of [1.05, 1.3, 1.6, 1.95])
      expect(
        surfaceChange(model, surfaceAt(at * spacing), surfaceAt(at * spacing + 1e-4 * spacing)),
      ).toBeLessThan(0.01);
  });

  it('does not depend on the order handles were made or moved', async () => {
    const { geometry, model } = await sheet(5, 160);
    for (const gap of [6, 1.5]) {
      const surfaces = [0, 1].map((order) => {
        const state = createWarpState(model.restNodes);
        const baseline = snapshotOf(model.grid, state);
        const make = [
          () => pointHandle(model, geometry, [-gap / 2, 0.1, 0], state, 5, 1, 'a', baseline),
          () => pointHandle(model, geometry, [gap / 2, -0.1, 0], state, 5, 1, 'b', baseline),
        ];
        const made = order ? [make[1](), make[0]()] : [make[0](), make[1]()];
        const handles = made.map((handle) =>
          moved(handle, handle.id === 'a' ? [0, 0, 2] : [0, 0, -1]),
        );
        // Moved one at a time, settling between, in the same order.
        const first = handles.map((handle, i) => (i === 0 ? handle : made[i]));
        converge(model, state, first);
        converge(model, state, handles);
        return state;
      });
      expect(surfaceChange(model, surfaces[0], surfaces[1])).toBeLessThan(1e-3);
    }
  });

  it('a handle added to a settled surface, of any radius, changes no more than settling again', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const a = moved(pointHandle(model, geometry, [-1.5, 0.1, 0], state, 6), [0, 0, 2]);
    const b = moved(pointHandle(model, geometry, [1.5, -0.1, 0], state, 6, 1, 'b'), [0, 0, -1]);
    solveHandles(model, state, [a, b], 400);
    const settled = copy(state);
    const again = copy(state);
    solveHandles(model, again, [a, b], 400);
    const resettle = surfaceChange(model, settled, again);
    for (const radius of [0, 2, 4, 20]) {
      for (const at of [[0.2, 0.3, 0] as Vec3, [6.2, 1.1, 0] as Vec3]) {
        const after = copy(settled);
        const pin = pointHandle(model, geometry, at, after, radius, 1, 'c');
        solveHandles(model, after, [a, b, pin], 400);
        expect(surfaceChange(model, settled, after)).toBeLessThanOrEqual(Math.max(resettle, 2e-3));
      }
    }
  });

  it('two overlapping handles moved opposite ways both reach their targets without folds', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const up = moved(pointHandle(model, geometry, [-4, 0, 0], state, 9), [0, 0, 2]);
    const down = moved(pointHandle(model, geometry, [4, 0.5, 0], state, 9, 1, 'b'), [0, 0, -2]);
    const shared = Array.from(up.reach!.node).filter((n) => down.reach!.node.includes(n));
    expect(shared.length).toBeGreaterThan(10);
    solveHandles(model, state, [up, down], 300);
    expect(distance(tipOf(model, state, up), up.target!)).toBeLessThan(0.02);
    expect(distance(tipOf(model, state, down), down.target!)).toBeLessThan(0.02);
    const { world, folds } = written(model, state);
    expect(folds.length).toBe(0);
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

  it('an unmoved handle inside a moved one holds its spot and gives way around it', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const hold = pointHandle(model, geometry, [6, 0.4, 0], state, 2, 1, 'b');
    const lift = moved(pointHandle(model, geometry, [0, 0, 0], state, 12), [0, 0, 3]);
    converge(model, state, [lift, hold]);
    // The evenly spaced grid binds both points more evenly than the simplifier's did, so their
    // soft constraints give a little more: 0.023 and 0.107 mm, from 0.014 and 0.100.
    expect(distance(tipOf(model, state, lift), lift.target!)).toBeLessThan(0.025);
    // Its exact constraint shares its nodes with the lift's guides, which pull it a little.
    expect(distance(tipOf(model, state, hold), hold.pin)).toBeLessThan(0.11);
    // Its holding gives way to the lift: over its radius the bump still mostly rises.
    const free = createWarpState(model.restNodes);
    converge(model, free, [lift]);
    const { world } = written(model, state);
    const { world: bare } = written(model, free);
    let held = 0,
      unheld = 0;
    for (const v of model.region.interior) {
      const d = Math.hypot(model.restWorld[v * 3] - 6, model.restWorld[v * 3 + 1] - 0.4);
      if (d < 1 || d > 2) continue;
      held += world[v * 3 + 2];
      unheld += bare[v * 3 + 2];
    }
    expect(held / unheld).toBeGreaterThan(0.6);
  });

  it('a pull near a fold leaves the face behind it', async () => {
    const { geometry, model, arc } = await foldedSheet();
    const state = createWarpState(model.restNodes);
    const handle = moved(pointHandle(model, geometry, [4, 0.5, 0.1], state, 5), [0, 1, 0]);
    solveHandles(model, state, [handle], 300);
    expect(distance(tipOf(model, state, handle), handle.target!)).toBeLessThan(0.02);
    const { world } = written(model, state);
    let far = 0;
    for (const v of model.region.interior) {
      const x = model.restWorld[v * 3],
        y = model.restWorld[v * 3 + 1];
      if (y > -0.4 || 4 + arc + x <= 8) continue;
      far = Math.max(
        far,
        distance(world.subarray(v * 3, v * 3 + 3), model.restWorld.subarray(v * 3)),
      );
    }
    expect(far).toBeLessThan(0.03);
  });

  it('an untouched automatic pin rides with a bump over it, and holds elsewhere', async () => {
    const { geometry, model } = await sheet(5, 160);
    const state = createWarpState(model.restNodes);
    const near = { ...nodePin(model, nearestNode(model, [2, 0, 0]), state, 'near'), auto: true };
    const far = { ...nodePin(model, nearestNode(model, [25, 0, 0]), state, 'far'), auto: true };
    const lift = moved(pointHandle(model, geometry, [0, 0, 0], state, 10), [0, 0, 2]);
    const [, ride, hold] = handleConstraints(
      [lift, near, far],
      model,
      warpGuides(model, [lift, near, far]),
    );
    const weight = reachWeight(
      distance(near.samples[0].restWorld, lift.samples[0].restWorld),
      10,
      1,
      lift.reach!.spacing,
    );
    expect(ride.target[2]).toBeGreaterThan(0.5 * 2 * weight);
    expect(ride.target[2]).toBeLessThanOrEqual(2);
    expect(distance(hold.target, far.samples[0].pin)).toBeLessThan(1e-9);
    solveHandles(model, state, [lift, near, far], 300);
    expect(written(model, state).folds.length).toBe(0);
    // A pin the user has placed holds.
    const placed = { ...near, auto: false };
    expect(
      handleConstraints([lift, placed], model, warpGuides(model, [lift, placed]))[1].target,
    ).toBe(placed.samples[0].pin);
  });

  it('on a coarse 60-node grid an off-grid point reaches its target and bends a broad area', async () => {
    const geometry = new SphereGeometry(16, 48, 32);
    const model = await modelOf(geometry, 0, null);
    expect(model.grid.nodes.length).toBeLessThan(80);
    const state = createWarpState(model.restNodes);
    const pin = nodePin(model, nearestNode(model, [0, -16, 0]), state);
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
    const handle = moved(
      reachHandle(model, { ...pin, id: 'a', samples: [sample], pin: sample.pin, radius: 16 }),
      [0, 3, 0],
    );
    expect(handle.reach!.activation).toBeGreaterThan(0.5);
    converge(model, state, [pin, handle]);
    // Its nodes lie up to 7 mm from it, where the guides lift the surface less than the point, so
    // on this coarsest grid it lands about 2.5 % short.
    expect(distance(tipOf(model, state, handle), handle.target!)).toBeLessThan(0.1);
    expect(distance(tipOf(model, state, pin), pin.pin)).toBeLessThan(0.01);
    const { world, folds } = written(model, state);
    expect(folds.length).toBe(0);
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
    converge(model, state, [handle]);
    // The fixed border 4 mm away steepens the bump; skin maps that stretch with the grid land the
    // point within 0.2 %.
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
});

describe('snapshots across grids', () => {
  it('carry a settled surface to a new grid closely enough to keep its shape', async () => {
    const geometry = new PlaneGeometry(100, 100, 160, 160);
    const faces = disc(geometry, 40);
    const coarse = await modelOf(geometry, 4, faces),
      fine = await modelOf(geometry, 5, faces);
    const state = createWarpState(coarse.restNodes);
    const pin = pointHandle(coarse, geometry, [8, 0, 0], state, 6, 1, 'b');
    const lift = moved(pointHandle(coarse, geometry, [0, 0, 0], state, 10), [0, 0, 2]);
    solveHandles(coarse, state, [lift, pin], 300);
    const before = written(coarse, state).world;
    const settled = snapshotOf(coarse.grid, state);
    const carried = transferSnapshot(coarse, settled, fine);
    expect(carried.grid).toBe(fine.grid);
    expect(carried.settled).toBe(false);
    const baseline = transferSnapshot(coarse, lift.baseline, fine);
    const rebind = (handle: WarpHandle) =>
      reachHandle(fine, {
        ...handle,
        samples: handle.samples.map((sample) => ({
          ...sample,
          binding: bindPoint(
            fine.region,
            fine.binding,
            fine.restWorld,
            sample.face,
            sample.barycentric,
          ),
        })),
        baseline,
        reach: null,
      });
    const next = { positions: carried.positions.slice(), rotations: carried.rotations.slice() };
    solveHandles(fine, next, [rebind(lift), rebind(pin)], 300);
    const after = written(fine, next).world;
    const errors = Array.from(fine.region.interior, (v) =>
      Math.abs(after[v * 3 + 2] - before[v * 3 + 2]),
    ).sort((a, b) => a - b);
    expect(errors[Math.floor(errors.length * 0.99)]).toBeLessThan(0.05 * 2);
    expect(errors.at(-1)).toBeLessThan(0.2 * 2);
  });
});

describe('close gap under a guide', () => {
  it('still pulls the seam nodes onto the neighbour under a handle’s guides', async () => {
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
    const pin = nodePin(model, nearestNode(model, [-10, 0, 0]), state);
    const top = nodeSample(model, nearestNode(model, [2, 10, 0]), state.positions);
    const guide = reachHandle(model, {
      ...pin,
      id: 'top',
      samples: [top],
      pin: top.pin,
      radius: 6,
    });
    const handles = [pin, guide];
    const gapTargets = closeGapTargets(model, state, neighbours, 0.1);
    const covered = gapTargets.filter(({ node }) => guide.reach!.node.includes(node));
    expect(covered.length).toBeGreaterThan(0);
    const constraints = [
      ...handleConstraints(handles, model, warpGuides(model, handles)),
      ...gapTargets.map(({ node, target }) => ({
        node: [node],
        weight: [1],
        rest: Array.from(model.restNodes.subarray(node * 3, node * 3 + 3)) as Vec3,
        target,
      })),
    ];
    const guides = warpGuides(
      model,
      handles,
      gapTargets.map(({ node }) => node),
    )!;
    for (const { node } of gapTargets) expect(Array.from(guides.node)).not.toContain(node);
    settle(model, state, constraints, guides, 200);
    for (const { node, target } of gapTargets)
      expect(distance(state.positions.subarray(node * 3, node * 3 + 3), target)).toBeLessThan(0.01);
  });
});

describe('distribution', () => {
  it('spreads distinct free nodes evenly and deterministically, away from the border', async () => {
    const { model } = await sheet(3, 80);
    const nodes = distributionNodes(model, 8);
    expect(nodes).toEqual(distributionNodes(model, 8));
    expect(new Set(nodes).size).toBe(8);
    for (const n of nodes) expect(model.grid.fixed[n]).toBe(0);
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

  it('puts points on a small painted piece as well as a large one', async () => {
    const geometry = new PlaneGeometry(100, 40, 200, 80);
    const centre = new Vector3();
    const faces: number[] = [];
    for (let f = 0; f < triangleCount(geometry); f++) {
      readFace(geometry, f).getMidpoint(centre);
      if (Math.hypot(centre.x + 25, centre.y) < 18 || Math.hypot(centre.x - 25, centre.y) < 6)
        faces.push(f);
    }
    const model = await modelOf(geometry, 3, faces);
    const nodes = distributionNodes(model, 8);
    expect(nodes).toHaveLength(8);
    const small = nodes.filter((n) => model.restNodes[n * 3] > 0);
    expect(small.length).toBeGreaterThanOrEqual(1);
    // Its first point sits in its middle.
    expect(
      Math.hypot(model.restNodes[small[0] * 3] - 25, model.restNodes[small[0] * 3 + 1]),
    ).toBeLessThan(2.5);
  });
});

const handleOffsetOf = (handle: WarpHandle): Vec3 =>
  handle.target
    ? [
        handle.target[0] - handle.pin[0],
        handle.target[1] - handle.pin[1],
        handle.target[2] - handle.pin[2],
      ]
    : [0, 0, 0];
