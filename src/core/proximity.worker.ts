import { Matrix4 } from 'three';
import { restoreGeometry } from './geometry-transfer';
import { bakeProximityField, proximityGrid } from './proximity';
import type { ProximityField, ProximitySource } from './proximity';
import { gpuSurfaceDistances } from './surface-distance';
import type { ProximityRequest } from './proximity-job';

async function acceleratedField(
  sources: ProximitySource[],
  request: ProximityRequest,
): Promise<ProximityField | null> {
  if (request.gpu === false || !navigator.gpu) return null;
  const grid = proximityGrid(sources, request.reach, request.limits);
  if (!grid) return null;
  const [nx, ny, nz] = grid.size,
    [ox, oy, oz] = grid.origin;
  if (nx * ny * nz < 32_768 && !request.allowSoftware) return null;
  const points = new Float32Array(nx * ny * nz * 3);
  for (let z = 0, i = 0; z < nz; z++)
    for (let y = 0; y < ny; y++)
      for (let x = 0; x < nx; x++, i += 3) {
        points[i] = ox + x * grid.cell;
        points[i + 1] = oy + y * grid.cell;
        points[i + 2] = oz + z * grid.cell;
      }
  const distances = await gpuSurfaceDistances(sources, points, grid.range, request.allowSoftware);
  if (!distances) return null;
  const data = new Uint8Array(distances.length),
    scale = 255 / grid.range;
  for (let i = 0; i < data.length; i++) data[i] = Math.min(255, Math.round(distances[i] * scale));
  return { ...grid, data };
}

self.onmessage = async ({ data: request }: { data: ProximityRequest }) => {
  const sources = request.sources.map((source) => ({
    geometry: restoreGeometry(source.geometry),
    matrix: new Matrix4().fromArray(source.matrix),
  }));
  try {
    let field = await acceleratedField(sources, request);
    let backend = 'webgpu';
    if (!field) {
      backend = 'cpu';
      const task = bakeProximityField(sources, request.reach, request.limits);
      let next = task.next();
      while (!next.done) next = task.next();
      field = next.value;
    }
    self.postMessage({ field, backend }, { transfer: field ? [field.data.buffer] : [] });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  } finally {
    sources.forEach((source) => source.geometry.dispose());
  }
};
