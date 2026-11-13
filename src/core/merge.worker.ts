/// <reference lib="webworker" />
import { BooleanProcessor } from './boolean';
import { assertClosed, mergedPart } from './merge';
import type { MergeWorkerRequest, MergeProgress } from './merge';
import { bakedPartGeometry, binaryGeometry, combineParts, deserializeGeometry } from './geometry';
import { restoreGeometry, snapshotGeometry, snapshotBuffers } from './geometry-transfer';
import type { Part } from './types';
import type { BufferGeometry } from 'three';

const processor = new BooleanProcessor();

self.onmessage = (event: MessageEvent<MergeWorkerRequest>) => {
  const { mode, name } = event.data;
  const owned: BufferGeometry[] = [];
  const progress = (value: MergeProgress) =>
    self.postMessage({ type: 'progress', progress: value });
  try {
    const parts = event.data.parts.map((source) => {
      const geometry = restoreGeometry(source.geometry);
      owned.push(geometry);
      return { ...source, geometry } as unknown as Part;
    });
    let geometry: BufferGeometry;
    if (mode === 'combine') {
      progress({ detail: `Combining ${parts.length} meshes`, progress: null });
      geometry = combineParts(parts);
    } else {
      const checked = new Set<string>();
      for (let i = 0; i < parts.length; i++) {
        progress({
          detail: `Checking closed surface · ${parts[i].name} (${i + 1} of ${parts.length})`,
          progress: null,
        });
        const source = event.data.parts[i];
        if (!source.validated && !checked.has(source.key)) assertClosed(parts[i]);
        checked.add(source.key);
      }
      self.postMessage({ type: 'validated', indices: parts.map((_, i) => i) });
      const meshes = parts.map((part, i) => ({
        key: JSON.stringify([
          event.data.parts[i].key,
          part.position,
          part.quaternion,
          part.scale,
          part.color,
        ]),
        create: () => {
          progress({
            detail: `Preparing transforms and colors · ${i + 1} of ${parts.length} parts`,
            progress: null,
          });
          return bakedPartGeometry(part, true);
        },
      }));
      const result = processor.evaluate(meshes, 'union', (completed, total) => {
        progress({
          detail: `Fusing volumes · ${completed} of ${total} joins complete`,
          progress: completed / total,
        });
      });
      owned.push(result);
      geometry = deserializeGeometry(binaryGeometry(result), false);
    }
    owned.push(geometry);
    progress({ detail: 'Preparing merged mesh', progress: null });
    const { geometry: result, ...part } = mergedPart(
      geometry,
      name,
      `${mode === 'union' ? 'Boolean union' : 'Combined'} · ${parts.length} parts`,
    );
    result.computeBoundingSphere();
    const snapshot = snapshotGeometry(result);
    self.postMessage(
      { part, geometry: snapshot, retain: mode === 'union' && processor.retainedBytes > 0 },
      { transfer: snapshotBuffers(snapshot) },
    );
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  } finally {
    owned.forEach((geometry) => geometry.dispose());
  }
};
