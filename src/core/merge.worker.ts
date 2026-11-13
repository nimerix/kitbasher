/// <reference lib="webworker" />
import { BufferAttribute, BufferGeometry } from 'three';
import { evaluateBoolean } from './boolean';
import { assertClosed } from './merge';
import type { MergeWorkerRequest } from './merge';
import type { Part } from './types';

self.onmessage = (event: MessageEvent<MergeWorkerRequest>) => {
  try {
    if (event.data.type === 'validate') {
      const { meshes } = event.data;
      for (let i = 0; i < meshes.length; i++) {
        const mesh = meshes[i];
        self.postMessage({
          type: 'progress',
          progress: {
            detail: `Checking closed surface · ${mesh.name} (${i + 1} of ${meshes.length})`,
            progress: null,
          },
        });
        const geometry = new BufferGeometry();
        geometry.setAttribute('position', new BufferAttribute(mesh.positions, 3));
        if (mesh.indices) geometry.setIndex(new BufferAttribute(mesh.indices, 1));
        try {
          assertClosed({ name: mesh.name, geometry } as Part);
        } finally {
          geometry.dispose();
        }
      }
      self.postMessage({ type: 'validated' });
      return;
    }
    const result = evaluateBoolean(event.data.meshes, 'union', (completed, total) => {
      self.postMessage({
        type: 'progress',
        progress: {
          detail: `Fusing volumes · ${completed} of ${total} joins complete`,
          progress: completed / total,
        },
      });
    });
    const transfer = Object.values(result)
      .filter((array) => array !== undefined)
      .map((array) => array.buffer);
    self.postMessage({ result }, { transfer });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
