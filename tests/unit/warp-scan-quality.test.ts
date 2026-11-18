import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, IcosahedronGeometry, Matrix4, Vector3 } from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { weldedPositionIndex } from '../../src/core/mesh-topology';
import { triangleCount } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, Vec3 } from '../../src/core/types';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/**
 * A dense closed surface like a scanned miniature, its largest axis `size` mm: organic curvature, a
 * tight ridge a bump can wrap, relief finer than the grid, an irregular triangulation, and slivers
 * where edges were split close to a corner. Unindexed, as scans are.
 */
function scanLike(size: number) {
  const ico = new IcosahedronGeometry(1, 90);
  ico.deleteAttribute('uv');
  ico.deleteAttribute('normal');
  const geometry = mergeVertices(ico);
  const position = geometry.getAttribute('position') as BufferAttribute;
  const v = new Vector3();
  seed = 7;
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i).normalize();
    // Tangential jitter of up to a third of an edge makes the triangulation irregular.
    const jitter = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).multiplyScalar(
      0.007,
    );
    v.add(jitter.sub(v.clone().multiplyScalar(jitter.dot(v)))).normalize();
    const around = Math.atan2(v.z, v.x),
      down = Math.acos(Math.max(-1, Math.min(1, v.y)));
    const ridge = Math.max(0, 1 - Math.abs(v.y + 0.25) / 0.035);
    v.multiplyScalar(
      1 +
        0.12 * Math.sin(3 * around) * Math.sin(down) ** 2 +
        0.08 * Math.cos(5 * down + 1) +
        0.09 * ridge +
        0.002 * Math.sin(170 * around + 3) * Math.sin(150 * down),
    );
    position.setXYZ(i, v.x * 0.6, v.y, v.z * 0.42);
  }
  // Split one edge in thirty close to a corner, on both its faces, leaving slivers.
  const index = Array.from(geometry.index!.array);
  const points = Array.from(position.array as Float32Array);
  const faces = new Map<string, number[]>();
  for (let f = 0; f < index.length / 3; f++)
    for (let k = 0; k < 3; k++) {
      const a = index[f * 3 + k],
        b = index[f * 3 + ((k + 1) % 3)];
      const key = a < b ? `${a},${b}` : `${b},${a}`;
      faces.set(key, [...(faces.get(key) ?? []), f]);
    }
  const split = new Set<number>();
  for (const [key, list] of faces) {
    if (list.length !== 2 || list.some((f) => split.has(f)) || random() > 1 / 30) continue;
    const [a, b] = key.split(',').map(Number);
    const t = 0.03;
    const m = points.length / 3;
    for (let c = 0; c < 3; c++) points.push(points[a * 3 + c] * (1 - t) + points[b * 3 + c] * t);
    for (const f of list) {
      split.add(f);
      const tri = index.slice(f * 3, f * 3 + 3);
      const k = tri.findIndex(
        (x, i) => (x === a && tri[(i + 1) % 3] === b) || (x === b && tri[(i + 1) % 3] === a),
      );
      const [p, q, r] = [tri[k], tri[(k + 1) % 3], tri[(k + 2) % 3]];
      index.splice(f * 3, 3, p, m, r);
      index.push(m, q, r);
    }
  }
  const indexed = new BufferGeometry();
  indexed.setAttribute('position', new BufferAttribute(Float32Array.from(points), 3));
  indexed.setIndex(index);
  const out = indexed.toNonIndexed();
  out.computeBoundingBox();
  const box = out.boundingBox!;
  const scale = size / Math.max(...box.max.clone().sub(box.min).toArray());
  out.scale(scale, scale, scale);
  out.computeVertexNormals();
  return out;
}

function open(geometry: BufferGeometry, faces?: number[], feather?: number) {
  const part: Part = {
    id: 'scan',
    name: 'scan',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
  editor().setScene({ name: 'Scan', parts: [part], joints: [] });
  useEditor.setState({ selected: ['scan'] });
  editor().setTool('warp');
  editor().setWarpFeather(feather ? { enabled: true, width: feather } : { enabled: false });
  if (faces) useEditor.setState({ warp: { ...session(), faces } });
  return editor().layWarpGrid();
}

/** World position of every welded region vertex on the preview. */
function written() {
  const warp = session();
  const matrix = new Matrix4().fromArray(warp.model!.matrix);
  const world = new Float64Array(warp.model!.region.weldedCount * 3);
  const v = new Vector3();
  warp.model!.region.weldOf.forEach((welded, g) => {
    if (welded !== 0xffffffff)
      v.fromArray(warp.output!.positions, g * 3)
        .applyMatrix4(matrix)
        .toArray(world, welded * 3);
  });
  return world;
}

/** Adds a point at a face centre, drags it once and undoes both, returning lift and folds. */
function pull(
  geometry: BufferGeometry,
  face: number,
  direction: (n: Vector3) => Vector3,
  h: number,
) {
  const triangle = readFace(geometry, face);
  const centre = triangle.getMidpoint(new Vector3()),
    normal = triangle.getNormal(new Vector3());
  const rest = written();
  editor().addWarpPoint(
    { partId: 'scan', point: centre.toArray(), normal: normal.toArray() },
    face,
  );
  const point = session().points.at(-1)!;
  const along = direction(normal);
  const target = new Vector3(...point.pin).addScaledVector(along, h).toArray() as Vec3;
  editor().moveWarpPoints([{ id: point.id, target }], 'end');
  const world = written();
  let lift = 0;
  for (const v of session().model!.region.interior)
    lift = Math.max(
      lift,
      (world[v * 3] - rest[v * 3]) * along.x +
        (world[v * 3 + 1] - rest[v * 3 + 1]) * along.y +
        (world[v * 3 + 2] - rest[v * 3 + 2]) * along.z,
    );
  const folds = session().folds.length;
  editor().undoWarpEdit();
  editor().undoWarpEdit();
  return { lift: lift / h, folds };
}

afterEach(() => editor().cancelWarp());

const outward = (n: Vector3) => n.clone();
const inward = (n: Vector3) => n.clone().negate();
const tangential = (n: Vector3) => {
  const t = new Vector3(-n.y, n.x, 0);
  return t.lengthSq() > 1e-6 ? t.normalize() : new Vector3(1, 0, 0);
};

describe('first drags on a dense scan-like surface at 32 mm', () => {
  it('fold almost nothing and never lift past the pull', async () => {
    const geometry = scanLike(32);
    await open(geometry);
    expect(session().points).toHaveLength(8);
    const count = triangleCount(geometry);
    const results: { lift: number; folds: number }[] = [];
    for (let i = 0; i < 24; i++) {
      const face = Math.floor(((i + 0.5) * count) / 24);
      for (const [direction, h] of [
        [outward, 2],
        [tangential, 0.48],
        [inward, 0.48],
      ] as const)
        results.push(pull(geometry, face, direction, h));
    }
    // The code before skin maps and the even grid folded 10 of these 24 outward pulls, up to 23
    // triangles, and 3 tangential ones, and lifted the surface to 1.17 times the pull. Cotangent
    // edge weights in the solve fold one triangle on a third outward pull.
    const [out, side, back] = [0, 1, 2].map((k) => results.filter((_, i) => i % 3 === k));
    expect(out.filter(({ folds }) => folds > 0).length).toBeLessThanOrEqual(3);
    for (const { folds } of out) expect(folds).toBeLessThanOrEqual(2);
    for (const { folds } of [...side, ...back]) expect(folds).toBe(0);
    for (const { lift } of results) expect(lift).toBeLessThan(1.1);
  }, 600_000);
});

/** Change in angle between adjacent written faces across the painted edge, degrees, ascending. */
function edgeChanges(geometry: BufferGeometry, painted: Uint8Array) {
  const { indices, vertices } = weldedPositionIndex(geometry);
  const sides = new Map<number, number[]>();
  for (let f = 0; f < indices.length / 3; f++)
    for (let k = 0; k < 3; k++) {
      const a = indices[f * 3 + k],
        b = indices[f * 3 + ((k + 1) % 3)];
      const key = Math.min(a, b) * vertices + Math.max(a, b);
      sides.set(key, [...(sides.get(key) ?? []), f]);
    }
  const normal = (positions: ArrayLike<number>, f: number) => {
    const [a, b, c] = [0, 1, 2].map((k) => new Vector3().fromArray(positions, (f * 3 + k) * 3));
    return b.sub(a).cross(c.sub(a)).normalize();
  };
  const rest = geometry.getAttribute('position').array,
    now = session().output!.positions;
  const changes: number[] = [];
  for (const list of sides.values()) {
    if (list.length !== 2 || painted[list[0]] === painted[list[1]]) continue;
    const [f, h] = list;
    const before = normal(rest, f).angleTo(normal(rest, h)),
      after = normal(now, f).angleTo(normal(now, h));
    changes.push((Math.abs(after - before) * 180) / Math.PI);
  }
  return changes.sort((a, b) => a - b);
}

describe('a feathered painted edge on a dense scan-like surface', () => {
  it('stays as smooth as the paint under a 1 mm pull from the middle, off it and across it', async () => {
    const geometry = scanLike(32);
    const count = triangleCount(geometry);
    const centre = new Vector3(),
      at = readFace(geometry, Math.floor(count * 0.37)).getMidpoint(new Vector3());
    const painted = new Uint8Array(count);
    const faces: number[] = [];
    for (let f = 0; f < count; f++)
      if (readFace(geometry, f).getMidpoint(centre).distanceTo(at) < 3.5) {
        painted[f] = 1;
        faces.push(f);
      }
    const normal = readFace(geometry, Math.floor(count * 0.37)).getNormal(new Vector3());
    const side = new Vector3().crossVectors(normal, new Vector3(0, 1, 0)).normalize();
    const spots = [0, 0.55 * 3.5, -0.55 * 3.5].map((d) => at.clone().addScaledVector(side, d));
    const nearest = (p: Vector3) => {
      let best = -1,
        distance = Infinity;
      for (const f of faces) {
        const d = readFace(geometry, f).getMidpoint(centre).distanceTo(p);
        if (d < distance) [best, distance] = [f, d];
      }
      return best;
    };
    const results: { feather: number; radius: number; p95: number; max: number; folds: number }[] =
      [];
    for (const feather of [0, 2]) {
      await open(geometry, faces, feather || undefined);
      for (const spot of spots)
        for (const radius of [null, 0]) {
          useEditor.setState({ warp: { ...session(), pointRadius: radius } });
          const face = nearest(spot);
          const triangle = readFace(geometry, face);
          const n = triangle.getNormal(new Vector3());
          editor().addWarpPoint(
            {
              partId: 'scan',
              point: triangle.getMidpoint(new Vector3()).toArray(),
              normal: n.toArray(),
            },
            face,
          );
          const point = session().points.at(-1)!;
          const target = new Vector3(...point.pin).addScaledVector(n, 1).toArray() as Vec3;
          editor().moveWarpPoints([{ id: point.id, target }], 'end');
          const changes = edgeChanges(geometry, painted);
          results.push({
            feather,
            radius: point.radius,
            p95: changes[Math.floor(changes.length * 0.95)],
            max: changes.at(-1)!,
            folds: session().folds.length,
          });
          editor().undoWarpEdit();
          editor().undoWarpEdit();
        }
      editor().cancelWarp();
    }
    // Absolute limits a few percent over what the feathered edge measures now. The code before
    // skin maps and the even grid reached a 95th percentile of 5.4° under a handle and 2.8° under
    // a bare point, and 13.3° at most; under a bare point at most 4.58°, which cotangent edge
    // weights take to 4.09° where the even grid alone gave 3.67°.
    for (const { feather, radius, p95, max, folds } of results) {
      expect(folds).toBe(0);
      // Unfeathered, a handle's bend fades into the fixed edge rather than creasing it: at most
      // 0.46° here, 1.59° on the simplifier's grid and 9.13° on the even grid before the fade.
      if (!feather && radius) expect(max).toBeLessThan(1);
      if (!feather) continue;
      expect(p95).toBeLessThan(radius ? 3.5 : 1.85);
      expect(max).toBeLessThan(radius ? 10 : 4.2);
    }
  }, 600_000);
});
