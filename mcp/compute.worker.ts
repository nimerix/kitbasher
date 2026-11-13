import { parentPort } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { MeshProcessor, wasmMeshKernels } from '../src/core/mesh-processing';
import { BooleanProcessor } from '../src/core/boolean';
import { assertClosed, mergedPart } from '../src/core/merge';
import {
  bakedPartGeometry,
  binaryGeometry,
  combineParts,
  deserializeGeometry,
} from '../src/core/geometry';
import { restoreGeometry, snapshotBuffers, snapshotGeometry } from '../src/core/geometry-transfer';
import { inspectMeshes } from '../src/core/inspection';
import type { Part } from '../src/core/types';
import type { ComputeRequest } from './compute-types';
import type { NativeKernelRequest, NativeKernelResult } from './native-mesh';

if (!parentPort) throw new Error('Mesh worker requires a parent.');
const port = parentPort;
const booleans = new BooleanProcessor();
const closedKeys = new Set<string>();
let prepared: { key: string; processor: MeshProcessor } | undefined;
let nativeReply: ((result: { value?: NativeKernelResult; error?: string }) => void) | undefined;
let usedNative = false;
function native(request: NativeKernelRequest): Promise<NativeKernelResult> {
  return new Promise((resolve, reject) => {
    nativeReply = (result) => {
      nativeReply = undefined;
      if (result.error) reject(new Error(result.error));
      else {
        usedNative = true;
        resolve(result.value!);
      }
    };
    port.postMessage({ type: 'native', request });
  });
}
port.on(
  'message',
  async (
    message:
      | { type: 'run'; request: ComputeRequest; native: boolean }
      | { type: 'native-result'; value?: NativeKernelResult; error?: string },
  ) => {
    if (message.type === 'native-result') {
      nativeReply?.(message);
      return;
    }
    const request = message.request;
    try {
      if (request.kind === 'process') {
        usedNative = false;
        const hash = createHash('sha256').update(message.native ? 'native' : 'wasm');
        for (const key of ['positions', 'indices', 'normals', 'colors'] as const) {
          const array = request.mesh[key];
          hash.update(key);
          if (array) hash.update(new Uint8Array(array.buffer, array.byteOffset, array.byteLength));
        }
        const key = hash.digest('hex');
        if (prepared?.key !== key)
          prepared = {
            key,
            processor: new MeshProcessor(
              request.mesh,
              message.native
                ? {
                    async reduce(mesh, target, error, lockBorder) {
                      try {
                        const result = await native({
                          mode: 'decimate',
                          mesh: {
                            positions: mesh.positions,
                            indices: mesh.indices,
                            colors: mesh.colors,
                          },
                          target,
                          error,
                          lockBorder,
                        });
                        if ('indices' in result) return [result.indices, result.error];
                      } catch {
                        /* A missing or incompatible native helper falls back to the same WASM kernel. */
                      }
                      return wasmMeshKernels.reduce(mesh, target, error, lockBorder);
                    },
                    async remesh(mesh, resolution) {
                      try {
                        const result = await native({
                          mode: 'remesh',
                          mesh: { positions: mesh.positions, indices: mesh.indices },
                          resolution,
                        });
                        if ('positions' in result) return result.positions;
                      } catch {
                        /* CPU WASM remains available on every supported host. */
                      }
                      return wasmMeshKernels.remesh(mesh, resolution);
                    },
                  }
                : wasmMeshKernels,
            ),
          };
        const result = await prepared.processor.process(request.options);
        const geometry = deserializeGeometry(result.mesh);
        const snapshot = snapshotGeometry(geometry);
        port.postMessage(
          {
            type: 'result',
            value: {
              geometry: snapshot,
              error: result.error,
              backend: usedNative ? 'native' : 'wasm',
            },
          },
          snapshotBuffers(snapshot),
        );
        geometry.dispose();
        if (
          Object.values(request.mesh).reduce((n, a) => n + (a?.byteLength ?? 0), 0) >
          128 * 1024 * 1024
        )
          prepared = undefined;
      } else if (request.kind === 'merge') {
        const parts = request.parts.map(
          (source, i) =>
            ({
              ...source,
              id: String(i),
              visible: true,
              locked: false,
              source: '',
              geometry: restoreGeometry(source.geometry),
            }) as Part,
        );
        try {
          if (request.mode !== 'combine')
            parts.forEach((part, i) => {
              const key = request.parts[i].key;
              if (!closedKeys.has(key)) assertClosed(part);
              closedKeys.add(key);
              if (closedKeys.size > 512) closedKeys.delete(closedKeys.values().next().value!);
            });
          const result =
            request.mode === 'combine'
              ? combineParts(parts)
              : booleans.evaluate(
                  parts.map((part, i) => ({
                    key: JSON.stringify([
                      request.parts[i].key,
                      part.position,
                      part.quaternion,
                      part.scale,
                      part.color,
                    ]),
                    create: () => bakedPartGeometry(part, true),
                  })),
                  request.mode,
                );
          try {
            if (request.mode !== 'combine')
              deserializeGeometry(binaryGeometry(result), false).dispose();
            const label = {
              combine: 'Combined',
              union: 'Boolean union',
              subtract: 'Boolean subtraction',
              intersect: 'Boolean intersection',
            }[request.mode];
            const { geometry, ...part } = mergedPart(
              result,
              request.name ?? `${parts[0].name} ${request.mode}`,
              `${label} · ${parts.length} parts`,
            );
            geometry.computeBoundingSphere();
            const snapshot = snapshotGeometry(geometry);
            port.postMessage(
              { type: 'result', value: { geometry: snapshot, part } },
              snapshotBuffers(snapshot),
            );
          } finally {
            result.dispose();
          }
        } finally {
          parts.forEach((part) => part.geometry.dispose());
        }
      } else port.postMessage({ type: 'result', value: inspectMeshes(request.request) });
    } catch (error) {
      port.postMessage({ type: 'error', error: (error as Error).message });
    }
  },
);
