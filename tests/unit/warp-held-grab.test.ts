import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, PlaneGeometry, Triangle, Vector3 } from 'three';
import { triangleCount } from '../../src/core/geometry';
import {
  finishWarpSettling,
  useEditor,
  writtenWarpSample,
  warpPinDrift,
  warpShortfall,
  warpShortfallShown,
  type WarpPoint,
} from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, SurfacePoint, Vec3 } from '../../src/core/types';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import { WarpRole } from '../../src/core/warp-region';
import { skinMapOf } from '../../src/core/warp-solve';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;
const current = (id: string) => session().points.find((point) => point.id === id)!;
const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
/** Where the surface is written at the point's first sample. */
const deformed = (point: WarpPoint) => writtenWarpSample(point.samples[0]);

const initial = useEditor.getState();
afterEach(() => {
  editor().cancelWarp();
  useEditor.setState(initial);
});

function part(geometry: BufferGeometry): Part {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
  return {
    id: 'p',
    name: 'p',
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
}

/** A 16 mm sheet of 0.1 mm triangles with relief a few tenths of a millimetre deep, like a scan. */
function relief() {
  const geometry = new PlaneGeometry(16, 16, 160, 160);
  geometry.deleteAttribute('uv');
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++) {
    const x = position.getX(i),
      y = position.getY(i);
    position.setZ(
      i,
      0.075 * Math.sin(2.1 * x + 0.4) * Math.cos(1.7 * y) +
        0.036 * Math.sin(5.3 * x - 3.1 * y) +
        0.015 * Math.cos(11 * y + 7 * x),
    );
  }
  geometry.computeVertexNormals();
  return geometry;
}

const hitOn = (geometry: BufferGeometry, face: number): SurfacePoint => {
  const triangle = readFace(geometry, face);
  return {
    partId: 'p',
    point: triangle.getMidpoint(new Vector3()).toArray(),
    normal: triangle.getNormal(new Vector3()).toArray(),
  };
};

/** Starts Warp on the sheet with a 1.5 mm brush disc painted at its middle, feather off. */
async function paintedDisc(geometry: BufferGeometry, density?: number) {
  editor().setScene({ name: 'Held', parts: [part(geometry)], joints: [] });
  useEditor.setState({ selected: ['p'] });
  editor().setTool('warp');
  editor().setWarpBrushRadius(1.5);
  let middle = 0;
  for (let face = 1, best = Infinity; face < triangleCount(geometry); face++) {
    const centre = readFace(geometry, face).getMidpoint(new Vector3());
    const from = Math.hypot(centre.x, centre.y);
    if (from < best) [best, middle] = [from, face];
  }
  editor().paintWarpRegion(hitOn(geometry, middle), middle, false, true);
  editor().endPaintStroke();
  if (density !== undefined) await editor().setWarpDensity(density);
  await editor().layWarpGrid();
  return middle;
}

/** Share of a point's binding weight on free nodes. */
const freeShare = (point: WarpPoint) => {
  const { binding } = point.samples[0];
  const { fixed } = session().model!.grid;
  return binding.node.reduce((sum, n, k) => sum + (fixed[n] ? 0 : binding.weight[k]), 0);
};

/** The painted face with one corner on the fixed edge whose centre is bound least to free nodes. */
function edgeFace(geometry: BufferGeometry) {
  const { region } = session().model!;
  let face = -1,
    least = Infinity;
  for (let t = 0; t < region.faces.length; t++) {
    const border = [0, 1, 2].filter(
      (c) => region.role[region.triangles[t * 3 + c]] === WarpRole.Border,
    ).length;
    if (border !== 1) continue;
    editor().addWarpPoint(hitOn(geometry, region.faces[t]), region.faces[t]);
    const point = session().points.at(-1);
    if (point && freeShare(point) < least) [least, face] = [freeShare(point), region.faces[t]];
    if (point) editor().undoWarpEdit();
  }
  return { face, free: least };
}

/** Pulls a new point on `face` 1 mm along the face's normal and settles. */
function pull(geometry: BufferGeometry, face: number, radius: number | null) {
  useEditor.setState({ warp: { ...session(), pointRadius: radius } });
  editor().addWarpPoint(hitOn(geometry, face), face);
  const point = session().points.at(-1)!;
  const before = session().state!.positions.slice();
  const triangle = readFace(geometry, face);
  const target = triangle
    .getMidpoint(new Vector3())
    .addScaledVector(triangle.getNormal(new Vector3()), 1)
    .toArray() as Vec3;
  editor().moveWarpPoints([{ id: point.id, target }], 'end');
  finishWarpSettling();
  editor().selectWarpPoints([point.id]);
  const { model, state } = session();
  let excursion = 0;
  for (let n = 0; n < before.length / 3; n++)
    excursion = Math.max(
      excursion,
      distance(state!.positions.subarray(n * 3), before.subarray(n * 3)),
    );
  let inverted = 0;
  const map = new Float64Array(9);
  for (let n = 0; n < model!.grid.nodes.length; n++) {
    skinMapOf(model!.grid, model!.restNodes, state!, n, map);
    const det =
      map[0] * (map[4] * map[8] - map[5] * map[7]) -
      map[1] * (map[3] * map[8] - map[5] * map[6]) +
      map[2] * (map[3] * map[7] - map[4] * map[6]);
    if (det <= 0) inverted++;
  }
  return { point: current(point.id), target, excursion, inverted, folds: session().folds.length };
}

describe('a grab bound partly to the fixed edge', () => {
  it('stops short and says so rather than throwing a spike', async () => {
    const geometry = relief();
    await paintedDisc(geometry);
    const { face, free } = edgeFace(geometry);
    // Most of its weight is on fixed nodes, as at the reviewer's painted edge.
    expect(free).toBeLessThan(0.5);
    for (const radius of [null, 0]) {
      const { point, target, excursion, inverted, folds } = pull(geometry, face, radius);
      if (radius === null) expect(point.radius).toBeGreaterThan(0.5);
      // No node moves much farther than the grab was asked to, nothing turns inside out.
      expect(excursion).toBeLessThan(1.3);
      expect(inverted).toBe(0);
      expect(folds).toBe(0);
      // The point stops short and the panel says how far.
      const short = distance(deformed(point), target);
      expect(short).toBeGreaterThan(warpShortfallShown);
      expect(warpShortfall(session())).toBeCloseTo(short, 9);
      editor().undoWarpEdit();
      editor().undoWarpEdit();
    }
  }, 30_000);

  it('leaves a grab on free surface landing where it did', async () => {
    for (const density of [0, defaultWarpDensity]) {
      const geometry = relief();
      const middle = await paintedDisc(geometry, density);
      const { point, target } = pull(geometry, middle, null);
      expect(freeShare(point)).toBe(1);
      const tolerance = density === 0 ? 0.03 : 0.01;
      expect(distance(deformed(point), target)).toBeLessThan(tolerance);
      expect(warpShortfall(session())).toBeLessThan(warpShortfallShown);
      editor().cancelWarp();
    }
  });
});

function plate() {
  return part(new PlaneGeometry(40, 40, 64, 64));
}

function faceAt(geometry: BufferGeometry, x: number, y: number) {
  const triangle = new Triangle(),
    point = new Vector3(x, y, 0),
    closest = new Vector3();
  for (let face = 0; face < triangleCount(geometry); face++) {
    readFace(geometry, face, triangle);
    if (triangle.closestPointToPoint(point, closest).distanceTo(point) < 1e-6) return face;
  }
  throw new Error('No face under the point.');
}

function addAt(geometry: BufferGeometry, x: number, y: number) {
  editor().addWarpPoint(
    { partId: 'p', point: [x, y, 0], normal: [0, 0, 1] },
    faceAt(geometry, x, y),
  );
  return session().points.at(-1)!;
}

describe('a pin the user placed', () => {
  it('holds against a point moved beside it, which stops short instead', async () => {
    for (const whole of [false, true])
      for (const radius of [null, 0])
        for (const gap of [0, 0.03, 0.25]) {
          const p = plate();
          editor().setScene({ name: 'Pins', parts: [p], joints: [] });
          useEditor.setState({ selected: ['p'] });
          editor().setTool('warp');
          if (!whole) {
            editor().setWarpBrushRadius(12);
            editor().paintWarpRegion(
              { partId: 'p', point: [0, 0, 0], normal: [0, 0, 1] },
              faceAt(p.geometry, 0, 0),
              false,
              true,
            );
            editor().endPaintStroke();
          }
          await editor().layWarpGrid();
          if (radius !== null) editor().setWarpPointSettings({ radius }, 'end');
          const pin = addAt(p.geometry, 0.5, 0.3);
          const moved = addAt(p.geometry, 0.5 + gap, 0.3);
          const target: Vec3 = [0.5 + gap, 0.3, 2];
          editor().moveWarpPoints([{ id: moved.id, target }], 'end');
          finishWarpSettling();
          const label = `${whole ? 'whole' : 'painted'}, radius ${radius}, ${gap} mm apart`;
          // The pin stays where it was put.
          expect(distance(deformed(current(pin.id)), pin.pin), label).toBeLessThan(0.01);
          editor().selectWarpPoints([pin.id]);
          expect(warpPinDrift(session()), label).toBeLessThan(warpShortfallShown);
          // The moved point is the one that stops short, and says so.
          editor().selectWarpPoints([moved.id]);
          const short = distance(deformed(current(moved.id)), target);
          expect(warpShortfall(session()), label).toBeCloseTo(short, 9);
          if (gap < 0.1) expect(short, label).toBeGreaterThan(warpShortfallShown);
          editor().cancelWarp();
        }
  }, 60_000);

  it('reports how far the surface has moved from it', async () => {
    const p = plate();
    editor().setScene({ name: 'Pins', parts: [p], joints: [] });
    useEditor.setState({ selected: ['p'] });
    editor().setTool('warp');
    await editor().layWarpGrid();
    const pin = addAt(p.geometry, 0.5, 0.3);
    editor().selectWarpPoints([pin.id]);
    expect(warpPinDrift(session())).toBeLessThan(1e-9);
    // Held 0.1 mm above where the surface is written.
    const lifted: Vec3 = [pin.pin[0], pin.pin[1], pin.pin[2] + 0.1];
    useEditor.setState({
      warp: {
        ...session(),
        points: session().points.map((point) =>
          point.id === pin.id ? { ...point, pin: lifted } : point,
        ),
      },
    });
    expect(warpPinDrift(session())).toBeCloseTo(0.1, 6);
    // An automatic point rides, so it reports nothing.
    const auto = session().points.find((point) => point.auto)!;
    editor().selectWarpPoints([auto.id]);
    expect(warpPinDrift(session())).toBe(0);
  });
});
