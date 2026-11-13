import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Euler,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Vector3,
} from 'three';
import { FreeTransformMotion } from '../../src/core/free-transform';
import { partPivot, quat, vec } from '../../src/core/geometry';
import { committedScene, useEditor } from '../../src/core/store';
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
