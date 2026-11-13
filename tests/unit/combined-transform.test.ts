import { describe, expect, it } from 'vitest';
import { BoxGeometry, OrthographicCamera, Quaternion, Vector2, Vector3 } from 'three';
import { CombinedTransformDrag } from '../../src/core/combined-transform';
import type { TransformHandle } from '../../src/core/combined-transform';
import { partPivot, quat, vec } from '../../src/core/geometry';
import { sanitizePreferences } from '../../src/core/preferences';
import type { Part } from '../../src/core/types';

const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
camera.position.set(0, 0, 100);
camera.lookAt(0, 0, 0);
camera.updateMatrixWorld();
const part = (patch: Partial<Part> = {}): Part => ({
  id: 'a',
  name: 'Part',
  geometry: new BoxGeometry(4, 6, 8),
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aaaaaa',
  visible: true,
  locked: false,
  source: 'test',
  ...patch,
});
const screen = (point: Vector3) => {
  const p = point.clone().project(camera);
  return new Vector2((p.x + 1) * 500, (1 - p.y) * 500);
};
const start = (
  handle: TransformHandle,
  parts = [part()],
  pivot = new Vector3(),
  pointer = new Vector2(600, 500),
  orientation = new Quaternion(),
) => new CombinedTransformDrag(parts, pivot, orientation, handle, camera, 1000, 1000, pointer, 9.6);

describe('combined transform', () => {
  it('translates on one axis or plane and snaps in the chosen frame without changing scale', () => {
    const move = start({ mode: 'translate', axis: 0 });
    const result = move.update(new Vector2(635, 480), false, { move: 1, rotate: 15, scale: 0.1 })[0]
      .patch;
    expect(vec(result.position!).distanceTo(new Vector3(4, 0, 0))).toBeLessThan(1e-8);
    expect(result.scale).toBeUndefined();
    expect(result.quaternion).toBeUndefined();
    const plane = start({ mode: 'translate', axis: null, plane: 2 });
    const planar = plane.update(new Vector2(630, 480), false, null)[0].patch;
    expect(vec(planar.position!).distanceTo(new Vector3(3, 2, 0))).toBeLessThan(1e-8);
  });

  it('rotates about a custom pivot while preserving mirrored dimensions exactly', () => {
    const p = part({ position: [10, 5, 0], scale: [-2, 3, 1], pivot: [2, 1, 0] });
    const pivot = partPivot(p);
    const positions = Array.from(p.geometry.attributes.position.array);
    const drag = start(
      { mode: 'rotate', axis: 2 },
      [p],
      pivot,
      screen(pivot.clone().add(new Vector3(10, 0, 0))),
    );
    const patch = drag.update(screen(pivot.clone().add(new Vector3(0, 10, 0))), false, null)[0]
      .patch;
    expect(partPivot({ ...p, ...patch }).distanceTo(pivot)).toBeLessThan(1e-8);
    expect(
      quat(patch.quaternion!).angleTo(
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
      ),
    ).toBeLessThan(1e-7);
    expect(patch.scale).toBeUndefined();
    expect(Array.from(p.geometry.attributes.position.array)).toEqual(positions);
    expect(p.scale).toEqual([-2, 3, 1]);
  });

  it('scales by an axis or uniformly about the same pivot', () => {
    const p = part({ position: [10, 0, 0], pivot: [2, 0, 0] }),
      pivot = partPivot(p);
    const drag = start({ mode: 'scale', axis: 0 }, [p], pivot);
    const patch = drag.update(new Vector2(650, 500), false, null)[0].patch;
    expect(patch.scale![0]).toBeGreaterThan(1);
    expect(patch.scale![1]).toBeCloseTo(1);
    expect(patch.scale![2]).toBeCloseTo(1);
    expect(partPivot({ ...p, ...patch }).distanceTo(pivot)).toBeLessThan(1e-8);
    const uniform = start({ mode: 'scale', axis: null }, [p], pivot).update(
      new Vector2(550, 550),
      false,
      null,
    )[0].patch;
    expect(uniform.scale![0]).toBeGreaterThan(1);
    expect(uniform.scale![0]).toBeCloseTo(uniform.scale![1], 10);
    expect(uniform.scale![1]).toBeCloseTo(uniform.scale![2], 10);
  });

  it('changes precision continuously and uses the configured angular increment', () => {
    const motion = start({ mode: 'translate', axis: 0 });
    motion.update(new Vector2(610, 500), false, null);
    motion.update(new Vector2(620, 500), true, null);
    expect(motion.update(new Vector2(630, 500), false, null)[0].patch.position![0]).toBeCloseTo(
      2.1,
      8,
    );
    const rotate = start({ mode: 'rotate', axis: 2 });
    const angle = (25 * Math.PI) / 180;
    const rotated = rotate.update(
      new Vector2(500 + Math.cos(angle) * 100, 500 - Math.sin(angle) * 100),
      false,
      { move: 1, rotate: 7, scale: 0.1 },
    );
    expect(
      (quat(rotated[0].patch.quaternion!).angleTo(new Quaternion()) * 180) / Math.PI,
    ).toBeCloseTo(28, 7);
  });

  it('preserves the disabled scaling preference and safely defaults old settings', () => {
    expect(sanitizePreferences({ transform: { scaling: false } }).transform.scaling).toBe(false);
    expect(sanitizePreferences({ transform: { scaling: 'no' } }).transform.scaling).toBe(true);
    expect(sanitizePreferences({ zoom: {} }).transform.scaling).toBe(true);
  });
});
