import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferGeometry, PlaneGeometry, SphereGeometry, Vector3 } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { triangleCount } from '../../src/core/geometry';
import { finishWarpSettling, useEditor, writtenWarpSample } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, Vec3 } from '../../src/core/types';
import { planarPointDetail } from '../../src/core/warp-point-surface';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** A 20 × 8 × 20 mm block, top at y = 4, with its top face's vertices jittered by half a cell. */
function block(height = (_x: number, _z: number) => 0) {
  const seg = 80;
  const box = new BoxGeometry(20, 8, 20, seg, 32, seg);
  box.deleteAttribute('uv');
  const position = box.getAttribute('position');
  const step = 20 / seg;
  seed = 7;
  const moved = new Map<string, [number, number]>();
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i),
      y = position.getY(i),
      z = position.getZ(i);
    if (Math.abs(y - 4) > 1e-6 || Math.abs(x) > 10 - 1e-6 || Math.abs(z) > 10 - 1e-6) continue;
    const key = `${Math.round(x / step)},${Math.round(z / step)}`;
    let d = moved.get(key);
    if (!d) moved.set(key, (d = [(random() - 0.5) * 0.5 * step, (random() - 0.5) * 0.5 * step]));
    position.setXYZ(i, x + d[0], y + height(x, z), z + d[1]);
  }
  const out = box.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

async function open(geometry: BufferGeometry) {
  const part: Part = {
    id: 'a',
    name: 'a',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
  editor().setScene({ name: 'Warp', parts: [part], joints: [] });
  useEditor.setState({ selected: ['a'] });
  editor().setTool('warp');
  editor().setWarpFeather({ enabled: false });
  await editor().layWarpGrid();
  return part;
}

/** The top face nearest (x, z), with its centre. */
function topFace(geometry: BufferGeometry, x: number, z: number) {
  let best = -1,
    distance = Infinity;
  const mid = new Vector3();
  const normal = new Vector3();
  for (let f = 0; f < triangleCount(geometry); f++) {
    const triangle = readFace(geometry, f);
    triangle.getMidpoint(mid);
    if (mid.y < 3.5 || triangle.getNormal(normal).y < 0.9) continue;
    const d = Math.hypot(mid.x - x, mid.z - z);
    if (d < distance) [best, distance] = [f, d];
  }
  return { face: best, centre: readFace(geometry, best).getMidpoint(new Vector3()) };
}

/** Adds a point on the top face at (x, z) and pulls it up by `h` and sideways by `side`. */
function pull(geometry: BufferGeometry, x: number, z: number, h: number, side = 0) {
  const { face, centre } = topFace(geometry, x, z);
  editor().addWarpPoint({ partId: 'a', point: centre.toArray(), normal: [0, 1, 0] }, face);
  const point = session().points.at(-1)!;
  const target: Vec3 = [point.pin[0] + side, point.pin[1] + h, point.pin[2]];
  editor().moveWarpPoints([{ id: point.id, target }], 'end');
  return { id: point.id, centre, target };
}

/**
 * The top face's written vertices around `centre`: the most any lifts off a line fitted through
 * its 29 nearest neighbours in distance from the centre, as teeth around the bend show, and the
 * lowest any past `from` sits below the face.
 */
function relief(geometry: BufferGeometry, centre: Vector3, from: number) {
  const rest = geometry.getAttribute('position').array as Float32Array;
  const out = session().output!.positions;
  const top: { r: number; lift: number }[] = [];
  const seen = new Set<string>();
  for (let g = 0; g < rest.length / 3; g++) {
    if (rest[g * 3 + 1] < 3.5) continue;
    const key = `${rest[g * 3]},${rest[g * 3 + 2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const r = Math.hypot(rest[g * 3] - centre.x, rest[g * 3 + 2] - centre.z);
    if (r < 9) top.push({ r, lift: out[g * 3 + 1] - rest[g * 3 + 1] });
  }
  top.sort((a, b) => a.r - b.r);
  const half = 14;
  let teeth = 0,
    dip = 0;
  for (let i = 0; i < top.length; i++) {
    const a = Math.max(0, i - half),
      b = Math.min(top.length - 1, i + half);
    let s = 0,
      sr = 0,
      sy = 0,
      srr = 0,
      sry = 0;
    for (let k = a; k <= b; k++) {
      s++;
      sr += top[k].r;
      sy += top[k].lift;
      srr += top[k].r ** 2;
      sry += top[k].r * top[k].lift;
    }
    const det = s * srr - sr * sr;
    const slope = Math.abs(det) > 1e-12 ? (s * sry - sr * sy) / det : 0;
    teeth = Math.max(teeth, Math.abs(top[i].lift - ((sy - slope * sr) / s + slope * top[i].r)));
    if (top[i].r > from) dip = Math.min(dip, top[i].lift);
  }
  return { teeth, dip };
}

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

afterEach(() => editor().cancelWarp());

describe('a long pull on a flat face', () => {
  // A 30 mm pull on an irregularly triangulated face, tall enough to expose any surface
  // drift and roughness left by the grid near the shoulder.
  for (const [falloff, teethLimit] of [
    [null, 0.3],
    [0, 0.2],
  ] as const)
    it(`rises cleanly from the face at ${falloff === null ? 'the default falloff' : '0 % falloff'}`, async () => {
      const geometry = block();
      await open(geometry);
      if (falloff !== null) editor().setWarpPointSettings({ falloff }, 'end');
      const { id, centre, target } = pull(geometry, 0, 0, 30);
      finishWarpSettling();
      const point = session().points.find((p) => p.id === id)!;
      expect(session().folds).toHaveLength(0);
      const { teeth, dip } = relief(geometry, centre, point.radius);
      expect(teeth).toBeLessThan(teethLimit);
      expect(dip).toBeGreaterThan(-0.02);
      const rest = geometry.getAttribute('position').array;
      const written = session().output!.positions;
      let drift = 0;
      for (let i = 0; i < rest.length; i += 3) {
        if (
          rest[i + 1] !== 4 ||
          Math.hypot(rest[i] - centre.x, rest[i + 2] - centre.z) > point.radius
        )
          continue;
        drift = Math.max(drift, Math.hypot(written[i] - rest[i], written[i + 2] - rest[i + 2]));
      }
      expect(drift).toBeLessThan(1e-6);
      // The tip still lands where it was pulled.
      const writtenCentre = readFace(session().preview!, point.samples[0].face).getMidpoint(
        new Vector3(),
      );
      expect(distance(writtenCentre.toArray(), target)).toBeLessThan(0.01);
      // Apply bakes exactly what is shown.
      const shown = Array.from(session().output!.positions);
      expect(editor().applyWarp()).toBe(true);
      const part = editor().scene.parts.find((p) => p.id === 'a')!;
      expect(Array.from(part.geometry.getAttribute('position').array)).toEqual(shown);
    }, 60_000);

  it.each([
    { name: 'a near-flat scan', side: 0 },
    { name: 'an oblique pull on a near-flat scan', side: 1.8 },
  ])(
    'keeps the shoulder smooth on $name',
    async ({ side }) => {
      // Low-frequency curvature and fine relief on uneven triangles, in mm.
      const geometry = block(
        (x, z) => 0.0015 * (x * x + 0.7 * z * z) + 0.008 * Math.sin(4 * x) * Math.cos(5 * z),
      );
      await open(geometry);
      const radius = 5;
      editor().setWarpPointSettings({ radius, falloff: 0 }, 'end');
      const { id, centre, target } = pull(geometry, 0, 0, 25, side);
      finishWarpSettling();
      const point = session().points.find((p) => p.id === id)!;
      expect(distance(writtenWarpSample(point.samples[0]), target)).toBeLessThan(0.01);
      expect(session().folds).toHaveLength(0);
      const { teeth, dip } = relief(geometry, centre, radius);
      expect(teeth).toBeLessThan(0.24);
      expect(dip).toBeGreaterThan(-0.025);
      const rest = geometry.getAttribute('position').array;
      const written = session().output!.positions;
      let shoulder = 0;
      for (let i = 0; i < rest.length; i += 3) {
        const r = Math.hypot(rest[i] - centre.x, rest[i + 2] - centre.z);
        if (rest[i + 1] > 3.5 && r >= radius && r < radius + 0.4)
          shoulder = Math.max(
            shoulder,
            distance(rest.subarray(i, i + 3), written.subarray(i, i + 3)),
          );
      }
      expect(shoulder).toBeLessThan(0.025);
    },
    60_000,
  );

  it('lands two overlapping points pulled at 0 % falloff and rises cleanly between them', async () => {
    const geometry = block();
    await open(geometry);
    editor().setWarpPointSettings({ falloff: 0 }, 'end');
    const first = pull(geometry, -1.5, 0, 20);
    const second = pull(geometry, 1.5, 0.5, 25);
    finishWarpSettling();
    expect(session().folds).toHaveLength(0);
    // Each holds the other back a little, by up to 0.028 mm before the bend was written per vertex.
    const moved = [first, second].map(({ id }) => session().points.find((p) => p.id === id)!);
    for (const [k, { target }] of [first, second].entries())
      expect(distance(writtenWarpSample(moved[k].samples[0]), target)).toBeLessThan(0.025);
    // Outside both radii the face stays nearly where it was: it dipped 1.40 mm before.
    const rest = geometry.getAttribute('position').array as Float32Array;
    const out = session().output!.positions;
    let dip = 0;
    for (let g = 0; g < rest.length / 3; g++) {
      if (Math.abs(rest[g * 3 + 1] - 4) > 1e-5) continue;
      const outside = moved.every(
        (point, k) =>
          Math.hypot(
            rest[g * 3] - [first, second][k].centre.x,
            rest[g * 3 + 2] - [first, second][k].centre.z,
          ) > point.radius,
      );
      if (outside) dip = Math.min(dip, out[g * 3 + 1] - 4);
    }
    expect(dip).toBeGreaterThan(-0.15);
  }, 60_000);
});

describe('a long pull near a crease or on a curved surface', () => {
  it.each([
    { name: 'a crease in the footprint', geometry: () => block(), x: 7, z: 0 },
    { name: 'a curved footprint', geometry: () => new SphereGeometry(6, 128, 96), x: 0, z: 0 },
  ])(
    'leaves $name to the grid solve',
    async ({ geometry, x, z }) => {
      const surface = geometry();
      await open(surface);
      editor().setWarpPointSettings({ radius: 4, falloff: 0 }, 'end');
      pull(surface, x, z, 12);
      finishWarpSettling();
      const { model, state, points } = session();
      expect(points.at(-1)?.reach?.activation).toBe(1);
      expect(planarPointDetail(model!, state!, points, undefined)).toBeUndefined();
    },
    60_000,
  );
});

describe('a long pull on one sheet of a fold', () => {
  it('leaves the sheet beneath where it was', async () => {
    // Two sheets 0.5 mm apart, joined along one edge: nearer in a straight line than across the
    // surface, which the bend must not cross.
    const lower = new PlaneGeometry(20, 20, 40, 40).rotateX(-Math.PI / 2);
    const upper = new PlaneGeometry(20, 20, 40, 40).rotateX(Math.PI / 2).translate(0, 0.5, 0);
    const strip = new PlaneGeometry(20, 0.5, 40, 1).rotateY(Math.PI / 2).translate(10, 0.25, 0);
    for (const g of [lower, upper, strip]) g.deleteAttribute('uv');
    const sheet = mergeVertices(mergeGeometries([lower, upper, strip])).toNonIndexed();
    sheet.computeVertexNormals();
    await open(sheet);
    editor().setWarpPointSettings({ radius: 4, falloff: 0 }, 'end');
    let face = -1;
    const mid = new Vector3();
    for (let f = 0; f < triangleCount(sheet) && face < 0; f++)
      if (readFace(sheet, f).getMidpoint(mid).y > 0.4 && Math.hypot(mid.x + 2, mid.z) < 0.4)
        face = f;
    const centre = readFace(sheet, face).getMidpoint(new Vector3());
    editor().addWarpPoint({ partId: 'a', point: centre.toArray(), normal: [0, 1, 0] }, face);
    const point = session().points.at(-1)!;
    editor().moveWarpPoints(
      [{ id: point.id, target: [point.pin[0], point.pin[1] + 10, point.pin[2]] }],
      'end',
    );
    finishWarpSettling();
    const rest = sheet.getAttribute('position').array as Float32Array;
    const out = session().output!.positions;
    let lowerMoved = 0,
      upperLift = 0;
    for (let g = 0; g < rest.length / 3; g++) {
      const moved = distance(out.subarray(g * 3, g * 3 + 3), rest.subarray(g * 3, g * 3 + 3));
      if (rest[g * 3 + 1] < 1e-6 && rest[g * 3] < 9) lowerMoved = Math.max(lowerMoved, moved);
      if (rest[g * 3 + 1] > 0.5 - 1e-6) upperLift = Math.max(upperLift, out[g * 3 + 1] - 0.5);
    }
    expect(upperLift).toBeGreaterThan(9);
    expect(lowerMoved).toBeLessThan(1e-6);
  }, 60_000);
});
