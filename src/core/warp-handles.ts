import type { Vec3 } from './types';
import { bindTrianglePoint, warpBindingNodes, type WarpPointBinding } from './warp-bind';
import type { WarpGrid } from './warp-grid';
import { isPaintedNode, type WarpModel } from './warp-model';
import { regionTriangleOf } from './warp-region';
import { deformPoint, skinnedWorldPositions } from './warp-evaluate';
import {
  modelledResponse,
  responseShrink,
  warpNodeStiffness,
  warpResponse,
  type WarpConstraint,
  type WarpGuides,
  type WarpState,
} from './warp-solve';

/** A surface point a handle holds. Immutable: moving a handle moves every sample by its offset. */
export interface WarpSample {
  face: number;
  barycentric: Vec3;
  binding: WarpPointBinding;
  restWorld: Vec3;
  /** Deformed world position when the handle was made; an unmoved handle holds it. */
  pin: Vec3;
}

/** Only points are made today. A line or an area is a handle with many samples. */
export type WarpHandleKind = 'point' | 'line' | 'area';

/**
 * Node positions and rotations on one grid, as a solve settled them. Never mutated once made, so
 * handles and undo steps share it by reference.
 */
export interface WarpSnapshot {
  grid: WarpGrid;
  positions: Float64Array;
  rotations: Float64Array;
  /** False when carried over from another grid: a close starting point rather than a solve. */
  settled: boolean;
  /** False when the solve was still settling: shown as it was, and settled further on restore. */
  converged: boolean;
}

/** Where a handle's reach is measured from. */
export interface WarpFootprint {
  /** Free nodes that move with the handle as one, at full weight whatever the radius. */
  nodes: readonly number[];
  /** Rest world points straight-line distance is measured from. */
  sources: readonly Vec3[];
  /** Free nodes paths along the grid start from, at their straight-line distance. */
  seeds: readonly number[];
}

/** The free nodes a handle's radius and holding band cover on one grid. */
export interface WarpReach {
  grid: WarpGrid;
  radius: number;
  /** The footprint the reach was measured from, to tell when it must be measured again. */
  key: unknown;
  /** Mean rest length of the grid edges at the footprint, mm. */
  spacing: number;
  /** 0 up to one spacing of radius, rising smoothly to 1 at two: what share of the guides apply. */
  activation: number;
  /** Footprint nodes first, then the others in node order. */
  node: Uint32Array;
  /** How many of `node`, from the start, are the footprint's own. */
  own: number;
  /** Intrinsic rest distance from the footprint, mm. */
  distance: Float64Array;
}

export interface WarpHandle {
  id: string;
  kind: WarpHandleKind;
  samples: readonly WarpSample[];
  /** An area's source faces, geometry face ids. Its footprint covers the nodes on them. */
  faces?: readonly number[];
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
  /** The settled surface the handle's guides start from. */
  baseline: WarpSnapshot;
  /** Null until measured on a model. */
  reach: WarpReach | null;
}

/** Guide stiffness relative to a node's diagonal in the ARAP system. */
export const warpGuideStiffness = 4;
/** Grid paths overstate straight-line distance on a flat triangulation by about this much. */
export const warpPathStretch = 1.16;
/**
 * Width of the band past a moved handle's radius that holds the surface, in node spacings, at
 * falloff 100 %. A sharper fade carries its slope farther, so the band grows to one spacing
 * wider at falloff 0.
 */
export const warpBandSpacings = 2.5;
const sharpBandSpacings = 1;
/** The holding band's width for a handle, mm. */
export const bandWidth = (falloff: number, spacing: number) =>
  (warpBandSpacings + sharpBandSpacings * (1 - falloff)) * spacing;
/**
 * Past the band, a moved handle goes on holding at this share of full stiffness, fading to 0
 * over this many node spacings. It keeps the far surface steady, so a drag frame converges as
 * fast as it did with a wider band.
 */
export const warpTailShare = 0.25;
export const warpTailSpacings = 10;
/** The narrowest fade the grid holds, in node spacings: falloff 0. */
export const warpFadeSpacings = 1.5;
/** How far a handle moves, in node spacings, before it drives rather than holds. */
const motionSpacings = 0.25;

const smoothstep = (t: number) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));

/**
 * 1 out to radius − fade, then a smoothstep down to 0 at the radius. The fade runs from `edge`,
 * the narrowest the grid holds, at falloff 0 to the whole radius at falloff 1.
 */
export function reachWeight(distance: number, radius: number, falloff: number, edge = 0) {
  if (!(distance <= radius)) return 0;
  const fade = radius <= edge ? radius : edge + falloff * (radius - edge);
  const inner = radius - fade;
  if (distance <= inner) return 1;
  return 1 - smoothstep((distance - inner) / fade);
}

/** A handle's weight at a distance, on a grid with this node spacing. */
export const handleWeight = (distance: number, radius: number, falloff: number, spacing: number) =>
  reachWeight(distance, radius, falloff, warpFadeSpacings * spacing);

/** Fade width the grid gives a handle at this falloff, mm. */
export const fadeWidth = (handle: Pick<WarpHandle, 'radius' | 'falloff' | 'reach'>) => {
  const edge = warpFadeSpacings * (handle.reach?.spacing ?? 0);
  return handle.radius <= edge ? handle.radius : edge + handle.falloff * (handle.radius - edge);
};

/** How far the handle has moved from its pin. */
export function handleOffset(handle: Pick<WarpHandle, 'pin' | 'target'>): Vec3 {
  const { pin, target } = handle;
  return target ? [target[0] - pin[0], target[1] - pin[1], target[2] - pin[2]] : [0, 0, 0];
}

const samePosition = (a: Vec3, b: Vec3) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

/**
 * How much more firmly a moved point is held than an untouched automatic pin, and a sample the user
 * placed or moved where something else acts on its nodes: other handles' samples, guides or gap
 * targets. It then lands on its target however coarse the grid, unless what shares its nodes is
 * held as firmly.
 */
export const warpPriorityStrength = 100;

/** Whether a handle is an automatic point no one has moved or edited. */
export const untouchedAuto = (handle: Pick<WarpHandle, 'auto' | 'target'>) =>
  handle.auto && handle.target === null;

/**
 * One exact constraint per sample, moved by the handle's offset. Given the `guides` on `model`, an
 * untouched automatic point rides where the guides take the surface at its nodes, so a bump rises
 * smoothly over it; wherever nothing guided moves, it holds its pin. A moved point outranks
 * everything else on its nodes, and any other sample the user placed or moved outranks automatic
 * pins, guides and the `exact` nodes, such as gap targets, that act on its nodes.
 */
export function handleConstraints(
  handles: readonly WarpHandle[],
  model?: WarpModel,
  guides?: WarpGuides,
  exact: Iterable<number> = [],
  carry?: ReadonlyMap<WarpHandle, number>,
): WarpConstraint[] {
  const riding =
    !!model &&
    !!guides &&
    handles.some((handle) => handle.target !== null && handle.reach?.grid === model.grid);
  const constraints: WarpConstraint[] = [];
  const owner: number[] = [];
  handles.forEach((handle, h) => {
    const share = carry?.get(handle) ?? 1;
    const offset = handleOffset(handle).map((value) => share * value) as Vec3;
    const rides = riding && untouchedAuto(handle);
    for (const sample of handle.samples) {
      const ride = rides ? rideOffset(model!, guides!, handle.baseline, sample.binding) : null;
      owner.push(h);
      constraints.push({
        ...sample.binding,
        rest: sample.restWorld,
        target:
          handle.target === null
            ? ride
              ? [sample.pin[0] + ride[0], sample.pin[1] + ride[1], sample.pin[2] + ride[2]]
              : sample.pin
            : share === 1 && samePosition(sample.pin, handle.pin)
              ? handle.target
              : [sample.pin[0] + offset[0], sample.pin[1] + offset[1], sample.pin[2] + offset[2]],
      });
    }
  });
  // Which handle's samples are bound to each node, or -1 when several handles' are or an exact
  // node is there.
  const held = new Map<number, number>();
  for (const n of exact) held.set(n, -1);
  constraints.forEach(({ node }, c) => {
    for (let k = 0; k < node.length; k++) {
      const by = held.get(node[k]);
      held.set(node[k], by === undefined || by === owner[c] ? owner[c] : -1);
    }
  });
  const fixed = model?.grid.fixed;
  const edgeStart = model?.grid.edgeStart;
  // The free nodes moved handles' samples are bound to, and those beside them: a pin the user
  // placed there holds as firmly as the handle pulls.
  const grabbed = new Set<number>();
  if (model)
    for (const handle of handles) {
      if (handle.target === null) continue;
      for (const { binding } of handle.samples)
        for (const n of binding.node) {
          if (fixed![n]) continue;
          grabbed.add(n);
          for (let e = edgeStart![n]; e < edgeStart![n + 1]; e++)
            if (!fixed![model.grid.edges[e]]) grabbed.add(model.grid.edges[e]);
        }
    }
  constraints.forEach((constraint, c) => {
    const handle = handles[owner[c]];
    if (untouchedAuto(handle)) return;
    const { node, weight } = constraint;
    // The nodes a handle moves as one already go where its samples do.
    const { reach } = handle;
    const own = reach?.grid === model?.grid ? reach?.node.subarray(0, reach.own) : undefined;
    // A moved point lands; a line or an area does by moving its footprint as one, and many stiff
    // samples on the same nodes would only slow the solve. Otherwise a sample outranks fully on
    // shared nodes, a pin also beside a moved handle's nodes, and under guides by how firmly they
    // hold its nodes, so the surface stays continuous as a radius reaches them.
    let contest = handle.target !== null && handle.samples.length === 1 ? 1 : 0;
    for (let k = 0; k < node.length && contest < 1; k++) {
      const n = node[k];
      if (fixed?.[n]) continue;
      if (held.get(n) === -1 || (handle.target === null && grabbed.has(n))) contest = 1;
      else if (guides && edgeStart && !own?.includes(n)) {
        const g = guideIndex(guides, n);
        if (g >= 0)
          contest +=
            weight[k] *
            Math.min(
              1,
              guides.stiffness[g] /
                (warpGuideStiffness * warpNodeStiffness(model.grid, model.restNodes, n)),
            );
      }
    }
    if (contest > 0) constraint.strength = 1 + (warpPriorityStrength - 1) * Math.min(1, contest);
  });
  return constraints;
}

/** Where `state` writes the handle's centre: its pin, carried by its samples' mean motion. */
export function writtenCentre(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  handle: Pick<WarpHandle, 'samples' | 'pin'>,
): Vec3 {
  if (handle.samples.length === 1) {
    const [{ binding, restWorld }] = handle.samples;
    return deformPoint(model, state, binding, restWorld);
  }
  const centre: Vec3 = [...handle.pin];
  const share = 1 / handle.samples.length;
  for (const { binding, restWorld, pin } of handle.samples) {
    const at = deformPoint(model, state, binding, restWorld);
    for (let a = 0; a < 3; a++) centre[a] += share * (at[a] - pin[a]);
  }
  return centre;
}

/**
 * The handle pinned where `state` writes it, with `baseline` for its guides: what an automatic
 * point that has ridden becomes when the user takes it over, so taking it changes nothing.
 */
export function heldWhereItIs(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  handle: WarpHandle,
  baseline: WarpSnapshot,
): WarpHandle {
  return {
    ...handle,
    pin: writtenCentre(model, state, handle),
    samples: handle.samples.map((sample) => ({
      ...sample,
      pin: deformPoint(model, state, sample.binding, sample.restWorld),
    })),
    baseline,
  };
}

/**
 * How far the guides take a sample's nodes from where the point holds them, blended by the
 * binding, each node by how firmly it is guided.
 */
function rideOffset(
  model: WarpModel,
  guides: WarpGuides,
  baseline: WarpSnapshot,
  binding: WarpPointBinding,
): Vec3 | null {
  if (baseline.grid !== model.grid) return null;
  const offset: Vec3 = [0, 0, 0];
  let moved = false;
  binding.node.forEach((n, k) => {
    const g = guideIndex(guides, n);
    if (g < 0) return;
    const full = warpGuideStiffness * warpNodeStiffness(model.grid, model.restNodes, n);
    const share = binding.weight[k] * Math.min(1, guides.stiffness[g] / full);
    for (let a = 0; a < 3; a++) {
      const d = share * (guides.target[g * 3 + a] - baseline.positions[n * 3 + a]);
      offset[a] += d;
      moved ||= d !== 0;
    }
  });
  return moved ? offset : null;
}

/** Where node `n` is among the guides, or -1. */
function guideIndex(guides: WarpGuides, n: number) {
  let low = 0,
    high = guides.node.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (guides.node[mid] === n) return mid;
    if (guides.node[mid] < n) low = mid + 1;
    else high = mid - 1;
  }
  return -1;
}

const eligibleNodes = new WeakMap<WarpModel, Uint8Array>();

/** 1 per node a handle can guide or sit on: free, and painted when the region is feathered. */
export function warpEligibleNodes(model: WarpModel) {
  let eligible = eligibleNodes.get(model);
  if (!eligible) {
    const { fixed } = model.grid;
    eligible = new Uint8Array(fixed.length);
    for (let n = 0; n < fixed.length; n++)
      eligible[n] = !fixed[n] && isPaintedNode(model, n) ? 1 : 0;
    eligibleNodes.set(model, eligible);
  }
  return eligible;
}

/** What a footprint is made from. Without a kind, a handle is a point. */
type WarpFootprintOf = Pick<WarpHandle, 'samples'> & Partial<Pick<WarpHandle, 'kind' | 'faces'>>;

/**
 * Where a handle's reach is measured from, by kind. A point is its samples alone. A line or an area
 * moves the free nodes its samples are bound to as one, and an area also the free nodes on its
 * faces still in the region. Paths start at all of them.
 */
export function handleFootprint(model: WarpModel, handle: WarpFootprintOf): WarpFootprint {
  const eligible = warpEligibleNodes(model);
  const seeds = new Set<number>(),
    nodes = new Set<number>();
  for (const { binding } of handle.samples)
    for (const n of binding.node) if (eligible[n]) seeds.add(n);
  const sources = handle.samples.map(({ restWorld }) => restWorld);
  if (handle.kind && handle.kind !== 'point') for (const n of seeds) nodes.add(n);
  if (handle.kind === 'area' && handle.faces) {
    const { region, grid, restWorld } = model;
    for (const face of handle.faces) {
      const triangle = regionTriangleOf(region, face);
      if (triangle < 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = region.triangles[triangle * 3 + c];
        sources.push([restWorld[v * 3], restWorld[v * 3 + 1], restWorld[v * 3 + 2]]);
        const n = grid.nodeOf[v];
        if (n !== 0xffffffff && eligible[n]) nodes.add(n);
      }
    }
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  for (const n of nodes) seeds.add(n);
  return { nodes: sorted(nodes), sources, seeds: sorted(seeds) };
}

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whether two footprints measure reach from the same nodes and points. */
const sameFootprint = (a: WarpFootprint, b: WarpFootprint) =>
  sameNumbers(a.nodes, b.nodes) &&
  sameNumbers(a.seeds, b.seeds) &&
  a.sources.length === b.sources.length &&
  a.sources.every((p, i) => samePosition(p, b.sources[i]));

/**
 * The samples without those bound exactly as an earlier one is, which would only hold the same
 * spot twice as firmly.
 */
export function uniqueSamples(samples: readonly WarpSample[]): WarpSample[] {
  const kept: WarpSample[] = [];
  const same = (a: WarpPointBinding, b: WarpPointBinding) =>
    sameNumbers(a.node, b.node) &&
    a.weight.every((w, k) => Math.abs(w - b.weight[k]) <= 1e-9) &&
    a.fixed.every((x, k) => Math.abs(x - b.fixed[k]) <= 1e-9);
  for (const sample of samples)
    if (!kept.some(({ binding }) => same(binding, sample.binding))) kept.push(sample);
  return kept;
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
 * Multi-source Dijkstra over grid edges at world rest lengths, through the nodes `through`
 * allows, lowering `distance` in place and stopping at `limit`. Returns the nodes it settled.
 */
function relax(
  model: WarpModel,
  seeds: Iterable<readonly [number, number]>,
  distance: Float64Array,
  through: Uint8Array,
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
      if (!through[j]) continue;
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

const borderDistances = new WeakMap<WarpGrid, Float64Array>();

/**
 * Each node's distance along the grid, as reach measures it, from the nearest fixed node the paint
 * meets directly. A feathered band between them already carries the bend.
 */
function borderDistance(model: WarpModel) {
  const { grid } = model;
  let distance = borderDistances.get(grid);
  if (distance) return distance;
  const { fixed, edgeStart, edges } = grid;
  const count = grid.nodes.length;
  distance = new Float64Array(count).fill(Infinity);
  const seeds: [number, number][] = [];
  for (let n = 0; n < count; n++) {
    if (!fixed[n]) continue;
    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++)
      if (!fixed[edges[e]] && isPaintedNode(model, edges[e])) {
        seeds.push([n, 0]);
        break;
      }
  }
  relax(model, seeds, distance, new Uint8Array(count).fill(1));
  for (let n = 0; n < count; n++) distance[n] /= warpPathStretch;
  borderDistances.set(grid, distance);
  return distance;
}

/** Mean rest length of the grid edges at these nodes. */
export function spacingAt(model: WarpModel, nodes: Iterable<number>) {
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

/** Share of a handle's guides that apply at this radius: none within one spacing, all at two. */
export const reachActivation = (radius: number, spacing: number) =>
  spacing > 0 ? smoothstep(radius / spacing - 1) : 0;

/**
 * The free nodes within `radius` of the footprint and the widest holding band and tail past it.
 * Distance
 * is the larger of the straight-line distance and the grid path over `warpPathStretch`, so it is
 * round on a flat area and cannot cross a fold to a surface the grid does not join nearby.
 */
export function footprintReach(
  model: WarpModel,
  footprint: WarpFootprint,
  radius: number,
  key: unknown = footprint,
): WarpReach {
  const { grid, restNodes } = model;
  const eligible = warpEligibleNodes(model);
  const own = [...new Set(footprint.nodes)].filter((n) => eligible[n]).sort((a, b) => a - b);
  const sources: number[] = [];
  for (const p of footprint.sources) sources.push(p[0], p[1], p[2]);
  for (const n of own) sources.push(restNodes[n * 3], restNodes[n * 3 + 1], restNodes[n * 3 + 2]);
  const straight = (n: number) => {
    let d = Infinity;
    const x = restNodes[n * 3],
      y = restNodes[n * 3 + 1],
      z = restNodes[n * 3 + 2];
    for (let s = 0; s < sources.length; s += 3)
      d = Math.min(d, Math.hypot(x - sources[s], y - sources[s + 1], z - sources[s + 2]));
    return d;
  };
  const seeds = new Map<number, number>();
  for (const n of footprint.seeds) if (eligible[n]) seeds.set(n, straight(n));
  for (const n of own) seeds.set(n, 0);
  const spacing = spacingAt(model, seeds.keys());
  const activation = reachActivation(radius, spacing);
  const node = own.slice(),
    distance = own.map(() => 0);
  if (activation > 0) {
    const band = bandWidth(0, spacing) + warpTailSpacings * spacing;
    const path = new Float64Array(grid.nodes.length).fill(Infinity);
    const settled = relax(model, seeds, path, eligible, (radius + band) * warpPathStretch);
    const ownSet = new Set(own);
    for (const n of settled.sort((a, b) => a - b)) {
      if (ownSet.has(n)) continue;
      const d = Math.max(straight(n), path[n] / warpPathStretch);
      if (d >= radius + band) continue;
      node.push(n);
      distance.push(d);
    }
  }
  return {
    grid,
    radius,
    key,
    spacing,
    activation,
    node: Uint32Array.from(node),
    own: own.length,
    distance: Float64Array.from(distance),
  };
}

/**
 * The handle with its reach measured on `model` from its footprint, reusing the one it has when
 * it was measured on the same grid at the same radius from the same footprint.
 */
export function reachHandle(model: WarpModel, handle: WarpHandle): WarpHandle {
  const { reach } = handle;
  const footprint = handleFootprint(model, handle);
  if (
    reach?.grid === model.grid &&
    reach.radius === handle.radius &&
    sameFootprint(reach.key as WarpFootprint, footprint)
  )
    return handle;
  return { ...handle, reach: footprintReach(model, footprint, handle.radius) };
}

/** Whether the handle guides any node beyond its samples' exact constraints. */
export const handleGuides = (handle: Pick<WarpHandle, 'reach'>) =>
  !!handle.reach && (handle.reach.own > 0 || handle.reach.activation > 0);

/**
 * How far the handle has gone from holding to driving: 0 while it sits on its pin, rising to 1
 * over a quarter of a node spacing of travel.
 */
function motionOf(handle: WarpHandle) {
  const offset = handleOffset(handle);
  const travel = Math.hypot(offset[0], offset[1], offset[2]);
  const scale = motionSpacings * (handle.reach?.spacing ?? 0);
  return travel === 0 ? 0 : scale > 0 ? Math.min(1, travel / scale) : 1;
}

/**
 * Soft per-node targets from the handles' radii. At each node it reaches, a handle with guides
 * has a profile: unmoved, its weight `w`, holding the surface softly over its radius; moved, 1
 * out to its radius and fading to 0 across the band past it. It drives the node toward its
 * baseline plus its whole offset at stiffness `w`, and holds it at its baseline for the rest of
 * the profile, so alone it targets `baseline + w × offset`. A holding term gives way by the
 * largest driving weight any other moved handle has there, and so does all of an unmoved
 * handle's profile.
 * Stiffnesses add and the target is their stiffness-weighted mean, so nothing depends on the
 * order of the handles. The `exact` nodes, such as gap targets, get no guide. Undefined when no
 * handle guides a node.
 */
export function warpGuides(
  model: WarpModel,
  handles: readonly WarpHandle[],
  exact: Iterable<number> = [],
  carry?: ReadonlyMap<WarpHandle, number>,
): WarpGuides | undefined {
  const { grid } = model;
  const guiding = handles.filter(
    (handle) =>
      handle.reach?.grid === grid && handle.baseline.grid === grid && handleGuides(handle),
  );
  if (!guiding.length) return undefined;
  const count = grid.nodes.length;
  const border = borderDistance(model);
  const blocked = new Uint8Array(count);
  for (const n of exact) blocked[n] = 1;
  const profiles = guiding.map((handle) => {
    const reach = handle.reach!;
    const motion = motionOf(handle);
    const { radius, falloff } = handle;
    const fade = fadeWidth(handle);
    const band = bandWidth(falloff, reach.spacing),
      tail = warpTailSpacings * reach.spacing;
    const weight = new Float64Array(reach.node.length),
      profile = new Float64Array(reach.node.length);
    for (let i = 0; i < reach.node.length; i++) {
      if (i < reach.own) {
        weight[i] = profile[i] = 1;
        continue;
      }
      const d = reach.distance[i];
      // A bend fades into the fixed border as it does at its radius, so the border does not crease.
      const w =
        handleWeight(d, radius, falloff, reach.spacing) *
        (fade > 0 ? smoothstep(border[reach.node[i]] / fade) : 1);
      const held =
        d <= radius
          ? 1
          : d <= radius + band
            ? 1 - (1 - warpTailShare) * smoothstep((d - radius) / band)
            : warpTailShare * (1 - smoothstep((d - radius - band) / tail));
      weight[i] = reach.activation * w;
      profile[i] = reach.activation * ((1 - motion) * w + motion * held);
    }
    const share = carry?.get(handle) ?? 1;
    const offset = handleOffset(handle).map((value) => share * value) as Vec3;
    return { handle, reach, weight, profile, motion, offset };
  });
  // The two largest driving weights at each node, and whose the largest is.
  const first = new Float64Array(count),
    second = new Float64Array(count),
    leader = new Int32Array(count).fill(-1);
  profiles.forEach(({ reach, weight, motion }, h) => {
    if (!motion) return;
    for (let i = 0; i < reach.node.length; i++) {
      const n = reach.node[i],
        m = weight[i] * motion;
      if (m > first[n]) {
        second[n] = first[n];
        first[n] = m;
        leader[n] = h;
      } else if (m > second[n]) second[n] = m;
    }
  });
  const stiffness = new Float64Array(count),
    target = new Float64Array(count * 3);
  const touched: number[] = [];
  profiles.forEach(({ handle, reach, weight, profile, motion, offset }, h) => {
    const base = handle.baseline.positions;
    for (let i = 0; i < reach.node.length; i++) {
      const n = reach.node[i];
      if (blocked[n]) continue;
      const full = warpGuideStiffness * warpNodeStiffness(grid, model.restNodes, n);
      const others = leader[n] === h ? second[n] : first[n];
      const drive = full * weight[i] * (1 - (1 - motion) * others);
      const hold = full * (profile[i] - weight[i]) * (1 - others);
      const s = drive + hold;
      if (!(s > 0)) continue;
      if (stiffness[n] === 0) touched.push(n);
      stiffness[n] += s;
      for (let a = 0; a < 3; a++) target[n * 3 + a] += s * base[n * 3 + a] + drive * offset[a];
    }
  });
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

/**
 * How far any grid node may move, per mm a grab travels, when the grab is bound partly to fixed
 * nodes or would move a pin the user placed: past this it stops short instead of overdriving the
 * few free nodes it has.
 */
export const warpCarryLimit = 1.25;
/**
 * How far apart the ends of a grid edge against the fixed edge, or against a pin that must hold,
 * may move, as a share of its rest length, under a grab held back that way. Steeper, and the
 * scan's relief folds.
 */
export const warpCreaseStrain = 1;
/** The least share of its determinant a node map beside such an edge or pin keeps under it. */
export const warpMapFloor = 0.5;
/** How far a moved handle may move a stationary pin the user placed, mm. */
export const warpPinHold = 0.005;

/** Share of a binding's weight on free nodes. */
const freeShare = (binding: WarpPointBinding, fixed: Uint8Array) =>
  binding.node.reduce((sum, n, k) => sum + (fixed[n] ? 0 : binding.weight[k]), 0);

/**
 * The share of its offset each moved handle can carry, for the handles that must stop short: those
 * bound partly to fixed nodes, and those that would move a stationary pin the user placed. From
 * the solve's linear response to the handle's travel with rotations held, a handle carries as far
 * as keeps every node within `warpCarryLimit` of its travel, the pins within `warpPinHold`, the
 * edges against the fixed nodes, and against those pins, within `warpCreaseStrain`, and the node
 * maps beside them above `warpMapFloor`. `constraints` and `guides`
 * are what the solve is given, the handles' constraints first in order. Handles on fully free
 * surface with no pin they would move are never in the map.
 */
export function handleCarry(
  model: WarpModel,
  handles: readonly WarpHandle[],
  constraints: WarpConstraint[],
  guides: WarpGuides | undefined,
  exact: Iterable<number> = [],
): Map<WarpHandle, number> {
  const carry = new Map<WarpHandle, number>();
  const { grid, restNodes } = model;
  const { fixed, edgeStart, edges } = grid;
  const first: number[] = [];
  let count = 0;
  for (const handle of handles) {
    first.push(count);
    count += handle.samples.length;
  }
  const pins = handles.flatMap((handle, h) => (handle.target === null && !handle.auto ? [h] : []));
  handles.forEach((handle, h) => {
    if (handle.target === null) return;
    const offset = handleOffset(handle);
    const travel = Math.hypot(offset[0], offset[1], offset[2]);
    if (!(travel > 0)) return;
    const held = handle.samples.some(({ binding }) => freeShare(binding, fixed) < 1 - 1e-9);
    // The pins its constraints fight directly: bound to its nodes or beside them.
    const near = new Set<number>();
    for (const { binding } of handle.samples)
      for (const n of binding.node) {
        near.add(n);
        for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) near.add(edges[e]);
      }
    const close = pins.filter((p) =>
      handles[p].samples.some(({ binding }) => binding.node.some((n) => near.has(n))),
    );
    if (!held && !close.length) return;
    const share = new Float64Array(constraints.length);
    for (let s = 0; s < handle.samples.length; s++) share[first[h] + s] = 1;
    let guideShare: Float64Array | undefined;
    if (guides && handleGuides(handle)) {
      const without = warpGuides(model, handles, exact, new Map([[handle, 0]]));
      if (without && without.node.length === guides.node.length) {
        guideShare = new Float64Array(guides.node.length);
        for (let g = 0; g < guideShare.length; g++) {
          let along = 0;
          for (let a = 0; a < 3; a++)
            along += (guides.target[g * 3 + a] - without.target[g * 3 + a]) * offset[a];
          guideShare[g] = along / (travel * travel);
        }
      }
    }
    const response = warpResponse(grid, restNodes, constraints, guides, share, guideShare);
    let pinned = 0;
    for (const p of close)
      for (let s = 0; s < handles[p].samples.length; s++)
        pinned = Math.max(
          pinned,
          Math.abs(modelledResponse(grid, restNodes, constraints[first[p] + s], response)),
        );
    const pulls = pinned * travel > warpPinHold;
    if (!held && !pulls) return;
    // What holds the surface still: the fixed nodes and, when they must hold, the pins' nodes.
    const anchored = pulls ? fixed.slice() : fixed;
    if (pulls)
      for (const p of close)
        for (const { binding } of handles[p].samples) for (const n of binding.node) anchored[n] = 1;
    // How far nodes move, and how steeply the edges against what holds still rise, per mm.
    let largest = 0,
      strain = 0;
    for (let n = 0; n < response.length; n++) {
      largest = Math.max(largest, Math.abs(response[n]));
      if (fixed[n]) continue;
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
        const j = edges[e];
        if (!anchored[j] || anchored[n]) continue;
        const length = Math.hypot(
          restNodes[n * 3] - restNodes[j * 3],
          restNodes[n * 3 + 1] - restNodes[j * 3 + 1],
          restNodes[n * 3 + 2] - restNodes[j * 3 + 2],
        );
        if (length > 0) strain = Math.max(strain, Math.abs(response[n] - response[j]) / length);
      }
    }
    let carried = largest > warpCarryLimit ? warpCarryLimit / largest : 1;
    if (strain * travel > warpCreaseStrain)
      carried = Math.min(carried, warpCreaseStrain / (strain * travel));
    const u: Vec3 = [offset[0] / travel, offset[1] / travel, offset[2] / travel];
    const shrink = responseShrink(grid, restNodes, response, u, anchored) * travel;
    if (shrink > 1 - warpMapFloor) carried = Math.min(carried, (1 - warpMapFloor) / shrink);
    if (pulls) carried = Math.min(carried, warpPinHold / (pinned * travel));
    if (carried < 1) carry.set(handle, carried);
  });
  return carry;
}

/** Each node's weight from the handle's radius and falloff, for drawing its reach. */
export function reachWeights(handle: WarpHandle) {
  const reach = handle.reach!;
  const weight = new Float64Array(reach.node.length);
  for (let i = 0; i < reach.node.length; i++)
    weight[i] =
      i < reach.own
        ? 1
        : reach.activation *
          handleWeight(reach.distance[i], handle.radius, handle.falloff, reach.spacing);
  return weight;
}

/** A copy of the state as a snapshot to share. */
export const snapshotOf = (
  grid: WarpGrid,
  state: { positions: Float64Array; rotations: Float64Array },
  converged = true,
): WarpSnapshot => ({
  grid,
  positions: state.positions.slice(),
  rotations: state.rotations.slice(),
  settled: true,
  converged,
});

/**
 * A snapshot carried from one grid to another: each node of `to` sits where the preview writes its
 * scan vertex under the snapshot on `from`, turned by the blend of its bound nodes' rotations.
 * Vertices `from` did not move stay at rest. A vertex `from` feathered and `to` paints sits where
 * it was written.
 */
export function transferSnapshot(
  from: WarpModel,
  snapshot: WarpSnapshot,
  to: WarpModel,
): WarpSnapshot {
  const K = warpBindingNodes;
  const { binding, restWorld } = from;
  const { rotations: Q } = snapshot;
  const count = to.grid.nodes.length;
  const positions = to.restNodes.slice(),
    rotations = new Float64Array(count * 4);
  const skinned = skinnedWorldPositions(from, snapshot, to.grid.nodes);
  for (let n = 0; n < count; n++) {
    rotations[n * 4 + 3] = 1;
    const v = to.grid.nodes[n];
    const px = skinned[n * 3],
      py = skinned[n * 3 + 1],
      pz = skinned[n * 3 + 2];
    if (Number.isNaN(px)) continue;
    const x = restWorld[v * 3],
      y = restWorld[v * 3 + 1],
      z = restWorld[v * 3 + 2];
    let qx = 0,
      qy = 0,
      qz = 0,
      qw = 0,
      total = 0;
    for (let k = 0; k < K; k++) {
      const j = binding.node[v * K + k],
        w = binding.weight[v * K + k];
      if (j === 0xffffffff || !(w > 0)) continue;
      const a = Q[j * 4],
        b = Q[j * 4 + 1],
        c = Q[j * 4 + 2],
        d = Q[j * 4 + 3];
      // Quaternions q and −q turn alike, so each joins the blend on the side of the first.
      const sign = total > 0 && a * qx + b * qy + c * qz + d * qw < 0 ? -w : w;
      qx += sign * a;
      qy += sign * b;
      qz += sign * c;
      qw += sign * d;
      total += w;
    }
    if (!(total > 0)) continue;
    // A vertex in the old feather band that the new region paints takes the position it was
    // written at. Where a feather still applies the blend comes later, so it stays unblended.
    const b = from.blend && isPaintedNode(to, n) ? from.blend[v] : 1;
    positions[n * 3] = b === 1 ? px : x + b * (px - x);
    positions[n * 3 + 1] = b === 1 ? py : y + b * (py - y);
    positions[n * 3 + 2] = b === 1 ? pz : z + b * (pz - z);
    if (b < 1) {
      // Turned as far as it was written: part way from no turn.
      const side = qw < 0 ? -b : b;
      qx *= side;
      qy *= side;
      qz *= side;
      qw = side * qw + (1 - b) * total;
    }
    const length = Math.hypot(qx, qy, qz, qw) || 1;
    rotations[n * 4] = qx / length;
    rotations[n * 4 + 1] = qy / length;
    rotations[n * 4 + 2] = qz / length;
    rotations[n * 4 + 3] = qw / length;
  }
  return { grid: to.grid, positions, rotations, settled: false, converged: false };
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

/** Connected pieces of the nodes `through` allows, as a piece number per node, -1 elsewhere. */
function piecesOf(model: WarpModel, through: Uint8Array) {
  const { edgeStart, edges } = model.grid;
  const piece = new Int32Array(through.length).fill(-1);
  let pieces = 0;
  const stack: number[] = [];
  for (let start = 0; start < through.length; start++) {
    if (!through[start] || piece[start] >= 0) continue;
    piece[start] = pieces;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
        const j = edges[e];
        if (through[j] && piece[j] < 0) {
          piece[j] = pieces;
          stack.push(j);
        }
      }
    }
    pieces++;
  }
  return { piece, pieces };
}

/**
 * Up to `count` free nodes for new points. First, each connected piece of the region without a
 * handle gets one, larger pieces first, at its node farthest along the grid from its edge (or
 * from its lowest node when it has none). Then farthest-point sampling along grid edges, away
 * from the handles, the nodes chosen and the region's edge. Deterministic, lowest node first
 * among ties; no node is chosen twice, nor one a handle already sits on.
 */
export function distributionNodes(
  model: WarpModel,
  count: number,
  handles: readonly WarpFootprintOf[] = [],
) {
  const eligible = warpEligibleNodes(model);
  const { edgeStart, edges } = model.grid;
  const size = eligible.length;
  // The region's edge: fixed or unpainted nodes beside an eligible one.
  const edge: [number, number][] = [];
  for (let n = 0; n < size; n++) {
    if (eligible[n]) continue;
    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++)
      if (eligible[edges[e]]) {
        edge.push([n, 0]);
        break;
      }
  }
  const taken = new Set<number>();
  for (const handle of handles) for (const n of handleFootprint(model, handle).seeds) taken.add(n);
  const { piece, pieces } = piecesOf(model, eligible);
  const sizes = new Uint32Array(pieces),
    held = new Uint8Array(pieces);
  for (let n = 0; n < size; n++) if (piece[n] >= 0) sizes[piece[n]]++;
  for (const n of taken) held[piece[n]] = 1;
  const fromEdge = new Float64Array(size).fill(Infinity);
  relax(model, edge, fromEdge, eligible);
  const chosen: number[] = [];
  const empty = Array.from({ length: pieces }, (_, p) => p)
    .filter((p) => !held[p])
    .sort((a, b) => sizes[b] - sizes[a] || a - b);
  for (const p of empty) {
    if (chosen.length >= count) break;
    let best = -1,
      lowest = -1;
    for (let n = 0; n < size; n++) {
      if (piece[n] !== p) continue;
      if (lowest < 0) lowest = n;
      if (Number.isFinite(fromEdge[n]) && (best < 0 || fromEdge[n] > fromEdge[best])) best = n;
    }
    if (best < 0) {
      // No edge: the far end of the piece from its lowest node.
      const from = new Float64Array(size).fill(Infinity);
      relax(model, [[lowest, 0]], from, eligible);
      for (let n = 0; n < size; n++)
        if (piece[n] === p && (best < 0 || from[n] > from[best])) best = n;
    }
    chosen.push(best);
  }
  const distance = fromEdge;
  const seeds: [number, number][] = [...taken, ...chosen].map((n) => [n, 0]);
  relax(model, seeds, distance, eligible);
  while (chosen.length < count) {
    let best = -1;
    for (let n = 0; n < size; n++)
      if (eligible[n] && distance[n] > 0 && (best < 0 || distance[n] > distance[best])) best = n;
    if (best < 0) break;
    chosen.push(best);
    relax(model, [[best, 0]], distance, eligible);
  }
  return chosen;
}
