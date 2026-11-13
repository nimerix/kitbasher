import { it } from 'vitest';
import { BoxGeometry } from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { binaryGeometry, combineParts } from '../../src/core/geometry';
import { assertClosed } from '../../src/core/merge';
import { MeshProcessor } from '../../src/core/mesh-processing';
import type { Part } from '../../src/core/types';

// Diagnostic only: no wall-clock assertions in the normal correctness suite.
it.skipIf(!process.env.KITBASHER_MESH_BENCH)(
  'profiles dense mesh processing',
  async () => {
    const samples: Record<string, number>[] = [];
    const timed = <T>(run: () => T) => {
      const start = performance.now();
      const value = run();
      return { value, ms: performance.now() - start };
    };
    const elapsed = async (run: () => Promise<unknown>) => {
      const start = performance.now();
      await run();
      return performance.now() - start;
    };
    for (let trial = 0; trial < 3; trial++) {
      const geometry = new BoxGeometry(10, 10, 10, 220, 220, 220);
      const input: Part = {
        id: 'scan',
        name: 'Synthetic scan',
        geometry,
        position: [0, 0, 0],
        quaternion: [0, 0, 0, 1],
        scale: [1, 1, 1],
        color: '#ffffff',
        visible: true,
        locked: false,
        source: 'benchmark',
      };
      const validation = timed(() => assertClosed(input));
      const cachedValidation = timed(() => assertClosed(input));
      const combined = timed(() => combineParts([input, { ...input, position: [4, 3, 2] }]));
      const combinedBytes = Object.values(binaryGeometry(combined.value)).reduce(
        (sum, array) => sum + (array?.byteLength ?? 0),
        0,
      );
      const soup = geometry.toNonIndexed(),
        data = binaryGeometry(soup);
      const reduce = { mode: 'decimate' as const, ratio: 0.25, error: 0.001, lockBorder: true };
      const remesh = { mode: 'remesh' as const, resolution: 64 };
      const reduction = new MeshProcessor(data),
        remeshing = new MeshProcessor(data);
      samples.push({
        trial,
        trianglesPerInput: 580_800,
        validationMs: validation.ms,
        cachedValidationMs: cachedValidation.ms,
        combineMs: combined.ms,
        combinedBytes,
        reduceMs: await elapsed(() => reduction.process(reduce)),
        repeatReduceMs: await elapsed(() => reduction.process(reduce)),
        remeshMs: await elapsed(() => remeshing.process(remesh)),
        repeatRemeshMs: await elapsed(() => remeshing.process(remesh)),
      });
      combined.value.dispose();
      soup.dispose();
      geometry.dispose();
    }
    const directory = join(tmpdir(), 'kitbasher-performance');
    mkdirSync(directory, { recursive: true });
    const path = join(
      directory,
      `mesh-${process.env.KITBASHER_MESH_BENCH!.replace(/[^a-z0-9-]/gi, '_')}.json`,
    );
    writeFileSync(
      path,
      JSON.stringify(
        {
          scope:
            'Synthetic CPU-only algorithm timings; excludes browser scheduling, worker startup and messaging.',
          node: process.version,
          samples,
        },
        null,
        2,
      ),
    );
    console.log(`Mesh benchmark saved to ${path}`);
  },
  60_000,
);
