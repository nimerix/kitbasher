import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import { weldedPositionIndex } from './mesh-topology';
import { bindRegion, type WarpBinding } from './warp-bind';
import { featherBlend, growWarpRegion } from './warp-feather';
import { buildWarpGrid, type WarpGrid } from './warp-grid';
import { buildWarpRegion, regionTriangleOf, WarpRole, type WarpRegion } from './warp-region';

export interface WarpModelInput {
  /** Copies: the worker job transfers them. */
  positions: Float32Array;
  index: Uint32Array | null;
  normals: Float32Array | null;
  /** partMatrix(part).elements */
  matrix: number[];
  faces: number[] | null;
  density: number;
  /** Feathered edge width in mm, for painted faces. 0 or absent keeps the painted edge fixed. */
  feather?: number;
}

export interface WarpFeather {
  /** Requested width, mm. */
  width: number;
  /** Unpainted faces that joined the region. 0 when the mesh beside the paint is too coarse. */
  joined: number;
  /** Painted vertices where the paint meets unpainted surface. 0 when nothing borders the paint. */
  edge: number;
  /** Painted vertices left on the outer border, where nothing could join. */
  fixedEdge: number;
  /** Connected pieces the band would have covered entirely, where its farthest ring stays fixed. */
  anchored: number;
  /** A piece of the grown region still had no fixed grid nodes, so the feather was dropped. */
  unanchored: boolean;
}

/** The one feather warning the panel shows, if any. */
export function featherWarning(
  feather: WarpFeather | null | undefined,
): 'unanchored' | 'anchored' | 'coarse' | null {
  if (!feather) return null;
  if (feather.unanchored) return 'unanchored';
  if (feather.anchored) return 'anchored';
  if (feather.joined === 0 && feather.edge > 0) return 'coarse';
  return null;
}

export interface WarpModel {
  region: WarpRegion;
  grid: WarpGrid;
  binding: WarpBinding;
  /** Per welded vertex. */
  restWorld: Float64Array;
  /** Per node, world. */
  restNodes: Float64Array;
  matrix: number[];
  inverse: number[];
  /** Original local positions, never mutated. */
  positions: Float32Array;
  index: Uint32Array | null;
  normals: Float32Array | null;
  indexed: boolean;
  /** How the feathered edge was built, or null when feathering was off. */
  feather: WarpFeather | null;
  /**
   * Per welded vertex: how much of the solved displacement is written. 1 on every vertex of a
   * painted face, 0 on the outer border, and below 1 across the feather band. Null when nothing
   * is feathered, which writes the whole displacement everywhere.
   */
  blend: Float32Array | null;
  /** Per region triangle, 1 when painted. Null when every region triangle is painted. */
  painted: Uint8Array | null;
}

export async function buildWarpModel(input: WarpModelInput): Promise<WarpModel> {
  const { positions, index, normals, matrix, faces, density, feather: width = 0 } = input;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  if (index) geometry.setIndex(new BufferAttribute(index, 1));

  const weld = weldedPositionIndex(geometry);
  const growth =
    faces?.length && width > 0
      ? growWarpRegion(weld.indices, weld.vertices, positions, index, matrix, faces, width)
      : null;
  let grown = growth && growth.joined > 0 ? growth : null;
  let region = buildWarpRegion(
    geometry,
    grown ? grown.faces : faces,
    weld,
    grown ? grown.pinned : undefined,
  );
  let grid = await buildWarpGrid(region, density);
  let unanchored = false;
  if (grown && !bandPiecesHeld(region, grid, grown.paintedFace)) {
    unanchored = true;
    grown = null;
    region = buildWarpRegion(geometry, faces, weld);
    grid = await buildWarpGrid(region, density);
  }

  const m = matrix;
  const restWorld = new Float64Array(region.rest.length);
  for (let i = 0; i < region.rest.length; i += 3) {
    const x = region.rest[i],
      y = region.rest[i + 1],
      z = region.rest[i + 2];
    restWorld[i] = m[0] * x + m[4] * y + m[8] * z + m[12];
    restWorld[i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13];
    restWorld[i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  }
  const restNodes = new Float64Array(grid.nodes.length * 3);
  for (let n = 0; n < grid.nodes.length; n++)
    for (let a = 0; a < 3; a++) restNodes[n * 3 + a] = restWorld[grid.nodes[n] * 3 + a];

  const binding = bindRegion(region, grid, restWorld);
  const inverse = new Matrix4().fromArray(matrix).invert().elements.slice();

  let feather: WarpFeather | null = null,
    blend: Float32Array | null = null,
    painted: Uint8Array | null = null;
  if (growth) {
    let fixedEdge = 0;
    for (let v = 0; v < region.weldedCount; v++)
      if (growth.paintedVertex[v] && region.role[v] === WarpRole.Border) fixedEdge++;
    feather = {
      width,
      joined: growth.joined,
      edge: growth.edge,
      fixedEdge,
      anchored: growth.anchored,
      unanchored,
    };
  }
  if (grown) {
    blend = featherBlend(region, matrix, grown.paintedVertex);
    painted = new Uint8Array(region.faces.length);
    for (let t = 0; t < painted.length; t++) painted[t] = grown.paintedFace[region.faces[t]];
  }
  return {
    region,
    grid,
    binding,
    restWorld,
    restNodes,
    matrix,
    inverse,
    positions,
    index,
    normals,
    indexed: index !== null,
    feather,
    blend,
    painted,
  };
}

/**
 * Whether every edge-connected piece of the region that holds band faces has at least two fixed
 * grid nodes. One alone lets the piece swing about it.
 */
function bandPiecesHeld(region: WarpRegion, grid: WarpGrid, paintedFace: Uint8Array) {
  const { weldedCount, triangles, faces } = region;
  const count = faces.length;
  const start = new Uint32Array(weldedCount + 1);
  for (let i = 0; i < triangles.length; i++) start[triangles[i] + 1]++;
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const incident = new Uint32Array(triangles.length);
  const fill = start.slice(0, weldedCount);
  for (let i = 0; i < triangles.length; i++) incident[fill[triangles[i]]++] = (i - (i % 3)) / 3;

  const piece = new Int32Array(count).fill(-1);
  const counted = new Int32Array(weldedCount).fill(-1);
  const stack: number[] = [];
  for (let seed = 0; seed < count; seed++) {
    if (piece[seed] >= 0) continue;
    let band = false,
      fixed = 0;
    piece[seed] = seed;
    stack.push(seed);
    while (stack.length) {
      const t = stack.pop()!;
      if (!paintedFace[faces[t]]) band = true;
      for (let k = 0; k < 3; k++) {
        const a = triangles[t * 3 + k],
          b = triangles[t * 3 + ((k + 1) % 3)];
        const node = grid.nodeOf[a];
        if (node !== 0xffffffff && grid.fixed[node] && counted[a] !== seed) {
          counted[a] = seed;
          fixed++;
        }
        if (a === b) continue;
        for (let e = start[a]; e < start[a + 1]; e++) {
          const u = incident[e];
          if (
            piece[u] < 0 &&
            (triangles[u * 3] === b || triangles[u * 3 + 1] === b || triangles[u * 3 + 2] === b)
          ) {
            piece[u] = seed;
            stack.push(u);
          }
        }
      }
    }
    if (band && fixed < 2) return false;
  }
  return true;
}

/** Whether a geometry face is painted: in the region and, when feathered, not in the band. */
export function isPaintedFace(model: WarpModel, face: number) {
  const triangle = regionTriangleOf(model.region, face);
  return triangle >= 0 && (!model.painted || model.painted[triangle] === 1);
}

/** Whether a grid node sits on the paint, including on its edge. Fixed nodes can be painted too. */
export function isPaintedNode(model: WarpModel, node: number) {
  return !model.blend || model.blend[model.grid.nodes[node]] === 1;
}

const nodeBlends = new WeakMap<WarpModel, Float32Array>();

/** Each grid node's blend, or null when nothing is feathered and every node blends fully. */
export function warpNodeBlend(model: WarpModel): Float32Array | null {
  if (!model.blend) return null;
  let blend = nodeBlends.get(model);
  if (!blend) {
    const { nodes } = model.grid;
    blend = new Float32Array(nodes.length);
    for (let n = 0; n < nodes.length; n++) blend[n] = model.blend[nodes[n]];
    nodeBlends.set(model, blend);
  }
  return blend;
}
