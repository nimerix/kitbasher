import { MeshoptSimplifier } from 'meshoptimizer/simplifier';
import { deserializeGeometry } from './geometry';
import type { BinaryGeometry } from './types';

export type MeshProcessOptions =
  | { mode: 'decimate'; ratio: number; error: number; lockBorder: boolean }
  | { mode: 'remesh'; resolution: number };

/** Exact position welding makes triangle-soup scans usable by the simplifier. */
function weldedIndices(data: BinaryGeometry) {
  const remap = MeshoptSimplifier.generatePositionRemap(data.positions, 3);
  const count = data.indices?.length ?? data.positions.length / 3;
  const indices = new Uint32Array(count);
  for (let i = 0; i < count; i++) indices[i] = remap[data.indices?.[i] ?? i];
  return indices;
}

function compact(data: BinaryGeometry, indices: Uint32Array): BinaryGeometry {
  const [remap, count] = MeshoptSimplifier.compactMesh(indices);
  const copy = (source?: Float32Array) => {
    if (!source) return undefined;
    const target = new Float32Array(count * 3);
    for (let i = 0; i < remap.length; i++) {
      if (remap[i] === 0xffffffff) continue;
      target.set(source.subarray(i * 3, i * 3 + 3), remap[i] * 3);
    }
    return target;
  };
  return {
    positions: copy(data.positions)!,
    indices,
    colors: copy(data.colors),
    normals: copy(data.normals),
  };
}

export async function decimateMesh(
  data: BinaryGeometry,
  ratio: number,
  error: number,
  lockBorder = true,
) {
  if (!(ratio > 0 && ratio <= 1) || !(error >= 0 && error <= 1))
    throw new Error(
      'Choose a triangle percentage above 0 and at most 100, and a valid error limit.',
    );
  await MeshoptSimplifier.ready;
  data = compact(data, weldedIndices(data));
  const indices = data.indices as Uint32Array;
  const target = Math.max(3, Math.floor((indices.length / 3) * ratio) * 3);
  const flags = lockBorder ? ['LockBorder' as const] : [];
  const [reduced, deviation] = data.colors
    ? MeshoptSimplifier.simplifyWithAttributes(
        indices,
        data.positions,
        3,
        data.colors,
        3,
        [1, 1, 1],
        null,
        target,
        error,
        flags,
      )
    : MeshoptSimplifier.simplify(indices, data.positions, 3, target, error, flags);
  if (!reduced.length)
    throw new Error('The reduction would remove the entire mesh. Use a higher triangle target.');
  return { mesh: compact(data, reduced), error: deviation };
}

/** Rebuilds a closed surface on a voxel grid using meshoptimizer's WASM remesher. */
export async function remeshMesh(
  data: BinaryGeometry,
  resolution: number,
): Promise<BinaryGeometry> {
  if (!Number.isInteger(resolution) || resolution < 24 || resolution > 128)
    throw new Error('Voxel resolution must be between 24 and 128.');
  await MeshoptSimplifier.ready;
  data = compact(data, weldedIndices(data));
  const indices = data.indices as Uint32Array;
  // Open surfaces have no unambiguous interior. Reject instead of silently sealing holes.
  // Sorted numeric keys keep this check bounded to eight bytes per triangle edge.
  const vertices = data.positions.length / 3;
  if (vertices * vertices > Number.MAX_SAFE_INTEGER)
    throw new Error('This scan is too large to remesh. Decimate it first.');
  const edges = new Float64Array(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    if (a === b || b === c || a === c) continue;
    edges[count++] = Math.min(a, b) * vertices + Math.max(a, b);
    edges[count++] = Math.min(b, c) * vertices + Math.max(b, c);
    edges[count++] = Math.min(c, a) * vertices + Math.max(c, a);
  }
  const sorted = edges.subarray(0, count).sort();
  for (let i = 0; i < count;) {
    let end = i + 1;
    while (end < count && sorted[end] === sorted[i]) end++;
    if (end - i !== 2)
      throw new Error(
        'Voxel remeshing requires a closed, manifold mesh. Repair open edges first, or use Decimate.',
      );
    i = end;
  }
  const positions = MeshoptSimplifier.remesh(indices, data.positions, 3, resolution);
  if (!positions.length)
    throw new Error('No surface survived at this resolution. Increase voxel resolution.');
  if (positions.length / 9 > 1_000_000)
    throw new Error('The remesh exceeded one million triangles. Lower voxel resolution.');
  // Normals are regenerated on load. Material tint remains on the part.
  return { positions };
}

export async function processMesh(data: BinaryGeometry, options: MeshProcessOptions) {
  // Validate worker input using the same rules as imported geometry.
  const validated = deserializeGeometry(data);
  validated.dispose();
  if (options.mode === 'decimate')
    return decimateMesh(data, options.ratio, options.error, options.lockBorder);
  return { mesh: await remeshMesh(data, options.resolution), error: null };
}
