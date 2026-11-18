import { describe, expect, it } from 'vitest';
import {
  BufferGeometry,
  LatheGeometry,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  SphereGeometry,
  Vector2,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { buildWarpModel, type WarpModel } from '../../src/core/warp-model';
import {
  traceWarpGridPathNow,
  warpGridPathLimits,
  warpGridSegments,
  writeWarpGridPath,
  type WarpGridPath,
} from '../../src/core/warp-grid-path';

function model(geometry: BufferGeometry, density: number, matrix = new Matrix4()) {
  const position = geometry.getAttribute('position');
  return buildWarpModel({
    positions: new Float32Array(position.array),
    index: geometry.index ? new Uint32Array(geometry.index.array) : null,
    normals: null,
    matrix: matrix.elements.slice(),
    faces: null,
    density,
  });
}

/** Local node positions at rest. */
function restLocal(model: WarpModel) {
  const local = new Float32Array(model.restNodes.length);
  const inverse = new Matrix4().fromArray(model.inverse),
    point = new Vector3();
  for (let i = 0; i < local.length; i += 3)
    point.fromArray(model.restNodes, i).applyMatrix4(inverse).toArray(local, i);
  return local;
}

function segments(model: WarpModel, path: WarpGridPath) {
  const out = new Float32Array(warpGridSegments(path) * 6);
  writeWarpGridPath(path, restLocal(model), model.positions, null, out);
  return out;
}

/** The furthest any segment's middle lies from the surface, over its edge's length. */
function worstDip(geometry: BufferGeometry, model: WarpModel, path: WarpGridPath) {
  const bvh = new MeshBVH(geometry);
  const out = segments(model, path);
  const middle = new Vector3();
  let worst = 0,
    s = 0;
  for (let e = 0; e < path.length.length; e++) {
    // Lengths are world; these tests' matrices scale by at most 2.
    const edge = path.length[e];
    for (let k = path.start[e]; k <= path.start[e + 1]; k++, s++) {
      middle.set(
        (out[s * 6] + out[s * 6 + 3]) / 2,
        (out[s * 6 + 1] + out[s * 6 + 4]) / 2,
        (out[s * 6 + 2] + out[s * 6 + 5]) / 2,
      );
      const hit = bvh.closestPointToPoint(middle)!;
      worst = Math.max(worst, hit.distance / edge);
    }
  }
  return worst;
}

const sphere = () => new SphereGeometry(15, 96, 64);

describe('grid paths', () => {
  it('lay every edge of a curved part on its surface', async () => {
    const geometry = sphere();
    for (const density of [0, 3, 6]) {
      const m = await model(geometry, density);
      const path = traceWarpGridPathNow(m);
      expect(path.failed, `density ${density}`).toBe(0);
      expect(path.from.length).toBeGreaterThan(0);
      // A chord between nodes dips by up to an eighth of a radian's turn; a traced edge by the
      // tolerance its kept points allow.
      expect(worstDip(geometry, m, path), `density ${density}`).toBeLessThan(
        warpGridPathLimits.tolerance * 1.01,
      );
      const chords = segments(m, { ...path, start: new Uint32Array(path.start.length) });
      expect(chords.every(Number.isFinite)).toBe(true);
    }
  });

  it('need no points between nodes on a flat part', async () => {
    const m = await model(new PlaneGeometry(30, 30, 40, 40), 3);
    const path = traceWarpGridPathNow(m);
    expect(path.failed).toBe(0);
    expect(path.from.length).toBe(0);
  });

  it('stay on their own side of a thin shell', async () => {
    const radius = 15;
    const arc = (r: number) =>
      Array.from({ length: 41 }, (_, i) => {
        const a = (i / 40) * (Math.PI / 2);
        return new Vector2(r * Math.cos(a), r * Math.sin(a));
      });
    const outer = arc(radius),
      inner = arc(radius - 0.8).reverse();
    const geometry = new LatheGeometry([...outer, ...inner, outer[0]], 96);
    for (const density of [0, 3]) {
      const m = await model(geometry, density);
      const path = traceWarpGridPathNow(m);
      const out = segments(m, path);
      const sheet = (x: number, y: number, z: number) =>
        Math.hypot(x, y, z) > radius - 0.4 ? 'outer' : 'inner';
      let s = 0,
        checked = 0;
      for (let e = 0; e < path.length.length; e++) {
        const count = path.start[e + 1] - path.start[e] + 1;
        const first = sheet(out[s * 6], out[s * 6 + 1], out[s * 6 + 2]),
          last = sheet(
            out[(s + count) * 6 - 3],
            out[(s + count) * 6 - 2],
            out[(s + count) * 6 - 1],
          );
        if (first === last)
          for (let k = 0; k < count; k++, checked++)
            expect(sheet(out[(s + k) * 6 + 3], out[(s + k) * 6 + 4], out[(s + k) * 6 + 5])).toBe(
              first,
            );
        s += count;
      }
      expect(checked).toBeGreaterThan(100);
    }
  });

  it('are the same under a mirrored, turned, unevenly scaled part', async () => {
    const geometry = sphere();
    const matrix = new Matrix4().compose(
      new Vector3(3, 15, -2),
      new Quaternion().setFromAxisAngle(new Vector3(1, 2, 0.5).normalize(), 0.8),
      new Vector3(-1, 2, 0.6),
    );
    const m = await model(geometry, 3, matrix);
    const path = traceWarpGridPathNow(m);
    expect(path.failed).toBe(0);
    expect(segments(m, path).every(Number.isFinite)).toBe(true);
    expect(worstDip(geometry, m, path)).toBeLessThan(warpGridPathLimits.tolerance * 2);
  });

  it('keep to their limits per edge and in all', async () => {
    const m = await model(sphere(), 0);
    const loose = traceWarpGridPathNow(m);
    const limits = { ...warpGridPathLimits, perEdge: 3, total: 200 };
    const path = traceWarpGridPathNow(m, limits);
    expect(loose.from.length).toBeGreaterThan(200);
    expect(path.from.length).toBeLessThanOrEqual(200);
    for (let e = 0; e < path.length.length; e++)
      expect(path.start[e + 1] - path.start[e]).toBeLessThanOrEqual(3);
  });

  it('carry a drag of their nodes to the points between them', async () => {
    const m = await model(sphere(), 3);
    const path = traceWarpGridPathNow(m);
    const local = restLocal(m);
    const shift = new Float32Array(local.length);
    let e = 0;
    while (path.start[e + 1] === path.start[e]) e++;
    const a = path.ends[e * 2],
      b = path.ends[e * 2 + 1];
    shift[a * 3 + 1] = 2;
    shift[b * 3 + 1] = 4;
    const still = new Float32Array(warpGridSegments(path) * 6),
      moved = new Float32Array(still.length);
    writeWarpGridPath(path, local, m.positions, null, still);
    writeWarpGridPath(path, local, m.positions, shift, moved);
    // Segments before this edge: one per edge and one per point.
    const before = e + path.start[e];
    for (let k = path.start[e]; k < path.start[e + 1]; k++) {
      const o = (before + k - path.start[e]) * 6 + 4;
      expect(moved[o] - still[o]).toBeCloseTo(2 + 2 * path.along[k], 5);
    }
  });
});
