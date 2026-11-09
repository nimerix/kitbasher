/// <reference lib="webworker" />
import { evaluateBoolean } from './boolean';
import type { BinaryGeometry } from './types';

self.onmessage = (event: MessageEvent<{ meshes: BinaryGeometry[] }>) => {
  try {
    self.postMessage({ result: evaluateBoolean(event.data.meshes) });
  } catch (error) {
    self.postMessage({ error: (error as Error).message });
  }
};
