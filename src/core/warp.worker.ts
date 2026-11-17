/// <reference lib="webworker" />
import { buildWarpModel, type WarpModelInput } from './warp-model';

self.onmessage = async ({ data }: MessageEvent<WarpModelInput>) => {
  try {
    const model = await buildWarpModel(data);
    const buffers = new Set<ArrayBufferLike>();
    const collect = (value: unknown) => {
      if (ArrayBuffer.isView(value)) buffers.add(value.buffer);
      else if (value && typeof value === 'object') Object.values(value).forEach(collect);
    };
    collect(model);
    const transfer = [...buffers].filter(
      (buffer): buffer is ArrayBuffer => buffer instanceof ArrayBuffer,
    );
    self.postMessage({ model }, { transfer });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
