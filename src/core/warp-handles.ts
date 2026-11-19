import type { Vec3 } from './types';
import { bindTrianglePoint, warpBindingNodes, type WarpPointBinding } from './warp-bind';
import type { WarpGrid } from './warp-grid';
import { isPaintedNode, type WarpModel } from './warp-model';
import { regionTriangleOf } from './warp-region';
import { flatPointPatch } from './warp-point-surface';
import { deformPoint, skinnedWorldPositions, type WarpOutput } from './warp-evaluate';
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
  /** The other free nodes a line's drawn path is bound to, in node order. */
  path: readonly number[];
  /** The most weight any spot of the path gives each of them. */
  pathWeight: readonly number[];
  /** The share of the guides each takes at radius 0. */
  pathShare: readonly number[];
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
  /** Point reach on a curved surface uses the edge-path profile and grid skinning. */
  curvedPoint?: boolean;
  /** Footprint nodes first, then the others in node order. */
  node: Uint32Array;
  /** How many of `node`, from the start, are the footprint's own. */
  own: number;
  /** Intrinsic rest distance from the footprint, mm. */
  distance: Float64Array;
  /** World rest points the straight-line part of `distance` is measured from, three values each. */
  sources: Float64Array;
  /** The least share of the guides each node takes, from the line's path. */
  least: Float64Array;
  /** How much of the radius's hold on each node the line's path lets go. */
  release: Float64Array;
}

export interface WarpHandle {
  id: string;
  kind: WarpHandleKind;
  samples: readonly WarpSample[];
  /** An area's source faces, geometry face ids. Its footprint covers the nodes on them. */
  faces?: readonly number[];
  /** A line as drawn, on geometry faces: what is shown of it, not what it holds. */
  path?: readonly { face: number; barycentric: Vec3 }[];
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
  detail?: WarpDetail,
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
      const target: Vec3 =
        handle.target === null
          ? ride
            ? [sample.pin[0] + ride[0], sample.pin[1] + ride[1], sample.pin[2] + ride[2]]
            : sample.pin
          : share === 1 && samePosition(sample.pin, handle.pin)
            ? handle.target
            : [sample.pin[0] + offset[0], sample.pin[1] + offset[1], sample.pin[2] + offset[2]];
      // The detail is written on top of what the nodes carry, so the nodes aim short of it.
      const extra =
        model && detail ? detailAt(model, detail, sample.face, sample.barycentric) : null;
      constraints.push({
        ...sample.binding,
        rest: sample.restWorld,
        target:
          extra && (extra[0] || extra[1] || extra[2])
            ? [target[0] - extra[0], target[1] - extra[1], target[2] - extra[2]]
            : target,
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
  detail?: WarpDetail,
): Vec3 {
  if (handle.samples.length === 1) return writtenSample(model, state, handle.samples[0], detail);
  const centre: Vec3 = [...handle.pin];
  const share = 1 / handle.samples.length;
  for (const sample of handle.samples) {
    const { pin } = sample;
    const at = writtenSample(model, state, sample, detail);
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
  detail?: WarpDetail,
): WarpHandle {
  return {
    ...handle,
    pin: writtenCentre(model, state, handle, detail),
    samples: handle.samples.map((sample) => ({
      ...sample,
      pin: writtenSample(model, state, sample, detail),
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
type WarpFootprintOf = Pick<WarpHandle, 'samples'> &
  Partial<Pick<WarpHandle, 'kind' | 'faces' | 'path'>>;

/**
 * A line or an area moves as one the free nodes within this many node spacings of it. A sample's
 * binding reaches farther, unevenly to either side, so taking every node the samples are bound to
 * would make the ridge's width depend on which triangles they fell in, and so on pointer speed. A
 * line's drawn path also guides the other nodes it is bound to, by `warpPathShare`.
 */
export const warpFootprintSpacings = 0.75;

/** Distance from a point to the segment from `a` to `b`. */
function segmentDistance(p: ArrayLike<number>, a: Vec3, b: Vec3) {
  const ux = b[0] - a[0],
    uy = b[1] - a[1],
    uz = b[2] - a[2];
  const length = ux * ux + uy * uy + uz * uz;
  const t =
    length > 0
      ? Math.max(
          0,
          Math.min(1, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy + (p[2] - a[2]) * uz) / length),
        )
      : 0;
  return Math.hypot(p[0] - a[0] - t * ux, p[1] - a[1] - t * uy, p[2] - a[2] - t * uz);
}

type WarpPath = NonNullable<WarpHandle['path']>;
type WarpPathBinding = { node: number[]; weight: number[] }[];
const boundToPath = new WeakMap<WarpModel, WeakMap<WarpPath, WarpPathBinding>>();

/** How each spot of a line's drawn path is bound to the grid. */
function pathBinding(model: WarpModel, path: WarpPath) {
  let paths = boundToPath.get(model);
  if (!paths) boundToPath.set(model, (paths = new WeakMap()));
  let bound = paths.get(path);
  if (!bound) {
    bound = [];
    for (const { face, barycentric } of path) {
      const triangle = regionTriangleOf(model.region, face);
      if (triangle < 0) continue;
      const { node, weight } = bindTrianglePoint(
        model.region,
        model.binding,
        model.restWorld,
        triangle,
        barycentric,
      );
      bound.push({ node, weight });
    }
    paths.set(path, bound);
  }
  return bound;
}

/**
 * At radius 0, a node a spot of a line's path is bound to by `w`, where the spot has weight `B`
 * on free nodes outside the footprint, takes `warpPathShare (w B)^warpPathPower` of the guides,
 * at most all: as much as holds the path level without lifting the surface beside the line.
 */
export const warpPathShare = 6;
export const warpPathPower = 1.5;
/**
 * As a radius's guides apply, a path node's share rises to a smoothstep of its weight over
 * `warpPathBound`, and the radius's hold on it at its baseline lets go by as much: a firm partial
 * lift of a node the line pulls a spot on raises or sinks the surface between the samples.
 */
export const warpPathBound = 0.05;

/**
 * Where a handle's reach is measured from, by kind. A point is its samples alone. A line or an area
 * moves as one the free nodes on it: within `warpFootprintSpacings` of the line through its
 * samples in order, or of an area's samples, found along the grid from the nodes the samples are
 * bound to. A sample with none of its own nodes among them adds its most heavily bound one. A line
 * also guides the other free nodes its drawn path is bound to, each by a share that grows with how
 * far the path's spots on it would lag (`warpPathShare`): a node left behind while the line pulls
 * the spots on it raises or sinks the surface between the samples. An area also
 * moves the free nodes on its faces still in the region, and straight-line distance is also
 * measured from its outline. Paths start at every free node the samples are bound to.
 */
export function handleFootprint(model: WarpModel, handle: WarpFootprintOf): WarpFootprint {
  const eligible = warpEligibleNodes(model);
  const seeds = new Set<number>(),
    nodes = new Set<number>();
  for (const { binding } of handle.samples)
    for (const n of binding.node) if (eligible[n]) seeds.add(n);
  const sources = handle.samples.map(({ restWorld }) => restWorld);
  if (handle.kind && handle.kind !== 'point') {
    const { restNodes } = model;
    const { edgeStart, edges } = model.grid;
    const on = (n: number) => {
      const at = restNodes.subarray(n * 3, n * 3 + 3);
      const limit = warpFootprintSpacings * spacingAt(model, [n]);
      for (let s = 0; s < sources.length; s++) {
        const d =
          handle.kind === 'line' && s > 0
            ? segmentDistance(at, sources[s - 1], sources[s])
            : Math.hypot(at[0] - sources[s][0], at[1] - sources[s][1], at[2] - sources[s][2]);
        if (d <= limit) return true;
      }
      return false;
    };
    const seen = new Set(seeds),
      stack = [...seeds];
    while (stack.length) {
      const n = stack.pop()!;
      const inside = on(n);
      if (inside) nodes.add(n);
      else if (!seeds.has(n)) continue;
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
        const j = edges[e];
        if (eligible[j] && !seen.has(j)) {
          seen.add(j);
          stack.push(j);
        }
      }
    }
    for (const { binding } of handle.samples) {
      if (binding.node.some((n) => nodes.has(n))) continue;
      let heaviest = -1;
      binding.node.forEach((n, k) => {
        if (eligible[n] && (heaviest < 0 || binding.weight[k] > binding.weight[heaviest]))
          heaviest = k;
      });
      if (heaviest >= 0) nodes.add(binding.node[heaviest]);
    }
  }
  const path: number[] = [],
    pathWeight: number[] = [],
    pathShare: number[] = [];
  if (handle.kind === 'line' && handle.path) {
    const most = new Map<number, number>(),
      share = new Map<number, number>();
    for (const { node, weight } of pathBinding(model, handle.path)) {
      let outside = 0;
      node.forEach((n, k) => {
        if (eligible[n] && !nodes.has(n)) outside += weight[k];
      });
      node.forEach((n, k) => {
        if (!eligible[n] || nodes.has(n)) return;
        most.set(n, Math.max(most.get(n) ?? 0, weight[k]));
        const lag = weight[k] * outside;
        share.set(
          n,
          Math.max(share.get(n) ?? 0, Math.min(1, warpPathShare * lag ** warpPathPower)),
        );
      });
    }
    for (const n of [...most.keys()].sort((a, b) => a - b)) {
      path.push(n);
      pathWeight.push(most.get(n)!);
      pathShare.push(share.get(n)!);
    }
  }
  if (handle.kind === 'area' && handle.faces) {
    const { region, grid, restWorld } = model;
    const { weldedCount } = region;
    // Straight-line distance from outside an area is to its outline, so the outline's vertices
    // are its sources: all of its corners would cost a measure each per node reached.
    const edges = new Map<number, number>();
    for (const face of handle.faces) {
      const triangle = regionTriangleOf(region, face);
      if (triangle < 0) continue;
      for (let c = 0; c < 3; c++) {
        const v = region.triangles[triangle * 3 + c],
          w = region.triangles[triangle * 3 + ((c + 1) % 3)];
        const n = grid.nodeOf[v];
        if (n !== 0xffffffff && eligible[n]) nodes.add(n);
        const key = v < w ? v * weldedCount + w : w * weldedCount + v;
        edges.set(key, (edges.get(key) ?? 0) + 1);
      }
    }
    const outline = new Set<number>();
    for (const [key, count] of edges)
      if (count === 1) outline.add(Math.floor(key / weldedCount)).add(key % weldedCount);
    for (const v of [...outline].sort((a, b) => a - b))
      sources.push([restWorld[v * 3], restWorld[v * 3 + 1], restWorld[v * 3 + 2]]);
  }
  const sorted = (set: Set<number>) => [...set].sort((a, b) => a - b);
  for (const n of nodes) seeds.add(n);
  return { nodes: sorted(nodes), sources, seeds: sorted(seeds), path, pathWeight, pathShare };
}

const sameNumbers = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Whether two footprints measure reach from the same nodes and points. */
const sameFootprint = (a: WarpFootprint, b: WarpFootprint) =>
  sameNumbers(a.nodes, b.nodes) &&
  sameNumbers(a.seeds, b.seeds) &&
  sameNumbers(a.path, b.path) &&
  sameNumbers(a.pathWeight, b.pathWeight) &&
  sameNumbers(a.pathShare, b.pathShare) &&
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

const incidentTriangles = new WeakMap<WarpGrid, { start: Uint32Array; triangle: Uint32Array }>();

/** CSR of the grid triangles at each node, skipping triangles with a repeated node. */
function trianglesAt(grid: WarpGrid) {
  let found = incidentTriangles.get(grid);
  if (found) return found;
  const { triangles } = grid;
  const count = grid.nodes.length;
  const sound = (t: number) =>
    triangles[t] !== triangles[t + 1] &&
    triangles[t + 1] !== triangles[t + 2] &&
    triangles[t] !== triangles[t + 2];
  const start = new Uint32Array(count + 1);
  for (let t = 0; t < triangles.length; t += 3)
    if (sound(t)) for (let k = 0; k < 3; k++) start[triangles[t + k] + 1]++;
  for (let n = 0; n < count; n++) start[n + 1] += start[n];
  const triangle = new Uint32Array(start[count]);
  const fill = start.slice(0, count);
  for (let t = 0; t < triangles.length; t += 3)
    if (sound(t)) for (let k = 0; k < 3; k++) triangle[fill[triangles[t + k]]++] = t;
  incidentTriangles.set(grid, (found = { start, triangle }));
  return found;
}

/**
 * Distance at node k across triangle (i, j, k) from a front that reaches i and j at `di` and `dj`,
 * unfolded flat: the front's source lies `di` from i and `dj` from j on the far side of the edge,
 * and its line to k must cross the edge. Infinity when it does not.
 */
function acrossTriangle(
  points: Float64Array,
  i: number,
  j: number,
  k: number,
  di: number,
  dj: number,
) {
  const ex = points[j * 3] - points[i * 3],
    ey = points[j * 3 + 1] - points[i * 3 + 1],
    ez = points[j * 3 + 2] - points[i * 3 + 2];
  const fx = points[k * 3] - points[i * 3],
    fy = points[k * 3 + 1] - points[i * 3 + 1],
    fz = points[k * 3 + 2] - points[i * 3 + 2];
  const e = Math.hypot(ex, ey, ez);
  if (!(e > 0)) return Infinity;
  const fu = (fx * ex + fy * ey + fz * ez) / e;
  const fv = Math.sqrt(Math.max(0, fx * fx + fy * fy + fz * fz - fu * fu));
  if (!(fv > 0)) return Infinity;
  const a = (di * di - dj * dj + e * e) / (2 * e);
  const b2 = di * di - a * a;
  if (!(b2 >= 0)) return Infinity;
  const b = Math.sqrt(b2);
  // Where the line from the source (a, −b) to k (fu, fv) crosses the edge.
  const cross = a + ((fu - a) * b) / (fv + b);
  if (cross < 0 || cross > e) return Infinity;
  return Math.hypot(fu - a, fv + b);
}

/**
 * Like `relax`, but a node is also reached across each grid triangle from two settled corners as
 * a flat front would reach it, which follows the surface far closer than paths along grid edges
 * do. Paths along edges overstate the distance by a share that changes from node to node with how
 * the edges happen to lie, which roughens anything shaped by the distance.
 */
function march(
  model: WarpModel,
  seeds: Iterable<readonly [number, number]>,
  distance: Float64Array,
  through: Uint8Array,
  limit = Infinity,
) {
  const { grid, restNodes } = model;
  const { edgeStart, edges, triangles } = grid;
  const { start, triangle } = trianglesAt(grid);
  const done = new Uint8Array(grid.nodes.length);
  const heap = new Heap();
  for (const [n, d] of seeds)
    if (d <= limit && d < distance[n]) {
      distance[n] = d;
      heap.push(d, n);
    }
  const settled: number[] = [];
  const top = { distance: 0, node: 0 };
  const offer = (j: number, next: number) => {
    if (next <= limit && next < distance[j]) {
      distance[j] = next;
      heap.push(next, j);
    }
  };
  while (heap.size) {
    heap.pop(top);
    const { distance: d, node: i } = top;
    if (done[i] || d > distance[i]) continue;
    done[i] = 1;
    settled.push(i);
    for (let e = edgeStart[i]; e < edgeStart[i + 1]; e++) {
      const j = edges[e];
      if (!through[j] || done[j]) continue;
      offer(
        j,
        d +
          Math.hypot(
            restNodes[i * 3] - restNodes[j * 3],
            restNodes[i * 3 + 1] - restNodes[j * 3 + 1],
            restNodes[i * 3 + 2] - restNodes[j * 3 + 2],
          ),
      );
    }
    for (let e = start[i]; e < start[i + 1]; e++) {
      const t = triangle[e];
      for (let k = 0; k < 3; k++) {
        const j = triangles[t + k],
          m = triangles[t + ((k + 1) % 3)];
        if (j === i || m === i) continue;
        // j is the other settled corner and m the one to reach, either way round.
        if (done[j] && !done[m] && through[m])
          offer(m, acrossTriangle(restNodes, i, j, m, d, distance[j]));
        if (done[m] && !done[j] && through[j])
          offer(j, acrossTriangle(restNodes, i, m, j, d, distance[m]));
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
 * How far the distance marched over the grid may exceed the straight line, as a share of it, and
 * still count as the straight line. Marching overstates a flat distance by a few percent that
 * change from node to node, and a bend shaped by that is uneven.
 */
export const warpChordSlack = 0.05;

/**
 * The free nodes within `radius` of the footprint and the widest holding band and tail past it.
 * Distance is the straight-line distance plus however far the distance marched over the grid
 * exceeds it beyond `warpChordSlack`, so it is round on a flat area and cannot cross a fold to a
 * surface the grid does not join nearby.
 */
export function footprintReach(
  model: WarpModel,
  footprint: WarpFootprint,
  radius: number,
  key: unknown = footprint,
  curvedPoint = false,
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
    distance = own.map(() => 0),
    least = own.map(() => 1),
    release = own.map(() => 0);
  const ownSet = new Set(own);
  // The line's path nodes: their least share and how much of the radius's hold they let go.
  const share = new Map<number, number>(),
    letGo = new Map<number, number>();
  footprint.path.forEach((n, k) => {
    if (!eligible[n] || ownSet.has(n)) return;
    const weight = footprint.pathWeight[k],
      at0 = footprint.pathShare[k];
    const bound = smoothstep(weight / warpPathBound);
    share.set(n, at0 + activation * (bound - at0));
    letGo.set(n, bound);
  });
  const path = new Float64Array(grid.nodes.length).fill(Infinity);
  if (activation > 0) {
    const band = bandWidth(0, spacing) + warpTailSpacings * spacing;
    const limit = radius + band;
    const settled = curvedPoint
      ? relax(model, seeds, path, eligible, limit * warpPathStretch)
      : march(model, seeds, path, eligible, limit);
    for (const n of settled.sort((a, b) => a - b)) {
      if (ownSet.has(n)) continue;
      const line = straight(n);
      const d = curvedPoint
        ? Math.max(line, path[n] / warpPathStretch)
        : line + Math.max(0, path[n] - (1 + warpChordSlack) * line);
      if (d >= radius + band && !share.has(n)) continue;
      node.push(n);
      distance.push(d);
      least.push(share.get(n) ?? 0);
      release.push(letGo.get(n) ?? 0);
      share.delete(n);
    }
  }
  // Path nodes beyond the radius's reach.
  for (const [n, s] of [...share].sort((a, b) => a[0] - b[0]))
    if (s > 0) {
      node.push(n);
      distance.push(Infinity);
      least.push(s);
      release.push(letGo.get(n)!);
    }
  return {
    grid,
    radius,
    key,
    spacing,
    activation,
    curvedPoint,
    node: Uint32Array.from(node),
    own: own.length,
    distance: Float64Array.from(distance),
    sources: Float64Array.from(sources),
    least: Float64Array.from(least),
    release: Float64Array.from(release),
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
  const curvedPoint =
    handle.kind === 'point' && !flatPointPatch(model, handle.samples[0], handle.radius);
  return {
    ...handle,
    reach: footprintReach(model, footprint, handle.radius, footprint, curvedPoint),
  };
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

/** What a guiding handle's profile needs at any place, with its weights at each node it reaches. */
interface GuideProfile {
  handle: WarpHandle;
  reach: WarpReach;
  motion: number;
  offset: Vec3;
  fade: number;
  band: number;
  tail: number;
  weight: Float64Array;
  profile: Float64Array;
}

/**
 * A handle's driving weight and whole profile at distance `d` from its footprint, `border` from
 * the fixed edge, with the line's least share there, into `out`.
 */
function profileAt(
  p: Omit<GuideProfile, 'weight' | 'profile'>,
  d: number,
  border: number,
  least: number,
  out: [number, number],
) {
  const { handle, reach, motion, fade, band, tail } = p;
  const { radius, falloff } = handle;
  // A bend fades into the fixed border as it does at its radius, so the border does not crease.
  const w =
    handleWeight(d, radius, falloff, reach.spacing) * (fade > 0 ? smoothstep(border / fade) : 1);
  const held =
    d <= radius
      ? 1
      : d <= radius + band
        ? 1 - (1 - warpTailShare) * smoothstep((d - radius) / band)
        : warpTailShare * (1 - smoothstep((d - radius - band) / tail));
  out[0] = Math.max(least, reach.activation * w);
  out[1] = Math.max(least, reach.activation * ((1 - motion) * w + motion * held));
}

function guideProfile(
  handle: WarpHandle,
  border: Float64Array,
  carry?: ReadonlyMap<WarpHandle, number>,
): GuideProfile {
  const reach = handle.reach!;
  const share = carry?.get(handle) ?? 1;
  const p = {
    handle,
    reach,
    motion: motionOf(handle),
    offset: handleOffset(handle).map((value) => share * value) as Vec3,
    fade: fadeWidth(handle),
    band: bandWidth(handle.falloff, reach.spacing),
    tail: warpTailSpacings * reach.spacing,
  };
  const weight = new Float64Array(reach.node.length),
    profile = new Float64Array(reach.node.length);
  const out: [number, number] = [0, 0];
  for (let i = 0; i < reach.node.length; i++) {
    if (i < reach.own) {
      weight[i] = profile[i] = 1;
      continue;
    }
    profileAt(p, reach.distance[i], border[reach.node[i]], reach.least[i], out);
    weight[i] = out[0];
    profile[i] = out[1];
  }
  return { ...p, weight, profile };
}

/**
 * Soft per-node targets from the handles' radii. At each node it reaches, a handle with guides
 * has a profile: unmoved, its weight `w`, holding the surface softly over its radius; moved, 1
 * out to its radius and fading to 0 across the band past it. It drives the node toward its
 * baseline plus its whole offset at stiffness `w`, and holds it at its baseline for the rest of
 * the profile, so alone it targets `baseline + w × offset`. A line's path raises `w` to its
 * least share at the nodes the path is bound to and lets go of their hold by its release. A holding
 * term gives way by the largest driving weight any other moved handle has there, and so does all of
 * an unmoved handle's profile.
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
  const profiles = guiding.map((handle) => guideProfile(handle, border, carry));
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
      const hold = full * (profile[i] - weight[i]) * (1 - others) * (1 - reach.release[i]);
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

/** Each reach's entry index per grid node, -1 where it does not reach. */
const reachIndices = new WeakMap<WarpReach, Int32Array>();

function reachIndex(reach: WarpReach) {
  let index = reachIndices.get(reach);
  if (!index) {
    index = new Int32Array(reach.grid.nodes.length).fill(-1);
    for (let i = 0; i < reach.node.length; i++) index[reach.node[i]] = i;
    reachIndices.set(reach, index);
  }
  return index;
}

/** Straight-line distance from (x, y, z) to the nearest of a reach's sources. */
function straightTo(sources: Float64Array, x: number, y: number, z: number) {
  let d = Infinity;
  for (let s = 0; s < sources.length; s += 3)
    d = Math.min(d, Math.hypot(x - sources[s], y - sources[s + 1], z - sources[s + 2]));
  return d;
}

const reachExcesses = new WeakMap<WarpReach, { excess: Float64Array; slope: Float64Array }>();

/**
 * Per reach entry, how far its distance exceeds the straight line to the sources, and the
 * least-squares gradient of that excess over the node's grid edges to other entries, world, three
 * values each. The slope is NaN where an end has no finite distance.
 */
function reachExcess(reach: WarpReach, restNodes: Float64Array) {
  let found = reachExcesses.get(reach);
  if (found) return found;
  const { grid, node, sources } = reach;
  const distance = new Float64Array(node.length);
  for (let i = 0; i < node.length; i++) {
    const n = node[i];
    distance[i] =
      reach.distance[i] -
      straightTo(sources, restNodes[n * 3], restNodes[n * 3 + 1], restNodes[n * 3 + 2]);
  }
  const slope = new Float64Array(node.length * 3);
  const { edgeStart, edges } = grid;
  const index = reachIndex(reach);
  for (let i = 0; i < node.length; i++) {
    const n = node[i];
    let a00 = 0,
      a01 = 0,
      a02 = 0,
      a11 = 0,
      a12 = 0,
      a22 = 0,
      b0 = 0,
      b1 = 0,
      b2 = 0,
      usable = Number.isFinite(distance[i]);
    for (let e = edgeStart[n]; usable && e < edgeStart[n + 1]; e++) {
      const j = index[edges[e]];
      if (j < 0) continue;
      if (!Number.isFinite(distance[j])) {
        usable = false;
        break;
      }
      const m = node[j];
      const ex = restNodes[m * 3] - restNodes[n * 3],
        ey = restNodes[m * 3 + 1] - restNodes[n * 3 + 1],
        ez = restNodes[m * 3 + 2] - restNodes[n * 3 + 2];
      const dd = distance[j] - distance[i];
      a00 += ex * ex;
      a01 += ex * ey;
      a02 += ex * ez;
      a11 += ey * ey;
      a12 += ey * ez;
      a22 += ez * ez;
      b0 += ex * dd;
      b1 += ey * dd;
      b2 += ez * dd;
    }
    // A small ridge keeps the solve sound across the normal, which no edge spans.
    const ridge = 0.01 * (a00 + a11 + a22);
    a00 += ridge;
    a11 += ridge;
    a22 += ridge;
    const c00 = a11 * a22 - a12 * a12,
      c01 = a02 * a12 - a01 * a22,
      c02 = a01 * a12 - a02 * a11,
      c11 = a00 * a22 - a02 * a02,
      c12 = a01 * a02 - a00 * a12,
      c22 = a00 * a11 - a01 * a01;
    const det = a00 * c00 + a01 * c01 + a02 * c02;
    if (!usable || !(Math.abs(det) > 0)) {
      slope.fill(NaN, i * 3, i * 3 + 3);
      continue;
    }
    slope[i * 3] = (c00 * b0 + c01 * b1 + c02 * b2) / det;
    slope[i * 3 + 1] = (c01 * b0 + c11 * b1 + c12 * b2) / det;
    slope[i * 3 + 2] = (c02 * b0 + c12 * b1 + c22 * b2) / det;
  }
  reachExcesses.set(reach, (found = { excess: distance, slope }));
  return found;
}

/**
 * Rings of grid nodes over which the detail fades in from where something else holds the surface
 * or the profile is cut off. The solve smooths a cut-off profile over a few spacings, so the
 * profile does not describe the surface there.
 */
const detailRings = 6;

/** Per-vertex displacement added to the skinned surface: see `warpDetail`. */
export interface WarpDetail {
  /** Welded vertices it moves. */
  vertices: Uint32Array;
  /** World displacement per listed vertex, three values each. */
  delta: Float64Array;
}

/**
 * The bend the moved handles' guides ask for, as the surface between grid nodes should take it.
 * The guides set each node's target from its distance to the handle; skinning then interpolates
 * those targets between nodes, and where the profile turns sharply, as at a low falloff, that
 * leaves teeth a grid spacing apart and dips past the radius. Here each vertex takes the guides'
 * displacement at its own distance, measured to first order from its nodes, in place of what
 * skinning makes of the nodes' guided displacement. That is nothing at a node, and nothing
 * wherever the profile is even across the vertex's nodes, so only the vertices where it turns are
 * listed. It fades out toward nodes something else holds, and where the profile is cut off, as
 * at the edge of the paint. Undefined when no moved handle guides the surface.
 */
export function warpDetail(
  model: WarpModel,
  handles: readonly WarpHandle[],
  exact: Iterable<number> = [],
  carry?: ReadonlyMap<WarpHandle, number>,
  samplesOnly = false,
): WarpDetail | undefined {
  const { grid } = model;
  // Only moved handles bend the surface. An unmoved one holds the surface as it was when it was
  // made, detail and all, so making one changes nothing.
  const guiding = handles.filter(
    (handle) =>
      handle.target !== null &&
      handle.reach?.grid === grid &&
      handle.baseline.grid === grid &&
      !handle.reach?.curvedPoint &&
      handleGuides(handle),
  );
  if (!guiding.length) return undefined;
  if (samplesOnly) {
    // A grid-only drag uses detail just to aim its sample constraints. The surface is
    // evaluated in full when the gesture ends.
    const corners = new Set<number>();
    for (const handle of handles)
      for (const { face } of handle.samples)
        for (let c = 0; c < 3; c++)
          corners.add(model.region.weldOf[model.index?.[face * 3 + c] ?? face * 3 + c]);
    return buildWarpDetail(model, guiding, exact, carry, corners);
  }
  // A single point with no exact targets has the same held nodes in every direction.
  const point = guiding[0];
  const cached = selectionBases.get(model);
  if (
    guiding.length === 1 &&
    point.kind === 'point' &&
    motionOf(point) === 1 &&
    cached?.freePoint &&
    point.reach === cached.reaches[0] &&
    point.falloff === cached.falloffs[0] &&
    Array.isArray(exact) &&
    !exact.length
  ) {
    const share = carry?.get(point) ?? 1;
    if (!share) return undefined;
    return applyBasis(cached.detail, [handleOffset(point).map((x) => x * share) as Vec3]);
  }
  return buildWarpDetail(model, guiding, exact, carry);
}

// Three independent scalar responses fit in the x, y and z components of one skinning
// pass. Keep the last set per model while a selection of handles moves together.
interface DetailBasis {
  freePoint: boolean;
  reaches: WarpReach[];
  falloffs: number[];
  held: Uint8Array;
  detail: WarpDetail;
}

const selectionBases = new WeakMap<WarpModel, DetailBasis>();

function applyBasis(basis: WarpDetail, offsets: Vec3[]): WarpDetail {
  const { vertices, delta: gains } = basis;
  const delta = new Float64Array(gains.length);
  for (let h = 0; h < offsets.length; h++) {
    const [x, y, z] = offsets[h];
    for (let i = 0; i < delta.length; i += 3) {
      const gain = gains[i + h];
      delta[i] += gain * x;
      delta[i + 1] += gain * y;
      delta[i + 2] += gain * z;
    }
  }
  return { vertices, delta };
}

function buildWarpDetail(
  model: WarpModel,
  guiding: readonly WarpHandle[],
  exact: Iterable<number>,
  carry: ReadonlyMap<WarpHandle, number> | undefined,
  candidates: Iterable<number> = model.region.interior,
): WarpDetail | undefined {
  const { grid, restNodes, restWorld, binding } = model;
  const border = borderDistance(model);
  // The profile from distance alone: the footprint's and the path's shares are held exactly, and
  // only the distance turns between nodes.
  const profiles = guiding.map((handle) => {
    const p = guideProfile(handle, border, carry);
    const { reach } = p;
    const share: [number, number] = [0, 0];
    for (let i = 0; i < reach.node.length; i++) {
      profileAt(p, reach.distance[i], border[reach.node[i]], 0, share);
      p.weight[i] = share[0];
      p.profile[i] = share[1];
    }
    return p;
  });
  if (!profiles.some(({ motion, offset }) => motion > 0 && offset.some((x) => x !== 0)))
    return undefined;
  const count = grid.nodes.length;
  const H = profiles.length;

  // The guides' displacement at a place, from each handle's weight, profile and release there:
  // Σ drive × offset over Σ (drive + hold), as `warpGuides` weighs its target. The node's
  // stiffness scales every term alike, so it drops out.
  const weightAt = new Float64Array(H),
    profileAtH = new Float64Array(H),
    releaseAt = new Float64Array(H);
  const displacement = (out: Float64Array, o: number) => {
    let first = 0,
      second = 0,
      leader = -1;
    for (let h = 0; h < H; h++) {
      const m = weightAt[h] * profiles[h].motion;
      if (m > first) {
        second = first;
        first = m;
        leader = h;
      } else if (m > second) second = m;
    }
    let sum = 0,
      x = 0,
      y = 0,
      z = 0;
    for (let h = 0; h < H; h++) {
      const { motion, offset } = profiles[h];
      const others = leader === h ? second : first;
      const drive = weightAt[h] * (1 - (1 - motion) * others);
      const hold = (profileAtH[h] - weightAt[h]) * (1 - others) * (1 - releaseAt[h]);
      if (!(drive + hold > 0)) continue;
      sum += drive + hold;
      x += drive * offset[0];
      y += drive * offset[1];
      z += drive * offset[2];
    }
    out[o] = sum > 0 ? x / sum : 0;
    out[o + 1] = sum > 0 ? y / sum : 0;
    out[o + 2] = sum > 0 ? z / sum : 0;
  };

  // Each node's guided displacement.
  const indices = profiles.map(({ reach }) => reachIndex(reach));
  const guided = new Float64Array(count * 3);
  const writeGuided = () => {
    for (let n = 0; n < count; n++) {
      let any = false;
      for (let h = 0; h < H; h++) {
        const i = indices[h][n];
        weightAt[h] = i < 0 ? 0 : profiles[h].weight[i];
        profileAtH[h] = i < 0 ? 0 : profiles[h].profile[i];
        releaseAt[h] = i < 0 ? 0 : profiles[h].reach.release[i];
        any ||= i >= 0;
      }
      if (any) displacement(guided, n * 3);
    }
  };
  writeGuided();

  const { edgeStart, edges } = grid;
  // Where something other than the profile holds the surface: a moved line's or area's samples'
  // nodes, a line's path nodes, whose share comes from the path rather than the distance, and the
  // exact nodes. A moved point's own nodes are not among them: its profile is centred there.
  const held = new Uint8Array(count);
  for (const n of exact) held[n] = 1;
  for (const { reach } of profiles)
    for (let i = 0; i < reach.node.length; i++) if (reach.least[i] > 0) held[reach.node[i]] = 1;
  for (const { handle } of profiles) {
    if (handle.kind === 'point') continue;
    for (const { binding: sample } of handle.samples)
      sample.node.forEach((n, k) => {
        if (sample.weight[k] > 0) held[n] = 1;
      });
  }

  // Where the profile is cut off while it still moves the surface: fixed nodes, and nodes past
  // the edge of a handle's reach, as at the edge of the paint, beside a node the guides move. In
  // an unfeathered region the profile fades to nothing at the fixed edge, so nothing is cut there.
  let largest = 0;
  for (const { offset } of profiles) largest = Math.max(largest, Math.hypot(...offset));
  const alive = 1e-3 * largest;
  profiles.forEach(({ reach }, h) => {
    const index = indices[h];
    for (let i = 0; i < reach.node.length; i++) {
      const n = reach.node[i];
      if (Math.hypot(guided[n * 3], guided[n * 3 + 1], guided[n * 3 + 2]) <= alive) continue;
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
        const m = edges[e];
        if (grid.fixed[m] || index[m] < 0) held[m] = 1;
      }
    }
  });
  // Once fully engaged, the blend weights stay fixed as targets move. Its only
  // offset-dependent boundary is the set of held nodes, which we have just measured.
  const offsets =
    candidates === model.region.interior && H <= 3 && profiles.every((p) => p.motion === 1)
      ? profiles.map((p) => p.offset)
      : undefined;
  if (offsets) {
    const cached = selectionBases.get(model);
    if (
      cached &&
      cached.reaches.length === H &&
      profiles.every(
        (p, h) => p.reach === cached.reaches[h] && p.handle.falloff === cached.falloffs[h],
      ) &&
      held.every((x, n) => x === cached.held[n])
    )
      return applyBasis(cached.detail, offsets);
    profiles.forEach((p, h) => {
      p.offset = [0, 0, 0];
      p.offset[h] = 1;
    });
    writeGuided();
  }

  // Nodes whose guided displacement differs from a neighbour's, and the ring beside them: a
  // vertex bound only to nodes outside these sees an even profile.
  const turning = new Uint8Array(count);
  for (let n = 0; n < count; n++)
    for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) {
      const j = edges[e];
      if (
        Math.abs(guided[n * 3] - guided[j * 3]) +
          Math.abs(guided[n * 3 + 1] - guided[j * 3 + 1]) +
          Math.abs(guided[n * 3 + 2] - guided[j * 3 + 2]) >
        1e-9
      ) {
        turning[n] = 1;
        break;
      }
    }
  const near = turning.slice();
  for (let n = 0; n < count; n++)
    if (turning[n]) for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++) near[edges[e]] = 1;

  // Each node's share of the detail: none on those nodes, rising smoothly to all of it
  // `detailRings` rings of grid nodes from them, so the detail fades out instead of stopping short.
  const hops = new Uint8Array(count).fill(detailRings);
  let ring: number[] = [];
  for (let n = 0; n < count; n++)
    if (held[n]) {
      hops[n] = 0;
      ring.push(n);
    }
  for (let r = 1; r < detailRings && ring.length; r++) {
    const next: number[] = [];
    for (const n of ring)
      for (let e = edgeStart[n]; e < edgeStart[n + 1]; e++)
        if (hops[edges[e]] > r) {
          hops[edges[e]] = r;
          next.push(edges[e]);
        }
    ring = next;
  }
  const open = new Float64Array(count);
  // The ring beside them takes none either: its skin maps span the step.
  for (let n = 0; n < count; n++) open[n] = smoothstep((hops[n] - 1) / (detailRings - 1));

  const K = warpBindingNodes;
  const { node: bound, weight: bindWeight } = binding;
  const listed: number[] = [];
  for (const v of candidates)
    for (let k = 0; k < K; k++) {
      const n = bound[v * K + k];
      if (n !== 0xffffffff && near[n]) {
        listed.push(v);
        break;
      }
    }
  if (!listed.length) return undefined;

  // What skinning makes of the guided displacement alone, unturned.
  const positions = restNodes.slice(),
    rotations = new Float64Array(count * 4);
  for (let n = 0; n < count; n++) {
    rotations[n * 4 + 3] = 1;
    for (let a = 0; a < 3; a++) positions[n * 3 + a] += guided[n * 3 + a];
  }
  const skinned = skinnedWorldPositions(model, { positions, rotations }, listed);

  const excesses = profiles.map(({ reach }) => reachExcess(reach, restNodes));
  const share: [number, number] = [0, 0];
  const intended = new Float64Array(3);
  const gone = new Uint8Array(K);
  const vertices: number[] = [],
    delta: number[] = [];
  for (let l = 0; l < listed.length; l++) {
    const v = listed[l];
    if (Number.isNaN(skinned[l * 3])) continue;
    const px = restWorld[v * 3],
      py = restWorld[v * 3 + 1],
      pz = restWorld[v * 3 + 2];
    for (let h = 0; h < H; h++) {
      const p = profiles[h];
      const { reach } = p;
      const index = indices[h],
        { excess, slope } = excesses[h];
      // Where every node of the vertex has a slope, its own straight-line distance and the
      // nodes' excess over theirs to first order; otherwise the nodes' weights and profiles,
      // blended.
      let total = 0,
        d = 0,
        far = 0,
        release = 0,
        weight = 0,
        profile = 0,
        smooth = true;
      let reached = false;
      for (let k = 0; k < K; k++) {
        const n = bound[v * K + k];
        if (n === 0xffffffff) continue;
        const w = bindWeight[v * K + k];
        total += w;
        const i = index[n];
        if (i < 0) {
          smooth = false;
          continue;
        }
        reached = true;
        weight += w * p.weight[i];
        profile += w * p.profile[i];
        release += w * reach.release[i];
        far += w * border[n];
        if (Number.isNaN(slope[i * 3])) smooth = false;
        else
          d +=
            w *
            (excess[i] +
              slope[i * 3] * (px - restNodes[n * 3]) +
              slope[i * 3 + 1] * (py - restNodes[n * 3 + 1]) +
              slope[i * 3 + 2] * (pz - restNodes[n * 3 + 2]));
      }
      if (!(total > 0)) smooth = false;
      if (smooth) {
        const straight = straightTo(reach.sources, px, py, pz);
        profileAt(p, Math.max(straight, straight + d / total), far / total, 0, share);
        weightAt[h] = share[0];
        profileAtH[h] = share[1];
      } else {
        weightAt[h] = total > 0 ? weight / total : 0;
        profileAtH[h] = total > 0 ? profile / total : 0;
      }
      releaseAt[h] = total > 0 ? release / total : 0;
      // Nodes this handle does not reach, beside ones it does, have no distance to turn by.
      if (reached)
        for (let k = 0; k < K; k++) {
          const n = bound[v * K + k];
          if (n !== 0xffffffff && index[n] < 0) gone[k] = 1;
        }
    }
    let total = 0,
      opened = 0;
    for (let k = 0; k < K; k++) {
      const n = bound[v * K + k];
      if (n === 0xffffffff) continue;
      const w = bindWeight[v * K + k];
      total += w;
      if (!gone[k]) opened += w * open[n];
      gone[k] = 0;
    }
    const free = total > 0 ? opened / total : 0;
    if (!(free > 0)) continue;
    displacement(intended, 0);
    const dx = free * (intended[0] - (skinned[l * 3] - px)),
      dy = free * (intended[1] - (skinned[l * 3 + 1] - py)),
      dz = free * (intended[2] - (skinned[l * 3 + 2] - pz));
    if (!(Math.abs(dx) + Math.abs(dy) + Math.abs(dz) > 0)) continue;
    vertices.push(v);
    delta.push(dx, dy, dz);
  }
  const detail = { vertices: Uint32Array.from(vertices), delta: Float64Array.from(delta) };
  if (!offsets) return detail;
  selectionBases.set(model, {
    freePoint: H === 1 && guiding[0].kind === 'point' && Array.isArray(exact) && !exact.length,
    detail,
    held,
    reaches: profiles.map((p) => p.reach),
    falloffs: profiles.map((p) => p.handle.falloff),
  });
  return applyBasis(detail, offsets);
}

const shownDetails = new WeakMap<WarpOutput, WarpDetail | undefined>();

/** Records the detail a preview's output was written with. */
export function showDetail(output: WarpOutput, detail: WarpDetail | undefined) {
  shownDetails.set(output, detail);
}

/** The detail a preview's output was last written with: what a point made on it sits on. */
export const shownDetail = (output: WarpOutput | null | undefined) =>
  output ? shownDetails.get(output) : undefined;

const snapshotDetails = new WeakMap<WarpSnapshot, WarpDetail>();

/**
 * Records the detail a snapshot's surface was written with. A handle made on that surface holds it
 * as written, so carrying the snapshot to another grid carries the detail too.
 */
export function writeSnapshotDetail(snapshot: WarpSnapshot, detail: WarpDetail | undefined) {
  if (detail?.vertices.length) snapshotDetails.set(snapshot, detail);
  else snapshotDetails.delete(snapshot);
}

/** The detail a snapshot's surface was written with, if any. */
export const snapshotDetail = (snapshot: WarpSnapshot) => snapshotDetails.get(snapshot);

const detailSlots = new WeakMap<Uint32Array, Map<number, number>>();

/** The detail at a surface point: the blend of its face corners' by `barycentric`, world. */
export function detailAt(
  model: WarpModel,
  detail: WarpDetail | undefined,
  face: number,
  barycentric: ArrayLike<number>,
): Vec3 {
  const out: Vec3 = [0, 0, 0];
  if (!detail?.vertices.length) return out;
  let slots = detailSlots.get(detail.vertices);
  if (!slots) {
    slots = new Map();
    for (let i = 0; i < detail.vertices.length; i++) slots.set(detail.vertices[i], i);
    detailSlots.set(detail.vertices, slots);
  }
  for (let c = 0; c < 3; c++) {
    const corner = model.index ? model.index[face * 3 + c] : face * 3 + c;
    const i = slots.get(model.region.weldOf[corner]);
    if (i === undefined) continue;
    for (let a = 0; a < 3; a++) out[a] += barycentric[c] * detail.delta[i * 3 + a];
  }
  return out;
}

/** Where `state` writes a sample, detail included. */
export function writtenSample(
  model: WarpModel,
  state: Pick<WarpState, 'positions' | 'rotations'>,
  sample: Pick<WarpSample, 'face' | 'barycentric' | 'binding' | 'restWorld'>,
  detail?: WarpDetail,
): Vec3 {
  const at = deformPoint(model, state, sample.binding, sample.restWorld);
  const extra = detailAt(model, detail, sample.face, sample.barycentric);
  return [at[0] + extra[0], at[1] + extra[1], at[2] + extra[2]];
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
 * maps beside them above `warpMapFloor`. `constraints` and `guides` are what the solve is given,
 * the handles' constraints first in order. Handles on fully free surface with no pin they would
 * move are never in the map.
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
        : Math.max(
            reach.least[i],
            reach.activation *
              handleWeight(reach.distance[i], handle.radius, handle.falloff, reach.spacing),
          );
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
 * it was written. The detail the snapshot was written with is carried along too, so each node of
 * `to` sits where its vertex was shown.
 */
export function transferSnapshot(
  from: WarpModel,
  snapshot: WarpSnapshot,
  to: WarpModel,
  detail = snapshotDetail(snapshot),
): WarpSnapshot {
  const K = warpBindingNodes;
  // A snapshot of the untouched surface is carried as rest exactly, so it still reads as untouched.
  if (!detail?.vertices.length && atRest(from, snapshot)) {
    const rotations = new Float64Array(to.grid.nodes.length * 4);
    for (let n = 0; n < to.grid.nodes.length; n++) rotations[n * 4 + 3] = 1;
    return {
      grid: to.grid,
      positions: to.restNodes.slice(),
      rotations,
      settled: false,
      converged: false,
    };
  }
  const { binding, restWorld } = from;
  const { rotations: Q } = snapshot;
  const count = to.grid.nodes.length;
  const positions = to.restNodes.slice(),
    rotations = new Float64Array(count * 4);
  const skinned = skinnedWorldPositions(from, snapshot, to.grid.nodes);
  if (detail?.vertices.length) {
    const slot = new Map<number, number>();
    to.grid.nodes.forEach((v, n) => slot.set(v, n));
    detail.vertices.forEach((v, i) => {
      const n = slot.get(v);
      if (n === undefined || Number.isNaN(skinned[n * 3])) return;
      for (let a = 0; a < 3; a++) skinned[n * 3 + a] += detail.delta[i * 3 + a];
    });
  }
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

/** Whether a snapshot holds every node of `model` at rest, unturned. */
function atRest(model: WarpModel, { positions, rotations }: WarpSnapshot) {
  for (let i = 0; i < positions.length; i++) if (positions[i] !== model.restNodes[i]) return false;
  for (let n = 0; n < rotations.length; n += 4)
    if (rotations[n] || rotations[n + 1] || rotations[n + 2] || rotations[n + 3] !== 1)
      return false;
  return true;
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
