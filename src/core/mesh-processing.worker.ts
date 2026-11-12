/// <reference lib="webworker" />
import { processMesh } from './mesh-processing';
import type { MeshProcessOptions } from './mesh-processing';
import type { BinaryGeometry } from './types';

self.onmessage = async ({
  data,
}: MessageEvent<{ mesh: BinaryGeometry; options: MeshProcessOptions }>) => {
  try {
    const result = await processMesh(data.mesh, data.options);
    const transfer = Object.values(result.mesh)
      .filter((array) => array !== undefined)
      .map((array) => array.buffer);
    self.postMessage(result, { transfer });
  } catch (error) {
    self.postMessage({ errorMessage: (error as Error).message });
  }
};
