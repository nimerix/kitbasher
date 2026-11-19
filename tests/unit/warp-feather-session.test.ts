import { afterEach, describe, expect, it } from 'vitest';
import { BufferGeometry, PlaneGeometry, Triangle, Vector3 } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { finishWarpSettling, useEditor } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import type { Part, SurfacePoint } from '../../src/core/types';
import { isPaintedFace, isPaintedNode } from '../../src/core/warp-model';

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;
const toast = () => useEditor.getState().toast?.message;

function plate(segments = 80): Part {
  return {
    id: 'plate',
    name: 'plate',
    geometry: new PlaneGeometry(40, 40, segments, segments),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
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

/** Faces whose centroid lies within `radius` of the plate centre. */
function disc(geometry: BufferGeometry, radius: number) {
  const faces: number[] = [];
  const triangle = new Triangle(),
    centre = new Vector3();
  for (let face = 0; face < triangleCount(geometry); face++)
    if (readFace(geometry, face, triangle).getMidpoint(centre).length() <= radius) faces.push(face);
  return faces;
}

const hit = (x: number, y: number): SurfacePoint => ({
  partId: 'plate',
  point: [x, y, 0],
  normal: [0, 0, 1],
});

/** Starts Warp on the plate with `faces` painted, and lays the grid. */
async function layOn(part: Part, faces: number[]) {
  editor().setScene({ name: 'Feather', parts: [part], joints: [] });
  useEditor.setState({ selected: [part.id] });
  editor().setTool('warp');
  useEditor.setState({ warp: { ...session(), faces } });
  await editor().layWarpGrid();
}

afterEach(() => {
  editor().cancelWarp();
  useEditor.setState({ warpFeather: { enabled: false, width: null } });
});

describe('feather option', () => {
  it('is off by default, starts at the brush radius and is remembered for the page session', async () => {
    expect(editor().warpFeather).toEqual({ enabled: false, width: null });
    const part = plate();
    editor().setScene({ name: 'Feather', parts: [part], joints: [] });
    useEditor.setState({ selected: [part.id] });
    editor().setTool('warp');
    editor().setWarpBrushRadius(2.5);
    editor().setWarpFeather({ enabled: true });
    expect(editor().warpFeather).toEqual({ enabled: true, width: 2.5 });
    editor().setWarpBrushRadius(4);
    expect(editor().warpFeather.width).toBe(2.5);
    editor().setWarpFeather({ width: 3 });

    await layOn(part, disc(part.geometry, 8));
    expect(session().model!.feather).toMatchObject({ width: 3 });
    // Leaving and starting again keeps it.
    editor().cancelWarp();
    editor().setTool('select');
    useEditor.setState({ selected: [part.id] });
    editor().setTool('warp');
    expect(editor().warpFeather).toEqual({ enabled: true, width: 3 });
    // Apply's restart keeps it too.
    useEditor.setState({ warp: { ...session(), faces: disc(part.geometry, 8) } });
    await editor().layWarpGrid();
    const face = faceAt(part.geometry, 0.1, 0.1);
    editor().addWarpPoint(hit(0.1, 0.1), face);
    editor().moveWarpPoints([{ id: session().points[0].id, target: [0.1, 0.1, 1] }], 'end');
    expect(editor().applyWarp()).toBe(true);
    expect(editor().warpFeather).toEqual({ enabled: true, width: 3 });
    expect(session().stage).toBe('region');
    await editor().layWarpGrid();
    expect(session().model!.feather).toMatchObject({ width: 3 });
  });

  it('feathers painted regions only', async () => {
    editor().setWarpFeather({ enabled: true, width: 2 });
    const part = plate();
    await layOn(part, []);
    expect(session().model!.feather).toBeNull();
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    expect(session().model!.feather).toBeNull();
    editor().setWarpRegion('painted');
    useEditor.setState({ warp: { ...session(), faces: disc(part.geometry, 8) } });
    await editor().layWarpGrid();
    expect(session().model!.feather!.joined).toBeGreaterThan(0);
  });

  it('builds today’s region when off or at width 0', async () => {
    const part = plate();
    const faces = disc(part.geometry, 8);
    await layOn(part, faces);
    const plain = session().model!;
    expect(plain.feather).toBeNull();
    editor().setWarpFeather({ enabled: true, width: 0 });
    editor().setWarpRegion('painted');
    await editor().layWarpGrid();
    expect(session().model!.feather).toBeNull();
    expect(session().model!.region).toEqual(plain.region);
  });

  it('says when the mesh is too coarse for the width', async () => {
    editor().setWarpFeather({ enabled: true, width: 1 });
    const part = plate(4);
    await layOn(part, disc(part.geometry, 12));
    expect(session().model!.feather).toMatchObject({ width: 1, joined: 0 });
    expect(session().model!.blend).toBeNull();
  });
});

describe('handles on a feathered region', () => {
  it('can be added only on the paint', async () => {
    editor().setWarpFeather({ enabled: true, width: 3 });
    const part = plate();
    await layOn(part, disc(part.geometry, 8));
    const model = session().model!;
    const band = faceAt(part.geometry, 9.6, 0.1);
    expect(isPaintedFace(model, band)).toBe(false);
    expect(model.region.faces).toContain(band);
    editor().addWarpPoint(hit(9.6, 0.1), band);
    expect(session().points).toHaveLength(0);
    expect(toast()).toBe('Click on the painted area.');
    editor().addWarpPoint(hit(7, 0.1), faceAt(part.geometry, 7, 0.1));
    expect(session().points).toHaveLength(1);
  });

  it('are dropped on rebinding when their face is no longer painted', async () => {
    const part = plate();
    await layOn(part, disc(part.geometry, 10));
    editor().addWarpPoint(hit(9, 0.1), faceAt(part.geometry, 9, 0.1));
    editor().addWarpPoint(hit(2, 0.1), faceAt(part.geometry, 2, 0.1));
    expect(session().points).toHaveLength(2);
    // Repaint smaller with a feather: the first point's face is now in the band.
    editor().setWarpRegion('painted');
    useEditor.setState({ warp: { ...session(), faces: disc(part.geometry, 6) } });
    editor().setWarpFeather({ enabled: true, width: 5 });
    await editor().layWarpGrid();
    const model = session().model!;
    expect(model.region.faces).toContain(faceAt(part.geometry, 9, 0.1));
    expect(session().points).toHaveLength(1);
    expect(isPaintedFace(model, session().points[0].samples[0].face)).toBe(true);
    expect(toast()).toBe('Some control points were outside the new region and were removed.');
  });
});

describe('a session’s own feather', () => {
  it('keeps the width it was laid with through density changes and a live refusal', async () => {
    editor().setWarpFeather({ enabled: true, width: 3 });
    const part = plate();
    useEditor.setState({ liveStatus: 'connected' });
    await layOn(part, disc(part.geometry, 8));
    expect(session().model!.feather).toMatchObject({ width: 3 });
    // The page option changes; a density change rebuilds with the session's own width.
    editor().setWarpFeather({ width: 1.5 });
    await editor().setWarpDensity(2);
    expect(session().model!.feather).toMatchObject({ width: 3 });
    editor().addWarpPoint(hit(0.1, 0.1), faceAt(part.geometry, 0.1, 0.1));
    editor().moveWarpPoints([{ id: session().points[0].id, target: [0.1, 0.1, 1] }], 'end');
    const confirmed = editor().scene;
    expect(editor().applyWarp()).toBe(true);
    expect(editor().warpPending!.session.model!.feather).toMatchObject({ width: 3 });

    editor().setWarpFeather({ enabled: false });
    editor().receiveScene(confirmed);
    editor().settleWarp(false);
    expect(session().model!.feather).toMatchObject({ width: 3 });
    await editor().setWarpDensity(4);
    expect(session().stage).toBe('warp');
    expect(session().model!.feather).toMatchObject({ width: 3 });
    expect(editor().warpFeather.enabled).toBe(false);
    useEditor.setState({ liveStatus: null });
  });

  it('takes the page option when the grid is laid again from the region stage', async () => {
    editor().setWarpFeather({ enabled: true, width: 3 });
    const part = plate();
    await layOn(part, disc(part.geometry, 8));
    editor().setWarpFeather({ enabled: false });
    editor().setWarpRegion('painted');
    await editor().layWarpGrid();
    expect(session().model!.feather).toBeNull();
  });
});

describe('a feathered region painted wider', () => {
  it('carries the band the new paint covers at the surface the user saw', async () => {
    editor().setWarpFeather({ enabled: true, width: 7 });
    const part = plate();
    await layOn(part, disc(part.geometry, 8));
    const old = session().model!;
    editor().setWarpPointSettings({ radius: 20 }, 'end');
    editor().addWarpPoint(hit(0.3, 0.2), faceAt(part.geometry, 0.3, 0.2));
    editor().moveWarpPoints([{ id: session().points[0].id, target: [0.3, 0.2, 2.5] }], 'end');
    finishWarpSettling();
    // A point added on the bent surface takes it as its baseline.
    editor().selectWarpPoints([]);
    editor().setWarpPointSettings({ radius: 6 }, 'end');
    editor().addWarpPoint(hit(3.1, 1.2), faceAt(part.geometry, 3.1, 1.2));
    const written = Float64Array.from(session().output!.positions);

    editor().setWarpRegion('painted');
    useEditor.setState({ warp: { ...session(), faces: disc(part.geometry, 14) } });
    await editor().layWarpGrid();
    const model = session().model!;
    const handle = session().points[1];
    const first = new Int32Array(old.region.weldedCount).fill(-1);
    old.region.weldOf.forEach((v, g) => {
      if (v !== 0xffffffff && first[v] < 0) first[v] = g;
    });
    const reached = new Set(handle.reach!.node);
    let band = 0,
      worst = 0,
      skin = 0;
    for (let n = 0; n < model.grid.nodes.length; n++) {
      const v = model.grid.nodes[n],
        b = old.blend![v];
      if (!(b > 0 && b < 0.9) || !isPaintedNode(model, n) || !reached.has(n)) continue;
      band++;
      const z = written[first[v] * 3 + 2];
      worst = Math.max(worst, Math.abs(handle.baseline.positions[n * 3 + 2] - z));
      // Where the old solve put it before the blend, well above what was written.
      const solved = old.restWorld[v * 3 + 2] + (z - old.restWorld[v * 3 + 2]) / b;
      skin = Math.max(skin, Math.abs(solved - z));
    }
    expect(band).toBeGreaterThan(20);
    expect(skin).toBeGreaterThan(0.1);
    // As close as the carried grid holds painted vertices, rather than the unblended solve.
    expect(worst).toBeLessThan(0.03);
  });

  it('gives every newly painted node the baseline that was written there', async () => {
    editor().setWarpFeather({ enabled: true, width: 7 });
    const part = plate();
    await layOn(part, disc(part.geometry, 8));
    const old = session().model!;
    editor().setWarpPointSettings({ radius: 20 }, 'end');
    editor().addWarpPoint(hit(0.3, 0.2), faceAt(part.geometry, 0.3, 0.2));
    editor().moveWarpPoints([{ id: session().points[0].id, target: [0.3, 0.2, 2.5] }], 'end');
    finishWarpSettling();
    editor().selectWarpPoints([]);
    editor().setWarpPointSettings({ radius: 6 }, 'end');
    editor().addWarpPoint(hit(3.1, 1.2), faceAt(part.geometry, 3.1, 1.2));
    const written = Float64Array.from(session().output!.positions);

    editor().setWarpRegion('painted');
    useEditor.setState({ warp: { ...session(), faces: disc(part.geometry, 14) } });
    await editor().layWarpGrid();
    const model = session().model!;
    const { baseline } = session().points[1];
    const first = new Int32Array(old.region.weldedCount).fill(-1);
    old.region.weldOf.forEach((v, g) => {
      if (v !== 0xffffffff && first[v] < 0) first[v] = g;
    });
    let painted = 0,
      nearlyPainted = 0,
      worst = 0;
    for (let n = 0; n < model.grid.nodes.length; n++) {
      const v = model.grid.nodes[n];
      if (!isPaintedNode(model, n) || old.blend![v] === 1 || first[v] < 0) continue;
      painted++;
      if (old.blend![v] >= 0.9) nearlyPainted++;
      // The plate sits at the origin, so its local positions are world positions.
      worst = Math.max(
        worst,
        Math.hypot(
          ...[0, 1, 2].map((a) => baseline.positions[n * 3 + a] - written[first[v] * 3 + a]),
        ),
      );
    }
    expect(painted).toBeGreaterThan(40);
    expect(nearlyPainted).toBeGreaterThan(0);
    // Single-precision rounding of the written mesh.
    expect(worst).toBeLessThan(1e-5);
  });
});
