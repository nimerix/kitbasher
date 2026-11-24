import { it, expect } from 'vitest';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DoubleSide,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Raycaster,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { SculptMesh } from '../../src/core/sculpt-mesh';

const enabled = process.env.KITBASHER_SCULPT_BENCH;
const timed = <T>(work: () => T) => {
  const start = performance.now();
  const result = work();
  return { result, ms: performance.now() - start };
};

it.skipIf(!enabled)('profiles coarse and dense sculpt strokes', () => {
  const metrics = [];
  for (const segments of [1, 707]) {
    const source = new PlaneGeometry(100, 100, segments, segments);
    source.boundsTree = new MeshBVH(source, { indirect: true });
    const initial = timed(() => new SculptMesh(source, new Matrix4()));
    const { result: draft } = initial;
    const prepare = timed(() => draft.prepare());
    const mesh = new Mesh(draft.geometry, new MeshBasicMaterial({ side: DoubleSide }));
    const raycast = new Raycaster();
    raycast.firstHitOnly = true;
    const durations: number[] = [];
    for (let dab = 0; dab < 30; dab++) {
      const result = timed(() => {
        raycast.ray.origin.set(-5 + dab / 3, 0, 30);
        raycast.ray.direction.set(0, 0, -1);
        const hits: import('three').Intersection[] = [];
        draft.raycast(raycast, mesh, hits);
        const hit = hits[0];
        if (!hit?.face || hit.faceIndex == null) return false;
        return draft.dab({
          brush: 'draw',
          point: hit.point,
          normal: hit.face.normal,
          face: hit.faceIndex,
          radius: 3,
          strength: 0.2,
          detail: 0.5,
          minEdge: 0.05,
          falloff: 'soft',
        });
      });
      expect(result.result).toBe(true);
      durations.push(result.ms);
    }
    const finish = timed(() => draft.finish());
    const geometry = finish.result!;
    const bytes =
      geometry.index!.array.byteLength +
      Object.values(geometry.attributes).reduce(
        (sum, attribute) => sum + attribute.array.byteLength,
        0,
      );
    const warm = durations.slice(1).sort((a, b) => a - b);
    metrics.push({
      triangles: source.index!.count / 3,
      setupMs: initial.ms,
      prepareMs: prepare.ms,
      firstDabMs: durations[0],
      warmP95Ms: warm[Math.floor(warm.length * 0.95)],
      warmWorstMs: warm.at(-1),
      finishMs: finish.ms,
      committedMeshBytes: bytes,
    });
    geometry.dispose();
    draft.geometry.dispose();
    mesh.material.dispose();
    source.dispose();
  }
  writeFileSync(
    join(tmpdir(), 'kitbasher-sculpt-benchmark.json'),
    JSON.stringify(metrics, null, 2),
  );
});

it.skipIf(!enabled)('profiles cooperative wide dabs on a dense mesh', () => {
  const segments = 500;
  const source = new PlaneGeometry(100, 100, segments, segments);
  source.boundsTree = new MeshBVH(source, { indirect: true });
  const measurements = [];
  for (const brush of ['mask', 'draw'] as const) {
    const draft = new SculptMesh(source, new Matrix4());
    const preparation = timed(() => draft.prepare());
    const job = draft.dabWork({
      brush,
      point: new Vector3(),
      normal: new Vector3(0, 0, 1),
      face: 2 * ((segments / 2) * segments + segments / 2),
      radius: 80,
      strength: 1,
      detail: 0,
      minEdge: 0.04,
      falloff: 'hard',
    });
    let changed = false;
    let done = false;
    const slices: number[] = [];
    while (!done) {
      const { ms } = timed(() => {
        const deadline = performance.now() + 6;
        do {
          const result = job.next();
          if (result.done) {
            done = true;
            changed = result.value;
          }
        } while (!done && performance.now() < deadline);
      });
      slices.push(ms);
    }
    expect(changed).toBe(true);
    expect(slices.length).toBeGreaterThan(1);
    const committed = timed(() => draft.finish());
    const sorted = [...slices].sort((a, b) => a - b);
    measurements.push({
      brush,
      triangles: source.index!.count / 3,
      prepareMs: preparation.ms,
      totalDabMs: slices.reduce((sum, value) => sum + value, 0),
      slices: slices.length,
      sliceP95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
      sliceWorstMs: sorted.at(-1),
      commitMs: committed.ms,
    });
    committed.result?.dispose();
    draft.geometry.dispose();
  }
  source.dispose();
  writeFileSync(
    join(tmpdir(), 'kitbasher-sculpt-wide.json'),
    JSON.stringify(measurements, null, 2),
  );
});
