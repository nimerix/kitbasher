/// <reference lib="webworker" />
import { inspectMeshes } from './inspection';
import type { InspectionRequest, InspectionResponse } from './inspection-types';

self.onmessage = (event: MessageEvent<InspectionRequest>) => {
  try {
    let lastUpdate = -Infinity;
    let lastStage = '';
    const result = inspectMeshes(event.data, (progress) => {
      const now = performance.now();
      // BVH construction can report every leaf. Keep the UI responsive without flooding it.
      if (progress.stage !== lastStage || now - lastUpdate >= 100) {
        lastStage = progress.stage;
        lastUpdate = now;
        self.postMessage({ progress } satisfies InspectionResponse);
      }
    });
    const transfer = [...result.overlaps, ...result.surfaces].map(
      (surface) => surface.positions.buffer,
    );
    self.postMessage({ result } satisfies InspectionResponse, { transfer });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
