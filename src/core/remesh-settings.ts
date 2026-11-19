export const MIN_REMESH_RESOLUTION = 24;
export const DEFAULT_REMESH_RESOLUTION = 128;
export const MAX_REMESH_RESOLUTION = 1024;
/** meshoptimizer's dense grid handles resolutions up to this; higher ones use the sparse remesher. */
export const DENSE_REMESH_RESOLUTION = 256;

export function isRemeshResolution(resolution: number) {
  return (
    Number.isInteger(resolution) &&
    resolution >= MIN_REMESH_RESOLUTION &&
    resolution <= MAX_REMESH_RESOLUTION
  );
}

/** Sparse remeshing keeps about 70 bytes of working data per occupied voxel plus 12 per
 * triangle. These caps bound a remesh to under 1 GB and keep its result within the app's
 * 10 million triangle tools. A 32 mm sphere fits at the maximum resolution; a cube does not. */
export const SPARSE_REMESH_MAX_VOXELS = 6_000_000;
export const SPARSE_REMESH_MAX_TRIANGLES = 10_000_000;
