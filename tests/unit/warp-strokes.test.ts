import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  CylinderGeometry,
  PlaneGeometry,
  SphereGeometry,
  Triangle,
  Vector3,
} from 'three';
import { triangleCount } from '../../src/core/geometry';
import {
  finishWarpSettling,
  useEditor,
  warpPinDrift,
  warpShortfallShown,
  type WarpPoint,
} from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import { bindTrianglePoint } from '../../src/core/warp-bind';
import { warpEligibleNodes } from '../../src/core/warp-handles';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import { isPaintedFace, type WarpModel } from '../../src/core/warp-model';
import { regionTriangleOf } from '../../src/core/warp-region';
import {
  areaBrushFaces,
  facePoint,
  lineSamples,
  strokeSample,
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

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

/** Distance from a point to the segment from `a` to `b`. */
function segmentDistance(p: Vec3, a: Vec3, b: Vec3) {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const t = Math.max(
    0,
    Math.min(
      1,
      (u[0] * (p[0] - a[0]) + u[1] * (p[1] - a[1]) + u[2] * (p[2] - a[2])) / distance(a, b) ** 2,
    ),
  );
  return distance(p, [a[0] + t * u[0], a[1] + t * u[1], a[2] + t * u[2]]);
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

  for (const span of [25, 45])
    it(`keep samples along a short line over tight curvature on the coarsest grid, ±${span}°`, async () => {
      // A 32 mm open half-pipe of radius 0.9 mm along y, laid whole at the coarsest density and
      // held by two points near its ends. Its grid spacing is several times the line's length.
      const R = 0.9;
      const part = partOf(new CylinderGeometry(R, R, 32, 32, 400, true, -Math.PI / 2, Math.PI));
      editor().setScene({ name: 'Warp', parts: [part], joints: [] });
      useEditor.setState({ selected: [part.id] });
      editor().setTool('warp');
      editor().setWarpOptions({ autoPoints: false });
      editor().setWarpRegion('whole');
      await editor().setWarpDensity(0);
      await editor().layWarpGrid();
      editor().setWarpPointSettings({ radius: 0 }, 'end');
      for (const y of [-15, 15]) {
        const pin = surfaceAt(part, [0, y, R]);
        editor().addWarpPoint({ partId: part.id, point: [0, y, R], normal: [0, 0, 1] }, pin.face);
      }
      // Around the pipe, rising a little along it.
      const around = (a: number) =>
        surfaceAt(part, [R * Math.sin(a), 1.3 + 0.2 * a, R * Math.cos(a)]);
      const a = (span * Math.PI) / 180;
      const points = Array.from({ length: 120 }, (_, i) => around(-a + (2 * a * i) / 119));
      expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
      const line = latest();
      const spacing = line.reach!.spacing;
      expect(spacing).toBeGreaterThan(2 * R * a);
      expect(line.samples.length).toBeGreaterThan(3);
      const lift = 0.5;
      editor().moveWarpPoints(
        [{ id: line.id, target: [line.pin[0], line.pin[1], line.pin[2] + lift] }],
        'end',
      );
      finishWarpSettling();
      const model = session().model!;
      const rises = points.map(
        (p) =>
          facePoint(model, session().output!.positions, p)[2] -
          facePoint(model, model.positions, p)[2],
      );
      figures[`short curved line, ±${span}°`] = {
        samples: line.samples.length,
        spacing,
        ends: [rises[0], rises.at(-1)],
        highest: Math.max(...rises),
        lowest: Math.min(...rises),
      };
      // Both ends land, and nothing between them stands above or sinks below the lift.
      for (const rise of rises) expect(Math.abs(rise - lift)).toBeLessThan(0.05 * lift);
    }, 30_000);

  it('lift a short line over tight relief on a small painted patch level at default settings', async () => {
    // A 1.2 mm tube about as coarse as a scanned miniature's mesh, one dab of paint on it at the
    // default density, and a line a little over two node spacings around it, rising along it.
    const R = 0.6;
    const part = partOf(new CylinderGeometry(R, R, 12, 12, 70, true).toNonIndexed());
    editor().setScene({ name: 'Warp', parts: [part], joints: [] });
    useEditor.setState({ selected: [part.id] });
    editor().setTool('warp');
    editor().setWarpBrushRadius(1.1);
    editor().paintWarpRegion(
      { partId: part.id, point: [0, 0, R], normal: [0, 0, 1] },
      surfaceAt(part, [0, 0, R]).face,
      false,
      true,
    );
    editor().endPaintStroke();
    await editor().layWarpGrid();
    const a = (35 * Math.PI) / 180;
    const points = Array.from({ length: 81 }, (_, i) => {
      const t = -a + (2 * a * i) / 80;
      return surfaceAt(part, [R * Math.sin(t), 0.4 * t, R * Math.cos(t)]);
    });
    expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
    const line = latest();
    const spacing = line.reach!.spacing;
    expect(2 * a * R).toBeLessThan(3 * spacing);
    const lift = 0.5;
    editor().moveWarpPoints(
      [{ id: line.id, target: [line.pin[0], line.pin[1], line.pin[2] + lift] }],
      'end',
    );
    finishWarpSettling();
    const model = session().model!;
    const rises = points.map(
      (p) =>
        facePoint(model, session().output!.positions, p)[2] -
        facePoint(model, model.positions, p)[2],
    );
    figures['short line over a small painted tube'] = {
      nodes: model.grid.nodes.length,
      samples: line.samples.length,
      spacing,
      radius: line.radius,
      lowest: Math.min(...rises),
      highest: Math.max(...rises),
      peak: worstPeak(rises, 4),
    };
    // Moving only the nodes nearest the line left spots between its samples 0.08 of the lift off.
    for (const rise of rises) expect(Math.abs(rise - lift)).toBeLessThan(0.05 * lift);
    expect(worstPeak(rises, 4)).toBeLessThan(0.02 * lift);
  });

  /**
   * A 10 mm patch of creased relief, a heightfield about as finely and as unevenly triangulated as
   * a scanned miniature, and the face under any spot seen from above.
   */
  function creasedRelief() {
    const size = 10,
      cell = 0.05,
      n = size / cell;
    const height = (x: number, y: number) =>
      0.25 *
      (Math.abs(Math.sin(4.1 * x + 0.8 * Math.sin(1.9 * y))) +
        0.6 * Math.abs(Math.sin(3.3 * y - 1.7 * x + 0.5)));
    let seed = 99;
    const noise = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff - 0.5;
    };
    // Jittered, in denser and sparser bands, with the cells split either way at random.
    const xy: number[][] = [];
    for (let j = 0; j <= n; j++)
      for (let i = 0; i <= n; i++) {
        let u = -size / 2 + i * cell,
          v = -size / 2 + j * cell;
        if (i > 0 && i < n) u += 0.4 * cell * noise();
        if (j > 0 && j < n) v += 0.4 * cell * noise();
        u += 0.15 * Math.sin((u * Math.PI) / 1.5) * (size / 2 - Math.abs(u));
        v += 0.15 * Math.sin((v * Math.PI) / 1.1) * (size / 2 - Math.abs(v));
        xy.push([u, v]);
      }
    const at = (i: number, j: number) => {
      const [x, y] = xy[j * (n + 1) + i];
      return [x, y, height(x, y)];
    };
    const positions: number[] = [];
    for (let j = 0; j < n; j++)
      for (let i = 0; i < n; i++) {
        const [a, b, c, d] = [at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)];
        if (noise() > 0) positions.push(...a, ...b, ...c, ...a, ...c, ...d);
        else positions.push(...a, ...b, ...d, ...b, ...c, ...d);
      }
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
    const key = (x: number, y: number) =>
      Math.floor((x + size) / cell) * 100000 + Math.floor((y + size) / cell);
    const buckets = new Map<number, number[]>();
    for (let f = 0; f < positions.length / 9; f++) {
      const xs = [0, 3, 6].map((k) => positions[f * 9 + k]),
        ys = [1, 4, 7].map((k) => positions[f * 9 + k]);
      for (let x = Math.min(...xs); x < Math.max(...xs) + cell; x += cell)
        for (let y = Math.min(...ys); y < Math.max(...ys) + cell; y += cell) {
          const k = key(Math.min(x, Math.max(...xs)), Math.min(y, Math.max(...ys)));
          const list = buckets.get(k) ?? [];
          if (!list.includes(f)) list.push(f);
          buckets.set(k, list);
        }
    }
    const below = (x: number, y: number): WarpStrokePoint => {
      let best: WarpStrokePoint | null = null,
        inside = -Infinity;
      for (const f of buckets.get(key(x, y)) ?? []) {
        const [ax, ay, , bx, by, , cx, cy] = positions.slice(f * 9, f * 9 + 9);
        const det = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
        const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / det;
        const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / det;
        const weights = [l1, l2, 1 - l1 - l2];
        if (Math.min(...weights) <= inside) continue;
        inside = Math.min(...weights);
        const clamped = weights.map((w) => Math.max(0, w));
        const sum = clamped[0] + clamped[1] + clamped[2];
        best = { face: f, barycentric: clamped.map((w) => w / sum) as Vec3 };
      }
      return best!;
    };
    return { part: partOf(geometry), height, below };
  }

  /** Whether a spot is painted and every node it is bound to is free. */
  const freeAt = (model: WarpModel, { face, barycentric }: WarpStrokePoint) =>
    isPaintedFace(model, face) &&
    bindTrianglePoint(
      model.region,
      model.binding,
      model.restWorld,
      regionTriangleOf(model.region, face),
      barycentric,
    ).node.every((n) => !model.grid.fixed[n]);

  it('lift short lines of every length, direction and bend level on painted patches of creased relief', async () => {
    // Six dabs of paint at the default density, ten strokes of up to 1 mm on each, curved either
    // way, each pulled 0.5 mm along a view up to 17 degrees off vertical and measured at its hits,
    // at the default radius and then at radius 0.
    const { part, height, below } = creasedRelief();
    let seed = 5;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lift = 0.5;
    const failures: string[] = [];
    let lines = 0;
    const extremes = { default: [Infinity, -Infinity, 0], 'radius 0': [Infinity, -Infinity, 0] };
    for (let dab = 0; dab < 6; dab++) {
      const x0 = (random() - 0.5) * 3,
        y0 = (random() - 0.5) * 3;
      editor().setScene({ name: 'Warp', parts: [part], joints: [] });
      useEditor.setState({ selected: [part.id] });
      editor().setTool('warp');
      editor().setWarpBrushRadius(1.5);
      editor().paintWarpRegion(
        { partId: part.id, point: [x0, y0, height(x0, y0)], normal: [0, 0, 1] },
        below(x0, y0).face,
        false,
        true,
      );
      editor().endPaintStroke();
      await editor().layWarpGrid();
      const model = session().model!;
      for (let k = 0, made = 0; k < 40 && made < 10; k++) {
        const direction = random() * Math.PI * 2,
          length = 0.1 + random() * 0.9,
          bend = (random() - 0.5) * 1.2;
        const cx = x0 + (random() - 0.5) * 0.8,
          cy = y0 + (random() - 0.5) * 0.8;
        const points = Array.from({ length: 61 }, (_, i) => {
          const s = i / 60 - 0.5,
            q = bend * length * (s * s - 0.25);
          return below(
            cx + length * s * Math.cos(direction) - q * Math.sin(direction),
            cy + length * s * Math.sin(direction) + q * Math.cos(direction),
          );
        });
        // A line partly held by fixed nodes stops short by design.
        if (!points.every((point) => freeAt(model, point))) continue;
        const steps = session().undo.length;
        expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
        made++;
        lines++;
        let line = latest();
        const tilt = random() * 0.3,
          turn = random() * Math.PI * 2;
        const up = [
          Math.sin(tilt) * Math.cos(turn),
          Math.sin(tilt) * Math.sin(turn),
          Math.cos(tilt),
        ];
        editor().moveWarpPoints(
          [{ id: line.id, target: line.pin.map((p, a) => p + lift * up[a]) as Vec3 }],
          'end',
        );
        finishWarpSettling();
        const rest = points.map((p) => facePoint(model, model.positions, p));
        let along = 0;
        for (let i = 1; i < rest.length; i++) along += distance(rest[i], rest[i - 1]);
        for (const radius of ['default', 'radius 0'] as const) {
          if (radius === 'radius 0') {
            editor().setWarpPointSettings({ radius: 0 }, 'end');
            finishWarpSettling();
            line = latest();
            expect(line.radius).toBe(0);
          }
          const rises = points.map((p, i) => {
            const moved = facePoint(model, session().output!.positions, p);
            return [0, 1, 2].reduce((sum, a) => sum + (moved[a] - rest[i][a]) * up[a], 0);
          });
          const peak = worstPeak(
            rises,
            Math.max(1, Math.round((line.reach!.spacing / along) * 60)),
          );
          const low = Math.min(...rises),
            high = Math.max(...rises);
          const extreme = extremes[radius];
          [extreme[0], extreme[1], extreme[2]] = [
            Math.min(extreme[0], low),
            Math.max(extreme[1], high),
            Math.max(extreme[2], peak),
          ];
          if (low < 0.9 * lift || high > 1.1 * lift || peak > 0.05 * lift)
            failures.push(
              `dab ${dab}, line ${made}, ${radius}: ${(along / line.reach!.spacing).toFixed(1)} ` +
                `spacings, ${low.toFixed(3)} to ${high.toFixed(3)} mm, peak ${peak.toFixed(3)} mm`,
            );
        }
        while (session().undo.length > steps) editor().undoWarpEdit();
      }
      editor().cancelWarp();
    }
    for (const [radius, [lowest, highest, peak]] of Object.entries(extremes))
      figures[`short lines on creased relief${radius === 'default' ? '' : `, ${radius}`}`] = {
        lines,
        lowest,
        highest,
        peak,
      };
    expect(lines).toBe(60);
    // Moving only the nodes nearest the samples left 5 of these between 0.41 and 0.54 mm, with
    // peaks up to 0.09 mm.
    expect(failures).toEqual([]);
  }, 30_000);

  it('raise a ridge at radius 0 about as narrow as the footprint on painted patches of creased relief', async () => {
    // Six wider dabs of paint at the default density, ten straight strokes of 0.3 to 1.5 mm on
    // each at radius 0, each pulled 0.5 mm straight up. Across its middle, the band of surface
    // that rises at least 0.9 of that is measured in the line's node spacings.
    const { part, height, below } = creasedRelief();
    let seed = 5;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const lift = 0.5;
    const bands: number[] = [];
    let worst = 0;
    for (let dab = 0; dab < 6; dab++) {
      const x0 = (random() - 0.5) * 3,
        y0 = (random() - 0.5) * 3;
      editor().setScene({ name: 'Warp', parts: [part], joints: [] });
      useEditor.setState({ selected: [part.id] });
      editor().setTool('warp');
      editor().setWarpBrushRadius(3);
      editor().paintWarpRegion(
        { partId: part.id, point: [x0, y0, height(x0, y0)], normal: [0, 0, 1] },
        below(x0, y0).face,
        false,
        true,
      );
      editor().endPaintStroke();
      await editor().layWarpGrid();
      const model = session().model!;
      editor().setWarpPointSettings({ radius: 0 }, 'end');
      for (let k = 0, made = 0; k < 40 && made < 10; k++) {
        const direction = random() * Math.PI * 2,
          length = 0.3 + random() * 1.2;
        const cx = x0 + (random() - 0.5) * 0.8,
          cy = y0 + (random() - 0.5) * 0.8;
        const [c, s] = [Math.cos(direction), Math.sin(direction)];
        const points = Array.from({ length: 61 }, (_, i) =>
          below(cx + length * (i / 60 - 0.5) * c, cy + length * (i / 60 - 0.5) * s),
        );
        if (!points.every((point) => freeAt(model, point))) continue;
        const steps = session().undo.length;
        expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
        made++;
        const line = latest();
        expect(line.radius).toBe(0);
        editor().moveWarpPoints(
          [{ id: line.id, target: [line.pin[0], line.pin[1], line.pin[2] + lift] }],
          'end',
        );
        finishWarpSettling();
        const rise = (spot: WarpStrokePoint) =>
          facePoint(model, session().output!.positions, spot)[2] -
          facePoint(model, model.positions, spot)[2];
        for (const point of points) worst = Math.max(worst, Math.abs(rise(point) - lift));
        /** How far across the middle, to one side, the surface still rises 0.9 of the lift. */
        const edge = (side: number) => {
          for (let o = 0.005; o < 1.5; o += 0.005)
            if (rise(below(cx - side * o * s, cy + side * o * c)) < 0.9 * lift) return o;
          return 1.5;
        };
        bands.push((edge(1) + edge(-1)) / line.reach!.spacing);
        while (session().undo.length > steps) editor().undoWarpEdit();
      }
      editor().cancelWarp();
    }
    const mean = bands.reduce((sum, band) => sum + band, 0) / bands.length;
    figures['ridge width at radius 0 on creased relief'] = {
      lines: bands.length,
      mean,
      widest: Math.max(...bands),
      worst: worst / lift,
    };
    expect(bands.length).toBe(60);
    expect(worst).toBeLessThan(0.1 * lift);
    // The narrow footprint alone made these 2.67 and 3.71 spacings; moving every node the path
    // is bound to with the line made them 3.00 and 4.36.
    expect(mean).toBeLessThan(2.8);
    expect(Math.max(...bands)).toBeLessThan(4);
  }, 30_000);

  it('lift a line by as much on either side of where its footprint used to change', async () => {
    // A line along a 1.2 mm tube on a dab of paint at the default density, bowed around it. Its
    // footprint used to take more nodes at radii between 1 and 4 node spacings, for lines no
    // longer than 5 spacings, bowed off their chord by more than 3.5 % of it.
    const R = 0.6;
    const part = partOf(new CylinderGeometry(R, R, 12, 12, 70, true).toNonIndexed());
    editor().setScene({ name: 'Warp', parts: [part], joints: [] });
    useEditor.setState({ selected: [part.id] });
    editor().setTool('warp');
    editor().setWarpBrushRadius(1.6);
    editor().paintWarpRegion(
      { partId: part.id, point: [0, 0, R], normal: [0, 0, 1] },
      surfaceAt(part, [0, 0, R]).face,
      false,
      true,
    );
    editor().endPaintStroke();
    await editor().layWarpGrid();
    const spot = surfaceAt(part, [0, 0, R]);
    /** Lifts a line `length` long through the spot, bowed by `bow`, and reads the spot's rise. */
    const lifted = (length: number, bow: number, radius: (spacing: number) => number) => {
      const steps = session().undo.length;
      const points = Array.from({ length: 81 }, (_, i) => {
        const s = i / 80 - 0.5,
          around = (bow * length * s * s) / R;
        return surfaceAt(part, [R * Math.sin(around), length * s, R * Math.cos(around)]);
      });
      expect(editor().addWarpStroke({ kind: 'line', points })).toBe(true);
      const line = latest();
      const spacing = line.reach!.spacing;
      const at = line.samples.map(({ restWorld }) => restWorld);
      let along = 0,
        off = 0;
      for (let k = 1; k < at.length; k++) {
        along += distance(at[k], at[k - 1]);
        off = Math.max(off, segmentDistance(at[k], at[0], at.at(-1)!));
      }
      editor().moveWarpPoints(
        [{ id: line.id, target: [line.pin[0], line.pin[1], line.pin[2] + 0.5] }],
        'end',
      );
      editor().setWarpPointSettings({ radius: radius(spacing) }, 'end');
      finishWarpSettling();
      const model = session().model!;
      const rise =
        facePoint(model, session().output!.positions, spot)[2] -
        facePoint(model, model.positions, spot)[2];
      while (session().undo.length > steps) editor().undoWarpEdit();
      return {
        rise,
        spacings: along / spacing,
        bend: off / distance(at[0], at.at(-1)!),
        radius: radius(spacing) / spacing,
      };
    };
    /** Two values of `x` about `gap` apart either side of where `f` passes 0. */
    const straddle = (f: (x: number) => number, low: number, high: number, gap: number) => {
      while (high - low > gap) {
        const middle = (low + high) / 2;
        if (f(middle) <= 0) low = middle;
        else high = middle;
      }
      return [low, high];
    };
    const twice = (s: number) => 2 * s;
    const pairs = {
      'radius of 1 spacing': [
        lifted(0.6, 0.6, (s) => s - 0.0005),
        lifted(0.6, 0.6, (s) => s + 0.0005),
      ],
      'radius of 4 spacings': [
        lifted(0.6, 0.6, (s) => 4 * s - 0.0005),
        lifted(0.6, 0.6, (s) => 4 * s + 0.0005),
      ],
      'length of 5 spacings': straddle(
        (length) => lifted(length, 0.6, twice).spacings - 5,
        0.3,
        2.5,
        1e-4,
      ).map((length) => lifted(length, 0.6, twice)),
      'bend of 3.5 %': straddle((bow) => lifted(0.8, bow, twice).bend - 0.035, 0, 1.5, 1e-5).map(
        (bow) => lifted(0.8, bow, twice),
      ),
    };
    expect(pairs['radius of 1 spacing'].map(({ radius }) => radius > 1)).toEqual([false, true]);
    expect(pairs['radius of 4 spacings'].map(({ radius }) => radius > 4)).toEqual([false, true]);
    expect(pairs['length of 5 spacings'].map(({ spacings }) => spacings > 5)).toEqual([
      false,
      true,
    ]);
    expect(pairs['bend of 3.5 %'].map(({ bend }) => bend > 0.035)).toEqual([false, true]);
    figures['rise either side of the old footprint thresholds'] = Object.fromEntries(
      Object.entries(pairs).map(([name, [a, b]]) => [name, [a.rise, b.rise]]),
    );
    // These changed the rise by 0.0008, 0.0073, 0.0098 and 0.0028 mm.
    for (const [a, b] of Object.values(pairs)) {
      expect(a.rise).toBeGreaterThan(0.45);
      expect(Math.abs(b.rise - a.rise)).toBeLessThan(0.0001);
    }
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

  it('refuse a dab whose faces are all held by fixed nodes, and say to paint farther inside', async () => {
    // A sheet as fine as a scan, painted in a small disc on the coarsest grid: most of the disc
    // is bound only to its fixed edge.
    const part = partOf(new PlaneGeometry(16, 16, 320, 320));
    editor().setScene({ name: 'Warp', parts: [part], joints: [] });
    useEditor.setState({ selected: [part.id] });
    editor().setTool('warp');
    editor().setWarpBrushRadius(1.5);
    editor().paintWarpRegion(
      { partId: part.id, point: [0, 0, 0], normal: [0, 0, 1] },
      surfaceAt(part, [0, 0, 0]).face,
      false,
      true,
    );
    editor().endPaintStroke();
    await editor().setWarpDensity(0);
    await editor().layWarpGrid();
    const { model, state } = session();
    const third: Vec3 = [1 / 3, 1 / 3, 1 / 3];
    const fixed = Array.from(model!.region.faces).filter(
      (face) =>
        strokeSample(model!, state!, { face, barycentric: third }) === null &&
        [
          [0.6, 0.2, 0.2],
          [0.2, 0.6, 0.2],
          [0.2, 0.2, 0.6],
        ].every(
          (barycentric) =>
            strokeSample(model!, state!, { face, barycentric: barycentric as Vec3 }) === null,
        ),
    );
    expect(fixed.length).toBeGreaterThan(10);
    // Fixed faces alone, and fixed faces first with a free one last.
    const free = Array.from(model!.region.faces).find(
      (face) => strokeSample(model!, state!, { face, barycentric: third }) !== null,
    )!;
    useEditor.setState({ toast: null });
    expect(
      editor().addWarpStroke({
        kind: 'area',
        faces: fixed.slice(0, 20),
        first: { face: fixed[0], barycentric: third },
      }),
    ).toBe(false);
    expect(session().points).toHaveLength(0);
    expect(useEditor.getState().toast?.message).toBe(
      'This spot is fixed. Paint farther inside the warp region.',
    );
    expect(
      editor().addWarpStroke({
        kind: 'area',
        faces: [...fixed.slice(0, 20), free],
        first: { face: fixed[0], barycentric: third },
      }),
    ).toBe(true);
    expect(latest().samples.length).toBeGreaterThan(0);
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

describe('handles made by strokes through a session', () => {
  /** Lays the plate's grid again over the painted faces whose centres pass `keep`. */
  async function shrink(part: Part, keep: (centre: Vector3) => boolean) {
    editor().setWarpRegion('painted');
    const faces = session().faces.filter((face) =>
      keep(readFace(part.geometry, face).getMidpoint(new Vector3())),
    );
    useEditor.setState({ toast: null, warp: { ...session(), faces } });
    await editor().layWarpGrid();
    expect(session().stage).toBe('warp');
  }
  const offset = (handle: WarpPoint) =>
    handle.target ? handle.target.map((value, a) => value - handle.pin[a]) : null;
  /** Whether a line moves as one every free node its drawn path is bound to on the current grid. */
  /** Whether the line moves or guides every free node its drawn path is bound to. */
  const guidesItsPath = (line: WarpPoint) => {
    const model = session().model!;
    const eligible = warpEligibleNodes(model);
    const { node, least } = line.reach!;
    const guided = new Set([...node].filter((_, i) => least[i] > 0));
    const bound = line.path!.flatMap(({ face, barycentric }) =>
      bindTrianglePoint(
        model.region,
        model.binding,
        model.restWorld,
        regionTriangleOf(model.region, face),
        barycentric,
      ).node.filter((n) => eligible[n]),
    );
    return bound.length > 0 && bound.every((n) => guided.has(n));
  };

  for (const moved of [false, true])
    it(`keep the run of a ${moved ? 'moved' : 'still'} line left on a smaller region, centred on it`, async () => {
      const part = await lay(surfaces.plate);
      editor().addWarpStroke({
        kind: 'line',
        points: stroke(part, surfaces.plate, [-9, 0.3, 0], [9, 1.1, 0], 0.03),
      });
      const made = latest();
      if (moved) lift(made, h);
      const before = session().points.find(({ id }) => id === made.id)!;
      // The region now stops at x = 2.5; the samples beyond it are lost.
      await shrink(part, (centre) => centre.x < 2.5);
      const line = session().points.find(({ id }) => id === made.id)!;
      const model = session().model!;
      expect(line.path!.length).toBeGreaterThan(10);
      for (const spot of line.path!) expect(isPaintedFace(model, spot.face)).toBe(true);
      for (const sample of line.samples) expect(isPaintedFace(model, sample.face)).toBe(true);
      expect(guidesItsPath(line)).toBe(true);
      const xs = line.samples.map(({ restWorld }) => restWorld[0]);
      expect(Math.max(...xs)).toBeLessThan(2.5);
      expect(Math.max(...xs)).toBeGreaterThan(1);
      // Centred on what is left, which the gizmo shows, with the same offset as before.
      const middle = (Math.min(...xs) + Math.max(...xs)) / 2;
      expect(Math.abs(line.pin[0] - middle)).toBeLessThan(0.5);
      expect(line.pin[2]).toBeCloseTo(0, 6);
      if (moved) offset(line)!.forEach((d, a) => expect(d).toBeCloseTo(offset(before)![a], 9));
      else expect(line.target).toBeNull();
      editor().selectWarpPoints([line.id]);
      finishWarpSettling();
      if (!moved) expect(warpPinDrift(session())).toBeLessThan(warpShortfallShown);
      // Undo gives the whole line back.
      await editor().undoWarpEdit();
      expect(session().points.find(({ id }) => id === made.id)).toMatchObject({
        pin: before.pin,
        target: before.target,
        path: before.path,
      });
    });

  it('drop a line with too little left on a smaller region, with the notice', async () => {
    const part = await lay(surfaces.plate);
    editor().addWarpStroke({
      kind: 'line',
      points: stroke(part, surfaces.plate, [-9, 0.3, 0], [9, 1.1, 0], 0.03),
    });
    const made = latest();
    const xs = made.samples.map(({ restWorld }) => restWorld[0]);
    // Only the last sample's end of the region is left.
    const cut = (Math.max(...xs) + [...xs].sort((a, b) => a - b).at(-2)!) / 2;
    await shrink(part, (centre) => centre.x > cut);
    expect(session().points.some(({ id }) => id === made.id)).toBe(false);
    expect(useEditor.getState().toast?.message).toBe(
      'Some control points were outside the new region and were removed.',
    );
  });

  for (const moved of [false, true])
    it(`keep the largest piece of a ${moved ? 'moved' : 'still'} area left on a smaller region, centred on it`, async () => {
      const part = await lay(surfaces.plate);
      const first = surfaceAt(part, [4, 0, 0]);
      editor().addWarpStroke({
        kind: 'area',
        faces: areaBrushFaces(session().model!, session().output!.positions, first, 3),
        first,
      });
      const made = latest();
      if (moved) lift(made, h);
      const before = session().points.find(({ id }) => id === made.id)!;
      await shrink(part, (centre) => centre.x < 4.5);
      const area = session().points.find(({ id }) => id === made.id)!;
      const model = session().model!;
      expect(area.faces!.length).toBeLessThan(made.faces!.length);
      for (const face of area.faces!) expect(isPaintedFace(model, face)).toBe(true);
      for (const sample of area.samples) expect(area.faces).toContain(sample.face);
      const xs = area.faces!.map(
        (face) => readFace(part.geometry, face).getMidpoint(new Vector3()).x,
      );
      expect(area.pin[0]).toBeLessThan(Math.max(...xs));
      expect(area.pin[0]).toBeGreaterThan(Math.min(...xs));
      expect(area.pin[0]).toBeLessThan(before.pin[0]);
      if (moved) offset(area)!.forEach((d, a) => expect(d).toBeCloseTo(offset(before)![a], 9));
      editor().selectWarpPoints([area.id]);
      finishWarpSettling();
      if (!moved) expect(warpPinDrift(session())).toBeLessThan(warpShortfallShown);
    });

  for (const kind of ['line', 'area'] as const)
    it(`keep a ${kind} whole through edits, a re-lay, undo, a live refusal and Apply`, async () => {
      const part = await lay(surfaces.plate);
      const surface = surfaces.plate;
      if (kind === 'line')
        editor().addWarpStroke({
          kind,
          points: stroke(part, surface, [-3, -1, 0], [3, 1.5, 0], 0.03),
        });
      else {
        const first = surfaceAt(part, [1, -1, 0]);
        editor().addWarpStroke({
          kind,
          faces: areaBrushFaces(session().model!, session().output!.positions, first, 1.5),
          first,
        });
      }
      const made = latest();
      const id = made.id;
      const current = () => session().points.find((point) => point.id === id)!;
      /** The handle is there, with its faces, and its footprint measured on the current grid. */
      const whole = () => {
        const handle = current();
        expect(handle.kind).toBe(kind);
        expect(handle.faces).toEqual(made.faces);
        expect(handle.path).toEqual(made.path);
        expect(handle.samples.length).toBeGreaterThan(1);
        expect(handle.reach!.grid).toBe(session().model!.grid);
        expect(handle.reach!.own).toBeGreaterThan(2);
        if (kind === 'line') expect(guidesItsPath(handle)).toBe(true);
      };
      /** The handle's spots stand at its lift. */
      const holds = (h: number) => {
        finishWarpSettling();
        const handle = current();
        for (const { face, barycentric } of handle.samples) {
          const model = session().model!;
          const rise =
            facePoint(model, session().output!.positions, { face, barycentric })[2] -
            facePoint(model, model.positions, { face, barycentric })[2];
          expect(Math.abs(rise - h)).toBeLessThan(0.1 * Math.max(h, 1));
        }
      };
      /** What each undo step must give back exactly: surface, region, grid and every handle. */
      const record = () => {
        finishWarpSettling();
        const warp = session();
        return {
          surface: Array.from(warp.preview!.getAttribute('position').array),
          normals: Array.from(warp.preview!.getAttribute('normal').array),
          region: warp.faces,
          density: warp.density,
          nodes: Array.from(warp.model!.grid.nodes),
          undo: warp.undo.length,
          handles: warp.points.map((handle) => ({
            id: handle.id,
            kind: handle.kind,
            pin: handle.pin,
            target: handle.target,
            radius: handle.radius,
            falloff: handle.falloff,
            faces: handle.faces,
            path: handle.path,
            samples: handle.samples.map(({ face, barycentric, restWorld, pin, binding }) => ({
              face,
              barycentric,
              restWorld,
              pin,
              binding,
            })),
            baseline: Array.from(handle.baseline.positions),
          })),
        };
      };
      whole();
      const history = [record()];
      lift(current(), h);
      history.push(record());
      whole();
      holds(h);
      editor().selectWarpPoints([id]);
      editor().setWarpPointSettings({ radius: 4 }, 'end');
      history.push(record());
      editor().setWarpPointSettings({ falloff: 0.3 }, 'end');
      history.push(record());
      expect(current()).toMatchObject({ radius: 4, falloff: 0.3 });
      whole();
      holds(h);
      await editor().setWarpDensity(defaultWarpDensity + 1);
      whole();
      holds(h);
      history.push(record());
      const grid = session().undo.at(-1)!.grid!;
      // Edit region, paint more, and lay the grid again.
      editor().setWarpRegion('painted');
      editor().paintWarpRegion(
        { partId: part.id, point: [10, 0, 0], normal: [0, 0, 1] },
        surfaceAt(part, [10, 0, 0]).face,
        false,
        true,
      );
      editor().endPaintStroke();
      await editor().layWarpGrid();
      expect(session().stage).toBe('warp');
      expect(session().faces).not.toEqual(history.at(-1)!.region);
      expect(session().undo).toHaveLength(history.at(-1)!.undo + 1);
      whole();
      holds(h);
      // The density step keeps the grid it rebuilds and its fingerprint through the re-lay.
      expect(session().undo.at(-2)!.grid).toBe(grid);
      // Each undo gives back the step before it exactly: the re-lay, the density change, the
      // falloff, the radius and the move.
      for (let step = history.length - 1; step >= 0; step--) {
        await editor().undoWarpEdit();
        expect(record()).toEqual(history[step]);
        whole();
      }
      expect(current().target).toBeNull();
      lift(current(), h);
      // A refused live Apply reopens the session with the handle as it was.
      useEditor.setState({ liveStatus: 'connected' });
      const confirmed = editor().scene;
      const shown = Array.from(session().preview!.getAttribute('position').array);
      expect(editor().applyWarp()).toBe(true);
      expect(Array.from(editor().scene.parts[0].geometry.getAttribute('position').array)).toEqual(
        shown,
      );
      editor().receiveScene(confirmed);
      useEditor.setState({ tool: 'select' });
      editor().settleWarp(false);
      whole();
      expect(current().target).not.toBeNull();
      holds(h);
      useEditor.setState({ liveStatus: 'disconnected' });
      expect(editor().applyWarp()).toBe(true);
      // Apply starts again on the result.
      expect(session().points.some((point) => point.id === id)).toBe(false);
    });
});
