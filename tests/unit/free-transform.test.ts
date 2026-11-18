import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferGeometry,
  Euler,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Triangle,
  Vector3,
} from 'three';
import { FreeTransformMotion } from '../../src/core/free-transform';
import { partPivot, quat, triangleCount, vec } from '../../src/core/geometry';
import { committedScene, useEditor, type WarpPoint } from '../../src/core/store';
import { readFace } from '../../src/core/surfaces';
import { transformSelection } from '../../src/core/transform-selection';
import { deformPoint } from '../../src/core/warp-evaluate';
import type { Part } from '../../src/core/types';

const original = useEditor.getState();
const state = () => useEditor.getState();
const part = (id = 'a', patch: Partial<Part> = {}): Part => ({
  id,
  name: id,
  geometry: new BoxGeometry(4, 6, 8),
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  locked: false,
  visible: true,
  source: 'test',
  ...patch,
});
const camera = () => {
  const c = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
  c.position.set(0, 0, 100);
  c.lookAt(0, 0, 0);
  c.updateMatrixWorld();
  return c;
};
const preview = (x: number) =>
  state().previewFreeTransform([{ id: 'a', patch: { position: [x, 0, 0] } }]);

beforeEach(() => {
  useEditor.setState(original, true);
  state().setScene({ name: 'Placement', parts: [part()], joints: [] });
  state().select('a');
  state().setView({ clip: { enabled: false, overlap: 0.1 } });
});
afterEach(() => useEditor.setState(original, true));

describe('pointer placement math', () => {
  it('maps pixels to the view plane in orthographic and perspective cameras', () => {
    const p = part();
    const motion = new FreeTransformMotion(camera(), new Vector3(), 1000, 1000);
    motion.move(100, 50, false);
    const patch = motion.patches([p], new Vector3(), new Quaternion(), 'translate', null, null)[0]
      .patch;
    expect(vec(patch.position!).distanceTo(new Vector3(10, -5, 0))).toBeLessThan(1e-8);
    const perspective = new PerspectiveCamera(90, 1, 0.1, 1000);
    perspective.position.set(0, 0, 100);
    perspective.lookAt(0, 0, 0);
    const other = new FreeTransformMotion(perspective, new Vector3(), 1000, 1000);
    other.move(100, 50, false);
    expect(
      vec(
        other.patches([p], new Vector3(), new Quaternion(), 'translate', null, null)[0].patch
          .position!,
      ).distanceTo(new Vector3(20, -10, 0)),
    ).toBeLessThan(1e-8);
  });

  it('changes precision continuously and snaps relative movement to the chosen frame', () => {
    const motion = new FreeTransformMotion(camera(), new Vector3(), 1000, 1000);
    motion.move(10, 0, false);
    motion.move(10, 0, true);
    motion.move(10, 0, false);
    const patch = motion.patches(
      [part()],
      new Vector3(),
      new Quaternion(),
      'translate',
      null,
      null,
    )[0].patch;
    expect(patch.position![0]).toBeCloseTo(2.1, 8);
    expect(
      motion.patches([part()], new Vector3(), new Quaternion(), 'translate', null, 1)[0].patch
        .position,
    ).toEqual([2, 0, 0]);
  });

  it('reaches a depth axis facing the camera and uses local axes for constrained movement', () => {
    const motion = new FreeTransformMotion(camera(), new Vector3(), 1000, 1000);
    motion.move(100, -100, false);
    const depth = motion.patches([part()], new Vector3(), new Quaternion(), 'translate', 2, null)[0]
      .patch.position!;
    expect(vec(depth).distanceTo(new Vector3(0, 0, 10))).toBeLessThan(1e-8);
    const frame = new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2));
    const local = motion.patches([part()], new Vector3(), frame, 'translate', 0, null)[0].patch
      .position!;
    expect(vec(local).distanceTo(new Vector3(0, 10, 0))).toBeLessThan(1e-8);
  });

  it('rotates rigidly in three dimensions around a custom pivot, preserving mirrored scale', () => {
    const p = part('a', { position: [20, 10, 0], scale: [-2, 3, 1], pivot: [2, 1, 0] });
    const pivot = partPivot(p),
      motion = new FreeTransformMotion(camera(), pivot, 1000, 1000);
    motion.move(80, 40, false);
    const patch = motion.patches([p], pivot, new Quaternion(), 'rotate', null, null)[0].patch;
    expect(partPivot({ ...p, ...patch }).distanceTo(pivot)).toBeLessThan(1e-8);
    expect(Math.abs(patch.quaternion![0])).toBeGreaterThan(0.01);
    expect(Math.abs(patch.quaternion![1])).toBeGreaterThan(0.01);
    expect(patch.scale).toBeUndefined();
    const axisPatch = motion.patches([p], pivot, new Quaternion(), 'rotate', 2, 7)[0].patch;
    const angle = (quat(axisPatch.quaternion!).angleTo(new Quaternion()) * 180) / Math.PI;
    expect(angle / 7).toBeCloseTo(Math.round(angle / 7), 8);
  });
});

describe('free transform transactions', () => {
  it('previews without changing history or the document revision; cancel restores redo exactly', () => {
    state().transform('a', { position: [3, 0, 0] });
    state().undo();
    const before = state();
    expect(state().beginFreeTransform('translate')).toBe(true);
    preview(10);
    preview(12);
    expect(state().scene.parts[0].position).toEqual([12, 0, 0]);
    expect(committedScene(state())).toBe(before.scene);
    expect(state().revision).toBe(before.revision);
    expect(state().past).toBe(before.past);
    expect(state().future).toBe(before.future);
    state().finishFreeTransform(false);
    expect(state().scene).toBe(before.scene);
    expect(state().future).toBe(before.future);
    state().redo();
    expect(state().scene.parts[0].position).toEqual([3, 0, 0]);
  });

  it('confirms many previews as one undo step, and retains original geometry', () => {
    const before = state();
    state().beginFreeTransform('translate');
    preview(3);
    preview(7);
    preview(12);
    state().finishFreeTransform(true);
    expect(state().freeTransform).toBeNull();
    expect(state().past).toEqual([before.scene]);
    expect(state().revision).toBe(before.revision + 1);
    expect(state().scene.parts[0].geometry).toBe(before.scene.parts[0].geometry);
    state().undo();
    expect(state().scene).toBe(before.scene);
    state().redo();
    expect(state().scene.parts[0].position).toEqual([12, 0, 0]);
  });

  it('does not add a checkpoint for no movement or a return to the starting pose', () => {
    const before = state().scene;
    state().beginFreeTransform('translate');
    state().finishFreeTransform(true);
    expect(state().past).toHaveLength(0);
    state().beginFreeTransform('translate');
    preview(5);
    preview(0);
    state().finishFreeTransform(true);
    expect(state().scene).toBe(before);
    expect(state().past).toHaveLength(0);
  });

  it('restores every connected part on cancel and never restores over a replacement scene', () => {
    const a = part(),
      b = part('b', { position: [4, 0, 0] });
    state().setScene({
      name: 'Connected',
      parts: [a, b],
      joints: [
        {
          id: 'j',
          name: 'Joint',
          parentId: 'a',
          childId: 'b',
          parentAnchor: [4, 0, 0],
          childAnchor: [0, 0, 0],
          restRotation: [0, 0, 0, 1],
          keepConnected: true,
          rotationLocks: [false, false, false],
        },
      ],
    });
    state().select('b');
    const before = state().scene;
    state().beginFreeTransform('translate');
    state().previewFreeTransform([{ id: 'b', patch: { position: [9, 0, 0] } }]);
    expect(state().scene.parts[0].position[0]).toBe(5);
    state().finishFreeTransform(false);
    expect(state().scene).toBe(before);
    state().beginFreeTransform('translate');
    const external = { ...before, name: 'From another editor', parts: [part('remote')] };
    state().receiveScene(external);
    state().finishFreeTransform(false);
    expect(state().scene).toBe(external);
    expect(state().freeTransform).toBeNull();
  });

  it('refuses unavailable selections and respects clipping on a confirmed move', () => {
    state().select(null);
    expect(state().beginFreeTransform('translate')).toBe(false);
    state().select('a');
    state().patchParts(['a'], { locked: true });
    expect(state().beginFreeTransform('rotate')).toBe(false);
    state().setScene({
      name: 'Clipping',
      joints: [],
      parts: [part(), part('b', { position: [10, 0, 0] })],
    });
    state().select('a');
    state().setView({ clip: { enabled: true, overlap: 0.1 } });
    state().beginFreeTransform('translate');
    preview(20);
    state().finishFreeTransform(true);
    expect(state().scene.parts[0].position[0]).toBeGreaterThan(0);
    expect(state().scene.parts[0].position[0]).toBeLessThanOrEqual(6.11);
  });
});

/** The face containing a mesh-local point on the z = 0 plate. */
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

describe('free transform on warp control points', () => {
  const warp = () => state().warp!;
  const distance = (a: ArrayLike<number>, b: ArrayLike<number>) =>
    Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  const deformed = (point: WarpPoint) =>
    deformPoint(warp().model!, warp().state!, point.samples[0].binding, point.samples[0].restWorld);
  const targets = () => warp().points.map((point) => point.target);

  const add = (x: number, y: number) => {
    const plate = state().scene.parts[0];
    state().addWarpPoint(
      { partId: plate.id, point: [x, y, 0], normal: [0, 0, 1] },
      faceAt(plate.geometry, x, y),
    );
    return warp().points.at(-1)!.id;
  };

  /** Lays a grid over a whole plate and adds two selected points on it. */
  async function warpPlate() {
    const plate = part('plate', { geometry: new PlaneGeometry(40, 40, 16, 16) });
    state().setScene({ name: 'Warp', parts: [plate], joints: [] });
    state().select('plate');
    state().setTool('warp');
    state().setWarpOptions({ autoPoints: false });
    await state().layWarpGrid();
    state().setWarpPointSettings({ radius: 0 }, 'end');
    const ids = [add(-4, 0), add(4, 0)];
    state().selectWarpPoints(ids);
    return ids;
  }

  /** Starts a free move and returns a function that lifts the points along Z by pixels. */
  function freeLift() {
    expect(state().beginFreeTransform('translate')).toBe(true);
    const selection = transformSelection(state(), 'translate');
    const motion = new FreeTransformMotion(camera(), selection.pivot, 1000, 1000);
    // The camera looks down Z, where 10 pixels of vertical motion reach 1 mm.
    return (pixels: number) => {
      motion.move(0, -pixels, false);
      state().previewFreeTransform(
        motion.patches(
          selection.parts,
          selection.pivot,
          selection.orientation,
          'translate',
          2,
          null,
        ),
      );
    };
  }

  afterEach(() => state().cancelWarp());

  it('free move on points confirms one session undo step and cancel restores', async () => {
    const [a, b] = await warpPlate();
    const { scene, past, revision } = state();
    expect(warp().undo).toHaveLength(2);

    const lift = freeLift();
    expect(state().tool).toBe('warp');
    lift(10);
    lift(10);
    expect(distance(targets()[0]!, [-4, 0, 2])).toBeLessThan(1e-6);
    expect(distance(targets()[1]!, [4, 0, 2])).toBeLessThan(1e-6);
    expect(warp().undo).toHaveLength(2);
    state().finishFreeTransform(true);
    expect(state().freeTransform).toBeNull();
    expect(state().tool).toBe('warp');
    // The whole gesture is one session step, holding the points from before it.
    expect(warp().undo).toHaveLength(3);
    expect(
      warp()
        .undo.at(-1)!
        .points.map((point) => point.target),
    ).toEqual([null, null]);
    for (const point of warp().points)
      expect(distance(deformed(point), point.target!)).toBeLessThan(0.01);
    // Scene history is untouched.
    expect(state().scene).toBe(scene);
    expect(state().past).toBe(past);
    expect(state().revision).toBe(revision);

    const settled = warp().points,
      surface = Array.from(warp().output!.positions);
    const again = freeLift();
    again(30);
    expect(targets()[0]![2]).toBeCloseTo(5, 6);
    state().finishFreeTransform(false);
    expect(state().freeTransform).toBeNull();
    expect(warp().points).toEqual(settled);
    expect(warp().undo).toHaveLength(3);
    const output = warp().output!.positions;
    expect(Math.max(...surface.map((value, i) => Math.abs(value - output[i])))).toBeLessThan(0.01);
    expect(state().scene).toBe(scene);
    expect(state().past).toBe(past);

    // The next gesture records the points from before it, not from the cancelled move.
    const c = add(0, 6);
    const added = warp().points;
    state().moveWarpPoints([{ id: a, target: [-4, 0, 1] }], 'end');
    expect(warp().undo).toHaveLength(5);
    expect(warp().undo.at(-1)!.points).toEqual(added);
    state().undoWarpEdit();
    expect(targets()).toEqual(added.map((point) => point.target));
    expect(warp().points.map((point) => point.id)).toEqual([a, b, c]);
  });

  it('adds no step for a free move of points that returns to where it began', async () => {
    await warpPlate();
    const before = warp().points;
    const lift = freeLift();
    lift(20);
    lift(-20);
    state().finishFreeTransform(true);
    expect(warp().points).toEqual(before);
    expect(warp().undo).toHaveLength(2);
    // Confirming without any movement adds none either.
    freeLift();
    state().finishFreeTransform(true);
    expect(warp().points).toEqual(before);
    expect(warp().undo).toHaveLength(2);
  });

  it('refuses a free move with no point selected and keeps the session', async () => {
    await warpPlate();
    state().selectWarpPoints([]);
    expect(state().beginFreeTransform('translate')).toBe(false);
    expect(state().toast?.message).toBe('Select a control point to move it.');
    expect(state().tool).toBe('warp');
    expect(state().warp).not.toBeNull();
  });

  it('cancels a free move of points that a received scene ends', async () => {
    const [a] = await warpPlate();
    const before = warp().points;
    const lift = freeLift();
    lift(20);
    expect(targets()[0]).not.toBeNull();
    state().receiveScene({ ...state().scene, name: 'From another editor' });
    expect(state().freeTransform).toBeNull();
    expect(state().warp).not.toBeNull();
    expect(warp().points).toEqual(before);
    expect(warp().undo).toHaveLength(2);
    add(0, 6);
    const added = warp().points;
    state().moveWarpPoints([{ id: a, target: [-4, 0, 1] }], 'end');
    expect(warp().undo.at(-1)!.points).toEqual(added);
  });
});
