/// <reference lib="webworker" />
import { inspectMeshes } from './inspection';
import type { InspectionRequest, InspectionResponse } from './inspection-types';

self.onmessage = (event: MessageEvent<InspectionRequest>) => {
  try {
    let lastUpdate = -Infinity;
    let lastStage = '';
    let lastDetail = '';
    const result = inspectMeshes(event.data, (progress) => {
      const now = performance.now();
      const partChanged =
        (progress.stage === 'preparing' ||
          progress.stage === 'indexing' ||
          progress.stage === 'validating') &&
        progress.detail !== lastDetail;
      // Announce each part before opaque work; throttle BVH leaves and fast pair changes.
      if (progress.stage !== lastStage || partChanged || now - lastUpdate >= 100) {
        lastStage = progress.stage;
        lastDetail = progress.detail;
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
