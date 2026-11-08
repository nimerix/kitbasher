/// <reference lib="webworker" />
import { inspectMeshes } from './inspection';
import type { InspectionRequest } from './inspection-types';

self.onmessage = (event: MessageEvent<InspectionRequest>) => {
  try {
    const result = inspectMeshes(event.data);
    const transfer = [...result.overlaps, ...result.surfaces].map(
      (surface) => surface.positions.buffer,
    );
    self.postMessage({ result }, { transfer });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
