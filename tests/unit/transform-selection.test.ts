import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Euler, Quaternion, Vector3 } from 'three';
import { anchorError } from '../../src/core/constraints';
import { partPivot, quat, vec } from '../../src/core/geometry';
import { transformSelection, stepTransform } from '../../src/core/transform-selection';
import { useEditor } from '../../src/core/store';
import type { Joint, Part } from '../../src/core/types';

const original = useEditor.getState();
const state = () => useEditor.getState();
const part = (id: string, patch: Partial<Part> = {}): Part => ({
  id,
  name: id,
  geometry: new BoxGeometry(4, 6, 8),
  position: [0, 0, 0],
  quaternion: [0, 0, 0, 1],
  scale: [1, 1, 1],
  color: '#aabbcc',
  visible: true,
  locked: false,
  source: 'test',
  ...patch,
});
const setup = (parts: Part[], joints: Joint[] = []) => {
  state().setScene({ name: 'Transforms', parts, joints });
  useEditor.setState({ selected: parts.map((p) => p.id) });
};
const step = (mode: 'translate' | 'rotate', axis: 0 | 1 | 2, amount: number) => {
  const patches = stepTransform(transformSelection(state(), mode), mode, axis, amount);
  if (patches.length) state().transformMany(patches, true, mode === 'translate', true);
};
beforeEach(() => {
  useEditor.setState(original, true);
  state().setView({ clip: { ...original.view.clip, enabled: false } });
});
afterEach(() => useEditor.setState(original, true));

describe('precise transform adjustments', () => {
  it.each(['translate', 'rotate', 'scale'] as const)(
    'keeps the %s tool through undo and redo',
    (tool) => {
      setup([part('p')]);
      state().setTool(tool);
      step('translate', 0, 1);
      state().undo();
      expect(state().tool).toBe(tool);
      expect(state().scene.parts[0].position).toEqual([0, 0, 0]);
      state().redo();
      expect(state().tool).toBe(tool);
      expect(state().scene.parts[0].position).toEqual([1, 0, 0]);
    },
  );

  it('stops a step at another part when Avoid clipping is enabled', () => {
    setup([part('a'), part('b', { position: [10, 0, 0] })]);
    useEditor.setState({ selected: ['a'] });
    state().setView({ clip: { enabled: true, overlap: 0.1 } });
    step('translate', 0, 20);
    expect(state().scene.parts[0].position[0]).toBeGreaterThan(0);
    expect(state().scene.parts[0].position[0]).toBeLessThanOrEqual(6.11);
    expect(state().scene.parts[1].position).toEqual([10, 0, 0]);
    expect(state().past).toHaveLength(1);
  });

  it('moves along local axes without changing rotation or geometry, and undoes in one step', () => {
    const p = part('p', {
      quaternion: new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)).toArray(),
    });
    setup([p]);
    state().setView({ space: 'local' });
    const before = state().scene;
    step('translate', 0, 2);
    expect(vec(state().scene.parts[0].position).distanceTo(new Vector3(0, 2, 0))).toBeLessThan(
      1e-10,
    );
    expect(state().scene.parts[0].quaternion).toEqual(p.quaternion);
    expect(state().scene.parts[0].geometry).toBe(p.geometry);
    expect(state().past).toEqual([before]);
    state().undo();
    expect(state().scene).toBe(before);
  });

  it('rotates mirrored and nonuniformly scaled parts rigidly about their custom pivot', () => {
    const p = part('p', { position: [7, 8, 9], scale: [-2, 3, 0.5], pivot: [2, 1, 3] });
    setup([p]);
    const pivot = partPivot(p),
      positions = Array.from(p.geometry.attributes.position.array);
    step('rotate', 2, 90);
    const after = state().scene.parts[0];
    expect(partPivot(after).distanceTo(pivot)).toBeLessThan(1e-10);
    expect(
      quat(after.quaternion).angleTo(
        new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), Math.PI / 2),
      ),
    ).toBeLessThan(1e-7);
    expect(after.scale).toEqual(p.scale);
    expect(after.geometry).toBe(p.geometry);
    expect(Array.from(after.geometry.attributes.position.array)).toEqual(positions);
  });

  it('rotates a group about its center on world axes, even when Local was preferred', () => {
    setup([part('a', { position: [-10, 0, 0] }), part('b', { position: [10, 0, 0] })]);
    state().setView({ space: 'local' });
    expect(transformSelection(state(), 'rotate').axes).toBe('world');
    step('rotate', 2, 90);
    const [a, b] = state().scene.parts;
    expect(vec(a.position).distanceTo(new Vector3(0, -10, 0))).toBeLessThan(1e-10);
    expect(vec(b.position).distanceTo(new Vector3(0, 10, 0))).toBeLessThan(1e-10);
    expect(vec(a.position).distanceTo(vec(b.position))).toBeCloseTo(20, 10);
    expect(state().past).toHaveLength(1);
  });

  it('uses joint axes, respects their locks, and keeps the connected anchor seated', () => {
    const parent = part('parent', {
      quaternion: new Quaternion().setFromEuler(new Euler(0, 0, Math.PI / 2)).toArray(),
      locked: true,
    });
    const child = part('child', { position: [0, -2, 0], quaternion: parent.quaternion });
    const joint: Joint = {
      id: 'joint',
      name: 'Hinge',
      keepConnected: true,
      parentId: parent.id,
      childId: child.id,
      parentAnchor: [0, 0, 0],
      childAnchor: [2, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [false, true, true],
    };
    setup([parent, child], [joint]);
    useEditor.setState({ selected: ['child'] });
    const selection = transformSelection(state(), 'rotate');
    expect(selection.axes).toBe('joint');
    expect(selection.pivot.length()).toBeLessThan(1e-10);
    step('rotate', 1, 10);
    expect(state().past).toHaveLength(0);
    step('rotate', 0, 10);
    expect(anchorError(state().scene.parts, joint)).toBeLessThan(1e-8);
    expect(quat(child.quaternion).angleTo(quat(state().scene.parts[1].quaternion))).toBeCloseTo(
      Math.PI / 18,
      8,
    );
    expect(transformSelection(state(), 'translate').blocked).toMatch(/locked connected part/);
  });

  it('ignores hidden, locked and isolated-away selections and blocks exploded edits', () => {
    setup([part('a'), part('b', { locked: true }), part('c', { visible: false }), part('d')]);
    useEditor.setState({ isolated: ['a'] });
    const selection = transformSelection(state(), 'translate');
    expect(selection.parts.map((p) => p.id)).toEqual(['a']);
    expect(selection.skipped).toBe(3);
    state().setView({ explode: 30 });
    step('translate', 0, 10);
    expect(state().past).toHaveLength(0);
    expect(transformSelection(state(), 'translate').blocked).toMatch(/exploded/);
  });

  it('moves connected selections once instead of applying the same step twice', () => {
    const joint: Joint = {
      id: 'j',
      name: 'Joint',
      keepConnected: true,
      parentId: 'a',
      childId: 'b',
      parentAnchor: [4, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [false, false, false],
    };
    setup([part('a'), part('b', { position: [4, 0, 0] })], [joint]);
    step('translate', 0, 3);
    expect(state().scene.parts.map((p) => p.position[0])).toEqual([3, 7]);
    expect(state().past).toHaveLength(1);
  });
});
