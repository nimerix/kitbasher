import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, IcosahedronGeometry, Matrix4, Vector3, type BufferGeometry } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { useEditor, writtenWarpSample } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, Vec3 } from '../../src/core/types';
import { handleGuides } from '../../src/core/warp-handles';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;

/** A lumpy closed surface shaped like a miniature's torso, its largest axis `size` mm. */
function torso(size: number) {
  const geometry = new IcosahedronGeometry(1, 70);
  geometry.deleteAttribute('uv');
  const position = geometry.getAttribute('position');
  const v = new Vector3();
  for (let i = 0; i < position.count; i++) {
    v.fromBufferAttribute(position, i);
    const around = Math.atan2(v.z, v.x),
      down = Math.acos(Math.max(-1, Math.min(1, v.y)));
    v.multiplyScalar(
      1 +
        0.12 * Math.sin(3 * around) * Math.sin(down) ** 2 +
        0.08 * Math.cos(5 * down + 1) +
        0.05 * Math.sin(7 * around + 2 * down) * Math.sin(down) ** 4,
    );
    position.setXYZ(i, v.x * 0.55, v.y, v.z * 0.38);
  }
  geometry.computeBoundingBox();
  const box = geometry.boundingBox!;
  const scale = size / Math.max(...box.max.clone().sub(box.min).toArray());
  geometry.scale(scale, scale, scale);
  geometry.computeVertexNormals();
  geometry.setAttribute(
    'color',
    new BufferAttribute(new Float32Array(position.count * 3).fill(0.5), 3),
  );
  return geometry;
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

let seed = 99;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

afterEach(() => editor().cancelWarp());

/**
 * The first drag of a new point with every setting at its default, over a whole miniature-like
 * part with its automatic points: a smooth bump, not a spike and not the whole part.
 */
async function firstDrags(size: number, clicks: number) {
  const geometry: BufferGeometry = torso(size);
  const part: Part = {
    id: 'mini',
    name: 'mini',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
  editor().setScene({ name: 'Mini', parts: [part], joints: [] });
  useEditor.setState({ selected: ['mini'] });
  editor().setTool('warp');
  await editor().layWarpGrid();
  expect(session().points).toHaveLength(8);
  const rest = written();
  seed = 99;
  const results = [];
  for (let click = 0; click < clicks; click++) {
    const face = Math.floor(random() * triangleCount(geometry));
    const triangle = readFace(geometry, face);
    const centre = triangle.getMidpoint(new Vector3()),
      normal = triangle.getNormal(new Vector3());
    editor().addWarpPoint(
      { partId: 'mini', point: centre.toArray(), normal: normal.toArray() },
      face,
    );
    const point = session().points.at(-1)!;
    const result = {
      active: handleGuides(point),
      radius: point.radius,
      pulls: [] as {
        lift: number;
        folds: number;
        nearTenth: number;
        tip: number;
      }[],
    };
    const tangent = new Vector3(-normal.y, normal.x, 0).normalize();
    for (const [direction, h] of [
      [normal, 2],
      [tangent, 0.015 * size],
      [normal.clone().negate(), 0.015 * size],
    ] as const) {
      const target = new Vector3(...point.pin).addScaledVector(direction, h).toArray() as Vec3;
      editor().moveWarpPoints([{ id: point.id, target }], 'end');
      const world = written();
      const { restWorld, region } = session().model!;
      const at = point.samples[0].restWorld;
      let lift = 0;
      const ring: number[] = [];
      for (const v of region.interior) {
        const along =
          (world[v * 3] - rest[v * 3]) * direction.x +
          (world[v * 3 + 1] - rest[v * 3 + 1]) * direction.y +
          (world[v * 3 + 2] - rest[v * 3 + 2]) * direction.z;
        lift = Math.max(lift, along);
        const d = Math.hypot(
          restWorld[v * 3] - at[0],
          restWorld[v * 3 + 1] - at[1],
          restWorld[v * 3 + 2] - at[2],
        );
        if (Math.abs(d - point.radius / 10) < point.radius / 40) ring.push(along / h);
      }
      ring.sort((a, b) => a - b);
      const moved = session().points.at(-1)!;
      const tip = writtenWarpSample(moved.samples[0]);
      result.pulls.push({
        lift: lift / h,
        folds: session().folds.length,
        nearTenth: ring[ring.length >> 1],
        tip: Math.hypot(tip[0] - target[0], tip[1] - target[1], tip[2] - target[2]) / h,
      });
      editor().undoWarpEdit();
    }
    editor().undoWarpEdit();
    results.push(result);
  }
  return results;
}

describe('a new point’s first drag at the default settings', () => {
  for (const size of [32, 100])
    it(`bends a ${size} mm miniature smoothly where it is clicked`, async () => {
      const results = await firstDrags(size, 16);
      for (const { active, pulls } of results) {
        expect(active).toBe(true);
        const [outward, ...moderate] = pulls;
        // A 2 mm pull: the grid never lifts past the point, and skin maps that stretch with it
        // keep the surface between nodes within a few percent.
        expect(outward.lift).toBeLessThan(1.05);
        expect(outward.nearTenth).toBeGreaterThanOrEqual(0.93);
        expect(outward.tip).toBeLessThan(0.01);
        // A tangential and an inward pull of 1.5 % of the part.
        for (const pull of moderate) expect(pull.lift).toBeLessThan(1.05);
      }
      for (const { pulls } of results) for (const { folds } of pulls) expect(folds).toBe(0);
    }, 300_000);
});
