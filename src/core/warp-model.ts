import { BufferAttribute, BufferGeometry, Matrix4 } from 'three';
import { bindRegion, type WarpBinding } from './warp-bind';
import { buildWarpGrid, type WarpGrid } from './warp-grid';
import { buildWarpRegion, type WarpRegion } from './warp-region';

export interface WarpModelInput {
  /** Copies: the worker job transfers them. */
  positions: Float32Array;
  index: Uint32Array | null;
  normals: Float32Array | null;
  /** partMatrix(part).elements */
  matrix: number[];
  faces: number[] | null;
  density: number;
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
}

export async function buildWarpModel(input: WarpModelInput): Promise<WarpModel> {
  const { positions, index, normals, matrix, faces, density } = input;
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(positions, 3));
  if (normals) geometry.setAttribute('normal', new BufferAttribute(normals, 3));
  if (index) geometry.setIndex(new BufferAttribute(index, 1));

  const region = buildWarpRegion(geometry, faces);
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
  };
}
