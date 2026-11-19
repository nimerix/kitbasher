export const MIN_REMESH_RESOLUTION = 24;
export const DEFAULT_REMESH_RESOLUTION = 128;
export const MAX_REMESH_RESOLUTION = 256;

export function isRemeshResolution(resolution: number) {
  return (
    Number.isInteger(resolution) &&
    resolution >= MIN_REMESH_RESOLUTION &&
    resolution <= MAX_REMESH_RESOLUTION
  );
}
