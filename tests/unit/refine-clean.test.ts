import { describe, expect, it } from 'vitest';
import { Matrix4 } from 'three';
import {
  type CleanSettings,
  autoCleanSize,
  cleanDefaults,
  cleanPlan,
  cleanSurface,
  maxCleanDepth,
  maxCleanSize,
  minCleanSize,
} from '../../src/core/refine-clean';
import { cleanRefineJob } from '../../src/core/refine-job';
import { type RefineMesh, buildTopology, weldedCorner } from '../../src/core/refine-mesh';
import { autoRule, cleanDepthMax, cleanSizeRange } from '../../src/components/refine-panel';
import { closedMesh, modelOf } from '../helpers/refine';
import { heightField, rivetedPlate, softBox } from '../helpers/soft-edges';

type Model = ReturnType<typeof modelOf>;
const off: CleanSettings = { smooth: 0, sharpen: 0, depth: 0, size: null };

/** The model's mesh with a clean applied: new positions and corners, and the result. */
function cleaned(
  model: Model,
  settings: Partial<CleanSettings>,
  triangles: Uint32Array | null = null,
) {
  const result = cleanSurface(model.mesh, model.topology, model.noise, model.step, {
    ...off,
    ...settings,
    triangles,
  });
  const position = model.mesh.position.slice();
  result.moved.forEach((v, i) => {
    for (let a = 0; a < 3; a++) position[v * 3 + a] = result.position[i * 3 + a];
  });
  const corners = model.mesh.corners.slice();
  result.triangles.forEach((t, i) => corners.set(result.corners.subarray(i * 3, i * 3 + 3), t * 3));
  const mesh: RefineMesh = { ...model.mesh, position, corners };
  return { position, corners, mesh, result };
}

/** Each rivet's height over the plate top (y = 0.5), and the RMS height of the plate far from them. */
function plate(position: Float64Array, rivets: { x: number; z: number }[], top = 0.5, yScale = 1) {
  const peaks = rivets.map(() => -Infinity);
  let squares = 0,
    count = 0;
  for (let v = 0; v < position.length / 3; v++) {
    const x = position[v * 3],
      y = position[v * 3 + 1] / yScale,
      z = position[v * 3 + 2];
    if (y < top - 0.2) continue;
    rivets.forEach((r, i) => {
      if (Math.hypot(x - r.x, z - r.z) < 0.15) peaks[i] = Math.max(peaks[i], y - top);
    });
    if (rivets.every((r) => Math.hypot(x - r.x, z - r.z) > 0.8) && Math.abs(x) < 2.6)
      if (Math.abs(z) < 1.6) {
        squares += (y - top) ** 2;
        count++;
      }
  }
  return { peak: Math.min(...peaks), roughness: Math.sqrt(squares / count) };
}

/** Width across x of the part of a step from y 0 to `height` that lies between 10 and 90 %. */
function stepWidth(position: Float64Array, height: number) {
  const xs: number[] = [];
  for (let v = 0; v < position.length / 3; v++) {
    const x = position[v * 3],
      y = position[v * 3 + 1],
      z = position[v * 3 + 2];
    if (Math.abs(z) < 1 && y > 0.1 * height && y < 0.9 * height) xs.push(x);
  }
  xs.sort((a, b) => a - b);
  return xs[Math.floor(xs.length * 0.95)] - xs[Math.floor(xs.length * 0.05)];
}

/** A triangle's normal times twice its area. */
function cross(mesh: RefineMesh, t: number) {
  const p = mesh.position;
  const [a, b, c] = [0, 1, 2].map((k) => weldedCorner(mesh, t, k as 0 | 1 | 2) * 3);
  const u = [0, 1, 2].map((i) => p[b + i] - p[a + i]),
    w = [0, 1, 2].map((i) => p[c + i] - p[a + i]);
  return [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
}

/**
 * Triangles of `after` facing away from the source surface around them: the sum of the source
 * normals of the triangles around their corners.
 */
function inverted(model: Model, after: RefineMesh) {
  const { mesh, topology } = model;
  const source = Array.from({ length: mesh.triangleCount }, (_, t) => cross(mesh, t));
  let count = 0;
  for (let t = 0; t < after.triangleCount; t++) {
    const reference = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      const v = weldedCorner(after, t, k as 0 | 1 | 2);
      for (let i = topology.triangleStart[v]; i < topology.triangleStart[v + 1]; i++)
        source[topology.trianglesOf[i]].forEach((x, a) => (reference[a] += x));
    }
    const n = cross(after, t);
    if (n[0] * reference[0] + n[1] * reference[1] + n[2] * reference[2] <= 0) count++;
  }
  return count;
}

/** Sum over interior edges of length times the angle between their two triangles' normals. */
function bending(mesh: RefineMesh) {
  const first = new Map<string, number>();
  let sum = 0;
  for (let t = 0; t < mesh.triangleCount; t++)
    for (let k = 0; k < 3; k++) {
      const a = weldedCorner(mesh, t, k as 0 | 1 | 2),
        b = weldedCorner(mesh, t, ((k + 1) % 3) as 0 | 1 | 2);
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      const other = first.get(key);
      if (other === undefined) {
        first.set(key, t);
        continue;
      }
      const [m, n] = [cross(mesh, t), cross(mesh, other)];
      const cos = (m[0] * n[0] + m[1] * n[1] + m[2] * n[2]) / (Math.hypot(...m) * Math.hypot(...n));
      const p = mesh.position;
      sum +=
        Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]) *
        Math.acos(Math.max(-1, Math.min(1, cos)));
    }
  return sum;
}

describe('refine clean', () => {
  it('removes noise from a flat face without changing the part', () => {
    const { geometry, rivets } = rivetedPlate({ noise: 0.01, ripple: 0 });
    const model = modelOf(geometry);
    const before = plate(model.mesh.position, rivets);
    const { position } = cleaned(model, { smooth: 0.5 });
    const after = plate(position, rivets);
    expect(after.roughness).toBeLessThan(0.4 * before.roughness);
    expect(after.peak).toBeGreaterThan(0.85 * before.peak);
    let moved = 0;
    for (let i = 0; i < position.length; i++)
      moved = Math.max(moved, Math.abs(position[i] - model.mesh.position[i]));
    expect(moved).toBeLessThan(0.1);
  });

  it('narrows a softened edge', () => {
    const height = 0.15;
    const model = modelOf(
      heightField(1.5, (x) => (height * (1 + Math.tanh(x / 0.1))) / 2, { noise: 0.003, ripple: 0 }),
    );
    const before = stepWidth(model.mesh.position, height);
    const half = stepWidth(cleaned(model, { sharpen: 0.5 }).position, height);
    const full = stepWidth(cleaned(model, { sharpen: 1 }).position, height);
    expect(half).toBeLessThan(before);
    expect(full).toBeLessThan(0.85 * before);
    expect(full).toBeLessThan(half);
    // The defaults sharpen it on balance, though Smooth alone softens a gentle edge.
    expect(stepWidth(cleaned(model, cleanDefaults).position, height)).toBeLessThan(before);
  });

  it('deepens relief up to Size, more for a larger Size', () => {
    const { geometry, rivets } = rivetedPlate({ ripple: 0 });
    const model = modelOf(geometry);
    const before = plate(model.mesh.position, rivets);
    const auto = cleaned(model, { depth: 1 });
    expect(auto.result.size).toBeCloseTo(autoCleanSize(model.step), 12);
    const deeper = plate(auto.position, rivets);
    expect(deeper.peak).toBeGreaterThan(1.1 * before.peak);
    const wide = plate(cleaned(model, { depth: 1, size: 1 }).position, rivets);
    expect(wide.peak).toBeGreaterThan(deeper.peak);
    // The plate around the rivets stays where it was.
    expect(deeper.roughness).toBeLessThan(before.roughness + 0.003);
    expect(plate(cleaned(model, { depth: 2 }).position, rivets).peak).toBeGreaterThan(deeper.peak);
  });

  it('cleans a mirrored, stretched part in world space', () => {
    const { geometry, rivets } = rivetedPlate({ ripple: 0 });
    const model = modelOf(geometry, new Matrix4().makeScale(-1, 2, 1));
    const flipped = rivets.map((r) => ({ x: -r.x, z: r.z }));
    const before = plate(model.mesh.position, flipped, 0.5, 2);
    const { position, mesh } = cleaned(model, { ...cleanDefaults, depth: 1 });
    expect(plate(position, flipped, 0.5, 2).peak).toBeGreaterThan(1.05 * before.peak);
    expect(inverted(model, mesh)).toBe(0);
  });

  it('turns no triangle over at the strongest settings', () => {
    for (const geometry of [rivetedPlate().geometry, softBox([2, 1.5, 1], 0.2)]) {
      const model = modelOf(geometry);
      const { mesh } = cleaned(model, {
        smooth: 1,
        sharpen: 1,
        depth: maxCleanDepth,
        size: maxCleanSize,
      });
      expect(inverted(model, mesh)).toBe(0);
      expect(closedMesh(mesh)).toBe(true);
    }
  });

  it('moves only the painted area, easing in from its border', () => {
    const { geometry } = rivetedPlate({ noise: 0.01, ripple: 0 });
    const model = modelOf(geometry);
    const { mesh } = model;
    const painted: number[] = [];
    for (let t = 0; t < mesh.triangleCount; t++) {
      const centre = [0, 1, 2].map(
        (a) =>
          [0, 1, 2].reduce(
            (sum, k) => sum + mesh.position[weldedCorner(mesh, t, k as 0 | 1 | 2) * 3 + a],
            0,
          ) / 3,
      );
      if (centre[1] > 0.45 && Math.hypot(centre[0] + 1, centre[2]) < 0.8) painted.push(t);
    }
    const inside = new Set<number>(),
      border = new Set<number>();
    const paintedSet = new Set(painted);
    for (const t of painted)
      for (let k = 0; k < 3; k++) inside.add(weldedCorner(mesh, t, k as 0 | 1 | 2));
    for (let t = 0; t < mesh.triangleCount; t++)
      if (!paintedSet.has(t))
        for (let k = 0; k < 3; k++) {
          const v = weldedCorner(mesh, t, k as 0 | 1 | 2);
          if (inside.has(v)) border.add(v);
        }
    const { position, result } = cleaned(
      model,
      { ...cleanDefaults, depth: 1 },
      Uint32Array.from(painted),
    );
    expect(result.moved.length).toBeGreaterThan(inside.size / 3);
    for (const v of result.moved) {
      expect(inside.has(v)).toBe(true);
      expect(border.has(v)).toBe(false);
    }
    // Only triangles between moved vertices turn.
    const moved = new Set(result.moved);
    for (let i = 0; i < result.corners.length; i++)
      expect(moved.has(mesh.weldOf[result.corners[i]])).toBe(true);
    // Everything else keeps its exact position.
    for (let v = 0; v < mesh.weldedCount; v++)
      if (!inside.has(v) || border.has(v))
        for (let a = 0; a < 3; a++) expect(position[v * 3 + a]).toBe(mesh.position[v * 3 + a]);
  });

  it('keeps refined-edge and open-border vertices in place', () => {
    const model = modelOf(heightField(1, (x, z) => 0.05 * Math.sin(4 * x) * Math.cos(3 * z)));
    const { mesh, topology } = model;
    const held = new Set<number>();
    for (let v = 0; v < mesh.weldedCount; v += 7) {
      mesh.crease[v] = 1;
      held.add(v);
    }
    for (let v = 0; v < mesh.weldedCount; v++)
      if (
        topology.triangleStart[v + 1] - topology.triangleStart[v] !==
        topology.neighbourStart[v + 1] - topology.neighbourStart[v]
      )
        held.add(v);
    const { result } = cleaned(model, { ...cleanDefaults, depth: 2 });
    expect(result.moved.length).toBeGreaterThan(0);
    for (const v of result.moved) expect(held.has(v)).toBe(false);
  });

  it('turns triangles to follow a sharpened edge, keeping the mesh closed', () => {
    for (const indexed of [false, true]) {
      const model = modelOf(softBox([2, 1.5, 1], 0.12, { indexed }));
      const { mesh, result } = cleaned(model, { smooth: 0.5, sharpen: 1 });
      expect(result.triangles.length).toBeGreaterThan(0);
      expect(closedMesh(mesh)).toBe(true);
      expect(result.topology).toEqual(buildTopology(mesh));
      expect(inverted(model, mesh)).toBe(0);
      // The turned triangles bend the surface less than the old ones at the same positions.
      expect(bending(mesh)).toBeLessThan(bending({ ...mesh, corners: model.mesh.corners }));
      // Each corner keeps a geometry vertex of its own welded vertex.
      const before = new Set(model.mesh.corners);
      for (const g of result.corners) expect(before.has(g)).toBe(true);
    }
  });

  it('changes nothing when every setting is off', () => {
    const model = modelOf(softBox([1, 1, 1], 0.2));
    expect(cleaned(model, off).result.moved).toHaveLength(0);
  });

  it('stops when cancelled', () => {
    const model = modelOf(softBox([1, 1, 1], 0.2));
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      cleanSurface(
        model.mesh,
        model.topology,
        model.noise,
        model.step,
        { ...cleanDefaults, triangles: null },
        () => {},
        controller.signal,
      ),
    ).toThrow(expect.objectContaining({ name: 'AbortError' }));
  });

  it('runs as a job the same as in-thread', async () => {
    const model = modelOf(softBox([1, 1, 1], 0.2));
    const input = { ...cleanDefaults, triangles: null };
    const direct = cleanSurface(model.mesh, model.topology, model.noise, model.step, input);
    const progress: number[] = [];
    const job = await cleanRefineJob(model, input, new AbortController().signal, (f) =>
      progress.push(f),
    );
    expect(job.moved).toEqual(direct.moved);
    expect(job.position).toEqual(direct.position);
    expect(job.corners).toEqual(direct.corners);
    expect(job.topology).toEqual(direct.topology);
    expect(progress.at(-1)).toBe(1);
    expect(progress.every((f, i) => i === 0 || f >= progress[i - 1])).toBe(true);
  });

  it('holds Size to its range and matches the panel', () => {
    expect(cleanPlan({ ...cleanDefaults, size: 100 }, 0.06).size).toBe(maxCleanSize);
    expect(cleanPlan({ ...cleanDefaults, size: 0.001 }, 0.06).size).toBe(0.06);
    expect(cleanPlan({ ...cleanDefaults, size: 0.001 }, 0.01).size).toBe(minCleanSize);
    expect(autoRule('size', { step: 0.06, noise: 0.01 })).toBe(autoCleanSize(0.06));
    expect(cleanDepthMax).toBe(maxCleanDepth);
    expect(cleanSizeRange).toEqual({ min: minCleanSize, max: maxCleanSize });
  });
});
