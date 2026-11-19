import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, PlaneGeometry, Vector3 } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { finishWarpSettling, useEditor, writtenWarpSample } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, Vec3 } from '../../src/core/types';
import { writtenLocalPositions } from '../../src/core/warp-evaluate';
import { detailAt, shownDetail, warpPinHold } from '../../src/core/warp-handles';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;

afterEach(() => editor().cancelWarp());

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

let seed = 7;
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648;
  return seed / 2147483648;
};

/** A 20 × 8 × 20 mm block, top at y = 4, with its top face's vertices jittered by half a cell. */
function block() {
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
    position.setXYZ(i, x + d[0], y, z + d[1]);
  }
  const out = box.toNonIndexed();
  out.computeVertexNormals();
  return out;
}

const partOf = (id: string, geometry: BufferGeometry, position: Vec3 = [0, 0, 0]): Part => ({
  id,
  name: id,
  geometry,
  position,
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
});

function begin(parts: Part[]) {
  editor().setScene({ name: 'Warp', parts, joints: [] });
  useEditor.setState({ selected: [parts[0].id] });
  editor().setTool('warp');
}

/** The face whose centre is nearest `at` among those whose normal is `up`, with its centre. */
function faceNear(geometry: BufferGeometry, at: Vec3, up: Vec3) {
  let best = -1,
    far = Infinity;
  const mid = new Vector3(),
    normal = new Vector3();
  for (let f = 0; f < triangleCount(geometry); f++) {
    const triangle = readFace(geometry, f);
    if (triangle.getNormal(normal).dot(new Vector3(...up)) < 0.99) continue;
    const d = triangle.getMidpoint(mid).distanceTo(new Vector3(...at));
    if (d < far) [best, far] = [f, d];
  }
  return { face: best, centre: readFace(geometry, best).getMidpoint(new Vector3()) };
}

/** Adds a point at the face centre nearest `at` and moves it by `by`. */
function pull(geometry: BufferGeometry, at: Vec3, up: Vec3, by: Vec3) {
  const { face, centre } = faceNear(geometry, at, up);
  editor().addWarpPoint({ partId: 'a', point: centre.toArray(), normal: up }, face);
  const point = session().points.at(-1)!;
  const target = point.pin.map((value, a) => value + by[a]) as Vec3;
  editor().moveWarpPoints([{ id: point.id, target }], 'end');
  finishWarpSettling();
  return session().points.find(({ id }) => id === point.id)!;
}

/** The mesh shown, as plain numbers. */
const shown = () => Array.from(session().output!.positions);

describe('detail the moved handles bend between grid nodes', () => {
  it('is written once on a new grid: a denser grid shows the pull a fresh one at that density does', async () => {
    for (const falloff of [0, 1]) {
      begin([partOf('a', block())]);
      editor().setWarpFeather({ enabled: false });
      await editor().layWarpGrid();
      editor().setWarpPointSettings({ falloff, radius: 4 }, 'end');
      const point = pull(session().source, [0, 4, 0], [0, 1, 0], [0, 30, 0]);
      expect(shownDetail(session().output)?.vertices.length, `falloff ${falloff}`).toBeGreaterThan(
        0,
      );
      await editor().setWarpDensity(session().density + 1);
      finishWarpSettling();
      const density = session().density;
      const relaid = shown();
      const landed = session().points.find(({ id }) => id === point.id)!;
      expect(distance(writtenWarpSample(landed.samples[0]), landed.target!)).toBeLessThan(1e-3);
      editor().cancelWarp();

      begin([partOf('a', block())]);
      editor().setWarpFeather({ enabled: false });
      await editor().layWarpGrid();
      await editor().setWarpDensity(density);
      editor().setWarpPointSettings({ falloff, radius: 4 }, 'end');
      pull(session().source, [0, 4, 0], [0, 1, 0], [0, 30, 0]);
      const fresh = shown();
      let worst = 0;
      for (let i = 0; i < fresh.length; i += 3)
        worst = Math.max(worst, distance(relaid.slice(i, i + 3), fresh.slice(i, i + 3)));
      // Detail carried in the new grid's nodes and written again on top would show here.
      expect(worst, `falloff ${falloff}`).toBeLessThan(1e-3);
      editor().cancelWarp();
    }
  });

  it('stays in a baseline taken on it when a new region is laid', async () => {
    const geometry = block();
    begin([partOf('a', geometry)]);
    editor().setWarpFeather({ enabled: true, width: 3 });
    const disc = (r: number) => {
      const faces: number[] = [];
      const mid = new Vector3();
      for (let f = 0; f < triangleCount(geometry); f++) {
        readFace(geometry, f).getMidpoint(mid);
        if (Math.abs(mid.y - 4) < 1e-4 && Math.hypot(mid.x, mid.z) < r) faces.push(f);
      }
      return faces;
    };
    useEditor.setState({ warp: { ...session(), faces: disc(5) } });
    await editor().layWarpGrid();
    editor().setWarpPointSettings({ radius: 3.7, falloff: 0 }, 'end');
    const first = pull(geometry, [0, 4, 0], [0, 1, 0], [0, 10, 0]);
    expect(shownDetail(session().output)?.vertices.length).toBeGreaterThan(0);
    const written = shown();
    const old = session().model!;
    // A point made on the bent surface, which its baseline holds as shown.
    const { face } = faceNear(geometry, [2.4, 4, 0], [0, 1, 0]);
    editor().addWarpPoint(
      {
        partId: 'a',
        point: readFace(geometry, face).getMidpoint(new Vector3()).toArray(),
        normal: [0, 1, 0],
      },
      face,
    );
    const second = session().points.at(-1)!;
    editor().moveWarpPoints(
      [{ id: first.id, target: first.target!.map((v, a) => v + (a === 1 ? 2 : 0)) as Vec3 }],
      'end',
    );
    finishWarpSettling();

    editor().setWarpRegion('painted');
    useEditor.setState({ warp: { ...session(), faces: disc(6.7) } });
    await editor().layWarpGrid();
    finishWarpSettling();
    const next = session().model!;
    const baseline = session().points.find(({ id }) => id === second.id)!.baseline;
    expect(baseline.grid).toBe(next.grid);
    const firstOf = new Map<number, number>();
    old.region.weldOf.forEach((v, g) => {
      if (!firstOf.has(v)) firstOf.set(v, g);
    });
    let compared = 0,
      worst = 0;
    next.grid.nodes.forEach((v, n) => {
      const g = firstOf.get(v);
      // Nodes written in full on both grids, where the old one bent them.
      if (g === undefined || !old.blend?.[v] || next.blend?.[v] !== 1 || next.grid.fixed[n]) return;
      compared++;
      worst = Math.max(
        worst,
        distance(baseline.positions.subarray(n * 3, n * 3 + 3), written.slice(g * 3, g * 3 + 3)),
      );
    });
    expect(compared).toBeGreaterThan(100);
    expect(worst).toBeLessThan(1e-5);
  });
});

describe('Close gap on a surface with detail', () => {
  /** A 40 mm plate in z = 0 facing +z. */
  function plate(id: string, size = 40, segments = 64, position: Vec3 = [0, 0, 0]): Part {
    const geometry = new PlaneGeometry(size, size, segments, segments);
    geometry.deleteAttribute('uv');
    const count = geometry.getAttribute('position').count;
    geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
    return partOf(id, geometry, position);
  }

  it('faces nodes by the surface as it is written, detail and all', async () => {
    begin([plate('a')]);
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    editor().setWarpPointSettings({ falloff: 0, radius: 4 }, 'end');
    pull(session().source, [0, 0, 0], [0, 0, 1], [0, 0, 6]);
    const { model, state, output } = session();
    const detail = shownDetail(output)!;
    expect(detail.vertices.length).toBeGreaterThan(0);
    const first = new Int32Array(model!.region.weldedCount).fill(-1);
    model!.region.weldOf.forEach((v, g) => {
      if (v !== 0xffffffff && first[v] < 0) first[v] = g;
    });
    const vertices = Array.from(detail.vertices);
    const expected = vertices.flatMap((v) =>
      Array.from(output!.positions.subarray(first[v] * 3, first[v] * 3 + 3)),
    );
    // What the seam readout and Close gap's normals read is the mesh shown, bit for bit.
    expect(Array.from(writtenLocalPositions(model!, state!, vertices, first, detail))).toEqual(
      expected,
    );
    expect(Array.from(writtenLocalPositions(model!, state!, vertices, first))).not.toEqual(
      expected,
    );
  });

  it('judges a held point by where it is written before and after closing', async () => {
    // Facing the plate 4 mm in front, over the side away from the held point.
    const b: Part = { ...plate('b', 40, 32, [24, 0, 4]), quaternion: [0, 1, 0, 0] };
    begin([plate('a'), b]);
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    editor().setWarpPointSettings({ falloff: 0, radius: 4 }, 'end');
    pull(session().source, [0, 0, 0], [0, 0, 1], [0, 0, 3]);
    // A point the user places on the pull's shoulder, where the detail bends the surface.
    const { face } = faceNear(session().source, [-3.3, 0, 0], [0, 0, 1]);
    const model = session().model!;
    // Holding only where it is placed, so the pull keeps its whole bend.
    editor().selectWarpPoints([]);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    // Clicked where the face's centre is shown.
    const index = session().source.index!;
    const shownAt: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = index.getX(face * 3 + c);
      for (let a = 0; a < 3; a++) shownAt[a] += session().output!.positions[v * 3 + a] / 3;
    }
    editor().addWarpPoint({ partId: 'a', point: shownAt, normal: [0, 0, 1] }, face);
    finishWarpSettling();
    const held = session().points.at(-1)!;
    expect(held.target).toBeNull();
    const { barycentric } = held.samples[0];
    const before = detailAt(model, shownDetail(session().output), face, barycentric);
    expect(Math.hypot(...before)).toBeGreaterThan(0.01);

    editor().closeWarpGap();
    finishWarpSettling();
    const { gapTargets, gapHeld } = session();
    expect(gapTargets.length).toBeGreaterThan(50);
    expect(distance(writtenWarpSample(held.samples[0]), held.pin)).toBeLessThanOrEqual(warpPinHold);
    expect(gapHeld).toBe(0);
  });
});
