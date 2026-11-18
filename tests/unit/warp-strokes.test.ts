import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, PlaneGeometry, SphereGeometry, Triangle, Vector3 } from 'three';
import type { BufferGeometry } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { finishWarpSettling, useEditor, type WarpPoint } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import {
  areaBrushFaces,
  facePoint,
  lineSamples,
  type WarpStrokePoint,
} from '../../src/core/warp-strokes';
import type { Part, SceneDocument, Vec3 } from '../../src/core/types';

function partOf(geometry: BufferGeometry): Part {
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
  return {
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
}

/**
 * A 40 mm plate painted in a 14 mm disc at default density, or a 16 mm ball laid whole on a
 * 60-node grid: a painted disc of a fine plate has more border vertices than 60, all fixed.
 */
const surfaces = {
  plate: {
    label: 'default density',
    make: () => partOf(new PlaneGeometry(40, 40, 64, 64)),
    density: defaultWarpDensity,
    onto: (p: Vec3): Vec3 => [p[0], p[1], 0],
  },
  ball: {
    label: 'a 60-node grid',
    make: () => partOf(new SphereGeometry(16, 48, 32)),
    density: 0,
    onto: (p: Vec3): Vec3 => {
      const length = Math.hypot(...p);
      return [(16 * p[0]) / length, (16 * p[1]) / length, (16 * p[2]) / length];
    },
  },
};
type Surface = (typeof surfaces)[keyof typeof surfaces];

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;
const initial = useEditor.getState();
afterEach(() => {
  editor().cancelWarp();
  useEditor.setState(initial);
});

/** The face nearest a mesh-local point and the point's barycentric coordinates on it. */
function surfaceAt(part: Part, at: Vec3): WarpStrokePoint {
  const triangle = new Triangle(),
    point = new Vector3(...at),
    closest = new Vector3();
  let face = -1,
    nearest = Infinity;
  for (let f = 0; f < triangleCount(part.geometry); f++) {
    readFace(part.geometry, f, triangle);
    const d = triangle.closestPointToPoint(point, closest).distanceToSquared(point);
    if (d < nearest) {
      nearest = d;
      face = f;
    }
  }
  readFace(part.geometry, face, triangle).closestPointToPoint(point, closest);
  const barycentric = triangle.getBarycoord(closest, new Vector3())!.toArray() as Vec3;
  return { face, barycentric };
}

async function lay(surface: Surface) {
  const part = surface.make();
  const scene: SceneDocument = { name: 'Warp', parts: [part], joints: [] };
  editor().setScene(scene);
  useEditor.setState({ selected: [part.id] });
  editor().setTool('warp');
  editor().setWarpBrushRadius(14);
  if (surface.density === 0) editor().setWarpRegion('whole');
  else {
    editor().paintWarpRegion(
      { partId: part.id, point: [0, 0, 0], normal: [0, 0, 1] },
      surfaceAt(part, [0, 0, 0]).face,
      false,
      true,
    );
    editor().endPaintStroke();
  }
  await editor().setWarpDensity(surface.density);
  await editor().layWarpGrid();
  expect(session().stage).toBe('warp');
  if (surface.density === 0) expect(session().model!.grid.nodes.length).toBeLessThan(80);
  return part;
}

const lerp = (a: Vec3, b: Vec3, t: number): Vec3 => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** Hits along a stroke on the surface, every `step` of its chord from `phase` past its start. */
function stroke(part: Part, surface: Surface, from: Vec3, to: Vec3, step: number, phase = 0) {
  const length = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const at = (t: number) => surfaceAt(part, surface.onto(lerp(from, to, t / length)));
  const points = [at(0)];
  for (let t = phase || step; t < length; t += step) points.push(at(t));
  points.push(at(length));
  return points;
}

/** How far the written surface has moved a mesh-local spot up, read from the preview itself. */
function lifted(part: Part, at: Vec3) {
  const spot = surfaceAt(part, at);
  const model = session().model!;
  return (
    facePoint(model, session().output!.positions, spot)[2] -
    facePoint(model, model.positions, spot)[2]
  );
}

const latest = () => session().points.at(-1)!;
function lift(handle: WarpPoint, h: number) {
  editor().moveWarpPoints(
    [{ id: handle.id, target: [handle.pin[0], handle.pin[1], handle.pin[2] + h] }],
    'end',
  );
  finishWarpSettling();
}

/** How far each spot every 0.05 mm along the line, between its first and last samples, rose. */
function profile(part: Part, surface: Surface, handle: WarpPoint) {
  const a = handle.samples[0].restWorld,
    b = handle.samples.at(-1)!.restWorld;
  const count = Math.max(2, Math.round(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) / 0.05));
  return Array.from({ length: count + 1 }, (_, i) =>
    lifted(part, surface.onto(lerp(a, b, i / count))),
  );
}

/** The most any local maximum stands above the lowest point within `window` probes each side. */
function worstPeak(zs: number[], window: number) {
  let worst = 0;
  for (let i = 1; i < zs.length - 1; i++) {
    if (!(zs[i] >= zs[i - 1] && zs[i] >= zs[i + 1])) continue;
    const left = Math.min(...zs.slice(Math.max(0, i - window), i));
    const right = Math.min(...zs.slice(i + 1, i + 1 + window));
    worst = Math.max(worst, zs[i] - Math.max(left, right));
  }
  return worst;
}

// Measured figures, written where WARP_STROKE_FIGURES says.
const figures: Record<string, unknown> = {};
afterEach(() => {
  if (process.env.WARP_STROKE_FIGURES)
    writeFileSync(process.env.WARP_STROKE_FIGURES, JSON.stringify(figures, null, 1));
});

const h = 2;
// An 8 mm stroke near the middle of the plate, or across the front of the ball.
const from: Vec3 = [-4, 0.3, 16],
  to: Vec3 = [4, 1.1, 16];

describe('line handles', () => {
  for (const surface of Object.values(surfaces))
    for (const radius of [0, null])
      it(`lift a continuous ridge with no peaks on ${surface.label}, ${radius === 0 ? 'radius 0' : 'default radius'}`, async () => {
        const part = await lay(surface);
        if (radius !== null) editor().setWarpPointSettings({ radius }, 'end');
        const points = stroke(part, surface, from, to, 0.04);
        const steps = session().undo.length;
        expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
        const line = latest();
        expect(line.kind).toBe('line');
        expect(session().selectedPoints).toEqual([line.id]);
        expect(session().undo).toHaveLength(steps + 1);
        lift(line, h);
        const zs = profile(part, surface, line);
        const worst = Math.max(...zs.map((z) => Math.abs(z - h)));
        const peak = worstPeak(zs, Math.round(line.reach!.spacing / 0.05));
        figures[`line, ${surface.label}, radius ${line.radius}`] = {
          samples: line.samples.length,
          spacing: line.reach!.spacing,
          worst: worst / h,
          peak: peak / h,
        };
        expect(worst).toBeLessThan(0.1 * h);
        expect(peak).toBeLessThan(0.05 * h);
      });

  for (const surface of Object.values(surfaces))
    it(`give the same result for the same stroke drawn slowly or quickly on ${surface.label}`, async () => {
      const part = await lay(surface);
      const results: number[][] = [];
      const counts: number[] = [];
      for (const [step, phase] of [
        [0.02, 0],
        [0.09, 0.05],
      ]) {
        editor().addWarpStroke({
          kind: 'line',
          points: stroke(part, surface, [-4, -2, 16], [3.5, 2.5, 16], step, phase),
        });
        const line = latest();
        counts.push(line.samples.length);
        lift(line, h);
        const zs: number[] = [];
        for (let x = -6; x <= 6; x += 0.5)
          for (let y = -4; y <= 4; y += 0.5) zs.push(lifted(part, surface.onto([x, y, 16])));
        results.push(zs);
        editor().undoWarpEdit();
        editor().undoWarpEdit();
      }
      const difference = Math.max(...results[0].map((z, i) => Math.abs(z - results[1][i])));
      figures[`slow and quick, ${surface.label}`] = { counts, difference: difference / h };
      expect(difference).toBeLessThan(0.02 * h);
    });

  it('take a sample about every half spacing and merge those bound alike, keeping both ends', async () => {
    const surface = { ...surfaces.plate, make: () => partOf(new PlaneGeometry(40, 40, 8, 8)) };
    const part = await lay(surface);
    const model = session().model!;
    // On a coarse mesh, every hit inside one triangle is bound to the same nodes.
    const points = stroke(part, surface, [-6, 0.3, 0], [6, 0.3, 0], 0.02);
    const made = lineSamples(model, session().state!, points)!;
    const inner = made.samples.slice(1, -1);
    const keys = inner.map((s) => [...new Set(s.binding.node)].sort().join());
    expect(new Set(keys).size).toBe(keys.length);
    expect(made.samples[0].restWorld[0]).toBeCloseTo(-6, 9);
    expect(made.samples.at(-1)!.restWorld[0]).toBeCloseTo(6, 9);
    figures['coarse mesh line'] = { hits: points.length, samples: made.samples.length };
  });
});

describe('area handles', () => {
  async function area(surface: Surface, radius: number, centre: Vec3) {
    const part = await lay(surface);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    const first = surfaceAt(part, surface.onto(centre));
    const faces = areaBrushFaces(session().model!, session().output!.positions, first, radius);
    expect(editor().addWarpStroke({ kind: 'area', faces, first })).toBe(true);
    const handle = latest();
    expect(handle.kind).toBe('area');
    expect(handle.faces).toEqual(faces);
    lift(handle, h);
    return { part, handle, faces };
  }

  for (const surface of Object.values(surfaces)) {
    it(`lift a plateau on ${surface.label}`, async () => {
      const { part, handle, faces } = await area(surface, 1.5, [2, -2, 16]);
      const zs = faces.map((face) =>
        lifted(part, readFace(part.geometry, face).getMidpoint(new Vector3()).toArray()),
      );
      const worst = Math.max(...zs.map((z) => Math.abs(z - h)));
      figures[`area, ${surface.label}`] = {
        samples: handle.samples.length,
        faces: faces.length,
        worst: worst / h,
      };
      expect(worst).toBeLessThan(0.1 * h);
    });

    it(`lift an area smaller than a grid cell as a plateau on ${surface.label}`, async () => {
      const { part, handle, faces } = await area(surface, 0.02, [2.1, -2.2, 16]);
      expect(faces.length).toBeLessThan(4);
      expect(handle.samples.length).toBeGreaterThanOrEqual(4);
      const spots: Vec3[] = [];
      for (const face of faces) {
        const t = readFace(part.geometry, face);
        for (const w of [
          [0.6, 0.2, 0.2],
          [0.2, 0.6, 0.2],
          [0.2, 0.2, 0.6],
          [1 / 3, 1 / 3, 1 / 3],
        ])
          spots.push(
            new Vector3()
              .addScaledVector(t.a, w[0])
              .addScaledVector(t.b, w[1])
              .addScaledVector(t.c, w[2])
              .toArray(),
          );
      }
      const worst = Math.max(...spots.map((spot) => Math.abs(lifted(part, spot) - h)));
      const largest = Math.max(
        ...faces.map((face) => {
          const t = readFace(part.geometry, face);
          return Math.max(t.a.distanceTo(t.b), t.b.distanceTo(t.c), t.c.distanceTo(t.a));
        }),
      );
      expect(largest).toBeLessThan(handle.reach!.spacing);
      figures[`small area, ${surface.label}`] = {
        samples: handle.samples.length,
        faces: faces.length,
        spacing: handle.reach!.spacing,
        worst: worst / h,
      };
      expect(worst).toBeLessThan(0.1 * h);
    });
  }

  it('paint connected faces within the radius on the warped surface, and leave the region alone', async () => {
    const part = await lay(surfaces.plate);
    const first = surfaceAt(part, [0, 0, 0]);
    const faces = areaBrushFaces(session().model!, session().output!.positions, first, 1);
    expect(faces.length).toBeGreaterThan(4);
    for (const face of faces)
      expect(
        readFace(part.geometry, face).closestPointToPoint(new Vector3(), new Vector3()).length(),
      ).toBeLessThanOrEqual(1 + 1e-9);
    const { faces: region, seed } = session();
    const history = editor().paintHistory;
    expect(editor().addWarpStroke({ kind: 'area', faces, first })).toBe(true);
    expect(session().faces).toBe(region);
    expect(session().seed).toBe(seed);
    expect(editor().paintHistory).toBe(history);
  });

  it('paint only faces turned toward the brush', async () => {
    const part = await lay(surfaces.ball);
    const first = surfaceAt(part, [0, 0, 16]);
    // The whole ball is within 40 mm of the hit; only the cap facing it is painted.
    const faces = areaBrushFaces(session().model!, session().output!.positions, first, 40);
    expect(faces.length).toBeGreaterThan(100);
    for (const face of faces)
      expect(readFace(part.geometry, face).getMidpoint(new Vector3()).z).toBeGreaterThan(0);
  });
});
