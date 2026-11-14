import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Quaternion } from 'three';
import { anchorError, transformAssembly } from '../../src/core/constraints';
import { hardPinsSatisfied, pinGaps } from '../../src/core/pins';
import { clippingDepth } from '../../src/core/clipping';
import { partMatrix, vec } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import { parseScene, readSceneFile, sceneFileBlob } from '../../src/core/scene-file';
import { applyPatch, diffScenes, reconcile } from '../../src/core/sync';
import { serializeScene } from '../helpers/legacy-scene';
import type { Joint, Part, Pin, SceneDocument, Vec3 } from '../../src/core/types';

function fixture(points: Vec3[] = [[0, 0, 0]], kind: Pin['kind'] = 'hard') {
  const part: Part = {
    id: 'part',
    name: 'Pinned part',
    geometry: new BoxGeometry(20, 20, 20),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
    pins: points.map((point, i) => ({
      id: `pin-${i}`,
      point,
      target: [...point],
      kind,
      priority: 50,
    })),
  };
  const scene: SceneDocument = { name: 'Pins', parts: [part], joints: [] };
  return { part, scene };
}
const initial = useEditor.getState();
afterEach(() => useEditor.setState(initial));
function setup(scene: SceneDocument) {
  const state = useEditor.getState();
  state.setScene(scene);
  state.setView({ clip: { enabled: false, overlap: 0.1 } });
  return state;
}
const rotate = (axis: Vec3, radians: number) =>
  new Quaternion().setFromAxisAngle(vec(axis), radians).toArray();

describe('rigid pins', () => {
  it('fixes a point exactly while allowing rotation about it, without editing the mesh or scale', () => {
    const { part } = fixture([[5, 3, 0]]);
    const vertices = Array.from(part.geometry.getAttribute('position').array);
    const requested = { ...part, position: [6, 1, 2] as Vec3, quaternion: rotate([0, 0, 1], 0.4) };
    const result = transformAssembly([part], [], part.id, requested)[0];
    expect(pinGaps(result)[0]).toBeLessThan(1e-7);
    expect(result.quaternion).not.toEqual(part.quaternion);
    expect(result.geometry).toBe(part.geometry);
    expect(Array.from(result.geometry.getAttribute('position').array)).toEqual(vertices);
    expect(result.scale).toBe(part.scale);
    expect(result.pins).toBe(part.pins);
  });

  it('two pins allow their shared-axis rotation and reject a perpendicular rotation', () => {
    const { part } = fixture([
      [-5, 0, 0],
      [5, 0, 0],
    ]);
    const allowed = rotate([1, 0, 0], 0.7);
    const result = transformAssembly([part], [], part.id, { ...part, quaternion: allowed })[0];
    expect(Math.max(...pinGaps(result))).toBeLessThan(1e-7);
    result.quaternion.forEach((v, i) => expect(v).toBeCloseTo(allowed[i], 8));
    const blocked = transformAssembly([part], [], part.id, {
      ...part,
      quaternion: rotate([0, 0, 1], 0.4),
    });
    expect(blocked).toEqual([part]);
  });

  it('three noncollinear pins hold the complete pose and refuse incompatible scaling', () => {
    const { part } = fixture([
      [-5, 0, 0],
      [5, 0, 0],
      [0, 8, 0],
    ]);
    const parts = [part];
    expect(
      transformAssembly(parts, [], part.id, {
        ...part,
        position: [20, 3, 1],
        quaternion: rotate([0, 1, 0], 1),
      }),
    ).toBe(parts);
    expect(() => transformAssembly(parts, [], part.id, { ...part, scale: [2, 2, 2] })).toThrow(
      'hard pins',
    );
  });

  it('handles coincident hard pins without inventing an axis', () => {
    const { part } = fixture([
      [0, 0, 0],
      [0, 0, 0],
    ]);
    const requested = { ...part, quaternion: rotate([0, 1, 0], 0.3), position: [3, 5, 2] as Vec3 };
    const result = transformAssembly([part], [], part.id, requested)[0];
    expect(hardPinsSatisfied(result)).toBe(true);
    result.quaternion.forEach((v, i) => expect(v).toBeCloseTo(requested.quaternion[i], 12));
  });

  it('preserves mirrored nonuniform scale and fixed world targets', () => {
    const { part } = fixture([[2, -3, 4]]);
    part.position = [100, -30, 8];
    part.scale = [-2, 3, 0.5];
    part.quaternion = rotate([0, 1, 0], 0.6);
    part.pins![0].target = vec(part.pins![0].point).applyMatrix4(partMatrix(part)).toArray();
    const result = transformAssembly([part], [], part.id, { ...part, position: [103, -32, 10] })[0];
    expect(hardPinsSatisfied(result)).toBe(true);
    expect(result.scale).toBe(part.scale);
    expect(result.pins![0].target).toEqual(part.pins![0].target);
  });

  it('soft pins resist displacement monotonically with priority and zero releases them', () => {
    const { part } = fixture([[0, 0, 0]], 'soft');
    const displacements = [0, 25, 50, 75, 100].map((priority) => {
      const p = { ...part, pins: [{ ...part.pins![0], priority }] };
      return transformAssembly([p], [], p.id, { ...p, position: [10, 0, 0] })[0].position[0];
    });
    expect(displacements[0]).toBe(10);
    for (let i = 1; i < displacements.length; i++)
      expect(displacements[i]).toBeLessThan(displacements[i - 1]);
    expect(displacements[2]).toBeCloseTo(10 / 11, 8);
    expect(displacements[4]).toBeCloseTo(10 / 1001, 8);
  });

  it('lets the low-priority pin give farther when a part is rotated', () => {
    const { part } = fixture(
      [
        [-8, 0, 0],
        [8, 0, 0],
      ],
      'soft',
    );
    part.pins![0].priority = 95;
    part.pins![1].priority = 10;
    const result = transformAssembly([part], [], part.id, {
      ...part,
      quaternion: rotate([0, 0, 1], 0.8),
    })[0];
    const [strong, weak] = pinGaps(result);
    expect(weak).toBeGreaterThan(0.1);
    expect(strong).toBeLessThan(weak / 20);
    expect(result.geometry).toBe(part.geometry);
  });

  it('hard pins stay exact even beside maximum-strength soft pins', () => {
    const { part } = fixture([
      [-8, 0, 0],
      [8, 0, 0],
    ]);
    part.pins![1].kind = 'soft';
    part.pins![1].priority = 100;
    const result = transformAssembly([part], [], part.id, {
      ...part,
      quaternion: rotate([0, 0, 1], 0.8),
    })[0];
    expect(pinGaps(result)[0]).toBeLessThan(1e-7);
    expect(pinGaps(result)[1]).toBeGreaterThan(0);
  });

  it('holds a pinned descendant and keeps its parent joint connected', () => {
    const { part: child, scene } = fixture([[5, 0, 0]]);
    const parent = { ...child, id: 'parent', pins: undefined };
    const joint: Joint = {
      id: 'joint',
      name: 'Joint',
      parentId: parent.id,
      childId: child.id,
      parentAnchor: [0, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, true],
      keepConnected: true,
    };
    scene.parts = [parent, child];
    scene.joints = [joint];
    const result = transformAssembly(scene.parts, scene.joints, parent.id, {
      ...parent,
      position: [0, 10, 0],
    });
    expect(hardPinsSatisfied(result[1])).toBe(true);
    expect(anchorError(result, joint)).toBeLessThan(1e-7);
    expect(result[0].position).not.toEqual(parent.position);
    const locked = { ...child, locked: true };
    const parts = [parent, locked];
    expect(transformAssembly(parts, [joint], parent.id, { ...parent, position: [0, 10, 0] })).toBe(
      parts,
    );
  });

  it('soft pins on descendants resist movement of their parent', () => {
    const { part: child } = fixture([[0, 0, 0]], 'soft');
    const parent = { ...child, id: 'parent', pins: undefined };
    const joint: Joint = {
      id: 'joint',
      name: 'Joint',
      parentId: parent.id,
      childId: child.id,
      parentAnchor: [0, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, true],
      keepConnected: true,
    };
    const result = transformAssembly([parent, child], [joint], parent.id, {
      ...parent,
      position: [10, 0, 0],
    });
    expect(result[0].position[0]).toBeCloseTo(10 / 11, 8);
    expect(anchorError(result, joint)).toBeLessThan(1e-7);
  });

  it('rejects a plane edit that would displace a hard pin without adding history', () => {
    const { part, scene } = fixture();
    const plane = { ...part, id: 'plane', pins: undefined, locked: true };
    scene.parts.push(plane);
    scene.constraints = [
      {
        id: 'mate',
        name: 'Mate',
        sourceId: part.id,
        targetId: plane.id,
        sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        kind: 'mate',
        offset: 0,
        angle: 0,
        opposed: false,
        enabled: true,
      },
    ];
    const state = setup(scene);
    state.updateConstraint('mate', { offset: 2 });
    expect(useEditor.getState().scene).toBe(scene);
    expect(useEditor.getState().past).toHaveLength(0);
    expect(useEditor.getState().toast?.message).toContain('Cannot satisfy');
  });
});

describe('pin integration', () => {
  it('lets soft pins resist a hinge without rotating locked axes or moving its parent', () => {
    const { part: child } = fixture([[6, 5, 4]], 'soft');
    const parent = { ...child, id: 'parent', pins: undefined, locked: true };
    const joint: Joint = {
      id: 'hinge',
      name: 'Hinge',
      parentId: parent.id,
      childId: child.id,
      parentAnchor: [0, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, false],
      keepConnected: true,
    };
    const result = transformAssembly([parent, child], [joint], child.id, {
      ...child,
      quaternion: rotate([0, 0, 1], 0.8),
    });
    expect(result[0]).toBe(parent);
    expect(anchorError(result, joint)).toBeLessThan(1e-7);
    expect(result[1].quaternion[0]).toBeCloseTo(0, 8);
    expect(result[1].quaternion[1]).toBeCloseTo(0, 8);
    expect(result[1].quaternion[2]).toBeGreaterThan(0.001);
    expect(result[1].quaternion[2]).toBeLessThan(Math.sin(0.4));
  });

  it('keeps hard pins exact through collision avoidance and release settling', () => {
    const { part, scene } = fixture([[-10, -10, 0]]);
    scene.parts.push({
      ...part,
      id: 'obstacle',
      position: [23, 0, 0],
      pins: undefined,
      locked: true,
    });
    const state = setup(scene);
    state.setView({ clip: { enabled: true, overlap: 0.1 } });
    const patches = [{ id: part.id, patch: { quaternion: rotate([0, 0, 1], -0.6) } }];
    state.transformMany(patches, true, false, false, Infinity);
    state.transformMany(patches, false, false, true, Infinity, scene.parts);
    const result = useEditor.getState().scene;
    expect(hardPinsSatisfied(result.parts[0])).toBe(true);
    expect(result.parts[1]).toBe(scene.parts[1]);
    expect(clippingDepth(result.parts, [part.id])).toBeLessThan(0.12);
  });

  it('cancels free movement cleanly and resets soft resting points without changing the mesh', () => {
    const { part, scene } = fixture([[0, 0, 0]], 'soft');
    const state = setup(scene);
    state.select(part.id);
    expect(state.beginFreeTransform('translate')).toBe(true);
    state.previewFreeTransform([{ id: part.id, patch: { position: [10, 0, 0] } }]);
    expect(useEditor.getState().scene.parts[0].position[0]).toBeCloseTo(10 / 11, 8);
    state.finishFreeTransform(false);
    expect(useEditor.getState().scene).toBe(scene);
    expect(useEditor.getState().past).toHaveLength(0);
    state.transform(part.id, { position: [10, 0, 0] });
    const placed = useEditor.getState().scene.parts[0];
    state.rebasePins(part.id);
    const rebased = useEditor.getState().scene.parts[0];
    expect(pinGaps(rebased)[0]).toBeLessThan(1e-9);
    expect(rebased.position).toBe(placed.position);
    expect(rebased.geometry).toBe(part.geometry);
    state.undo();
    expect(useEditor.getState().scene.parts[0].pins).toBe(placed.pins);
  });
});

describe('pin state and persistence', () => {
  it('makes an entire drag one undo step and is independent of intermediate event count', () => {
    const { part, scene } = fixture([[0, 0, 0]], 'soft');
    const state = setup(scene);
    state.transformMany([{ id: part.id, patch: { position: [5, 0, 0] } }]);
    state.transformMany([{ id: part.id, patch: { position: [10, 0, 0] } }], false);
    const result = useEditor.getState().scene;
    expect(result.parts[0].position[0]).toBeCloseTo(10 / 11, 8);
    expect(result.parts[0].pins).toBe(part.pins);
    expect(useEditor.getState().past).toHaveLength(1);
    state.undo();
    expect(useEditor.getState().scene).toBe(scene);
    state.redo();
    expect(useEditor.getState().scene).toBe(result);
  });

  it('persists mixed pins through binary and legacy scenes, and rejects malformed data', async () => {
    const { scene, part } = fixture([
      [0, 0, 0],
      [3, 0, 0],
    ]);
    part.pins![1].kind = 'soft';
    part.pins![1].priority = 83;
    expect((await readSceneFile(await sceneFileBlob(scene))).parts[0].pins).toEqual(part.pins);
    expect(parseScene(serializeScene(scene)).parts[0].pins).toEqual(part.pins);
    for (const patch of [
      { priority: -1 },
      { priority: 101 },
      { priority: NaN },
      { kind: 'rubber' },
      { target: [Infinity, 0, 0] },
      { point: [0, 0] },
      { id: 'pin-0' },
    ]) {
      const legacy = serializeScene(scene);
      Object.assign(legacy.parts[0].pins![1], patch);
      expect(() => parseScene(legacy)).toThrow('invalid pins');
    }
  });

  it('places, edits, rebases, duplicates and removes pins with undo support', () => {
    const { part, scene } = fixture([]);
    const state = setup(scene);
    state.select(part.id);
    state.setTool('pins');
    state.addPin({ partId: part.id, point: [5, 0, 0], normal: [1, 0, 0] });
    const pin = useEditor.getState().scene.parts[0].pins![0];
    expect(pin.kind).toBe('hard');
    expect(pin.target).toEqual([5, 0, 0]);
    state.updatePin(part.id, pin.id, { kind: 'soft', priority: 25 });
    state.transform(part.id, { position: [5, 0, 0] });
    const stretched = useEditor.getState().scene.parts[0];
    state.updatePin(part.id, pin.id, { kind: 'hard' });
    expect(useEditor.getState().scene.parts[0].position).toEqual(stretched.position);
    expect(hardPinsSatisfied(useEditor.getState().scene.parts[0])).toBe(true);
    state.duplicateSelected();
    const copy = useEditor.getState().scene.parts[1];
    expect(hardPinsSatisfied(copy)).toBe(true);
    expect(copy.pins![0].id).not.toBe(pin.id);
    state.removePin(copy.id, copy.pins![0].id);
    expect(useEditor.getState().scene.parts[1].pins).toEqual([]);
    state.undo();
    expect(useEditor.getState().scene.parts[1].pins).toEqual(copy.pins);
  });

  it('ignores invalid edits and rejects placement on locked, hidden or exploded parts', () => {
    const { part, scene } = fixture();
    const state = setup(scene);
    state.select(part.id);
    state.setTool('pins');
    state.updatePin(part.id, part.pins![0].id, { priority: NaN });
    expect(useEditor.getState().scene).toBe(scene);
    useEditor.setState({ pinPicking: 'soft' });
    part.locked = true;
    state.addPin({ partId: part.id, point: [2, 0, 0], normal: [0, 1, 0] });
    part.locked = false;
    part.visible = false;
    state.addPin({ partId: part.id, point: [2, 0, 0], normal: [0, 1, 0] });
    part.visible = true;
    state.setView({ explode: 0.5 });
    state.addPin({ partId: part.id, point: [2, 0, 0], normal: [0, 1, 0] });
    expect(useEditor.getState().scene).toBe(scene);
    expect(useEditor.getState().past).toHaveLength(0);
  });

  it('includes pin edits in shared history and refuses invalid shared hard-pin poses', () => {
    const { part, scene } = fixture();
    const next = { ...scene, parts: [{ ...part, pins: [{ ...part.pins![0], priority: 77 }] }] };
    const patch = diffScenes(scene, next);
    expect(applyPatch(next, patch, 'undo').scene.parts[0].pins).toEqual(part.pins);
    expect(applyPatch(scene, patch, 'redo').scene.parts[0].pins).toEqual(next.parts[0].pins);
    expect(() => reconcile({ ...scene, parts: [{ ...part, position: [1, 0, 0] }] })).toThrow(
      'hard pin',
    );
  });
});
