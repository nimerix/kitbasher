import type { BufferGeometry } from 'three';
import { appendGeometry, readGeometry, validateLayout } from './scene-file';
import type { MeshProcessOptions } from './mesh-processing';

let capabilities:
  Promise<{ native: boolean; modes: string[]; minTriangles: number } | null> | undefined;
/** Available only in the authenticated local/shared session, with an installed native helper. */
export async function processMeshLocally(
  geometry: BufferGeometry,
  options: MeshProcessOptions,
  signal: AbortSignal,
) {
  capabilities ??= fetch('live/compute', { signal: AbortSignal.timeout(2000) })
    .then(async (response) => (response.ok ? await response.json() : null))
    .catch(() => null);
  const policy = await capabilities;
  if (
    !policy?.native ||
    !policy.modes?.includes(options.mode) ||
    signal.aborted ||
    (geometry.index?.count ?? geometry.attributes.position.count) / 3 < policy.minTriangles
  )
    return undefined;
  const parts: BlobPart[] = [];
  const { layout } = appendGeometry(geometry, parts, 0);
  const body = new Blob(parts);
  if (body.size > 256 * 1024 * 1024) return undefined;
  try {
    const response = await fetch('live/process', {
      method: 'POST',
      body,
      signal,
      headers: {
        'X-Kitbasher-Layout': JSON.stringify(layout),
        'X-Kitbasher-Options': JSON.stringify(options),
      },
    });
    if (!response.ok) return undefined;
    const result = await response.blob();
    const resultLayout = JSON.parse(response.headers.get('X-Kitbasher-Layout')!);
    validateLayout(resultLayout, 0, result.size);
    return {
      geometry: await readGeometry(result, resultLayout),
      error: JSON.parse(response.headers.get('X-Kitbasher-Error')!),
    } as { geometry: BufferGeometry; error: number | null };
  } catch (error) {
    if (signal.aborted) throw error;
    // An unavailable host never prevents the browser's own WASM path from running.
    return undefined;
  }
}
