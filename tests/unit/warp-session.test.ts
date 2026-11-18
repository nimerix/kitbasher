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
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { MeshBVH } from 'three-mesh-bvh';
import { requestTaskCancellation, useActivity } from '../../src/core/activity';
import {
  chooseTransformTool,
  editorCommands,
  executeEditorCommand,
  stepSelection,
} from '../../src/core/commands';
import { triangleCount } from '../../src/core/geometry';
import { spatialIndexOptions, workerIndexTriangles } from '../../src/core/spatial-index';
import {
  finishWarpDrag,
  finishWarpSettling,
  isWarpDragging,
  useEditor,
  warpChanges,
  warpRadiusSpacings,
  warpShortfall,
  warpShortfallShown,
  warpWholeDensity,
  type WarpBaseline,
  type WarpPoint,
} from '../../src/core/store';
import { useXR } from '../../src/core/xr-session';
import { readFace } from '../../src/core/surfaces';
import { activeTransformTool, transformSelection } from '../../src/core/transform-selection';
import { bindPoint } from '../../src/core/warp-bind';
import { deformPoint } from '../../src/core/warp-evaluate';
import { defaultWarpDensity } from '../../src/core/warp-grid';
import { handleGuides, snapshotOf } from '../../src/core/warp-handles';
import { isPaintedNode, type WarpModel } from '../../src/core/warp-model';
import {
  createWarpState,
  solveWarp,
  warpSettleIterations,
  warpSettleTolerance,
} from '../../src/core/warp-solve';
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
const seams = vi.hoisted(() => ({ measured: 0 }));
vi.mock('../../src/core/warp-neighbour', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/warp-neighbour')>();
  return {
    ...actual,
    measureSeam: (...args: Parameters<typeof actual.measureSeam>) => {
      seams.measured++;
      return actual.measureSeam(...args);
    },
  };
});
vi.mock('../../src/core/warp-job', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/warp-job')>();
  return {
    ...actual,
    buildWarpModelJob: (...args: Parameters<typeof actual.buildWarpModelJob>) =>
      job.failure ? Promise.reject(job.failure) : actual.buildWarpModelJob(...args),
  };
});

function plate(id: string, x = 0, segments = 16): Part {
  const geometry = new PlaneGeometry(40, 40, segments, segments);
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
  const binding = bindPoint(model.region, model.binding, model.restWorld, face, barycentric);
  return {
    id,
    kind: 'point',
    samples: [{ face, barycentric, binding, restWorld, pin: restWorld }],
    pin: restWorld,
    target: null,
    radius: 0,
    falloff: 1,
    auto: false,
    baseline: snapshotOf(model.grid, createWarpState(model.restNodes)),
    reach: null,
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
  editor().setWarpBrushRadius(radius);
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
  deformPoint(
    session().model!,
    session().state!,
    point.samples[0].binding,
    point.samples[0].restWorld,
  );

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
    editor().setWarpBrushRadius(3);

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
    editor().setWarpOptions({ autoPoints: false });
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
    editor().setWarpOptions({ autoPoints: false });
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
    editor().setWarpOptions({ autoPoints: false });
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

  it('cancels when the scene is replaced', async () => {
    const scene = setup([plate('a')], ['a']);
    editor().setTool('warp');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    // The same parts and geometry, but a new scene epoch.
    editor().setScene({ ...scene });
    expect(editor().warp).toBeNull();
    expect(toast()).toBe('The part changed, so the warp was cancelled.');
  });

  it('cancels quietly when nothing was done in the session', () => {
    const scene = setup([plate('a')], ['a']);
    editor().setTool('warp');
    useEditor.setState({ toast: null });
    editor().setScene({ ...scene });
    expect(editor().warp).toBeNull();
    expect(toast()).toBeUndefined();
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
    editor().setWarpOptions({ autoPoints: false });
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
    editor().setWarpOptions({ autoPoints: false });
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
        undo: [
          {
            points: [inside, outside],
            gapTargets,
            surface: inside.baseline,
            pointRadius: null,
            pointFalloff: 1,
          },
        ],
      },
    });

    editor().setWarpRegion('painted');
    expect(session().stage).toBe('region');
    editor().setWarpBrushRadius(6);
    expect(
      editor().paintWarpRegion(hit('a', -10, 0), faceAt(a.geometry, -10, 0), false, true),
    ).toBe(true);
    editor().endPaintStroke();
    const faces = session().faces;
    expect(faces).toContain(inside.samples[0].face);
    expect(faces).not.toContain(outside.samples[0].face);
    useEditor.setState({ toast: null });
    await editor().layWarpGrid();

    let warp = session();
    const model = warp.model!;
    expect(model).not.toBe(whole);
    expect(Array.from(model.region.faces)).toEqual(faces);
    expect(toast()).toBe('Some control points were outside the new region and were removed.');
    expect(useActivity.getState().notifications.map((n) => n.message)).toContain(
      'Close gap again to close the seam at this density.',
    );
    expect(editor().paintHistory).toHaveLength(0);
    expect(warp.points.map((p) => p.id)).toEqual(['inside']);
    expect(warp.selectedPoints).toEqual(['inside']);
    expect(warp.gapTargets).toEqual([]);
    const [kept] = warp.points;
    expect(kept.samples[0].binding).toEqual(
      bindPoint(
        model.region,
        model.binding,
        model.restWorld,
        inside.samples[0].face,
        inside.samples[0].barycentric,
      ),
    );
    kept.samples[0].binding.node.forEach((n) => expect(n).toBeLessThan(model.grid.nodes.length));
    kept.samples[0].restWorld.forEach((v, i) =>
      expect(v).toBeCloseTo(inside.samples[0].restWorld[i], 5),
    );
    expect(kept.target).toEqual([-10, 1, 3]);
    expect(kept.pin).toEqual(inside.pin);
    expect(warp.undo).toHaveLength(1);
    expect(warp.undo[0]).toMatchObject({ points: [kept], gapTargets: [] });
    expect(warp.undo[0].surface!.grid).toBe(model.grid);
    expect(kept.baseline).toBe(warp.undo[0].surface);

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
    expect(warp.points[0].samples[0].binding).toEqual(
      bindPoint(
        warp.model!.region,
        warp.model!.binding,
        warp.model!.restWorld,
        inside.samples[0].face,
        inside.samples[0].barycentric,
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
    // Nothing painted is the whole part, which starts finer.
    expect(session()).toMatchObject({ stage: 'warp', density: warpWholeDensity });
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
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    const model = session().model!;

    job.failure = new Error('The warp worker stopped.');
    await editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'warp', density: warpWholeDensity });
    expect(session().model).toBe(model);
    expect(failures().map((task) => task.detail)).toEqual(['The warp worker stopped.']);
    expect(errors()).toEqual(['Preparing warp: The warp worker stopped.']);

    job.failure = null;
    await editor().setWarpDensity(1);
    expect(session()).toMatchObject({ stage: 'warp', density: 1 });
    expect(session().model).not.toBe(model);
    expect(failures()).toHaveLength(1);
  });

  it('keeps the feather of the grid it has when a re-lay fails, and of the grid it reuses', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    useEditor.setState({ warpFeather: { enabled: true, width: 3 } });
    await warpDisc(a, 0, 0, 8);
    expect(session()).toMatchObject({ feather: 3, laid: { feather: 3 } });
    const model = session().model!;

    editor().setWarpFeather({ width: 6 });
    editor().setWarpRegion('painted');
    job.failure = new Error('The warp worker stopped.');
    await editor().layWarpGrid();
    expect(session().model).toBe(model);
    expect(session().feather).toBe(3);

    // Back to the width it was laid with: the grid is reused, and a density change keeps it.
    job.failure = null;
    editor().setWarpFeather({ width: 3 });
    editor().setWarpRegion('painted');
    await editor().layWarpGrid();
    expect(session().model).toBe(model);
    expect(session().feather).toBe(3);
    editor().setWarpFeather({ width: 6 });
    await editor().setWarpDensity(2);
    expect(session().model!.feather).toMatchObject({ width: 3 });
    useEditor.setState({ warpFeather: { enabled: false, width: null } });
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
    expect(p.samples[0].face).toBe(faceAt(a.geometry, 1, 0.5));
    const corners = readFace(a.geometry, p.samples[0].face);
    const expected = corners.getBarycoord(new Vector3(1, 0.5, 0), new Vector3())!.toArray();
    p.samples[0].barycentric.forEach((w, i) => expect(w).toBeCloseTo(expected[i], 6));
    expect(p.samples[0].binding).toEqual(
      bindPoint(
        model!.region,
        model!.binding,
        model!.restWorld,
        p.samples[0].face,
        p.samples[0].barycentric,
      ),
    );
    expect(distance(p.samples[0].restWorld, [6, 0.5, 0])).toBeLessThan(1e-5);
    expect(distance(p.pin, p.samples[0].restWorld)).toBeLessThan(1e-6);
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
    q.samples[0].barycentric.forEach((w) => expect(w).toBeCloseTo(1 / 3, 5));
    const rest = readFace(a.geometry, face)
      .getMidpoint(new Vector3())
      .add(new Vector3(5, 0, 0));
    expect(distance(q.samples[0].restWorld, rest.toArray())).toBeLessThan(1e-5);
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
    editor().setWarpPointSettings({ radius: 0 }, 'end');
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
    editor().setWarpPointSettings({ radius: 0 }, 'end');
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

  it('a drag frame uploads only the region and leaves folds to the end', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    const p = addAt(a, 0, 0);
    const preview = session().preview!;
    const position = preview.getAttribute('position') as BufferAttribute;
    const normal = preview.getAttribute('normal') as BufferAttribute;
    const folds = session().folds;

    move(p.id, [0, 0, 2], 'drag');
    for (const attribute of [position, normal]) {
      const covered = attribute.updateRanges.reduce((sum, range) => sum + range.count, 0);
      expect(covered).toBeGreaterThan(0);
      expect(covered).toBeLessThan(attribute.array.length);
    }
    expect(session().folds).toBe(folds);
    const box = preview.boundingBox!,
      corner = new Vector3();
    for (let g = 0; g < position.count; g++)
      expect(box.containsPoint(corner.fromBufferAttribute(position, g))).toBe(true);
    expect(box.max.z).toBeGreaterThan(1.9);
    expect(preview.boundingSphere!.radius).toBeGreaterThan(0);

    move(p.id, [0, 0, 2]);
    expect(session().folds).not.toBe(folds);
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
        model: { ...model, region: { ...model.region, interiorCount: 50_001 } },
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
    editor().setWarpOptions({ autoPoints: false });
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

  it('tells once a session when snap or the seam pass over a part still being prepared', async () => {
    const message = 'Still preparing Dense scan. Try again when it finishes.';
    const notices = () =>
      useActivity.getState().notifications.filter((n) => n.message === message).length;
    const side = Math.ceil(Math.sqrt(workerIndexTriangles / 12)) + 1;
    const session = async (snap: boolean) => {
      const a = plate('a');
      const dense: Part = {
        ...solid('dense', new BoxGeometry(10, 10, 10, side, side, side), [0, 0, 7]),
        name: 'Dense scan',
        visible: false,
      };
      setup([a, dense], ['a']);
      await warpDisc(a, 0, 0, 8);
      const p = addAt(a, 0, 0);
      editor().setWarpOptions({ snap });
      // Shown now, its index is built by a worker that never finishes here.
      vi.stubGlobal('Worker', class {});
      try {
        editor().patchParts(['dense'], { visible: true });
        for (let z = 1; z <= 3; z++) move(p.id, [0, 0, z * 0.5], 'drag');
        move(p.id, [0, 0, 1.5]);
        move(p.id, [0, 0, 1]);
      } finally {
        vi.unstubAllGlobals();
      }
    };

    await session(true);
    expect(notices()).toBe(1);
    await session(false);
    expect(notices()).toBe(2);
  });

  it('close gap on a whole part leaves no gap to report', async () => {
    const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
    const wall = solid('wall', new BoxGeometry(20, 20, 20, 12, 12, 12), [21, 0, 0]);
    setup([block, wall], ['block']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    expect(session().seam!.largestGap).toBeCloseTo(1, 5);
    editor().closeWarpGap();
    expect(session().seam!.largestGap).toBeLessThanOrEqual(0);
  });

  it('schedules browser seam measurement for smaller regions, including after a rename or moved neighbour', async () => {
    const source = solid('a', new PlaneGeometry(10, 10, 220, 220), [0, 0, 0]);
    const neighbour = solid('b', new PlaneGeometry(20, 20).rotateY(Math.PI), [0, 0, 1]);
    setup([source, neighbour], ['a']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    editor().setWarpOptions({ autoPoints: false });
    vi.stubGlobal('window', {});
    try {
      await editor().layWarpGrid();
      expect(session().seam).toBeNull();
      editor().renameScene('Renamed');
      await vi.waitFor(() => expect(session().seam?.largestGap).toBeCloseTo(1));
      move(addAt(source, 0, 0).id, [0, 0, 0.1]);
      editor().transform('b', { position: [0, 0, 2] });
      await vi.waitFor(() => expect(session().seam?.largestGap).toBeCloseTo(2, 0));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('close gap again finds the same targets and keeps the seam closed', async () => {
    const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
    const wall = solid('wall', new BoxGeometry(20, 20, 20, 12, 12, 12), [21, 0, 0]);
    setup([block, wall], ['block']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    editor().addWarpPoint(
      { partId: 'block', point: [-10, 0.5, 0.5], normal: [-1, 0, 0] },
      faceAt(block.geometry, -10, 0.5, 0.5),
    );
    editor().closeWarpGap();
    const first = session().gapTargets;
    expect(first.length).toBeGreaterThan(0);
    const steps = session().undo.length;

    editor().closeWarpGap();
    expect(session().gapTargets).toEqual(first);
    editor().closeWarpGap();
    expect(session().gapTargets).toEqual(first);
    // Nothing changed, so nothing was recorded.
    expect(session().undo).toHaveLength(steps);

    editor().setWarpOptions({ overlap: 0.3 });
    editor().closeWarpGap();
    expect(session().gapTargets.map(({ node }) => node)).toEqual(first.map(({ node }) => node));
    expect(session().seam!.largestGap).toBeLessThanOrEqual(-0.25);
    editor().setWarpOptions({ overlap: 0.1 });
    editor().closeWarpGap();
    expect(session().gapTargets).toEqual(first);
    expect(session().seam!.largestGap).toBeLessThanOrEqual(0);
  });

  it('undoWarpEdit restores the previous points and surface', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 9);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
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
    editor().setWarpPointSettings({ radius: 0 }, 'end');
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
    editor().addWarpPoint(hit('a', free[0], free[1], free[2]), b.samples[0].face);
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

    // The session after Apply has nothing in it, so undoing the Apply ends it quietly.
    useEditor.setState({ toast: null });
    editor().undo();
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(editor().warp).toBeNull();
    expect(toast()).toBeUndefined();
    expect(editor().past).toHaveLength(past);
    editor().redo();
    expect(partOf('a').geometry).toBe(applied);
  });

  it('frees a mesh that leaves the history without freeing the index and color it shares', async () => {
    const a = plate('a');
    setup([a], ['a']);
    const { index } = a.geometry,
      color = a.geometry.getAttribute('color');
    /** What each disposal left on the geometry for the renderer to free. */
    const disposals = (geometry: BufferGeometry) => {
      const seen: { index: unknown; names: string[] }[] = [];
      geometry.addEventListener('dispose', () =>
        seen.push({ index: geometry.index, names: Object.keys(geometry.attributes).sort() }),
      );
      return seen;
    };
    const source = disposals(a.geometry);

    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    editor().applyWarp();
    const applied = partOf('a').geometry;
    expect(applied.index).toBe(index);
    expect(applied.getAttribute('color')).toBe(color);
    const first = disposals(applied);

    // Undo the Apply, then edit: the warped mesh leaves the history while the source shows.
    editor().undo();
    editor().patchParts(['a'], { name: 'Plate' });
    expect(first).toEqual([{ index: null, names: ['normal', 'position'] }]);
    expect(source).toEqual([]);
    // Whole again afterwards, for anything that still holds it.
    expect(applied.index).toBe(index);
    expect(applied.getAttribute('color')).toBe(color);

    // Apply again, then push the source out of the history while the warp shows.
    await warpDisc(partOf('a'), 0, 0, 8);
    move(addAt(partOf('a'), 0, 0).id, [0, 0, 2]);
    editor().applyWarp();
    const second = partOf('a').geometry;
    for (let i = 0; i < 40; i++) editor().patchParts(['a'], { name: `Plate ${i}` });
    expect(source).toEqual([{ index: null, names: ['normal', 'position', 'uv'] }]);
    expect(second.index).toBe(index);
    expect(second.getAttribute('color')).toBe(color);
    expect(a.geometry.index).toBe(index);
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
    const positions = positionsOf(a.geometry);
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
    expect(positionsOf(partOf(copy.id).geometry)).not.toEqual(positions);
    expect(partOf('a')).toBe(original);
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(positionsOf(a.geometry)).toEqual(positions);
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

  it('apply without a warp changes nothing', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    const { past, revision } = editor();
    expect(editor().applyWarp()).toBe(false);
    // An unmoved point holds the surface where it already is.
    addAt(a, 0, 0);
    expect(editor().applyWarp()).toBe(false);
    expect(partOf('a').geometry).toBe(a.geometry);
    expect(partOf('a').source).toBe('test');
    expect(editor().past).toBe(past);
    expect(editor().revision).toBe(revision);
    expect(session().stage).toBe('warp');
  });

  it('refreshes the seam only if the shared scene refuses the warp and it reopens', async () => {
    const a = plate('a');
    const lid = solid('lid', new BoxGeometry(10, 10, 10), [0, 0, 7]);
    setup([a, lid], ['a']);
    useEditor.setState({ liveStatus: 'disconnected' });
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 1]);
    const confirmed = editor().scene;
    const measured = seams.measured;
    expect(editor().applyWarp()).toBe(true);
    expect(seams.measured).toBe(measured);
    expect(editor().warpPending).not.toBeNull();
    editor().receiveScene(confirmed);
    editor().settleWarp(false);
    expect(seams.measured).toBe(measured + 1);
    expect(session().seam).not.toBeNull();
  });

  it('apply is refused while the part is locked', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    const past = editor().past.length;
    editor().patchParts(['a'], { locked: true }, false);
    expect(editor().warp).not.toBeNull();
    useEditor.setState({ toast: null });

    expect(editor().applyWarp()).toBe(false);
    expect(toast()).toBe('Unlock a to apply the warp.');
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
    expect(partOf('a').geometry).not.toBe(a.geometry);
    expect(pending.session).toMatchObject({ stage: 'warp', source: a.geometry });
    expect(pending.session.points.map((point) => point.target)).toEqual([[0, 0, 2]]);
    expect(session().source).toBe(partOf('a').geometry);

    // live.ts shows the server's scene again, then settles the warp.
    editor().receiveScene(confirmed);
    expect(editor().warp).toBeNull();
    useEditor.setState({ tool: 'select' });
    editor().settleWarp(false);
    expect(editor().warp).toMatchObject({ id: pending.session.id, points: pending.session.points });
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
    const messages = useActivity.getState().notifications.map((n) => n.message);
    expect(messages).not.toContain('The part changed, so the warp was cancelled.');
  });

  it('applies successive offline warps and reopens the first draft after a coalesced refusal', async () => {
    const a = plate('a');
    const b = plate('b', 100);
    const confirmed = setup([a, b], ['a']);
    useEditor.setState({ liveStatus: 'disconnected' });
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    expect(editor().applyWarp()).toBe(true);
    const first = editor().warpPending!;
    editor().setTool('select');
    editor().select('b');
    await warpDisc(b, 0, 0, 8);
    move(addAt(b, 0, 0).id, [100, 0, 2]);
    expect(editor().applyWarp()).toBe(true);
    expect(partOf('b').geometry).not.toBe(b.geometry);
    expect(editor().warpPending).toBe(first);

    editor().submitWarp();
    expect(editor().warpInFlight).toBe(first);
    editor().receiveScene(confirmed);
    editor().settleWarp(false);
    expect(session().id).toBe(first.session.id);
    expect(editor().warpPending).toBeNull();
    expect(editor().warpInFlight).toBeNull();
  });

  it('settles only the submitted warp when another warp has since been queued', async () => {
    const a = plate('a');
    const b = plate('b', 100);
    setup([a, b], ['a']);
    useEditor.setState({ liveStatus: 'connected' });
    await warpDisc(a, 0, 0, 8);
    move(addAt(a, 0, 0).id, [0, 0, 2]);
    expect(editor().applyWarp()).toBe(true);
    const first = editor().warpPending!;
    editor().submitWarp();

    editor().setTool('select');
    editor().select('b');
    await warpDisc(b, 0, 0, 8);
    move(addAt(b, 0, 0).id, [100, 0, 2]);
    expect(editor().applyWarp()).toBe(true);
    const second = editor().warpPending!;
    expect(editor().warpInFlight).toBe(first);
    expect(second.partId).toBe('b');
    editor().settleWarp(true, true);
    expect(editor().warpInFlight).toBeNull();
    expect(editor().warpPending).toBe(second);
  });

  it('lets go of a kept warp that can no longer reopen', async () => {
    const a = plate('a');
    /** Applies a warp in a live session, and returns the scene from before it. */
    const applyLive = async () => {
      setup([a], ['a']);
      useEditor.setState({ liveStatus: 'connected' });
      await warpDisc(a, 0, 0, 8);
      move(addAt(a, 0, 0).id, [0, 0, 2]);
      const confirmed = editor().scene;
      expect(editor().applyWarp()).toBe(true);
      const preview = editor().warpPending!.session.preview!;
      let released = false;
      preview.addEventListener('dispose', () => {
        released = preview.index === null;
      });
      return { confirmed, released: () => released };
    };
    const refuse = (scene: SceneDocument) => {
      editor().receiveScene(scene);
      useEditor.setState({ toast: null });
      editor().settleWarp(false);
      expect(editor().warp).toBeNull();
      expect(editor().warpPending).toBeNull();
      expect(toast()).toBeUndefined();
    };
    const patched = (scene: SceneDocument, patch: Partial<Part>) => ({
      ...scene,
      parts: scene.parts.map((part) => ({ ...part, ...patch })),
    });

    let kept = await applyLive();
    refuse(patched(kept.confirmed, { locked: true }));
    expect(kept.released()).toBe(true);
    kept = await applyLive();
    refuse(patched(kept.confirmed, { visible: false }));
    expect(kept.released()).toBe(true);
    kept = await applyLive();
    useXR.setState({ session: {} as XRSession });
    try {
      refuse(kept.confirmed);
    } finally {
      useXR.setState({ session: null });
    }
    expect(kept.released()).toBe(true);

    // Waiting ends with the live session or the scene.
    kept = await applyLive();
    useEditor.setState({ liveStatus: 'disconnected' });
    expect(editor().warpPending).not.toBeNull();
    expect(kept.released()).toBe(false);
    useEditor.setState({ liveStatus: null });
    expect(editor().warpPending).toBeNull();
    expect(kept.released()).toBe(true);
    kept = await applyLive();
    editor().setScene({ ...editor().scene });
    expect(editor().warpPending).toBeNull();
    expect(kept.released()).toBe(true);
  });
});

describe('warp commands', () => {
  it('Mod+Z undoes warp strokes and point edits before the scene', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().patchParts(['a'], { color: '#112233' });
    expect(editor().past).toHaveLength(1);
    editor().setTool('warp');
    editor().setWarpBrushRadius(3);
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    const first = session().faces;
    editor().paintWarpRegion(hit('a', 8, 0), faceAt(a.geometry, 8, 0), false, true);
    editor().endPaintStroke();
    expect(session().faces.length).toBeGreaterThan(first.length);

    executeEditorCommand('undo');
    expect(session().faces).toEqual(first);
    expect(editor().paintHistory).toHaveLength(1);
    expect(editor().tool).toBe('warp');
    expect(editor().past).toHaveLength(1);

    await editor().layWarpGrid();
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    expect(session().undo).toHaveLength(2);
    executeEditorCommand('undo');
    expect(session().points[0].target).toBeNull();
    executeEditorCommand('undo');
    expect(session().points).toEqual([]);
    expect(editor().tool).toBe('warp');
    expect(editor().past).toHaveLength(1);
    expect(editor().scene.parts[0].color).toBe('#112233');

    // The grid and region are still the session's work, so Undo stops short of the scene.
    expect(editorCommands().undo.enabled).toBe(false);
    executeEditorCommand('undo');
    expect(editor().past).toHaveLength(1);
    expect(editor().scene.parts[0].color).toBe('#112233');
    expect(session().stage).toBe('warp');

    // A session with nothing done in it, such as the one after Apply, lets Undo reach the scene.
    editor().cancelWarp();
    editor().setTool('warp');
    expect(editorCommands().undo.enabled).toBe(true);
    executeEditorCommand('undo');
    expect(editor().past).toHaveLength(0);
    expect(editor().scene.parts[0].color).toBe('#aabbcc');
    expect(editor().warp).toBeNull();
  });

  it('Mod+Z in the region and building stages stays in the session', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().patchParts(['a'], { color: '#112233' });
    editor().setTool('warp');
    editor().setWarpBrushRadius(3);
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    const painted = session().faces;
    await editor().layWarpGrid();
    const laid = session().model;
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);

    // Edit region keeps the points, and Undo steps back through them.
    editor().setWarpRegion('painted');
    expect(editorCommands().undo.enabled).toBe(true);
    executeEditorCommand('undo');
    expect(session()).toMatchObject({ stage: 'region' });
    expect(session().points[0].target).toBeNull();
    executeEditorCommand('undo');
    expect(session().points).toEqual([]);
    // The painted region is left, which scene undo would discard.
    expect(editorCommands().undo.enabled).toBe(false);
    executeEditorCommand('undo');
    expect(editor().tool).toBe('warp');
    expect(session().faces).toBe(painted);
    expect(editor().past).toHaveLength(1);
    expect(editor().scene.parts[0].color).toBe('#112233');

    // During a build, Undo takes back the last stroke and stops the build.
    editor().paintWarpRegion(hit('a', 8, 0), faceAt(a.geometry, 8, 0), false, true);
    editor().endPaintStroke();
    const pending = editor().layWarpGrid();
    expect(session().stage).toBe('building');
    expect(editorCommands().undo.enabled).toBe(true);
    executeEditorCommand('undo');
    await pending;
    expect(session().stage).toBe('region');
    expect(session().model).toBe(laid);
    expect(session().faces).toBe(painted);
    expect(editor().paintHistory).toEqual([]);
    expect(failures()).toEqual([]);

    // With no stroke left, a build in flight blocks scene undo too.
    editor().setWarpRegion('whole');
    const again = editor().layWarpGrid();
    expect(session().stage).toBe('building');
    expect(editorCommands().undo.enabled).toBe(false);
    executeEditorCommand('undo');
    await again;
    expect(session().stage).toBe('warp');
    expect(editor().past).toHaveLength(1);
  });

  it('scene Redo waits while a warp session has edits', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().patchParts(['a'], { color: '#112233' });
    editor().undo();
    editor().setTool('warp');
    expect(editorCommands().redo.enabled).toBe(true);
    editor().setWarpBrushRadius(3);
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    expect(editorCommands().redo.enabled).toBe(false);
    executeEditorCommand('redo');
    expect(editor().scene.parts[0].color).toBe('#aabbcc');
    expect(editor().future).toHaveLength(1);
    expect(editor().warp).not.toBeNull();

    executeEditorCommand('undo');
    expect(session().faces).toEqual([]);
    expect(editorCommands().redo.enabled).toBe(true);
    executeEditorCommand('redo');
    expect(editor().scene.parts[0].color).toBe('#112233');
    expect(editor().warp).toBeNull();
  });

  it('enables Undo for session edits without scene history', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    expect(editorCommands().undo.enabled).toBe(false);
    editor().setWarpBrushRadius(3);
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    expect(editorCommands().undo.enabled).toBe(true);
    await editor().layWarpGrid();
    expect(editorCommands().undo.enabled).toBe(false);
    addAt(a, 0, 0);
    expect(editorCommands().undo.enabled).toBe(true);
    // Back in the region stage, Undo still steps through the points.
    editor().setWarpRegion('painted');
    expect(editorCommands().undo.enabled).toBe(true);
  });

  it('transform tool choices set the warp gizmo only while warping', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    const warpId = session().id;
    chooseTransformTool('translate');
    expect(session()).toMatchObject({ id: warpId, stage: 'region', gizmo: 'translate' });
    editor().setWarpOptions({ autoPoints: false });
    const build = editor().layWarpGrid();
    chooseTransformTool('scale');
    expect(session()).toMatchObject({ id: warpId, stage: 'building', gizmo: 'scale' });
    await build;
    chooseTransformTool('rotate');
    expect(editor().tool).toBe('warp');
    expect(session().gizmo).toBe('rotate');
    executeEditorCommand('scale');
    expect(session().gizmo).toBe('scale');
    expect(activeTransformTool(editor())).toBe('scale');
    executeEditorCommand('transform');
    expect(activeTransformTool(editor())).toBe('transform');

    editor().cancelWarp();
    editor().setTool('select');
    chooseTransformTool('rotate');
    expect(editor().tool).toBe('rotate');
    expect(activeTransformTool(editor())).toBe('rotate');
  });
});

describe('warp panel', () => {
  it('steps selected points as one session undo step without scene history', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().patchParts(['a'], { color: '#112233' });
    const { scene, past, revision } = editor();
    await warpDisc(a, 0, 0, 9);
    const p = addAt(a, 0, 0);
    chooseTransformTool('translate');
    const undo = session().undo.length;
    stepSelection(2, 1);
    expect(session().undo).toHaveLength(undo + 1);
    expect(session().points[0].target).toEqual([0, 0, editor().view.snapStep]);
    expect(distance(deformed(session().points[0]), [0, 0, editor().view.snapStep])).toBeLessThan(
      0.01,
    );
    expect(editor().scene).toBe(scene);
    expect(editor().past).toBe(past);
    expect(editor().revision).toBe(revision);
    expect(editor().tool).toBe('warp');

    // Turning a single point about itself moves nothing, so it records nothing.
    chooseTransformTool('rotate');
    stepSelection(0, 1);
    expect(session().undo).toHaveLength(undo + 1);

    executeEditorCommand('undo');
    expect(session().points[0].id).toBe(p.id);
    expect(session().points[0].target).toBeNull();
    expect(editor().past).toBe(past);
  });

  it('a drag that ends where it began restores its points and records nothing', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 9);
    const p = addAt(a, 0, 0);
    const rest = Array.from(session().output!.positions);
    const begin = (): WarpBaseline => ({
      model: session().model!,
      points: session().points,
      selection: transformSelection(editor(), 'translate') as WarpBaseline['selection'],
    });
    const undo = session().undo.length;

    let baseline = begin();
    move(p.id, [0, 0, 2], 'drag');
    expect(session().points[0].target).toEqual([0, 0, 2]);
    finishWarpDrag(baseline, [{ id: p.id, target: [...p.pin] }]);
    expect(session().points).toEqual(baseline.points);
    expect(session().undo).toHaveLength(undo);
    const settled = session().output!.positions;
    expect(Math.max(...rest.map((value, i) => Math.abs(value - settled[i])))).toBeLessThan(0.01);
    // The next drag starts from these points, not from the abandoned one.
    baseline = begin();
    move(p.id, [0, 0, 1], 'drag');
    finishWarpDrag(baseline, [{ id: p.id, target: [0, 0, 1.5] }]);
    expect(session().undo).toHaveLength(undo + 1);
    expect(session().undo.at(-1)!.points).toBe(baseline.points);
    expect(distance(deformed(session().points[0]), [0, 0, 1.5])).toBeLessThan(0.01);

    // A press without motion reaches no session, so finishing it changes nothing.
    const current = session();
    finishWarpDrag(begin(), []);
    expect(session()).toBe(current);
  });

  it('tells which sessions Apply would change', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 9);
    expect(warpChanges(session())).toBe(false);
    const p = addAt(a, 0, 0);
    expect(warpChanges(session())).toBe(false);
    move(p.id, [0, 0, 1]);
    expect(warpChanges(session())).toBe(true);
    editor().undoWarpEdit();
    expect(warpChanges(session())).toBe(false);
    editor().removeWarpPoints([p.id]);
    useEditor.setState({ warp: { ...session(), gapTargets: [{ node: 0, target: [0, 0, 0] }] } });
    expect(warpChanges(session())).toBe(true);
  });

  it('asks for Close gap again when a rebuild drops its targets', async () => {
    const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
    const wall = solid('wall', new BoxGeometry(20, 20, 20, 12, 12, 12), [21, 0, 0]);
    setup([block, wall], ['block']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    await editor().setWarpDensity(2);
    expect(toast()).toBeUndefined();

    editor().closeWarpGap();
    expect(session().gapTargets.length).toBeGreaterThan(0);
    await editor().setWarpDensity(1);
    expect(session().gapTargets).toEqual([]);
    expect(toast()).toBe('Close gap again to close the seam at this density.');

    // Laying the same region at the same density keeps the grid and its gap targets.
    useEditor.setState({ toast: null });
    editor().closeWarpGap();
    const { model, gapTargets } = session();
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    expect(session().model).toBe(model);
    expect(session().gapTargets).toBe(gapTargets);
    expect(toast()).toBeUndefined();
  });
});

describe('warp handles', () => {
  /** The highest written vertex of the preview, world z on a plate at z = 0. */
  const peak = () => Math.max(...positionsOf(session().preview!).filter((_, i) => i % 3 === 2));
  const corner = (part: Part) => {
    const positions = session().output!.positions;
    const position = part.geometry.getAttribute('position');
    let best = 0;
    for (let i = 0; i < position.count; i++)
      if (position.getX(i) + position.getY(i) < position.getX(best) + position.getY(best)) best = i;
    return positions[best * 3 + 2];
  };

  it('pins the whole part with evenly spread points on its first grid, so a drag bends it', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    expect(session()).toMatchObject({ autoPoints: true, distributeCount: 8, firstLay: true });
    // Painted with nothing painted is the whole part too.
    await editor().layWarpGrid();
    const auto = session().points;
    expect(auto).toHaveLength(8);
    for (const point of auto) {
      expect(point).toMatchObject({ kind: 'point', auto: true, target: null, radius: 0 });
      expect(point.samples[0].binding.node).toHaveLength(1);
    }
    expect(new Set(auto.map((point) => point.samples[0].binding.node[0])).size).toBe(8);
    expect(session().selectedPoints).toEqual([]);
    expect(session().undo).toEqual([]);
    expect(warpChanges(session())).toBe(false);

    editor().setWarpPointSettings({ radius: 0 }, 'end');
    const p = addAt(a, 1, 1);
    move(p.id, [1, 1, 3]);
    expect(distance(deformed(session().points.at(-1)!), [1, 1, 3])).toBeLessThan(0.01);
    for (const pin of auto) expect(distance(deformed(pin), pin.pin)).toBeLessThan(0.01);
    // It bends between the pins instead of rising as a whole.
    expect(Math.abs(corner(a))).toBeLessThan(1.5);

    // A density change, a trip to Edit region or deleting them never places them again.
    await editor().setWarpDensity(2);
    expect(session().points.filter((point) => point.auto)).toHaveLength(8);
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    expect(session().points).toHaveLength(9);
    editor().removeWarpPoints(auto.map((point) => point.id));
    await editor().setWarpDensity(3);
    expect(session().points.map((point) => point.id)).toEqual([p.id]);

    // Without them, the same drag lifts the whole plate.
    editor().cancelWarp();
    editor().setTool('warp');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    expect(session().points).toEqual([]);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    move(addAt(a, 1, 1).id, [1, 1, 3]);
    expect(corner(a)).toBeGreaterThan(2.5);
  });

  it('places no points automatically over a painted region', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 8);
    expect(session().points).toEqual([]);
    expect(session().firstLay).toBe(false);
  });

  it('distributes unmoved points as one undo step, marked automatic until moved or edited', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 12);
    const p = addAt(a, 0, 0);
    editor().setWarpOptions({ distributeCount: 4 });
    editor().distributeWarpPoints();
    const [, ...added] = session().points;
    expect(added).toHaveLength(4);
    expect(session().selectedPoints).toEqual([p.id]);
    expect(
      session()
        .undo.at(-1)!
        .points.map((point) => point.id),
    ).toEqual([p.id]);
    const nodes = added.map((point) => point.samples[0].binding.node[0]);
    for (const point of added) {
      expect(point).toMatchObject({ auto: true, target: null, radius: 0 });
      expect(distance(deformed(point), point.pin)).toBeLessThan(1e-9);
    }
    // Never on the same node, and away from the point already there.
    editor().distributeWarpPoints();
    const more = session()
      .points.slice(5)
      .map((point) => point.samples[0].binding.node[0]);
    expect(new Set([...nodes, ...more]).size).toBe(8);
    editor().undoWarpEdit();
    expect(session().points).toHaveLength(5);

    move(added[0].id, [...added[0].pin.slice(0, 2), 1] as Vec3);
    expect(session().points[1].auto).toBe(false);
    editor().selectWarpPoints([added[1].id]);
    editor().setWarpPointSettings({ falloff: 0.5 }, 'end');
    expect(session().points[2]).toMatchObject({ auto: false, falloff: 0.5 });
    expect(session().points[3].auto).toBe(true);
  });

  it('close gap releases the automatic points that hold its seam open, on its surface only', async () => {
    const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
    const wall = solid('wall', new BoxGeometry(20, 20, 20, 12, 12, 12), [21, 0, 0]);
    setup([block, wall], ['block']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    const auto = session().points;
    expect(auto).toHaveLength(8);
    editor().addWarpPoint(
      { partId: 'block', point: [-10, 0.5, 0.5], normal: [-1, 0, 0] },
      faceAt(block.geometry, -10, 0.5, 0.5),
    );
    const placed = session().points.at(-1)!;
    const steps = session().undo.length;

    editor().closeWarpGap();
    const { points } = session();
    const released = auto.filter((point) => !points.some(({ id }) => id === point.id));
    expect(released.length).toBeGreaterThan(0);
    // None on the face turned away from the neighbour.
    for (const point of auto)
      if (point.pin[0] < -9.9) expect(points.some(({ id }) => id === point.id)).toBe(true);
    expect(points.map(({ id }) => id)).toContain(placed.id);
    expect(distance(deformed(points.at(-1)!), placed.pin)).toBeLessThan(0.01);
    expect(session().undo).toHaveLength(steps + 1);
    expect(session().seam!.largestGap).toBeLessThan(0.05);

    editor().undoWarpEdit();
    expect(session().points.map(({ id }) => id)).toEqual([...auto.map(({ id }) => id), placed.id]);
    expect(session().gapTargets).toEqual([]);

    // A point the user moved stays, even on the seam.
    const touched = released[0];
    move(touched.id, touched.pin);
    expect(session().points.find(({ id }) => id === touched.id)!.auto).toBe(false);
    editor().closeWarpGap();
    expect(session().points.map(({ id }) => id)).toContain(touched.id);
  });

  it('close gap closes the box seam whatever the number of automatic points', async () => {
    for (const count of [8, 16, 32]) {
      const block = solid('block', new BoxGeometry(20, 20, 20, 12, 12, 12), [0, 0, 0]);
      const wall = solid('wall', new BoxGeometry(20, 20, 20, 12, 12, 12), [21, 0, 0]);
      setup([block, wall], ['block']);
      editor().setTool('warp');
      editor().setWarpRegion('whole');
      editor().setWarpOptions({ distributeCount: count });
      await editor().layWarpGrid();
      const auto = session().points;
      expect(auto).toHaveLength(count);
      editor().closeWarpGap();
      finishWarpSettling();
      expect(session().points.length).toBeLessThan(count);
      // Points away from the +X face stay.
      for (const point of auto)
        if (point.pin[0] < -9.9)
          expect(session().points.some(({ id }) => id === point.id)).toBe(true);
      expect(session().seam!.largestGap).toBeLessThan(0.05);

      editor().cancelWarp();
    }
  });

  it('close gap keeps an automatic point that has ridden with a bump when the seam barely moves it', async () => {
    const a = plate('a', 0, 64);
    // 1 mm over the plate's +X side only.
    const wall = solid('wall', new BoxGeometry(14, 30, 4), [13, 0, 3]);
    setup([a, wall], ['a']);
    editor().setTool('warp');
    await editor().layWarpGrid();
    const rider = session().points.find(
      (point) => Math.hypot(point.pin[0] + 2.5, point.pin[1] - 3.75) < 0.1,
    )!;
    expect(rider.auto).toBe(true);
    const lift = addAt(a, -1.3, 3.6);
    move(lift.id, [-1.3, 3.6, 5]);
    finishWarpSettling();
    const now = deformed(session().points.find(({ id }) => id === rider.id)!);
    expect(now[2] - rider.pin[2]).toBeGreaterThan(2);
    editor().closeWarpGap();
    finishWarpSettling();
    expect(session().gapTargets.length).toBeGreaterThan(0);
    expect(session().points.some(({ id }) => id === rider.id)).toBe(true);
    expect(
      distance(deformed(session().points.find(({ id }) => id === rider.id)!), now),
    ).toBeLessThan(0.05);
    for (const { node, target } of session().gapTargets)
      expect(
        distance(session().state!.positions.subarray(node * 3, node * 3 + 3), target),
      ).toBeLessThan(0.01);
  });

  it('close gap leaves the automatic points on a sheet it does not pull', async () => {
    // Two sheets 2 mm apart in one part, back to back, the front one 1 mm under a wall.
    const sheets = mergeGeometries([
      new PlaneGeometry(20, 20, 16, 16),
      new PlaneGeometry(20, 20, 16, 16).rotateX(Math.PI).translate(0, 0, -2),
    ])!;
    const part = solid('sheets', sheets, [0, 0, 0]);
    const wall = solid('wall', new BoxGeometry(30, 30, 4), [0, 0, 3]);
    setup([part, wall], ['sheets']);
    editor().setTool('warp');
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    const auto = session().points;
    const back = auto.filter((point) => point.pin[2] < -1);
    expect(back.length).toBeGreaterThan(0);
    expect(back.length).toBeLessThan(auto.length);
    editor().closeWarpGap();
    const { gapTargets, points, model } = session();
    expect(gapTargets.length).toBeGreaterThan(0);
    for (const { node } of gapTargets) expect(model!.restNodes[node * 3 + 2]).toBeGreaterThan(-1);
    for (const point of back) expect(points.some(({ id }) => id === point.id)).toBe(true);
    expect(points.length).toBeLessThan(auto.length);
  });

  it('new points take the last radius and falloff, by default reaching a few node spacings', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 12);
    const first = addAt(a, 0, 0);
    const spacing = first.reach!.spacing;
    // Wider than 6 % of the 40 mm plate where its 2.5 mm cells need it, within a quarter of the region.
    expect(first.radius).toBeGreaterThan(2.4);
    expect(first.radius).toBeCloseTo(Math.min(warpRadiusSpacings * spacing, 6), 0);
    expect(first.falloff).toBe(1);
    expect(handleGuides(first)).toBe(true);
    editor().selectWarpPoints([]);
    editor().setWarpPointSettings({ radius: 1.5, falloff: 0.4 }, 'end');
    expect(session().undo).toHaveLength(1);
    expect(addAt(a, 4, 0)).toMatchObject({ radius: 1.5, falloff: 0.4 });
    // A radius the user chose is used as given, and 0 stays a bare point.
    editor().selectWarpPoints([]);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    expect(handleGuides(addAt(a, -4, 0))).toBe(false);

    // A small region caps the default at a quarter of its extent.
    editor().cancelWarp();
    await warpDisc(a, 0, 0, 3);
    expect(session().pointRadius).toBeNull();
    const nodes = session().model!.restNodes;
    let extent = 0;
    for (let i = 0; i < nodes.length; i += 3) extent = Math.max(extent, Math.abs(nodes[i]) * 2);
    expect(addAt(a, 0, 0).radius).toBeLessThanOrEqual(Number((extent / 4).toPrecision(2)));
  });

  it('a whole part starts on a finer grid than a painted region, unless the user chose one', async () => {
    const a = plate('a');
    setup([a], ['a']);
    editor().setTool('warp');
    editor().setWarpOptions({ autoPoints: false });
    await editor().layWarpGrid();
    expect(session().density).toBe(warpWholeDensity);
    editor().setWarpRegion('painted');
    editor().setWarpBrushRadius(6);
    editor().paintWarpRegion(hit('a', 0, 0), faceAt(a.geometry, 0, 0), false, true);
    editor().endPaintStroke();
    await editor().layWarpGrid();
    expect(session().density).toBe(defaultWarpDensity);
    await editor().setWarpDensity(4);
    editor().setWarpRegion('whole');
    await editor().layWarpGrid();
    expect(session().density).toBe(4);
  });

  it('a radius or falloff gesture changes only reach and weights and records one step', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 14);
    editor().setWarpPointSettings({ radius: 4 }, 'end');
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    const steps = session().undo.length;
    const { reach, baseline } = session().points[0];

    for (const falloff of [0.8, 0.6, 0.5]) editor().setWarpPointSettings({ falloff }, 'drag');
    expect(isWarpDragging()).toBe(true);
    // Falloff reuses the reach; the guides keep their baseline.
    expect(session().points[0].reach).toBe(reach);
    expect(session().points[0].baseline).toBe(baseline);
    expect(session().undo).toHaveLength(steps);
    editor().setWarpPointSettings({ falloff: 0.5 }, 'end');
    expect(isWarpDragging()).toBe(false);
    expect(session().undo).toHaveLength(steps + 1);
    expect(session().points[0]).toMatchObject({ falloff: 0.5, radius: 4 });
    expect(session().pointFalloff).toBe(0.5);
    expect(distance(deformed(session().points[0]), [0, 0, 2])).toBeLessThan(0.02);

    for (const radius of [5, 6, 8]) editor().setWarpPointSettings({ radius }, 'drag');
    editor().setWarpPointSettings({ radius: 8 }, 'end');
    expect(session().undo).toHaveLength(steps + 2);
    expect(session().points[0].baseline).toBe(baseline);
    // The new radius reshapes the same bump from the same baseline: no stacking.
    expect(peak()).toBeLessThan(2.25);
    expect(distance(deformed(session().points[0]), [0, 0, 2])).toBeLessThan(0.02);
    // Wider reach lifts a spot 5 mm out.
    const source = a.geometry.getAttribute('position');
    let vertex = -1;
    for (let i = 0; i < source.count && vertex < 0; i++)
      if (Math.abs(source.getX(i) - 5) < 1e-6 && Math.abs(source.getY(i)) < 1e-6) vertex = i;
    expect(session().output!.positions[vertex * 3 + 2]).toBeGreaterThan(0.3);

    // The same settings again record nothing.
    editor().setWarpPointSettings({ radius: 8 }, 'end');
    expect(session().undo).toHaveLength(steps + 2);
  });

  it('a point of any radius added on a bent surface changes nothing', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 14);
    editor().setWarpPointSettings({ radius: 6 }, 'end');
    const p = addAt(a, 0, 0);
    move(p.id, [0, 0, 2]);
    const before = positionsOf(session().preview!);
    // Settling again with nothing added.
    move(p.id, [0, 0, 2.000001]);
    const resettle = Math.max(
      ...positionsOf(session().preview!).map((value, i) => Math.abs(value - before[i])),
    );
    for (const radius of [0, 2, 6, 12]) {
      editor().selectWarpPoints([]);
      editor().setWarpPointSettings({ radius }, 'end');
      const q = addAt(a, 3, 0.5);
      expect(q.pin[2]).toBeGreaterThan(0.3);
      move(p.id, [0, 0, 2]);
      const after = positionsOf(session().preview!);
      expect(Math.max(...before.map((value, i) => Math.abs(value - after[i])))).toBeLessThanOrEqual(
        Math.max(resettle, 1e-3),
      );
      editor().undoWarpEdit();
      editor().undoWarpEdit();
    }
  });

  it('a point added over two overlapping handles and the automatic pins changes nothing', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    editor().setTool('warp');
    await editor().layWarpGrid();
    expect(session().points).toHaveLength(8);
    editor().setWarpPointSettings({ radius: 5 }, 'end');
    const p = addAt(a, -1.5, 0.1);
    const q = addAt(a, 1.5, -0.1);
    move(p.id, [-1.5, 0.1, 2]);
    move(q.id, [1.5, -0.1, -1]);
    const before = positionsOf(session().preview!);
    for (const radius of [0, 2, 5, 12]) {
      editor().selectWarpPoints([]);
      editor().setWarpPointSettings({ radius }, 'end');
      addAt(a, 0.2, 0.3);
      move(p.id, [-1.5, 0.1, 2.0000001]);
      const after = positionsOf(session().preview!);
      expect(Math.max(...before.map((value, i) => Math.abs(value - after[i])))).toBeLessThan(1e-3);
      editor().undoWarpEdit();
      editor().undoWarpEdit();
    }
  });

  it('undo restores each step exactly, with the settings new points take', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 14);
    const surfaces = [positionsOf(session().preview!)];
    const settings = [session().pointRadius];
    const record = () => {
      surfaces.push(positionsOf(session().preview!));
      settings.push(session().pointRadius);
    };
    editor().setWarpPointSettings({ radius: 5 }, 'end');
    const p = addAt(a, -2, 0);
    record();
    move(p.id, [-2, 0, 2]);
    record();
    const q = addAt(a, 2.5, 0.5);
    record();
    move(q.id, [2.5, 0.5, -1.5]);
    record();
    editor().setWarpPointSettings({ radius: 7, falloff: 0.5 }, 'end');
    record();
    for (let step = surfaces.length - 2; step >= 0; step--) {
      editor().undoWarpEdit();
      expect(positionsOf(session().preview!)).toEqual(surfaces[step]);
      if (step > 0) expect(session().pointRadius).toBe(settings[step]);
    }
    // Undoing the radius change leaves the next new point at the old radius.
    expect(session().pointRadius).toBe(5);
  });

  it('laying the same region at the same density keeps the grid and moves nothing', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 14);
    editor().setWarpPointSettings({ radius: 5 }, 'end');
    move(addAt(a, -2, 0).id, [-2, 0, 2]);
    move(addAt(a, 2, 0).id, [2, 0, -1]);
    const { model, state, undo, points } = session();
    const surface = positionsOf(session().preview!);
    const tasks = warpTasks().length;
    editor().setWarpRegion('painted');
    await editor().layWarpGrid();
    expect(session().model).toBe(model);
    expect(session().state).toBe(state);
    expect(session().points).toBe(points);
    expect(session().undo).toBe(undo);
    expect(positionsOf(session().preview!)).toEqual(surface);
    expect(warpTasks()).toHaveLength(tasks);
  });

  it('undo after a density change comes back close to each step', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 14);
    editor().setWarpPointSettings({ radius: 6 }, 'end');
    const p = addAt(a, -2, 0);
    move(p.id, [-2, 0, 2]);
    const q = addAt(a, 2.5, 0.5);
    move(q.id, [2.5, 0.5, -1]);
    const surfaces: number[][] = [];
    surfaces.push(positionsOf(session().preview!));
    editor().selectWarpPoints([p.id]);
    editor().setWarpPointSettings({ radius: 8 }, 'end');
    surfaces.push(positionsOf(session().preview!));
    editor().setWarpPointSettings({ falloff: 0.6 }, 'end');
    surfaces.push(positionsOf(session().preview!));
    // Through the overlap.
    move(p.id, [0, 0, 2.5]);
    const last = positionsOf(session().preview!);
    const worst = (a: number[], b: number[]) =>
      Math.max(...a.map((value, i) => Math.abs(value - b[i])));

    await editor().setWarpDensity(4);
    const errors = [worst(positionsOf(session().preview!), last)];
    for (let step = surfaces.length - 1; step >= 0; step--) {
      editor().undoWarpEdit();
      errors.push(worst(positionsOf(session().preview!), surfaces[step]));
    }
    // Each step comes back as closely as the new grid holds the current surface itself.
    for (const error of errors) expect(error).toBeLessThan(errors[0] * 1.05 + 0.02);
    expect(errors[0]).toBeLessThan(0.6);
  });

  it('a rebuild drops points that could only sit on fixed nodes, from undo steps too', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 12);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    const kept = addAt(a, 0.4, 0.3);
    const lost = addAt(a, 5.4, 0.3);
    move(lost.id, [5.4, 0.3, 1]);
    // A region whose every vertex is on its border except around the kept point.
    const row = Array.from({ length: triangleCount(a.geometry) }, (_, f) => f).filter((f) => {
      const centre = readFace(a.geometry, f).getMidpoint(new Vector3());
      return (
        (Math.abs(centre.y - 0.8) < 1.3 && Math.abs(centre.x - 5) < 1.5) || centre.length() < 3
      );
    });
    useEditor.setState({ toast: null, warp: { ...session(), region: 'painted', faces: row } });
    await editor().layWarpGrid();
    expect(session().points.map((point) => point.id)).toEqual([kept.id]);
    for (const step of session().undo)
      expect(step.points.map((point) => point.id)).not.toContain(lost.id);
    expect(toast()).toBe('Some control points were outside the new region and were removed.');
    expect(warpChanges(session())).toBe(false);
  });

  it('points without a radius solve bit for bit as they did before handles', async () => {
    const a = plate('a');
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 12);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    const p = addAt(a, 0.4, 0.3);
    const q = addAt(a, -5, 1);
    move(p.id, [0.4, 0.3, 2]);
    const { model } = session();
    const state = createWarpState(model!.restNodes);
    const constraints = [p, q].map((point, i) => ({
      ...point.samples[0].binding,
      rest: point.samples[0].restWorld,
      target: i === 0 ? ([0.4, 0.3, 2] as Vec3) : point.pin,
    }));
    for (let i = 0; i < warpSettleIterations; i++)
      if (solveWarp(model!.grid, model!.restNodes, constraints, state, 1) < warpSettleTolerance)
        break;
    expect(Array.from(session().state!.positions)).toEqual(Array.from(state.positions));
    expect(Array.from(session().state!.rotations)).toEqual(Array.from(state.rotations));
  });

  it('on a feathered region, reach and distribution stay on the paint', async () => {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    useEditor.setState({ warpFeather: { enabled: true, width: 4 } });
    await warpDisc(a, 0, 0, 8);
    const model = session().model!;
    expect(model.blend).not.toBeNull();
    editor().setWarpPointSettings({ radius: 6 }, 'end');
    const p = addAt(a, 2, 0);
    for (const n of p.reach!.node) {
      expect(isPaintedNode(model, n)).toBe(true);
      expect(model.grid.fixed[n]).toBe(0);
    }
    editor().setWarpOptions({ distributeCount: 8 });
    editor().distributeWarpPoints();
    for (const point of session().points.slice(1))
      for (const n of point.samples[0].binding.node) expect(isPaintedNode(model, n)).toBe(true);
    useEditor.setState({ warpFeather: { enabled: false, width: null } });
  });
});

describe('warp handles that must land', () => {
  /** Lays a whole 40 mm plate with its automatic points and lifts a handle beside one of them. */
  async function ridden() {
    const a = plate('a', 0, 64);
    setup([a], ['a']);
    editor().setTool('warp');
    await editor().layWarpGrid();
    const rider = session().points.find(
      (point) => Math.hypot(point.pin[0] + 2.5, point.pin[1] - 3.75) < 0.1,
    )!;
    const lift = addAt(a, -1.3, 3.6);
    move(lift.id, [-1.3, 3.6, 5]);
    finishWarpSettling();
    return { a, rider: current(rider.id), lift: current(lift.id) };
  }
  const current = (id: string) => session().points.find((point) => point.id === id)!;
  const surfaceChange = (a: number[], b: number[]) =>
    Math.max(...a.map((value, i) => Math.abs(value - b[i])));
  /** Where the written mesh puts a point's sample, from its face's written corners. */
  const writtenSample = (point: WarpPoint) => {
    const { face, barycentric } = point.samples[0];
    const { positions } = session().output!;
    const index = partOf(session().partId).geometry.index;
    const at: Vec3 = [0, 0, 0];
    for (let c = 0; c < 3; c++) {
      const v = index ? index.getX(face * 3 + c) : face * 3 + c;
      for (let a = 0; a < 3; a++) at[a] += barycentric[c] * positions[v * 3 + a];
    }
    return at;
  };

  it('takes over an automatic point that has ridden with a bump where it is', async () => {
    const { rider } = await ridden();
    expect(rider.auto).toBe(true);
    const at = deformed(rider);
    expect(at[2]).toBeGreaterThan(2);
    // Its gizmo starts where it is drawn.
    editor().selectWarpPoints([rider.id]);
    const selection = transformSelection(editor(), 'translate');
    expect(selection.kind === 'warp' && selection.parts[0].position).toEqual(at);
    const before = positionsOf(session().preview!);
    const steps = session().undo.length;

    // Given a radius without moving it, nothing moves.
    editor().setWarpPointSettings({ radius: 8 }, 'end');
    finishWarpSettling();
    expect(current(rider.id)).toMatchObject({ auto: false, radius: 8, pin: at });
    expect(distance(deformed(current(rider.id)), at)).toBeLessThan(1e-3);
    expect(surfaceChange(positionsOf(session().preview!), before)).toBeLessThan(1e-3);
    expect(session().undo).toHaveLength(steps + 1);
    editor().undoWarpEdit();
    expect(current(rider.id)).toEqual(rider);
    expect(positionsOf(session().preview!)).toEqual(before);

    // Moved 0.1 mm, its surface moves 0.1 mm.
    move(rider.id, [at[0], at[1], at[2] + 0.1]);
    finishWarpSettling();
    expect(distance(deformed(current(rider.id)), [at[0], at[1], at[2] + 0.1])).toBeLessThan(0.002);
    editor().undoWarpEdit();
    expect(current(rider.id)).toEqual(rider);
    expect(positionsOf(session().preview!)).toEqual(before);
  });

  it('a snapped point lands on its target on a coarse grid, releasing the automatic pins under it', async () => {
    for (const density of [0, defaultWarpDensity]) {
      const a = plate('a', 0, 32);
      // A neighbour face at z = 2, so snapping puts the target at 2.1.
      const lid = solid('lid', new BoxGeometry(30, 30, 10), [0, 0, 7]);
      setup([a, lid], ['a']);
      editor().setTool('warp');
      editor().setWarpRegion('whole');
      await editor().setWarpDensity(density);
      await editor().layWarpGrid();
      const auto = session().points.map(({ id }) => id);
      const p = addAt(a, 0.37, 0.21);
      editor().setWarpOptions({ snap: true });
      move(p.id, [0.37, 0.21, 1.5]);
      finishWarpSettling();
      const target = current(p.id).target!;
      expect(target[2]).toBeCloseTo(2.1, 6);
      const tolerance = density === 0 ? 0.03 : 0.01;
      expect(distance(deformed(current(p.id)), target)).toBeLessThan(tolerance);
      // The triangles written there reach it too.
      expect(Math.abs(writtenSample(current(p.id))[2] - 2.1)).toBeLessThan(tolerance);
      expect(warpShortfall(session())).toBeLessThan(warpShortfallShown);
      const released = auto.filter((id) => !session().points.some((point) => point.id === id));
      if (density === 0) expect(released.length).toBeGreaterThan(0);
      for (const id of released) {
        const pin = session()
          .undo.at(-1)!
          .points.find((point) => point.id === id)!;
        expect(
          pin.samples[0].binding.node.some((n) =>
            current(p.id).samples[0].binding.node.includes(n),
          ),
        ).toBe(true);
      }
      // Released in the same step as the move.
      editor().undoWarpEdit();
      expect(session().points.map(({ id }) => id)).toEqual([...auto, p.id]);
      editor().cancelWarp();
    }
  });

  it('says how far a point stops short when a pin on its spot holds it', async () => {
    const a = plate('a', 0, 32);
    setup([a], ['a']);
    await warpDisc(a, 0, 0, 12);
    editor().setWarpPointSettings({ radius: 0 }, 'end');
    const pin = addAt(a, 0.5, 0.3);
    const p = addAt(a, 0.53, 0.31);
    move(p.id, [0.53, 0.31, 2]);
    finishWarpSettling();
    editor().selectWarpPoints([p.id]);
    const short = distance(deformed(current(p.id)), [0.53, 0.31, 2]);
    expect(short).toBeGreaterThan(warpShortfallShown);
    expect(warpShortfall(session())).toBeCloseTo(short, 9);
    // It is the pin's own spot that holds it, not the grid.
    editor().removeWarpPoints([pin.id]);
    finishWarpSettling();
    editor().selectWarpPoints([p.id]);
    expect(warpShortfall(session())).toBeLessThan(0.01);
  });

  it('Apply bakes exactly the surface shown, also while it is still settling', async () => {
    for (const radius of [0, null]) {
      const a = plate('a', 0, 64);
      setup([a], ['a']);
      editor().setTool('warp');
      await editor().layWarpGrid();
      if (radius !== null) editor().setWarpPointSettings({ radius }, 'end');
      const p = addAt(a, 0.3, 0.2);
      move(p.id, [0.3, 0.2, 3]);
      expect(session().settling).toBe(true);
      const shown = positionsOf(session().preview!);
      expect(editor().applyWarp()).toBe(true);
      expect(positionsOf(partOf('a').geometry)).toEqual(shown);
      editor().cancelWarp();
    }
  });

  it('settles a grid until it has converged, so an edit settles only what it changed', async () => {
    const { lift } = await ridden();
    expect(session().settling).toBe(false);
    expect(session().surface).toMatchObject({ settled: true, converged: true });
    editor().selectWarpPoints([lift.id]);
    // Typed in, its own radius only becomes the one new points take.
    editor().setWarpPointSettings({ radius: lift.radius }, 'end');
    const checkpoint = positionsOf(session().preview!);
    const steps = session().undo.length;
    // The same value again does nothing.
    editor().setWarpPointSettings({ radius: lift.radius }, 'end');
    move(lift.id, lift.target!);
    expect(positionsOf(session().preview!)).toEqual(checkpoint);
    expect(session().undo).toHaveLength(steps);

    const edit = (radius: number) => {
      editor().setWarpPointSettings({ radius }, 'end');
      finishWarpSettling();
      return positionsOf(session().preview!);
    };
    edit(lift.radius + 0.01);
    const twice = edit(lift.radius + 0.02);
    editor().undoWarpEdit();
    editor().undoWarpEdit();
    expect(positionsOf(session().preview!)).toEqual(checkpoint);
    const once = edit(lift.radius + 0.02);
    expect(surfaceChange(twice, once)).toBeLessThan(1e-3);
    expect(surfaceChange(once, checkpoint)).toBeLessThan(0.05);
  });
});
