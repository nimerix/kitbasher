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
  /** Painted vertices left on the outer border, where nothing could join. */
  fixedEdge: number;
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
  const grown = growth && growth.joined > 0 ? growth : null;
  const region = buildWarpRegion(geometry, grown ? grown.faces : faces, weld);
  const grid = await buildWarpGrid(region, density);

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
    feather = { width, joined: growth.joined, fixedEdge };
  }
  if (grown) {
    blend = featherBlend(region, restWorld, grown.paintedVertex);
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
