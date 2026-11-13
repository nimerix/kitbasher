/// <reference lib="webworker" />
import { MeshProcessor } from './mesh-processing';
import type { MeshProcessOptions } from './mesh-processing';
import type { BinaryGeometry } from './types';
import { deserializeGeometry } from './geometry';
import { snapshotGeometry, snapshotBuffers } from './geometry-transfer';

let cached: { key: string; processor: MeshProcessor } | undefined;

self.onmessage = async ({
  data,
}: MessageEvent<{
  mesh?: BinaryGeometry;
  key: string;
  retain: boolean;
  options: MeshProcessOptions;
}>) => {
  try {
    if (data.mesh) cached = { key: data.key, processor: new MeshProcessor(data.mesh) };
    if (!cached || cached.key !== data.key)
      throw new Error('The prepared mesh is no longer available. Try again.');
    const result = await cached.processor.process(data.options, (detail) => {
      self.postMessage({ type: 'progress', detail });
    });
    self.postMessage({ type: 'progress', detail: 'Returning processed mesh' });
    const geometry = deserializeGeometry(result.mesh);
    const snapshot = snapshotGeometry(geometry);
    self.postMessage(
      { geometry: snapshot, error: result.error },
      { transfer: snapshotBuffers(snapshot) },
    );
    geometry.dispose();
  } catch (error) {
    self.postMessage({ errorMessage: (error as Error).message });
  } finally {
    if (!data.retain) cached = undefined;
  }
};
