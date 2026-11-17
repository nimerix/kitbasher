import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Euler, OrthographicCamera, Quaternion, Vector2, Vector3 } from 'three';
import { CombinedTransformDrag } from '../../src/core/combined-transform';
import { anchorError } from '../../src/core/constraints';
import { partPivot, quat, sceneBounds, vec } from '../../src/core/geometry';
import { createSample } from '../../src/core/sample';
import {
  activeTransformTool,
  transformSelection,
  stepTransform,
  warpMovesFromPatches,
} from '../../src/core/transform-selection';
import { useEditor, type WarpPoint, type WarpSession } from '../../src/core/store';
import type { Joint, Part, Vec3 } from '../../src/core/types';

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

const point = (id: string, pin: Vec3, target: Vec3 | null = null): WarpPoint => ({
  id,
  face: 0,
  barycentric: [1, 0, 0],
  binding: { node: [], weight: [] },
  restWorld: pin,
  pin,
  target,
});
const points = [point('a', [1, 2, 3]), point('b', [4, 0, 0], [5, 0, 0]), point('c', [9, 9, 9])];
/** The editor state with a warp session on part `p`, as the session is only read here. */
const warping = (patch: Partial<WarpSession> = {}, tool: 'warp' | 'select' = 'warp') => {
  const warp: WarpSession = {
    partId: 'p',
    source: state().scene.parts[0].geometry,
    epoch: state().sceneEpoch,
    stage: 'warp',
    region: 'whole',
    faces: [],
    density: 3,
    model: null,
    state: null,
    output: null,
    preview: null,
    points,
    selectedPoints: ['a', 'b'],
    gapTargets: [],
    snap: false,
    overlap: 0.1,
    gizmo: 'translate',
    folds: new Uint32Array(0),
    seam: null,
    undo: [],
    ...patch,
  };
  return { ...state(), tool, warp };
};
const pointSelection = (selectedPoints: string[]) => {
  const selection = transformSelection(warping({ selectedPoints }), 'translate');
  if (selection.kind !== 'warp') throw new Error('Expected control points.');
  return selection;
};
const close = (a: ArrayLike<number>, b: ArrayLike<number>) =>
  Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('transform tools on warp control points', () => {
  it('selects control points as warp targets with a centroid pivot', () => {
    setup([part('p')]);
    state().setView({ space: 'local' });
    const selection = transformSelection(warping(), 'rotate');
    expect(selection).toEqual({
      kind: 'warp',
      parts: [
        { id: 'a', position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
        { id: 'b', position: [5, 0, 0], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] },
      ],
      joint: undefined,
      axes: 'world',
      orientation: new Quaternion(),
      pivot: new Vector3(3, 1, 1.5),
      pivotLabel: 'Point center',
      locks: undefined,
      blocked: null,
      skipped: 0,
    });
    const single = transformSelection(warping({ selectedPoints: ['b'] }), 'translate');
    expect(single.pivot).toEqual(new Vector3(5, 0, 0));
    expect(single.pivotLabel).toBe('Control point');

    // While warping, the transform tools never fall back to moving the part.
    const none = transformSelection(warping({ selectedPoints: [] }), 'translate');
    expect(none.kind).toBe('warp');
    expect(none.parts).toEqual([]);
    expect(none.blocked).toBe('Select a control point to move it.');
    state().setView({ explode: 20 });
    expect(transformSelection(warping(), 'translate').blocked).toBe(
      'Reset the exploded view to move control points.',
    );

    expect(activeTransformTool(warping({ gizmo: 'rotate' }))).toBe('rotate');
    expect(activeTransformTool(warping({ stage: 'region', gizmo: 'rotate' }))).toBe('warp');
    expect(activeTransformTool(warping({ gizmo: 'rotate' }, 'select'))).toBe('select');
    expect(activeTransformTool({ tool: 'scale', warp: null })).toBe('scale');
  });

  it('returns parts selection unchanged outside the warp tool', () => {
    const sample = createSample();
    state().setScene(sample);
    const parts = (ids: string[]) => state().scene.parts.filter((p) => ids.includes(p.id));
    const cases = [
      {
        selected: ['torso', 'backpack'],
        tool: 'translate' as const,
        expected: {
          kind: 'parts',
          parts: parts(['torso', 'backpack']),
          joint: undefined,
          axes: 'world',
          orientation: new Quaternion(),
          pivot: sceneBounds(parts(['torso', 'backpack'])).getCenter(new Vector3()),
          pivotLabel: 'Selection center',
          locks: undefined,
          blocked: null,
          skipped: 0,
        },
      },
      {
        selected: ['head'],
        tool: 'rotate' as const,
        expected: {
          kind: 'parts',
          parts: parts(['head']),
          joint: sample.joints.find((joint) => joint.id === 'joint-neck'),
          axes: 'joint',
          orientation: quat(parts(['torso'])[0].quaternion).multiply(
            quat(sample.joints.find((joint) => joint.id === 'joint-neck')!.restRotation),
          ),
          pivot: partPivot(
            parts(['head'])[0],
            sample.joints.find((joint) => joint.id === 'joint-neck')!.childAnchor,
          ),
          pivotLabel: 'Joint anchor',
          locks: [true, false, true],
          blocked: null,
          skipped: 0,
        },
      },
      {
        selected: ['base', 'torso'],
        tool: 'scale' as const,
        expected: {
          kind: 'parts',
          parts: parts(['torso']),
          joint: undefined,
          axes: 'world',
          orientation: new Quaternion(),
          pivot: sceneBounds(parts(['torso'])).getCenter(new Vector3()),
          pivotLabel: 'Mesh center',
          locks: undefined,
          blocked: null,
          skipped: 1,
        },
      },
    ];
    for (const { selected, tool, expected } of cases) {
      useEditor.setState({ selected });
      const plain = transformSelection(state(), tool);
      expect(plain).toEqual(expected);
      expect(plain.parts.every((p, i) => p === expected.parts[i])).toBe(true);
      // A session in the region stage, or one left behind by another tool, changes nothing.
      expect(transformSelection(warping({ stage: 'region' }), tool)).toEqual(plain);
      expect(transformSelection(warping({ stage: 'building' }), tool)).toEqual(plain);
      expect(transformSelection(warping({}, 'select'), tool)).toEqual(plain);
      expect(transformSelection({ ...state(), tool: 'warp', warp: null }, tool)).toEqual(plain);
    }
  });

  it('maps translate and rotate patches to point moves', () => {
    setup([part('p')]);
    const selection = pointSelection(['a', 'b']);
    expect(warpMovesFromPatches(selection, stepTransform(selection, 'translate', 0, 2))).toEqual([
      { id: 'a', target: [3, 2, 3] },
      { id: 'b', target: [7, 0, 0] },
    ]);
    // A quarter turn about Z through the centroid (3, 1, 1.5).
    const turned = warpMovesFromPatches(selection, stepTransform(selection, 'rotate', 2, 90));
    expect(turned.map((move) => move.id)).toEqual(['a', 'b']);
    expect(close(turned[0].target, [2, -1, 3])).toBeLessThan(1e-10);
    expect(close(turned[1].target, [4, 3, 0])).toBeLessThan(1e-10);
    // Patches for anything that is not a selected point are ignored.
    expect(warpMovesFromPatches(selection, [{ id: 'p', patch: { position: [1, 1, 1] } }])).toEqual(
      [],
    );

    // Scaling several points moves them about the pivot, with or without a position.
    const camera = new OrthographicCamera(-50, 50, 50, -50, 0.1, 1000);
    camera.position.set(0, 0, 100);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const drag = new CombinedTransformDrag(
      selection.parts,
      selection.pivot,
      selection.orientation,
      { mode: 'scale', axis: 0 },
      camera,
      1000,
      1000,
      new Vector2(500, 500),
      9.6,
    );
    const scaled = drag.update(new Vector2(560, 500), false, null);
    const factor = scaled[0].patch.scale![0];
    expect(factor).toBeGreaterThan(1.5);
    const moves = warpMovesFromPatches(selection, scaled);
    expect(close(moves[0].target, [3 - 2 * factor, 2, 3])).toBeLessThan(1e-8);
    expect(close(moves[1].target, [3 + 2 * factor, 0, 0])).toBeLessThan(1e-8);
    expect(
      warpMovesFromPatches(selection, [
        { id: 'a', patch: { scale: [2, 3, 1] } },
        { id: 'b', patch: { scale: [2, 3, 1] } },
      ]),
    ).toEqual([
      { id: 'a', target: [-1, 4, 3] },
      { id: 'b', target: [7, -2, 0] },
    ]);
  });

  it('ignores a scale patch on a single point', () => {
    setup([part('p')]);
    const selection = pointSelection(['b']);
    expect(warpMovesFromPatches(selection, [{ id: 'b', patch: { scale: [2, 2, 2] } }])).toEqual([]);
    expect(
      warpMovesFromPatches(selection, [
        { id: 'b', patch: { position: [5, 0, 0], quaternion: [0, 0, 0, 1], scale: [2, 2, 2] } },
      ]),
    ).toEqual([]);
    // A point has no orientation of its own, so turning it about itself does nothing either.
    expect(warpMovesFromPatches(selection, stepTransform(selection, 'rotate', 1, 30))).toEqual([]);
    expect(warpMovesFromPatches(selection, stepTransform(selection, 'translate', 1, 3))).toEqual([
      { id: 'b', target: [5, 3, 0] },
    ]);
  });
});
