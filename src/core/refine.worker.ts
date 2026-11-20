/// <reference lib="webworker" />
import { type RefineRequest, buffersOf, runRefineRequest } from './refine-model';

self.onmessage = ({ data }: MessageEvent<RefineRequest>) => {
  try {
    const result = runRefineRequest(data, (fraction) =>
      self.postMessage({ type: 'progress', fraction }),
    );
    self.postMessage({ result }, { transfer: buffersOf(result) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
