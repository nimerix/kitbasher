import { MeshoptSimplifier } from '../vendor/meshoptimizer/simplifier';
import { deserializeGeometry } from './geometry';
import type { BinaryGeometry } from './types';
import { hasClosedEdges } from './mesh-topology';

export type MeshProcessOptions =
  | { mode: 'decimate'; ratio: number; error: number; lockBorder: boolean }
  | { mode: 'remesh'; resolution: number };

export interface MeshKernelBackend {
  reduce(
    data: BinaryGeometry,
    target: number,
    error: number,
    lockBorder: boolean,
  ): Promise<[Uint32Array, number]> | [Uint32Array, number];
  remesh(data: BinaryGeometry, resolution: number): Promise<Float32Array> | Float32Array;
}

export const wasmMeshKernels: MeshKernelBackend = {
  reduce(data, target, error, lockBorder) {
    const indices = data.indices as Uint32Array;
    const flags = lockBorder ? ['LockBorder' as const] : [];
    return data.colors
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
  },
  remesh(data, resolution) {
    return MeshoptSimplifier.remesh(data.indices as Uint32Array, data.positions, 3, resolution);
  },
};

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
      const from = i * 3,
        to = remap[i] * 3;
      target[to] = source[from];
      target[to + 1] = source[from + 1];
      target[to + 2] = source[from + 2];
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

/** Owns one immutable source snapshot and reuses its welded topology across attempts. */
export class MeshProcessor {
  private prepared?: BinaryGeometry;
  private closed?: boolean;
  constructor(
    private data: BinaryGeometry | undefined,
    private readonly kernels = wasmMeshKernels,
  ) {}

  async process(options: MeshProcessOptions, onProgress?: (detail: string) => void) {
    if (!options || !['decimate', 'remesh'].includes(options.mode))
      throw new Error('Choose reduction or remeshing.');
    if (options.mode === 'decimate') {
      if (!(options.ratio > 0 && options.ratio <= 1) || !(options.error >= 0 && options.error <= 1))
        throw new Error(
          'Choose a triangle percentage above 0 and at most 100, and a valid error limit.',
        );
    } else if (
      !Number.isInteger(options.resolution) ||
      options.resolution < 24 ||
      options.resolution > 128
    ) {
      throw new Error('Voxel resolution must be between 24 and 128.');
    }
    if (!this.prepared) {
      onProgress?.('Validating mesh');
      // Check imported data without computing normals and bounds only to discard them.
      deserializeGeometry(this.data!, false).dispose();
      onProgress?.('Loading mesh processor');
      await MeshoptSimplifier.ready;
      onProgress?.('Welding identical vertices');
      this.prepared = compact(this.data!, weldedIndices(this.data!));
      this.data = undefined;
    } else onProgress?.('Reusing prepared mesh');
    const data = this.prepared;
    const indices = data.indices as Uint32Array;
    if (options.mode === 'decimate') {
      const target = Math.max(3, Math.floor((indices.length / 3) * options.ratio) * 3);
      onProgress?.('Reducing triangles');
      const [reduced, deviation] = await this.kernels.reduce(
        data,
        target,
        options.error,
        options.lockBorder,
      );
      if (!reduced.length)
        throw new Error(
          'The reduction would remove the entire mesh. Use a higher triangle target.',
        );
      onProgress?.('Packing reduced mesh');
      return { mesh: compact(data, reduced), error: deviation as number | null };
    }
    if (this.closed === undefined) {
      onProgress?.('Checking closed surface');
      this.closed = hasClosedEdges(indices, data.positions.length / 3, true);
    }
    if (!this.closed)
      throw new Error(
        'Voxel remeshing requires a closed, manifold mesh. Repair open edges first, or use Decimate.',
      );
    onProgress?.('Rebuilding surface on voxel grid');
    const positions = await this.kernels.remesh(data, options.resolution);
    if (!positions.length)
      throw new Error('No surface survived at this resolution. Increase voxel resolution.');
    if (positions.length / 9 > 1_000_000)
      throw new Error('The remesh exceeded one million triangles. Lower voxel resolution.');
    return { mesh: { positions } as BinaryGeometry, error: null };
  }
}

export async function processMesh(
  data: BinaryGeometry,
  options: MeshProcessOptions,
  onProgress?: (detail: string) => void,
) {
  return new MeshProcessor(data).process(options, onProgress);
}

export async function decimateMesh(
  data: BinaryGeometry,
  ratio: number,
  error: number,
  lockBorder = true,
  onProgress?: (detail: string) => void,
) {
  return processMesh(data, { mode: 'decimate', ratio, error, lockBorder }, onProgress);
}

export async function remeshMesh(
  data: BinaryGeometry,
  resolution: number,
  onProgress?: (detail: string) => void,
): Promise<BinaryGeometry> {
  return (await processMesh(data, { mode: 'remesh', resolution }, onProgress)).mesh;
}
