import type { Vec3 } from './types';
import { bindTrianglePoint, type WarpPointBinding } from './warp-bind';
import type { WarpGrid } from './warp-grid';
import type { WarpModel } from './warp-model';
import type { WarpConstraint, WarpGuides } from './warp-solve';

/** A surface point a handle holds. Immutable: moving a handle moves every sample by its offset. */
export interface WarpSample {
  face: number;
  barycentric: Vec3;
  binding: WarpPointBinding;
  restWorld: Vec3;
  /** Deformed world position when the handle was made; an unmoved handle holds it. */
  pin: Vec3;
}

export type WarpHandleKind = 'point';

/**
 * The free nodes a handle guides on one grid, and where each guide starts from. Its footprint, the
 * free nodes its samples are bound to, comes first.
 */
export interface WarpReach {
  grid: WarpGrid;
  node: Uint32Array;
  /** How many of `node`, from the start, are the handle's footprint. */
  own: number;
  /** Straight-line rest distance from the nearest sample, mm. */
  distance: Float64Array;
  /** Whether the radius reaches any node beyond the footprint. */
  effective: boolean;
  /** Width of the band beyond the radius where guides hold the surface, mm. */
  skirt: number;
  /** Narrowest fade the grid holds here, mm. */
  edge: number;
  /**
   * Share of the offset each footprint node carries: the radius's weight, scaled so the samples
   * move by the whole offset; 1 when the radius has no effect.
   */
  carried: Float64Array;
  /** World position per node the guide holds while the handle is unmoved. */
  base: Float64Array;
  /** Per footprint node, the target of the earlier handles' guides it took over. */
  held: Float64Array;
}

export interface WarpHandle {
  id: string;
  kind: WarpHandleKind;
  samples: readonly WarpSample[];
  /** Where the handle's target is measured from: a point's sample pin. */
  pin: Vec3;
  /** Null while unmoved, when the handle acts as a pin. */
  target: Vec3 | null;
  /** mm; 0 is the samples alone. */
  radius: number;
  /** 0 to 1: the outer share of the radius over which the bend fades. */
  falloff: number;
  /** Placed by Distribute points or automatically, and not moved or edited since. */
  auto: boolean;
  /** Null until the handle is bound to a model. */
  reach: WarpReach | null;
}

/** Guide stiffness relative to a node's diagonal in the ARAP system. */
export const warpGuideStiffness = 4;
// First-order ARAP bends like a plate, so a bump whose guides fade out at the radius carries its
// slope on past it. Guides also hold a band beyond the radius at zero weight, fading over it.
const skirtShare = 0.25,
  skirtSpacings = 2.5;
// A cliff sharper than the grid turns the nodes on it on edge, and the bend carries on past it.
const edgeSpacings = 3;
// Distance is measured in a straight line, which grid paths overstate unevenly, among nodes the
// grid connects within this multiple of the reach, so it does not jump across thin walls.
const reachSlack = 1.5;
// A footprint's own guides only stop its nodes sagging around the samples, which hold it exactly.
const footprintShare = 0.25;

/**
 * 1 out to radius × (1 − falloff), then a smoothstep down to 0 at the radius. The fade is at least
 * `edge` wide, where the grid could not hold a sharper one.
 */
export function reachWeight(distance: number, radius: number, falloff: number, edge = 0) {
  if (!(distance <= radius)) return 0;
  const inner = radius - Math.min(radius, Math.max(radius * falloff, edge));
  if (distance <= inner) return 1;
  const t = (distance - inner) / (radius - inner);
  return 1 - t * t * (3 - 2 * t);
}

/** Share of the guide stiffness at `distance`: full inside the radius, fading across the band. */
export function reachStiffness(distance: number, radius: number, skirt: number) {
  return distance <= radius ? 1 : reachWeight(distance - radius, skirt, 1);
}

/** How far the handle has moved from its pin. */
export function handleOffset(handle: Pick<WarpHandle, 'pin' | 'target'>): Vec3 {
  const { pin, target } = handle;
  return target ? [target[0] - pin[0], target[1] - pin[1], target[2] - pin[2]] : [0, 0, 0];
}

const samePosition = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/** One exact constraint per sample, moved by the handle's offset. */
export function handleConstraints(handles: readonly WarpHandle[]): WarpConstraint[] {
  const constraints: WarpConstraint[] = [];
  for (const handle of handles) {
    const offset = handleOffset(handle);
    for (const sample of handle.samples)
      constraints.push({
        ...sample.binding,
        rest: sample.restWorld,
        target:
          handle.target === null
            ? sample.pin
            : samePosition(sample.pin, handle.pin)
              ? handle.target
              : [sample.pin[0] + offset[0], sample.pin[1] + offset[1], sample.pin[2] + offset[2]],
      });
  }
  return constraints;
}

/** Nodes the handle covers before its radius, at their distance from the nearest sample. */
export function handleFootprint(model: WarpModel, handle: Pick<WarpHandle, 'samples'>) {
  const { restNodes } = model;
  const footprint = new Map<number, number>();
  for (const { binding, restWorld } of handle.samples)
    for (const n of binding.node) {
      const d = Math.hypot(
        restWorld[0] - restNodes[n * 3],
        restWorld[1] - restNodes[n * 3 + 1],
        restWorld[2] - restNodes[n * 3 + 2],
      );
      if (!(footprint.get(n)! <= d)) footprint.set(n, d);
    }
  return footprint;
}

class Heap {
  private d: number[] = [];
  private n: number[] = [];
  get size() {
    return this.d.length;
  }
  push(distance: number, node: number) {
    const { d, n } = this;
    let i = d.length;
    d.push(distance);
    n.push(node);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (d[p] < distance || (d[p] === distance && n[p] <= node)) break;
      d[i] = d[p];
      n[i] = n[p];
      i = p;
    }
    d[i] = distance;
    n[i] = node;
  }
  /** Removes the nearest entry, lowest node first among equals, into `out`. */
  pop(out: { distance: number; node: number }) {
    const { d, n } = this;
    out.distance = d[0];
    out.node = n[0];
    const distance = d.pop()!,
      node = n.pop()!;
    const size = d.length;
    if (!size) return;
    let i = 0;
    for (;;) {
      let c = 2 * i + 1;
      if (c >= size) break;
      if (c + 1 < size && (d[c + 1] < d[c] || (d[c + 1] === d[c] && n[c + 1] < n[c]))) c++;
      if (d[c] > distance || (d[c] === distance && n[c] >= node)) break;
      d[i] = d[c];
      n[i] = n[c];
      i = c;
    }
    d[i] = distance;
    n[i] = node;
  }
}

/**
 * Multi-source Dijkstra over grid edges at world rest lengths, lowering `distance` in place and
 * stopping at `limit`. Returns the nodes it reached, in the order they settled.
 */
function relax(
  model: WarpModel,
  seeds: Iterable<[number, number]>,
  distance: Float64Array,
  limit = Infinity,
) {
  const { grid, restNodes } = model;
  const { edgeStart, edges } = grid;
  const heap = new Heap();
  for (const [n, d] of seeds)
    if (d <= limit && d < distance[n]) {
      distance[n] = d;
      heap.push(d, n);
    }
  const settled: number[] = [];
  const top = { distance: 0, node: 0 };
  while (heap.size) {
    heap.pop(top);
    const { distance: d, node: i } = top;
    if (d > distance[i]) continue;
    settled.push(i);
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      const next =
        d +
        Math.hypot(
          restNodes[i * 3] - restNodes[j * 3],
          restNodes[i * 3 + 1] - restNodes[j * 3 + 1],
          restNodes[i * 3 + 2] - restNodes[j * 3 + 2],
        );
      if (next <= limit && next < distance[j]) {
        distance[j] = next;
        heap.push(next, j);
      }
    }
  }
  return settled;
}

/** Mean rest length of the grid edges at these nodes. */
function spacingAt(model: WarpModel, nodes: Iterable<number>) {
  const { grid, restNodes } = model;
  const { edgeStart, edges } = grid;
  let sum = 0,
    count = 0;
  for (const i of nodes)
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      sum += Math.hypot(
        restNodes[i * 3] - restNodes[j * 3],
        restNodes[i * 3 + 1] - restNodes[j * 3 + 1],
        restNodes[i * 3 + 2] - restNodes[j * 3 + 2],
      );
      count++;
    }
  return count ? sum / count : 0;
}

/**
 * The free nodes the handle guides: its footprint, then those within its radius and the band
 * beyond it. Only the footprint when the radius reaches no node beyond it.
 */
export function handleReachNodes(model: WarpModel, handle: Pick<WarpHandle, 'samples' | 'radius'>) {
  const { radius, samples } = handle;
  const { fixed } = model.grid;
  const { restNodes } = model;
  const footprint = handleFootprint(model, handle);
  const nearest = (n: number) => {
    let d = Infinity;
    for (const { restWorld: p } of samples)
      d = Math.min(
        d,
        Math.hypot(
          p[0] - restNodes[n * 3],
          p[1] - restNodes[n * 3 + 1],
          p[2] - restNodes[n * 3 + 2],
        ),
      );
    return d;
  };
  const node = [...footprint.keys()].filter((n) => !fixed[n]).sort((a, b) => a - b);
  const own = node.length;
  const distance = node.map(nearest);
  let skirt = 0,
    edge = 0,
    effective = false;
  if (radius > 0) {
    const spacing = spacingAt(model, footprint.keys());
    skirt = Math.max(radius * skirtShare, skirtSpacings * spacing);
    edge = edgeSpacings * spacing;
    const path = new Float64Array(fixed.length).fill(Infinity);
    const settled = relax(model, footprint, path, (radius + skirt) * reachSlack);
    for (const n of settled.sort((a, b) => a - b)) {
      if (fixed[n] || footprint.has(n)) continue;
      const d = nearest(n);
      if (d > radius + skirt) continue;
      effective ||= d <= radius;
      node.push(n);
      distance.push(d);
    }
    if (!effective) node.length = distance.length = own;
  }
  return {
    node: Uint32Array.from(node),
    own,
    distance: Float64Array.from(distance),
    skirt: effective ? skirt : 0,
    edge: effective ? edge : 0,
    effective,
  };
}

/** Each footprint node's share of the offset, so that every sample moves by the whole offset. */
function carriedShares(
  handle: Pick<WarpHandle, 'samples' | 'radius' | 'falloff'>,
  reach: Pick<WarpReach, 'node' | 'own' | 'distance' | 'effective' | 'edge'>,
  model: WarpModel,
) {
  const carried = new Float64Array(reach.own);
  if (!reach.effective) return carried.fill(1);
  const { restNodes } = model;
  const index = new Map<number, number>();
  for (let i = 0; i < reach.own; i++) index.set(reach.node[i], i);
  for (const { binding, restWorld: p } of handle.samples) {
    let total = 0,
      weighted = 0;
    const shares: [number, number][] = [];
    binding.node.forEach((n, k) => {
      const i = index.get(n);
      if (i === undefined) return;
      const d = Math.hypot(
        p[0] - restNodes[n * 3],
        p[1] - restNodes[n * 3 + 1],
        p[2] - restNodes[n * 3 + 2],
      );
      const w = reachWeight(d, handle.radius, handle.falloff, reach.edge);
      total += binding.weight[k];
      weighted += binding.weight[k] * w;
      shares.push([i, w]);
    });
    const scale = weighted > 0 ? total / weighted : 1;
    for (const [i, w] of shares) carried[i] = Math.max(carried[i], weighted > 0 ? w * scale : 1);
  }
  return carried;
}

/**
 * The handle with its reach on `model`. Each guide starts from where `surface` (world, per node)
 * puts its node, less the share of `before`'s offset that node carried. Nodes `before` already had
 * on this grid keep their start, so changing the radius or falloff only reshapes the handle's own
 * bump. A new handle's footprint also takes over the targets of `guides`, the guides of the
 * handles before it, so adding it changes nothing.
 */
export function reachHandle(
  model: WarpModel,
  handle: WarpHandle,
  surface: ArrayLike<number>,
  before: WarpHandle | null = null,
  guides?: WarpGuides,
): WarpHandle {
  const kept = before?.reach?.grid === model.grid ? before.reach : null;
  const nodes =
    kept && before!.radius === handle.radius && before!.samples === handle.samples
      ? kept
      : handleReachNodes(model, handle);
  const { node, own, distance, skirt, edge, effective } = nodes;
  const carried = carriedShares(handle, nodes, model);
  const keptAt = new Map<number, number>();
  if (kept) kept.node.forEach((n, i) => keptAt.set(n, i));
  // On another grid, a node's share of the old offset is its share under the old settings.
  const offset = before && !kept ? handleOffset(before) : null;
  const was = offset
    ? carriedShares(
        { samples: handle.samples, radius: before!.radius, falloff: before!.falloff },
        { node, own, distance, edge, effective: before!.radius > 0 && effective },
        model,
      )
    : null;
  const guided = new Map<number, number>();
  if (guides && !before) for (let g = 0; g < guides.node.length; g++) guided.set(guides.node[g], g);
  const base = new Float64Array(node.length * 3),
    held = new Float64Array(own * 3);
  for (let i = 0; i < node.length; i++) {
    const n = node[i],
      k = keptAt.get(n);
    if (k !== undefined) {
      base.set(kept!.base.subarray(k * 3, k * 3 + 3), i * 3);
      if (i < own && k < kept!.own) held.set(kept!.held.subarray(k * 3, k * 3 + 3), i * 3);
      else if (i < own) held.set(base.subarray(i * 3, i * 3 + 3), i * 3);
      continue;
    }
    const w = !offset
      ? 0
      : i < own
        ? was![i]
        : reachWeight(distance[i], before!.radius, before!.falloff, edge);
    for (let a = 0; a < 3; a++) base[i * 3 + a] = surface[n * 3 + a] - (offset ? w * offset[a] : 0);
    if (i >= own) continue;
    const g = guided.get(n);
    if (g === undefined) held.set(base.subarray(i * 3, i * 3 + 3), i * 3);
    else for (let a = 0; a < 3; a++) held[i * 3 + a] = guides!.target[g * 3 + a];
  }
  return {
    ...handle,
    reach: { grid: model.grid, node, own, distance, effective, skirt, edge, carried, base, held },
  };
}

/**
 * Soft targets for the nodes the handles reach: `base + w × D` at stiffness
 * `warpGuideStiffness × reachStiffness × diagonal`. Where handles overlap, stiffnesses add and the
 * target is their stiffness-weighted mean. A handle guides its own footprint with the share of
 * its offset that agrees with its exact samples, and no other handle guides it. Where earlier
 * handles' guides would have, it takes them over at their stiffness. The `exact` nodes, such as
 * gap targets, get no guide. Undefined when no handle reaches a node.
 */
export function warpGuides(
  model: WarpModel,
  handles: readonly WarpHandle[],
  exact: Iterable<number> = [],
): WarpGuides | undefined {
  const { grid } = model;
  if (!handles.some(({ reach }) => reach?.grid === grid && reach.effective)) return undefined;
  const { edgeStart } = grid;
  const count = grid.nodes.length;
  const blocked = new Uint8Array(count);
  for (const n of exact) blocked[n] = 2;
  for (const { samples } of handles)
    for (const { binding } of samples) for (const n of binding.node) blocked[n] ||= 1;
  // Stiffness the guides of the handles so far would have at each node.
  const earlier = new Float64Array(count);
  const stiffness = new Float64Array(count),
    target = new Float64Array(count * 3);
  const touched: number[] = [];
  const add = (n: number, s: number, from: Float64Array, i: number, w: number, offset: Vec3) => {
    if (stiffness[n] === 0) touched.push(n);
    stiffness[n] += s;
    for (let a = 0; a < 3; a++) target[n * 3 + a] += s * (from[i * 3 + a] + w * offset[a]);
  };
  const full = (n: number) => warpGuideStiffness * 2 * (edgeStart[n + 1] - edgeStart[n]);
  for (const handle of handles) {
    const { reach } = handle;
    if (!reach || reach.grid !== grid) continue;
    const offset = handleOffset(handle);
    for (let i = 0; i < reach.own; i++) {
      const n = reach.node[i];
      if (blocked[n] === 2) continue;
      if (reach.effective)
        add(n, full(n) * footprintShare, reach.base, i, reach.carried[i], offset);
      if (earlier[n] > 0) add(n, earlier[n], reach.held, i, reach.carried[i], offset);
    }
    for (let i = reach.own; i < reach.node.length; i++) {
      const n = reach.node[i],
        d = reach.distance[i];
      const s = full(n) * reachStiffness(d, handle.radius, reach.skirt);
      if (!(s > 0)) continue;
      earlier[n] += s;
      if (!blocked[n])
        add(n, s, reach.base, i, reachWeight(d, handle.radius, handle.falloff, reach.edge), offset);
    }
  }
  if (!touched.length) return undefined;
  touched.sort((a, b) => a - b);
  const guides = {
    node: Uint32Array.from(touched),
    stiffness: new Float64Array(touched.length),
    target: new Float64Array(touched.length * 3),
  };
  for (let g = 0; g < touched.length; g++) {
    const n = touched[g],
      s = stiffness[n];
    guides.stiffness[g] = s;
    for (let a = 0; a < 3; a++) guides.target[g * 3 + a] = target[n * 3 + a] / s;
  }
  return guides;
}

const cornerTriangles = new WeakMap<WarpModel, Int32Array>();

/** A region triangle using each welded vertex, as triangle × 3 + corner, or -1. */
function cornerOf(model: WarpModel) {
  let corners = cornerTriangles.get(model);
  if (!corners) {
    const { triangles, weldedCount } = model.region;
    corners = new Int32Array(weldedCount).fill(-1);
    for (let i = 0; i < triangles.length; i++)
      if (corners[triangles[i]] < 0) corners[triangles[i]] = i;
    cornerTriangles.set(model, corners);
  }
  return corners;
}

/** A sample on a node's own scan vertex, pinned where `positions` (world, per node) puts it. */
export function nodeSample(
  model: WarpModel,
  node: number,
  positions: ArrayLike<number>,
): WarpSample {
  const corner = cornerOf(model)[model.grid.nodes[node]];
  const triangle = Math.floor(corner / 3);
  const barycentric: Vec3 = [0, 0, 0];
  barycentric[corner % 3] = 1;
  const { restNodes } = model;
  return {
    face: model.region.faces[triangle],
    barycentric,
    binding: bindTrianglePoint(model.region, model.binding, model.restWorld, triangle, barycentric),
    restWorld: [restNodes[node * 3], restNodes[node * 3 + 1], restNodes[node * 3 + 2]],
    pin: [positions[node * 3], positions[node * 3 + 1], positions[node * 3 + 2]],
  };
}

/**
 * Up to `count` free nodes spread by farthest-point sampling along grid edges, away from the
 * handles already present and the fixed border. Each disconnected piece of the region gets a node
 * before any piece gets a second; ties go to the lowest node. No node is chosen twice, and no
 * node a handle already sits on.
 */
export function distributionNodes(
  model: WarpModel,
  count: number,
  handles: readonly Pick<WarpHandle, 'samples'>[] = [],
) {
  const { fixed } = model.grid;
  const distance = new Float64Array(fixed.length).fill(Infinity);
  const seeds: [number, number][] = [];
  for (let n = 0; n < fixed.length; n++) if (fixed[n]) seeds.push([n, 0]);
  for (const handle of handles) seeds.push(...handleFootprint(model, handle));
  relax(model, seeds, distance);
  const chosen: number[] = [];
  while (chosen.length < count) {
    let best = -1;
    for (let n = 0; n < fixed.length; n++)
      if (!fixed[n] && distance[n] > 0 && (best < 0 || distance[n] > distance[best])) best = n;
    if (best < 0) break;
    chosen.push(best);
    relax(model, [[best, 0]], distance);
  }
  return chosen;
}
