import { afterEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry, PlaneGeometry, Triangle, Vector3 } from 'three';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import { triangleCount } from '../../src/core/geometry';
import { useEditor, type WarpPoint } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import { bindPoint } from '../../src/core/warp-bind';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import type { WarpModel } from '../../src/core/warp-model';
import type { Part, SceneDocument, SurfacePoint, Vec3 } from '../../src/core/types';

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

/** The face containing a mesh-local point on the z = 0 plate. */
function faceAt(geometry: BufferGeometry, x: number, y: number) {
  const triangle = new Triangle(),
    point = new Vector3(x, y, 0);
  for (let face = 0; face < triangleCount(geometry); face++)
    if (readFace(geometry, face, triangle).containsPoint(point)) return face;
  throw new Error('No face under the point.');
}

const hit = (partId: string, x: number, y: number): SurfacePoint => ({
  partId,
  point: [x, y, 0],
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

function setup(parts: Part[], selected: string[] = []) {
  const scene: SceneDocument = { name: 'Warp', parts, joints: [] };
  useEditor.getState().setScene(scene);
  useEditor.setState({ selected });
  return scene;
}

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
