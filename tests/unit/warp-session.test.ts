import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  Box3,
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  PlaneGeometry,
  Ray,
  Triangle,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import { triangleCount } from '../../src/core/geometry';
import { spatialIndexOptions, workerIndexTriangles } from '../../src/core/spatial-index';
import { useEditor, type WarpPoint } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import { bindPoint } from '../../src/core/warp-bind';
import { deformPoint } from '../../src/core/warp-evaluate';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import type { WarpModel } from '../../src/core/warp-model';
import { WarpRole } from '../../src/core/warp-region';
import type {
  Joint,
  Part,
  PlaneConstraint,
  SceneDocument,
  SurfacePoint,
  Vec3,
} from '../../src/core/types';

const job = vi.hoisted(() => ({ failure: null as Error | null }));
vi.mock('../../src/core/warp-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/warp-job')>();
  return {
    ...actual,
    buildWarpModelJob: (...args: Parameters<typeof actual.buildWarpModelJob>) =>
      job.failure ? Promise.reject(job.failure) : actual.buildWarpModelJob(...args),
  };
});

function plate(id: string, x = 0): Part {
  const geometry = new PlaneGeometry(40, 40, 16, 16);
  const count = geometry.getAttribute('position').count;
  geometry.setAttribute('color', new BufferAttribute(new Float32Array(count * 3).fill(0.5), 3));
  return {
    id,
    name: id,
    geometry,
    position: [x, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
  };
}

/** The face containing a mesh-local point, by default on the z = 0 plate. */
function faceAt(geometry: BufferGeometry, x: number, y: number, z = 0) {
  const triangle = new Triangle(),
    point = new Vector3(x, y, z),
    closest = new Vector3();
  for (let face = 0; face < triangleCount(geometry); face++) {
    readFace(geometry, face, triangle);
    if (triangle.closestPointToPoint(point, closest).distanceTo(point) < 1e-6) return face;
  }
  throw new Error('No face under the point.');
}

const hit = (partId: string, x: number, y: number, z = 0): SurfacePoint => ({
  partId,
  point: [x, y, z],
  normal: [0, 0, 1],
});

/** A control point as Task 9 adds one: bound to the model, resting at its face position. */
function pointOn(model: WarpModel, part: Part, id: string, x: number, y: number): WarpPoint {
  const face = faceAt(part.geometry, x, y);
  const triangle = readFace(part.geometry, face);
  const barycentric = triangle.getBarycoord(new Vector3(x, y, 0), new Vector3())!.toArray();
  const restWorld: Vec3 = [x + part.position[0], y, 0];
  return {
    id,
    face,
    barycentric,
    binding: bindPoint(model.region, model.grid, model.binding, face, barycentric),
    restWorld,
    pin: restWorld,
    target: null,
  };
}

function setup(
  parts: Part[],
  selected: string[] = [],
  links: Pick<SceneDocument, 'joints' | 'constraints'> = { joints: [] },
) {
  const scene: SceneDocument = { name: 'Warp', parts, ...links };
  useEditor.getState().setScene(scene);
  useEditor.setState({ selected });
  return scene;
}

function solid(id: string, geometry: BufferGeometry, position: Vec3): Part {
  return { ...plate(id), geometry, position };
}

/** Paints a disc of the plate around a mesh-local point and lays the grid over it. */
async function warpDisc(part: Part, x: number, y: number, radius: number) {
  editor().setTool('warp');
  editor().setBrush({ radius, erase: false });
  editor().paintWarpRegion(hit(part.id, x, y), faceAt(part.geometry, x, y), false, true);
  editor().endPaintStroke();
  await editor().layWarpGrid();
}

/** Clicks the plate at a mesh-local point and returns the point that was added. */
function addAt(part: Part, x: number, y: number, z = 0) {
  editor().addWarpPoint(hit(part.id, x, y, z), faceAt(part.geometry, x, y));
  return session().points.at(-1)!;
}

const move = (id: string, target: Vec3, gesture: 'drag' | 'end' = 'end') =>
  editor().moveWarpPoints([{ id, target }], gesture);

/** Where a point sits on the solved warp, in world space. */
const deformed = (point: WarpPoint) =>
  deformPoint(session().model!, session().state!, point.binding, point.restWorld);

const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

const partOf = (id: string) => editor().scene.parts.find((part) => part.id === id)!;
const positionsOf = (geometry: BufferGeometry) =>
  Array.from(geometry.getAttribute('position').array);

const editor = () => useEditor.getState();
const session = () => useEditor.getState().warp!;
const toast = () => useEditor.getState().toast?.message;
const warpTasks = () => useActivity.getState().tasks.filter((t) => t.title === 'Preparing warp');
const runningTask = () => warpTasks().find((t) => t.status === 'running')!;
const failures = () => warpTasks().filter((t) => t.status === 'failed');
const errors = () =>
  useActivity
    .getState()
    .notifications.filter((n) => n.kind === 'error')
    .map((n) => n.message);

const initial = useEditor.getState();
afterEach(() => {
  job.failure = null;
  editor().cancelWarp();
  useEditor.setState(initial);
  useActivity.setState({ tasks: [], notifications: [] });
});

describe('warp session', () => {
  it('refuses to start without exactly one unlocked part', () => {
    setup([plate('a'), plate('b', 50)]);
    editor().setTool('warp');
    expect(editor().tool).toBe('select');
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('Select one visible, unlocked part to warp.');

    useEditor.setState({ selected: ['a'], toast: null });
    editor().setTool('translate');
    useEditor.setState({ selected: ['a', 'b'] });
    editor().setTool('warp');
    expect(editor().tool).toBe('translate');
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('Select one visible, unlocked part to warp.');

    editor().patchParts(['a'], { locked: true });
    useEditor.setState({ selected: ['a'], toast: null });
    editor().setTool('warp');
    expect(editor().tool).toBe('translate');
    expect(toast()).toBe('Select one visible, unlocked part to warp.');

    editor().patchParts(['b'], { visible: false });
    useEditor.setState({ selected: ['b'], toast: null });
    editor().setTool('warp');
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('Select one visible, unlocked part to warp.');

    editor().patchParts(['b'], { visible: true });
    const part = editor().scene.parts.find((p) => p.id === 'b')!;
    useEditor.setState({ toast: null });
    editor().setTool('warp');
    expect(editor().tool).toBe('warp');
    expect(toast()).toBeUndefined();
    expect(session()).toMatchObject({
      partId: 'b',
      epoch: editor().sceneEpoch,
      stage: 'region',
      region: 'painted',
      faces: [],
      density: defaultWarpDensity,
      model: null,
      state: null,
      output: null,
      preview: null,
      points: [],
      selectedPoints: [],
      gapTargets: [],
      snap: false,
      overlap: 0.1,
      gizmo: 'translate',
      seam: null,
      undo: [],
    });
    expect(session().source).toBe(part.geometry);
    expect(session().folds.length).toBe(0);
  });

  it('refuses parts over the triangle limit with the limit message', () => {
    const geometry = new BufferGeometry();
    geometry.attributes.position = {
      count: 30_000_003,
      itemSize: 3,
      array: { BYTES_PER_ELEMENT: 4 },
    } as unknown as BufferAttribute;
    const part = { ...plate('dense'), name: 'Dense scan', geometry };
    useEditor.setState({ scene: { name: 'Warp', parts: [part], joints: [] }, selected: ['dense'] });
    editor().setTool('warp');
    expect(editor().tool).toBe('select');
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('Dense scan has too many triangles to warp. The limit is 10 million.');
  });

  it('paints only on the warped part', () => {
    const a = plate('a'),
      b = plate('b', 50);
    setup([a, b], ['a']);
    editor().setTool('warp');
    editor().setBrush({ radius: 3, erase: false });

    expect(editor().paintWarpRegion(hit('b', 0, 0), faceAt(b.geometry, 0, 0), false, true)).toBe(
      false,
    );
    expect(session().faces).toEqual([]);
    expect(editor().paintHistory).toHaveLength(0);

    expect(editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false)).toBe(false);
    expect(editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true)).toBe(
      true,
    );
    expect(editor().painting).toBe(true);
    const first = session().faces;
    expect(first.length).toBeGreaterThan(0);
    expect(first).toEqual([...first].sort((x, y) => x - y));
    expect(session().seed).toMatchObject({ partId: 'a', face: faceAt(a.geometry, 0, 0) });

    expect(editor().paintWarpRegion(hit('b', 4, 0), faceAt(b.geometry, 4, 0))).toBe(false);
    expect(editor().paintWarpRegion(hit('a', 4, 0), faceAt(a.geometry, 4, 0))).toBe(true);
    const grown = session().faces;
    expect(grown.length).toBeGreaterThan(first.length);
    expect(first.every((face) => grown.includes(face))).toBe(true);
    editor().endPaintStroke();
    expect(editor().painting).toBe(false);

    expect(editor().paintWarpRegion(hit('a', 4, 0), faceAt(a.geometry, 4, 0), true, true)).toBe(
      true,
    );
    expect(session().faces.length).toBeLessThan(grown.length);
    expect(editor().paintHistory).toHaveLength(2);
    editor().endPaintStroke();
    editor().undoPaintStroke();
    expect(session().faces).toEqual(grown);
    editor().undoPaintStroke();
    expect(session().faces).toEqual([]);
    expect(session().seed).toBeUndefined();
    expect(editor().paintHistory).toHaveLength(0);
  });

  it('lays a grid over the whole part when nothing is painted', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    const pending = editor().layWarpGrid();
    expect(session().stage).toBe('building');
    expect(warpTasks()[0]?.status).toBe('running');
    await pending;

    const warp = session();
    expect(warp.stage).toBe('warp');
    expect(warp.model!.region.faces.length).toBe(triangleCount(a.geometry));
    expect(Array.from(warp.state!.positions)).toEqual(Array.from(warp.model!.restNodes));
    const preview = warp.preview!;
    expect(preview.index).toBe(a.geometry.index);
    expect(preview.getAttribute('color')).toBe(a.geometry.getAttribute('color'));
    expect(preview.getAttribute('position').array).toBe(warp.output!.positions);
    expect(preview.getAttribute('normal').array).toBe(warp.output!.normals);
    expect(preview.getAttribute('position').array).not.toBe(
      a.geometry.getAttribute('position').array,
    );
    expect(Array.from(preview.getAttribute('position').array)).toEqual(
      Array.from(a.geometry.getAttribute('position').array),
    );
    expect(warpTasks().map((task) => task.status)).toEqual(['completed']);
    expect(editor().scene.parts[0].geometry).toBe(a.geometry);
  });

  it('cancels when the part geometry changes under the session', async () => {
    const a = plate('a');
    setup([a], ['a']);
    const edited = plate('a').geometry;
    expect(
      editor().applyProcessedMesh('a', a.geometry, edited, false, editor().sceneEpoch, 'Edited'),
    ).toBe(true);
    editor().setTool('warp');
    await editor().layWarpGrid();
    const preview = session().preview!;
    let detached = false;
    preview.addEventListener('dispose', () => {
      detached = preview.index === null && !preview.getAttribute('color');
    });

    editor().undo();
    expect(editor().scene.parts[0].geometry).toBe(a.geometry);
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('The part changed, so the warp was cancelled.');
    expect(detached).toBe(true);
    expect(edited.index).not.toBeNull();
    expect(edited.getAttribute('color')).toBeDefined();

    // A build in flight is abandoned without reporting a failure.
    editor().redo();
    useEditor.setState({ selected: ['a'] });
    editor().setTool('warp');
    const pending = editor().layWarpGrid();
    editor().undo();
    await pending;
    expect(editor().warp).toBeNull();
    expect(
      warpTasks()
        .map((task) => task.status)
        .sort(),
    ).toEqual(['cancelled', 'completed']);
    expect(useActivity.getState().notifications.some((n) => n.kind === 'error')).toBe(false);
  });

  it('cancels when the scene is replaced', () => {
    const scene = setup([plate('a')], ['a']);
    editor().setTool('warp');
    expect(editor().warp).not.toBeNull();
    // The same parts and geometry, but a new scene epoch.
    editor().setScene({ ...scene });
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('The part changed, so the warp was cancelled.');
  });

  it('discards edits when leaving the tool and cancels silently without them', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    useEditor.setState({ toast: null });
    editor().setTool('select');
    expect(editor().warp).toBeNull();
    expect(toast()).toBeUndefined();

    editor().setTool('warp');
    await editor().layWarpGrid();
    useEditor.setState({
      warp: { ...session(), points: [pointOn(session().model!, a, 'p', 0, 0)] },
    });
    // Choosing the tool again keeps the session.
    editor().setTool('warp');
    expect(session().points).toHaveLength(1);
    editor().setTool('measure');
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('Warp discarded. Use Apply to keep a warp.');
  });

  it('keeps points inside a rebuilt region and drops the rest with a notice', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    await editor().layWarpGrid();
    const whole = session().model!;
    const inside = { ...pointOn(whole, a, 'inside', -10, 1), target: [-10, 1, 3] as Vec3 };
    const outside = pointOn(whole, a, 'outside', 12, -12);
    const gapTargets = [{ node: 0, target: [0, 0, 0] as Vec3 }];
    useEditor.setState({
      warp: {
        ...session(),
        points: [inside, outside],
        selectedPoints: ['inside', 'outside'],
        gapTargets,
        undo: [{ points: [inside, outside], gapTargets }],
      },
    });

    editor().setWarpRegion('painted');
    expect(session().stage).toBe('region');
    editor().setBrush({ radius: 6, erase: false });
    expect(
      editor().paintWarpRegion(hit('a', -10, 0), faceAt(a.geometry, -10, 0), false, true),
    ).toBe(true);
    editor().endPaintStroke();
    const faces = session().faces;
    expect(faces).toContain(inside.face);
    expect(faces).not.toContain(outside.face);
    useEditor.setState({ toast: null });
    await editor().layWarpGrid();

    let warp = session();
    const model = warp.model!;
    expect(model).not.toBe(whole);
    expect(Array.from(model.region.faces)).toEqual(faces);
    expect(toast()).toBe('Some control points were outside the new region and were removed.');
    expect(editor().paintHistory).toHaveLength(0);
    expect(warp.points.map((p) => p.id)).toEqual(['inside']);
    expect(warp.selectedPoints).toEqual(['inside']);
    expect(warp.gapTargets).toEqual([]);
    const [kept] = warp.points;
    expect(kept.binding).toEqual(
      bindPoint(model.region, model.grid, model.binding, inside.face, inside.barycentric),
    );
    kept.binding.node.forEach((n) => expect(n).toBeLessThan(model.grid.nodes.length));
    kept.restWorld.forEach((v, i) => expect(v).toBeCloseTo(inside.restWorld[i], 5));
    expect(kept.target).toEqual([-10, 1, 3]);
    expect(kept.pin).toEqual(inside.pin);
    expect(warp.undo).toEqual([{ points: [kept], gapTargets: [] }]);

    // A density change rebuilds the grid and keeps every point that is still inside.
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    const nodes = session().model!.grid.nodes.length;
    useEditor.setState({ toast: null });
    const superseded = editor().setWarpDensity(1);
    await editor().setWarpDensity(0);
    await superseded;
    warp = session();
    expect(warp.stage).toBe('warp');
    expect(warp.density).toBe(0);
    expect(warp.model!.grid.nodes.length).toBeLessThan(nodes);
    expect(warp.points.map((p) => p.id)).toEqual(['inside']);
    expect(warp.points[0].binding).toEqual(
      bindPoint(
        warp.model!.region,
        warp.model!.grid,
        warp.model!.binding,
        inside.face,
        inside.barycentric,
      ),
    );
    expect(toast()).toBeUndefined();
    expect(
      warpTasks()
        .map((task) => task.status)
        .sort(),
    ).toEqual(['cancelled', 'completed', 'completed', 'completed', 'completed']);
  });

  it('restores the stage, density and stroke undo when a build is cancelled', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    const painted = session().faces;

    const first = editor().layWarpGrid();
    requestTaskCancellation(runningTask().id);
    await first;
    expect(session()).toMatchObject({ stage: 'region', density: defaultWarpDensity, model: null });
    expect(session().faces).toEqual(painted);
    expect(editor().paintHistory).toHaveLength(1);
    editor().undoPaintStroke();
    expect(session().faces).toEqual([]);

    await editor().layWarpGrid();
    const model = session().model!;
    const rebuild = editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'building', density: 1 });
    requestTaskCancellation(runningTask().id);
    await rebuild;
    expect(session()).toMatchObject({ stage: 'warp', density: defaultWarpDensity });
    expect(session().model).toBe(model);
    expect(failures()).toEqual([]);
    expect(errors()).toEqual([]);

    await editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'warp', density: 1 });
    expect(session().model).not.toBe(model);
    expect(session().model!.grid.nodes.length).toBeLessThan(model.grid.nodes.length);
    expect(failures()).toEqual([]);
  });

  it('restores the stage and density and reports the error when a rebuild fails', async () => {
    setup([plate('a')], ['a']);
    editor().setTool('warp');
    await editor().layWarpGrid();
    const model = session().model!;

    job.failure = new Error('The warp worker stopped.');
    await editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'warp', density: defaultWarpDensity });
    expect(session().model).toBe(model);
    expect(failures().map((task) => task.detail)).toEqual(['The warp worker stopped.']);
    expect(errors()).toEqual(['Preparing warp: The warp worker stopped.']);

    job.failure = null;
    await editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'warp', density: 1 });
    expect(session().model).not.toBe(model);
    expect(failures()).toHaveLength(1);
  });

  it('never writes to the source geometry arrays', async () => {
    const a = plate('a');
    const arrays = ['position', 'normal', 'color'].map(
      (name) => a.geometry.getAttribute(name).array,
    );
    const before = [...arrays, a.geometry.index!.array].map((array) => Array.from(array));
    setup([a], ['a']);
    editor().setTool('warp');
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    await editor().layWarpGrid();
    await editor().setWarpDensity(1);

    const { model, output, preview } = session();
    expect(model!.positions).not.toBe(arrays[0]);
    expect(model!.normals).not.toBe(arrays[1]);
    expect(model!.index).not.toBe(a.geometry.index!.array);
    output!.positions.fill(7);
    output!.normals!.fill(0);
    preview!.getAttribute('position').needsUpdate = true;
    editor().cancelWarp();

    const after = [...arrays, a.geometry.index!.array].map((array) => Array.from(array));
    expect(after).toEqual(before);
    expect(a.geometry.getAttribute('position').array).toBe(arrays[0]);
  });
});

describe('warp points, close gap and apply', () => {
  it('adds points only inside the region', async () => {
    const a = plate('a', 5),
      b = plate('b', 50);
    setup([a, b], ['a']);
    editor().setTool('warp');
    editor().addWarpPoint(hit('a', 0, 0), faceAt(a.geometry, 0, 0));
    expect(session().points).toEqual([]);
    await warpDisc(a, 0, 0, 6);

    useEditor.setState({ toast: null });
    editor().addWarpPoint(hit('a', 15, 15), faceAt(a.geometry, 15, 15));
    expect(session().points).toEqual([]);
    expect(toast()).toBe('Click inside the warp region.');
    useEditor.setState({ toast: null });
    editor().addWarpPoint(hit('b', 0, 0), faceAt(b.geometry, 0, 0));
    expect(session().points).toEqual([]);
    expect(toast()).toBe('Click inside the warp region.');

    const { model } = session();
    const p = addAt(a, 1, 0.5);
    expect(session().selectedPoints).toEqual([p.id]);
    expect(p.face).toBe(faceAt(a.geometry, 1, 0.5));
    const corners = readFace(a.geometry, p.face);
    const expected = corners.getBarycoord(new Vector3(1, 0.5, 0), new Vector3())!.toArray();
    p.barycentric.forEach((w, i) => expect(w).toBeCloseTo(expected[i], 6));
    expect(p.binding).toEqual(
      bindPoint(model!.region, model!.grid, model!.binding, p.face, p.barycentric),
    );
    expect(distance(p.restWorld, [6, 0.5, 0])).toBeLessThan(1e-5);
    expect(distance(p.pin, p.restWorld)).toBeLessThan(1e-6);
    expect(p.target).toBeNull();

    // On a warped surface, a click is measured on the deformed triangle, and the point holds
    // where the warp now puts it.
    move(p.id, [6, 0.5, 3]);
    const face = faceAt(a.geometry, 2.6, 1.3);
    const { output } = session();
    const at = (corner: number) =>
      new Vector3().fromArray(output!.positions, a.geometry.index!.getX(face * 3 + corner) * 3);
    const centroid = at(0).add(at(1)).add(at(2)).divideScalar(3);
    expect(centroid.z).toBeGreaterThan(0.5);
    editor().addWarpPoint(hit('a', centroid.x, centroid.y, centroid.z), face);
    const q = session().points.at(-1)!;
    expect(session().points).toHaveLength(2);
    expect(session().selectedPoints).toEqual([q.id]);
    q.barycentric.forEach((w) => expect(w).toBeCloseTo(1 / 3, 5));
    const rest = readFace(a.geometry, face)
      .getMidpoint(new Vector3())
      .add(new Vector3(5, 0, 0));
    expect(distance(q.restWorld, rest.toArray())).toBeLessThan(1e-5);
    expect(distance(q.pin, deformed(q))).toBeLessThan(1e-9);
    expect(q.pin[2]).toBeGreaterThan(0.5);
    // At a corner the point's warp and the surface's agree.
    const corner = at(0);
    editor().addWarpPoint(hit('a', corner.x, corner.y, corner.z), face);
    const r = session().points.at(-1)!;
    expect(distance(r.pin, corner.add(new Vector3(5, 0, 0)).toArray())).toBeLessThan(1e-4);
  });

  it('moves a point to its target within 0.01 mm after end', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    const p = addAt(a, 0, 0);
    const { preview, output, model } = session();
    const position = preview!.getAttribute('position') as BufferAttribute,
      normal = preview!.getAttribute('normal') as BufferAttribute;
    const versions = [position.version, normal.version];

    move(p.id, [0, 0, 1], 'drag');
    expect(session().points[0].target).toEqual([0, 0, 1]);
    expect(position.version).toBeGreaterThan(versions[0]);
    expect(normal.version).toBeGreaterThan(versions[1]);
    expect(preview!.boundingBox!.max.z).toBeGreaterThan(0.5);
    move(p.id, [0, 0, 2], 'drag');
    move(p.id, [0, 0, 3]);
    expect(distance(deformed(session().points[0]), [0, 0, 3])).toBeLessThan(0.01);

    // One undo step for the whole gesture, holding the points from before it.
    expect(session().undo).toHaveLength(2);
    expect(session().undo.at(-1)!.points[0].target).toBeNull();
    // A release that moved nothing adds none.
    move(p.id, [0, 0, 3]);
    expect(session().undo).toHaveLength(2);
    expect(session().folds.length).toBe(0);
    expect(session().seam).toBeNull();

    const box = preview!.boundingBox!;
    expect(box.max.z).toBeGreaterThan(2.9);
    expect(box.max.z).toBeLessThan(3.01);
    expect(box.min.z).toBe(0);
    expect(preview!.boundingSphere!.containsPoint(box.max)).toBe(true);
    expect(preview!.boundingSphere!.containsPoint(box.min)).toBe(true);

    // Vertices outside the region keep their original bits.
    const source = a.geometry.getAttribute('position').array;
    const weldOf = model!.region.weldOf;
    let outside = 0;
    for (let g = 0; g < weldOf.length; g++) {
      if (model!.region.role[weldOf[g]] === WarpRole.Interior) continue;
      outside++;
      for (let c = 0; c < 3; c++) expect(output!.positions[g * 3 + c]).toBe(source[g * 3 + c]);
    }
    expect(outside).toBeGreaterThan(0);
  });

  it('solves a rebuilt grid so the surface follows its points', async () => {
    const a = plate('a');
    const lid = solid('lid', new BoxGeometry(10, 10, 10), [0, 0, 14]);
    setup([a, lid], ['a']);
    await warpDisc(a, 0, 0, 9);
    expect(session().seam).toBeNull();
    const handle = addAt(a, -3, 0);
    move(handle.id, [-3, 0, 2]);
    // Added on the raised surface, so it holds the surface there without a target.
    const held = addAt(a, 3, 0);
    expect(held.pin[2]).toBeGreaterThan(0.2);
    editor().patchParts(['lid'], { position: [0, 0, 9] });

    await editor().setWarpDensity(1);
    const warp = session();
    expect(warp.density).toBe(1);
    expect(warp.points.map((point) => point.id)).toEqual([handle.id, held.id]);
    expect(distance(deformed(warp.points[0]), [-3, 0, 2])).toBeLessThan(0.05);
    expect(distance(deformed(warp.points[1]), held.pin)).toBeLessThan(0.01);
    expect(warp.preview!.boundingBox!.max.z).toBeGreaterThan(1.9);
    expect(Math.max(...positionsOf(warp.preview!).filter((_, i) => i % 3 === 2))).toBe(
      warp.preview!.boundingBox!.max.z,
    );
    expect(warp.folds.length).toBe(0);
    expect(warp.seam).not.toBeNull();
  });

  it('updates only the grid and points while dragging a large region', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    const p = addAt(a, 0, 0);
    const model = session().model!;
    useEditor.setState({
      warp: {
        ...session(),
        model: { ...model, region: { ...model.region, interiorCount: 250_001 } },
      },
    });
    const position = session().preview!.getAttribute('position') as BufferAttribute;
    const version = position.version;
    const rest = Array.from(session().output!.positions);

    move(p.id, [0, 0, 2], 'drag');
    expect(position.version).toBe(version);
    expect(Array.from(session().output!.positions)).toEqual(rest);
    expect(deformed(session().points[0])[2]).toBeGreaterThan(1);

    move(p.id, [0, 0, 2]);
    expect(position.version).toBeGreaterThan(version);
    expect(Array.from(session().output!.positions)).not.toEqual(rest);
    expect(distance(deformed(session().points[0]), [0, 0, 2])).toBeLessThan(0.01);
  });

  it('snaps a dragged point 0.1 mm inside a neighbour when snap is on', async () => {
    const a = plate('a');
    // Its underside is 2 mm above the plate.
    const lid = solid('lid', new BoxGeometry(10, 10, 10), [0, 0, 7]);
    setup([a, lid], ['a']);
    await warpDisc(a, 0, 0, 8);
    const p = addAt(a, 0, 0);

    move(p.id, [0, 0, 1.5], 'drag');
    expect(session().points[0].target).toEqual([0, 0, 1.5]);
    editor().setWarpOptions({ snap: true });
    expect(session().snap).toBe(true);
    move(p.id, [0.5, 0, 1.5], 'drag');
    session().points[0].target!.forEach((v, i) => expect(v).toBeCloseTo([0.5, 0, 2.1][i], 6));
    move(p.id, [0, 0, 1.5]);
    session().points[0].target!.forEach((v, i) => expect(v).toBeCloseTo([0, 0, 2.1][i], 6));
    expect(distance(deformed(session().points[0]), [0, 0, 2.1])).toBeLessThan(0.01);
    expect(session().seam).not.toBeNull();

    // Out of range, a target stays where it was dragged.
    move(p.id, [0, 0, -4], 'drag');
    expect(session().points[0].target).toEqual([0, 0, -4]);

    editor().setWarpOptions({ overlap: 0.5 });
    move(p.id, [0, 0, 1.5], 'drag');
    expect(session().points[0].target![2]).toBeCloseTo(2.5, 6);
    editor().setWarpOptions({ overlap: 9 });
    expect(session().overlap).toBe(5);
    editor().setWarpOptions({ overlap: Number.NaN, gizmo: 'rotate' });
    expect(session()).toMatchObject({ overlap: 5, gizmo: 'rotate', snap: true });
  });

  it('close gap leaves every targeted node at the overlap depth', async () => {
    const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
    // 1 mm from the block's +X face.
    const wall = solid('wall', new BoxGeometry(20, 20, 20), [21, 0, 0]);
    setup([block, wall], ['block']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    expect(Math.min(...session().seam!.gaps)).toBeCloseTo(1, 5);

    // A pin on the far face holds the block, so it stretches to the wall.
    editor().addWarpPoint(
      { partId: 'block', point: [-10, 0.5, 0.5], normal: [-1, 0, 0] },
      faceAt(block.geometry, -10, 0.5, 0.5),
    );
    const pin = session().points[0];
    editor().closeWarpGap();
    const { gapTargets, state } = session();
    expect(gapTargets.length).toBeGreaterThan(0);
    for (const { node, target } of gapTargets) {
      expect(target[0]).toBeCloseTo(11.1, 6);
      expect(distance(state!.positions.subarray(node * 3, node * 3 + 3), target)).toBeLessThan(
        0.01,
      );
    }
    expect(distance(deformed(pin), pin.pin)).toBeLessThan(0.01);
    expect(session().undo).toHaveLength(2);
    expect(session().undo.at(-1)!.gapTargets).toEqual([]);
    expect(Math.min(...session().seam!.gaps)).toBeCloseTo(-0.1, 1);

    editor().patchParts(['wall'], { position: [60, 0, 0] });
    useEditor.setState({ toast: null });
    editor().closeWarpGap();
    expect(toast()).toBe('No neighbouring part is within 5 mm of this region.');
    expect(session().gapTargets).toBe(gapTargets);

    vi.stubGlobal('Worker', class {});
    try {
      const side = Math.ceil(Math.sqrt(workerIndexTriangles / 12)) + 1;
      const dense = solid('dense', new BoxGeometry(10, 10, 10, side, side, side), [0, 0, 16]);
      editor().addParts([{ ...dense, name: 'Dense scan' }]);
      useEditor.setState({ selected: ['block'], toast: null });
      editor().closeWarpGap();
      expect(toast()).toBe('Still preparing Dense scan. Try Close gap again when it finishes.');
      expect(session().gapTargets).toBe(gapTargets);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('undoWarpEdit restores the previous points and surface', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 9);
    const rest = Array.from(session().output!.positions);
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    const lifted = Array.from(session().output!.positions);
    const q = addAt(a, -4, 0);
    move(q.id, [-4, 0, -1]);
    expect(session().undo).toHaveLength(4);

    editor().selectWarpPoints([p.id, 'missing']);
    expect(session().selectedPoints).toEqual([p.id]);
    editor().selectWarpPoints([q.id], true);
    expect(session().selectedPoints).toEqual([p.id, q.id]);
    editor().selectWarpPoints([q.id], true);
    expect(session().selectedPoints).toEqual([p.id]);
    editor().removeWarpPoints();
    expect(session().points.map((point) => point.id)).toEqual([q.id]);
    expect(session().selectedPoints).toEqual([]);
    expect(deformed(p)[2]).toBeLessThan(1.5);
    editor().undoWarpEdit();
    expect(session().points.map((point) => point.id)).toEqual([p.id, q.id]);
    expect(distance(deformed(session().points[0]), [0, 0, 2])).toBeLessThan(0.01);

    const close = (a: number[], b: ArrayLike<number>) => {
      let worst = 0;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
      return worst;
    };
    editor().undoWarpEdit();
    expect(session().points[1].target).toBeNull();
    expect(close(lifted, session().output!.positions)).toBeLessThan(0.01);
    editor().undoWarpEdit();
    expect(session().points.map((point) => point.id)).toEqual([p.id]);
    editor().undoWarpEdit();
    expect(session().points[0].target).toBeNull();
    expect(close(rest, session().output!.positions)).toBeLessThan(0.01);
    editor().undoWarpEdit();
    expect(session().points).toEqual([]);
    expect(session().undo).toEqual([]);
    expect(close(rest, session().output!.positions)).toBeLessThan(1e-5);
    editor().undoWarpEdit();
    expect(session().points).toEqual([]);
  });

  it('adding or removing a pin between drags changes the solve', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 9);
    const handle = addAt(a, -4, 0);
    const b = addAt(a, 4, 0);
    // The fixed border and pins resist the handle, which leaves it a little short of its target.
    move(handle.id, [-4, 0, 3]);
    expect(distance(deformed(handle), [-4, 0, 3])).toBeLessThan(0.05);
    expect(distance(deformed(b), [4, 0, 0])).toBeLessThan(0.01);

    // Without the pin, its place rises with the handle.
    editor().removeWarpPoints([b.id]);
    move(handle.id, [-4, 0, 4]);
    expect(distance(deformed(handle), [-4, 0, 4])).toBeLessThan(0.05);
    const free = deformed(b);
    expect(free[2]).toBeGreaterThan(0.5);

    // A new pin there holds where the surface now is.
    editor().addWarpPoint(hit('a', free[0], free[1], free[2]), b.face);
    const c = session().points.at(-1)!;
    expect(distance(c.pin, free)).toBeLessThan(0.05);
    move(handle.id, [-4, 0, 1]);
    expect(distance(deformed(handle), [-4, 0, 1])).toBeLessThan(0.05);
    expect(distance(deformed(c), c.pin)).toBeLessThan(0.01);
  });

  it('cancels when the warped part moves, turns or scales', async () => {
    const a = plate('a'),
      b = plate('b', 50);
    for (const patch of [
      { position: [1, 0, 0] as Vec3 },
      { quaternion: [0, 0, 0.6, 0.8] as Part['quaternion'] },
      { scale: [1, 1, 2] as Vec3 },
    ]) {
      setup([a, b], ['a']);
      await warpDisc(a, 0, 0, 6);
      addAt(a, 0, 0);
      editor().patchParts(['b'], { position: [60, 0, 0] });
      editor().patchParts(['a'], { color: '#112233', name: 'Renamed' });
      expect(editor().warp).not.toBeNull();
      useEditor.setState({ toast: null });
      editor().patchParts(['a'], patch);
      expect(editor().warp).toBeNull();
      expect(toast()).toBe('The part changed, so the warp was cancelled.');
      expect(editor().applyWarp()).toBe(false);
    }
  });

  it('apply is one undo step and undo restores the original geometry', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    const faces = session().faces;
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    const { preview, output } = session();
    let disposed = false;
    preview!.addEventListener('dispose', () => {
      disposed = preview!.index === null;
    });
    const past = editor().past.length;

    expect(editor().applyWarp()).toBe(true);
    const applied = partOf('a').geometry;
    expect(applied).not.toBe(a.geometry);
    expect(partOf('a').source).toBe('Warp · test');
    expect(editor().past).toHaveLength(past + 1);
    expect(positionsOf(applied)).toEqual(Array.from(output!.positions));
    expect(applied.getAttribute('position').array).not.toBe(output!.positions);
    expect(applied.boundsTree).toBeUndefined();
    expect(disposed).toBe(true);
    expect(editor().warpPending).toBeNull();
    expect(editor().tool).toBe('warp');
    expect(session()).toMatchObject({
      partId: 'a',
      source: applied,
      stage: 'region',
      region: 'painted',
      faces,
      model: null,
      preview: null,
      points: [],
      gapTargets: [],
      undo: [],
    });

    editor().undo();
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(editor().warp).toBeNull();
    expect(editor().past).toHaveLength(past);
    editor().redo();
    expect(partOf('a').geometry).toBe(applied);
  });

  it('apply leaves pins, anchors, pivot and joints unchanged and moves no other part', async () => {
    const a: Part = {
      ...plate('a'),
      pivot: [1, 2, 0],
      pins: [{ id: 'pin', point: [0, 0, 0], target: [0, 0, 0], kind: 'hard', priority: 50 }],
      anchors: [{ id: 'anchor', point: [1, 0, 0], target: [1, 0, 0] }],
    };
    const b = plate('b', 50);
    const joint: Joint = {
      id: 'j',
      name: 'Hinge',
      parentId: 'b',
      childId: 'a',
      parentAnchor: [-20, 0, 0],
      childAnchor: [20, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, false],
      keepConnected: true,
    };
    const constraint: PlaneConstraint = {
      id: 'c',
      name: 'Mate',
      sourceId: 'a',
      targetId: 'b',
      sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
      targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
      kind: 'parallel',
      angle: 0,
      offset: 0,
      opposed: false,
      enabled: true,
    };
    setup([a, b], ['a'], { joints: [joint], constraints: [constraint] });
    const before = editor().scene;
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    expect(editor().applyWarp()).toBe(true);

    const after = editor().scene;
    const [warped, other] = after.parts;
    expect(warped.geometry).not.toBe(a.geometry);
    expect(other).toBe(before.parts[1]);
    expect(after.joints).toBe(before.joints);
    expect(after.constraints).toBe(before.constraints);
    for (const key of ['position', 'quaternion', 'scale', 'pivot', 'pins', 'anchors'] as const)
      expect(warped[key]).toBe(before.parts[0][key]);
    expect({ ...warped, geometry: null, source: null }).toEqual({
      ...before.parts[0],
      geometry: null,
      source: null,
    });
  });

  it('apply on a pasted copy leaves its sibling on the original geometry', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().copySelected();
    editor().pasteClipboard();
    const copy = editor().scene.parts[1];
    expect(copy.geometry).toBe(a.geometry);
    expect(editor().selected).toEqual([copy.id]);
    await warpDisc(copy, 0, 0, 8);
    move(addAt(copy, 0, 0).id, [0, 0, 2]);
    const original = partOf('a');

    expect(editor().applyWarp()).toBe(true);
    expect(partOf(copy.id).geometry).not.toBe(a.geometry);
    expect(partOf('a')).toBe(original);
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(positionsOf(a.geometry).every((v, i) => v === positionsOf(original.geometry)[i])).toBe(
      true,
    );
  });

  it('apply shares index and color with the source and refits its BVH', async () => {
    const a = plate('a');
    a.geometry.boundsTree = new MeshBVH(a.geometry, spatialIndexOptions);
    const source = a.geometry;
    const tree = source.boundsTree as MeshBVH;
    const index = Array.from(source.index!.array);
    const sourceBox = tree.getBoundingBox(new Box3());
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 3]);
    const { output } = session();

    expect(editor().applyWarp()).toBe(true);
    const applied = partOf('a').geometry;
    expect(applied.index).toBe(source.index);
    expect(applied.getAttribute('color')).toBe(source.getAttribute('color'));
    expect(applied.getAttribute('position').array).not.toBe(output!.positions);
    expect(applied.getAttribute('normal').array).not.toBe(output!.normals);
    expect(applied.getAttribute('normal').array).not.toBe(source.getAttribute('normal').array);
    expect(Array.from(applied.getAttribute('normal').array)).toEqual(Array.from(output!.normals!));
    expect(Array.from(source.index!.array)).toEqual(index);

    const copy = applied.boundsTree as MeshBVH;
    expect(copy).toBeInstanceOf(MeshBVH);
    expect(copy).not.toBe(tree);
    expect(copy.geometry).toBe(applied);
    expect(copy.getBoundingBox(new Box3()).max.z).toBeCloseTo(
      Math.max(...positionsOf(applied).filter((_, i) => i % 3 === 2)),
      5,
    );
    expect(tree.getBoundingBox(new Box3())).toEqual(sourceBox);
    const down = new Ray(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    expect(copy.raycastFirst(down, DoubleSide)!.point.z).toBeGreaterThan(2.9);
    expect(tree.raycastFirst(down, DoubleSide)!.point.z).toBe(0);

    // Edits in the session that restarts on the applied mesh never reach it.
    const committed = positionsOf(applied);
    await editor().layWarpGrid();
    move(addAt(a, 0, 0).id, [0, 0, 6]);
    expect(positionsOf(applied)).toEqual(committed);
  });

  it('apply is refused after the part changes', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    const past = editor().past.length;
    editor().patchParts(['a'], { locked: true }, false);
    expect(editor().warp).not.toBeNull();
    useEditor.setState({ toast: null });

    expect(editor().applyWarp()).toBe(false);
    expect(toast()).toBe('The part changed, so the warp could not be applied.');
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(editor().past).toHaveLength(past);
    expect(session().stage).toBe('warp');

    editor().patchParts(['a'], { locked: false }, false);
    expect(editor().applyWarp()).toBe(true);
  });

  it('settleWarp(false) reopens the session after a live refusal', async () => {
    const a = plate('a');
    setup([a], ['a']);
    useEditor.setState({ liveStatus: 'connected' });
    await warpDisc(a, 0, 0, 8);
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    const confirmed = editor().scene;

    expect(editor().applyWarp()).toBe(true);
    const pending = editor().warpPending!;
    expect(pending).toMatchObject({ partId: 'a', source: a.geometry });
    expect(pending.applied).toBe(partOf('a').geometry);
    expect(pending.session).toMatchObject({ stage: 'warp', source: a.geometry });
    expect(pending.session.points.map((point) => point.target)).toEqual([[0, 0, 2]]);
    expect(session().source).toBe(pending.applied);

    // live.ts shows the server's scene again, then settles the warp.
    editor().receiveScene(confirmed);
    expect(editor().warp).toBeNull();
    useEditor.setState({ tool: 'select' });
    editor().settleWarp(false);
    expect(editor().warp).toBe(pending.session);
    expect(editor().warpPending).toBeNull();
    expect(editor().tool).toBe('warp');
    expect(editor().selected).toEqual(['a']);
    expect(toast()).toBe(
      'Your warp could not be combined with another edit. It is open again so you can apply it once more.',
    );
    expect(session().preview!.index).toBe(a.geometry.index);

    // Accepted: the kept session is released.
    expect(editor().applyWarp()).toBe(true);
    const kept = editor().warpPending!.session.preview!;
    let released = false;
    kept.addEventListener('dispose', () => {
      released = kept.index === null;
    });
    editor().settleWarp(true);
    expect(editor().warpPending).toBeNull();
    expect(released).toBe(true);
    useEditor.setState({ toast: null });
    editor().settleWarp(false);
    expect(toast()).toBeUndefined();

    // Refused while the part still holds the warp: nothing to reopen.
    await editor().layWarpGrid();
    move(addAt(a, 0, 0).id, [0, 0, 1]);
    expect(editor().applyWarp()).toBe(true);
    const restarted = session();
    editor().settleWarp(false);
    expect(editor().warpPending).toBeNull();
    expect(editor().warp).toBe(restarted);
    expect(toast()).toBeUndefined();
  });
});
