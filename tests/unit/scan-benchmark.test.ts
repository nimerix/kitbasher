import { it } from 'vitest';
import { BoxGeometry, TorusGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { placeClear } from '../../src/core/clipping';
import type { Part } from '../../src/core/types';

// Run explicitly when profiling; keep wall-clock measurements out of correctness assertions.
it.skipIf(!process.env.KITBASHER_BENCH)(
  'benchmarks dense-scan movement',
  () => {
    const make = (id: string, geometry: Part['geometry'], x = 0): Part => ({
      id,
      name: id,
      geometry,
      position: [x, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      color: '#fff',
      visible: true,
      locked: false,
      source: 'benchmark',
    });
    const result: Record<string, unknown> = {};
    for (const shape of ['box', 'torus'] as const) {
      const geometry =
        shape === 'box'
          ? new BoxGeometry(10, 10, 10, 220, 220, 220)
          : new TorusGeometry(10, 3, 256, 256);
      const tree = new MeshBVH(geometry, { indirect: true, targetLeafSize: 10 });
      geometry.boundsTree = tree;
      let queries = 0;
      const original = tree.closestPointToPoint.bind(geometry.boundsTree);
      tree.closestPointToPoint = (...args) => {
        queries++;
        return original(...args);
      };
      const fixed = make('fixed', geometry);
      let parts = [fixed, make('moving', geometry, shape === 'box' ? 9.95 : 20)];
      const times: number[] = [];
      for (let frame = 0; frame < 100; frame++) {
        const start = performance.now();
        const target: Part = {
          ...parts[1],
          position: [parts[1].position[0], (frame + 1) * 0.002, 0],
        };
        parts = placeClear({
          parts,
          joints: [],
          ids: ['moving'],
          target: [target],
          place: ([pose]) => [fixed, pose],
          overlap: 0.1,
          mode: 'drag',
          budget: 5,
        }).parts;
        if (frame >= 10) times.push(performance.now() - start);
      }
      times.sort((a, b) => a - b);
      result[shape] = {
        medianMs: times[Math.floor(times.length / 2)],
        p95Ms: times[Math.floor(times.length * 0.95)],
        queries,
      };
      geometry.dispose();
    }
    const far = Array.from({ length: 12 }, (_, i) =>
      make(`far-${i}`, new BoxGeometry(10, 10, 10, 100, 100, 100), (i + 1) * 100),
    );
    const mover = make('moving', new BoxGeometry(1, 1, 1));
    const before = performance.now();
    placeClear({
      parts: [mover, ...far],
      joints: [],
      ids: ['moving'],
      target: [{ ...mover, position: [1, 0, 0] }],
      place: ([pose]) => [pose, ...far],
      overlap: 0.1,
      mode: 'drag',
      budget: 5,
    });
    result.distant = {
      ms: performance.now() - before,
      treesBuilt: far.filter((part) => part.geometry.boundsTree).length,
    };
    const output = join(tmpdir(), 'kitbasher-performance');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      join(output, `${process.env.KITBASHER_BENCH!.replace(/[^a-z0-9-]/gi, '_')}.json`),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  },
  60_000,
);
