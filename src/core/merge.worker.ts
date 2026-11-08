/// <reference lib="webworker" />
import { Brush, Evaluator, ADDITION } from 'three-bvh-csg';
import { deserializeGeometry, serializeGeometry } from './geometry';
import type { SerializedGeometry } from './types';

self.onmessage = (event: MessageEvent<{ meshes: SerializedGeometry[] }>) => {
  const brushes: Brush[] = [];
  try {
    const evaluator = new Evaluator();
    evaluator.attributes = ['position', 'normal', 'color'];
    evaluator.useGroups = false;
    for (const data of event.data.meshes) {
      const geometry = deserializeGeometry(data);
      geometry.clearGroups();
      const brush = new Brush(geometry);
      brush.updateMatrixWorld(true);
      brushes.push(brush);
    }
    let result = brushes[0];
    for (let i = 1; i < brushes.length; i++) {
      const next = evaluator.evaluate(result, brushes[i], ADDITION);
      if (!brushes.includes(result)) result.geometry.dispose();
      result = next;
    }
    const geometry = result.geometry;
    if (!geometry.getAttribute('position')?.count)
      throw new Error('The union produced an empty mesh. Check that the meshes are closed.');
    self.postMessage({ result: serializeGeometry(geometry) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  } finally {
    brushes.forEach((b) => b.geometry.dispose());
  }
};
