import { expect, it } from 'vitest';
import { Matrix4, SphereGeometry } from 'three';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildBand, estimateWidth } from '../../src/core/refine-band';
import { smoothDab } from '../../src/core/refine-brush';
import { cutAlongField } from '../../src/core/refine-cut';
import { detectDefaults, detectFeatures } from '../../src/core/refine-detect';
import { applyEdge, solveEdge, type EdgeInput } from '../../src/core/refine-edge';
import { cloneRefineMesh, writeRefinedGeometry } from '../../src/core/refine-mesh';
import { buildRefineModel, modelFromMesh, refineModelInput } from '../../src/core/refine-model';
import { applyRegion, solveRegion } from '../../src/core/refine-region';
import { modelOf, pointOn } from '../helpers/refine';
import { softBox } from '../helpers/soft-edges';

// Run explicitly when profiling, as the Warp benchmark is.
const bench = process.env.KITBASHER_REFINE_BENCH;
const time = <T>(run: () => T): [T, number] => {
  const start = performance.now();
  const value = run();
  return [value, performance.now() - start];
};
const write = (name: string, result: unknown) => {
  const output = join(tmpdir(), 'kitbasher-performance');
  mkdirSync(output, { recursive: true });
  writeFileSync(
    join(output, `${name}-${bench!.replace(/[^a-z0-9-]/gi, '_')}.json`),
    JSON.stringify(result, null, 2),
  );
  console.log(JSON.stringify(result));
};

// The unit tests hold these only to bounds that catch a change of complexity, so that load from
// other work on the machine cannot fail them; on a quiet machine they are held here.
it.skipIf(!bench)(
  'builds bands and cuts within their frame limits',
  () => {
    const crest = 0.3 - 0.3 / Math.SQRT2;
    const small = modelOf(softBox([2, 1.5, 1], 0.3, { step: 0.012 }));
    const shortGuide = [-1.2, 1.2].map((x) => pointOn(small.mesh, [x, 1.5 - crest, 1 - crest]));
    const [band, built] = time(() =>
      buildBand(small.mesh, small.topology, 'line', shortGuide, 1.2, 0.0086),
    );
    expect(band!.vertices.length).toBeGreaterThan(39000);
    const long = modelOf(softBox([20, 2, 2], 0.3, { step: 0.04 }));
    const longGuide = [-20, -10, 0, 10, 20].map((x) =>
      pointOn(long.mesh, [x, 2 - crest, 2 - crest]),
    );
    const [, builtLong] = time(() =>
      buildBand(long.mesh, long.topology, 'spline', longGuide, 2.2, 0.0086),
    );
    const [, estimatedLong] = time(() =>
      estimateWidth(long.mesh, long.topology, 'spline', longGuide, 0.0086),
    );
    const sphere = modelOf(new SphereGeometry(10, 640, 640));
    const ids = Uint32Array.from({ length: sphere.mesh.weldedCount }, (_, v) => v).filter(
      (v) => Math.abs(sphere.mesh.position[v * 3 + 1] - 0.013) < 0.075,
    );
    let cut = Infinity;
    for (let run = 0; run < 3; run++) {
      const mesh = cloneRefineMesh(sphere.mesh, true);
      const field = Float32Array.from(ids, (v) => mesh.position[v * 3 + 1] - 0.013);
      cut = Math.min(
        cut,
        time(() =>
          cutAlongField(mesh, sphere.topology, ids, field, (x, _y, z, out) =>
            out.set([x, 0.013, z]),
          ),
        )[1],
      );
    }
    write('refine-limits', { built, builtLong, estimatedLong, cut });
    expect(built).toBeLessThan(300);
    expect(builtLong).toBeLessThan(1000);
    expect(estimatedLong).toBeLessThan(2000);
    expect(cut).toBeLessThan(40);
  },
  300_000,
);

/**
 * A 50 mm sphere cut by the planes x = 20 and y = 20, every edge rounded, rippled and noisy,
 * as about 3 million unindexed triangles: each sphere direction is pushed out to the solid's
 * surface along it.
 */
function cutSphere() {
  const sphere = new SphereGeometry(1, 1500, 1001);
  sphere.deleteAttribute('uv');
  const geometry = sphere.toNonIndexed();
  sphere.dispose();
  const position = geometry.getAttribute('position');
  const soft = 0.4;
  // Smooth minimum of the distances to the three boundaries along the direction.
  const reach = (d: number[]) => {
    const limits = [50, d[0] > 0 ? 20 / d[0] : Infinity, d[1] > 0 ? 20 / d[1] : Infinity];
    const least = Math.min(...limits);
    const sum = limits.reduce((s, t) => s + Math.exp(-(t - least) / soft), 0);
    return least - soft * Math.log(sum);
  };
  for (let i = 0; i < position.count; i++) {
    const d = [position.getX(i), position.getY(i), position.getZ(i)];
    const length = Math.hypot(d[0], d[1], d[2]);
    // Noise hashed from the direction, so the copies of one vertex move alike and stay welded.
    const noise =
      ((Math.sin(d[0] * 12.9898 + d[1] * 78.233 + d[2] * 37.719) * 43758.5453) % 1) - 0.5;
    const r =
      reach(d.map((x) => x / length)) +
      0.02 * Math.sin(d[0] * 40) * Math.sin(d[2] * 40) +
      0.008 * noise;
    position.setXYZ(i, (d[0] / length) * r, (d[1] / length) * r, (d[2] / length) * r);
  }
  geometry.deleteAttribute('normal');
  geometry.computeVertexNormals();
  return geometry;
}

it.skipIf(!bench)(
  'benchmarks Refine on a 3M-triangle scan',
  () => {
    const geometry = cutSphere();
    const matrix = new Matrix4();
    const result: Record<string, unknown> = {
      triangles: geometry.getAttribute('position').count / 3,
    };
    const [model, build] = time(() => buildRefineModel(refineModelInput(geometry, matrix)));
    result.buildRefineModel = build;
    const { mesh, topology, noise } = model;
    // A 40 mm line along the rounded edge where the two planes meet.
    // The surface point nearest the sharp corner is the rounded edge's crest, by symmetry.
    const on = (z: number) => pointOn(mesh, [20, 20, z]);
    const input: EdgeInput = {
      segments: [{ kind: 'line', points: [on(-20), on(20)] }],
      joints: [],
      closed: false,
      width: null,
      strength: 1,
    };
    const preview = cloneRefineMesh(mesh, false);
    const [solve, solved] = time(() => solveEdge(mesh, topology, input, noise));
    expect(solve).not.toBeNull();
    const [, applied] = time(() => applyEdge(preview, topology, solve!, 1, false));
    result.previewUpdate = { solveEdge: solved, applyEdge: applied, total: solved + applied };
    const cutMesh = cloneRefineMesh(mesh, true);
    const [cutSolve, cutSolved] = time(() => solveEdge(mesh, topology, input, noise));
    const [, cut] = time(() => applyEdge(cutMesh, topology, cutSolve!, 1, true));
    const [next, rebuilt] = time(() => modelFromMesh(cutMesh, model));
    const [, written] = time(() => writeRefinedGeometry(geometry, matrix, cutMesh, next.topology));
    result.accept = {
      solveEdge: cutSolved,
      applyEdgeCut: cut,
      modelFromMesh: rebuilt,
      writeRefinedGeometry: written,
      total: cutSolved + cut + rebuilt + written,
    };

    // 200,000 triangles grown over shared edges from the side away from the cuts.
    const start = pointOn(mesh, [-50, 0, 0]);
    const seen = new Uint8Array(mesh.triangleCount);
    const triangles = [start.triangle];
    seen[start.triangle] = 1;
    for (let q = 0; q < triangles.length && triangles.length < 200_000; q++)
      for (let k = 0; k < 3; k++) {
        const v = mesh.weldOf[mesh.corners[triangles[q] * 3 + k]];
        for (let j = topology.triangleStart[v]; j < topology.triangleStart[v + 1]; j++) {
          const t = topology.trianglesOf[j];
          if (seen[t] || triangles.length >= 200_000) continue;
          seen[t] = 1;
          triangles.push(t);
        }
      }
    const region = {
      triangles: Uint32Array.from(triangles).sort(),
      treatment: 'smooth' as const,
      shape: 'auto' as const,
      strength: 1,
      keepDetail: true,
      detail: null,
      blend: null,
    };
    const [regionSolve, regionSolved] = time(() => solveRegion(mesh, topology, region, noise));
    expect(regionSolve).not.toBeNull();
    const [, regionApplied] = time(() => applyRegion(cloneRefineMesh(mesh, false), regionSolve!));
    result.smoothRegion = {
      triangles: triangles.length,
      solveRegion: regionSolved,
      applyRegion: regionApplied,
    };

    const dabMesh = cloneRefineMesh(mesh, false);
    const dabs = [-1, -0.5, 0, 0.5, 1]
      .map((z) => pointOn(mesh, [-50, 0, z]))
      .map(
        ({ triangle, position }) =>
          time(() =>
            smoothDab(dabMesh, topology, {
              triangle,
              center: position,
              radius: 1,
              strength: 1,
              noise,
            }),
          )[1],
      );
    result.smoothDab = { first: dabs[0], later: dabs.slice(1) };

    const [found, detected] = time(() =>
      detectFeatures(mesh, topology, noise, { ...detectDefaults, triangles: null }),
    );
    result.detectFeatures = { ms: detected, proposals: found.length };
    write('refine', result);
  },
  1_200_000,
);
