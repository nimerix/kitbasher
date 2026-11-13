import { it } from 'vitest';
import { BoxGeometry } from 'three';
import { writeFileSync } from 'node:fs';
import { MeshoptSimplifier as stock } from 'meshoptimizer';
import { binaryGeometry } from '../../src/core/geometry';
import { MeshProcessor, wasmMeshKernels } from '../../src/core/mesh-processing';
import { releaseComputeWorkers, runCompute } from '../../mcp/compute';

it.skipIf(!process.env.KITBASHER_ACCELERATION_BENCH)(
  'measures complete processing including native IPC',
  async () => {
    await stock.ready;
    const geometry = new BoxGeometry(10, 8, 6, 220, 220, 220),
      mesh = binaryGeometry(geometry);
    const options = [
      { mode: 'remesh', resolution: 128 },
      { mode: 'decimate', ratio: 0.25, error: 0.001, lockBorder: true },
    ] as const;
    const samples: Record<string, number[]> = {};
    const time = async (label: string, run: () => Promise<unknown>) => {
      const times: number[] = [];
      for (let i = 0; i < 6; i++) {
        const start = performance.now();
        await run();
        if (i) times.push(performance.now() - start);
      }
      samples[label] = times;
    };
    for (const option of options) {
      const previous = new MeshProcessor(mesh, {
        ...wasmMeshKernels,
        remesh: (data, resolution) =>
          stock.remesh(data.indices as Uint32Array, data.positions, 3, resolution),
      });
      const current = new MeshProcessor(mesh);
      await time(`${option.mode}StockPrepared`, () => previous.process(option));
      await time(`${option.mode}SinglePassPrepared`, () => current.process(option));
      for (const native of ['0', 'all']) {
        process.env.KITBASHER_NATIVE_MESH = native;
        releaseComputeWorkers();
        await time(`${option.mode}Server${native === 'all' ? 'Native' : 'Wasm'}`, () =>
          runCompute({ kind: 'process', mesh, options: option }),
        );
      }
    }
    delete process.env.KITBASHER_NATIVE_MESH;
    releaseComputeWorkers();
    geometry.dispose();
    const path = '/tmp/kitbasher-integrated-acceleration.json';
    writeFileSync(
      path,
      JSON.stringify(
        {
          triangles: 580800,
          scope:
            'Prepared full mesh processing; server runs include worker messages, content hashing, native process startup and IPC. Excludes browser HTTP.',
          samples,
        },
        null,
        2,
      ),
    );
    console.log(path);
  },
  60_000,
);
