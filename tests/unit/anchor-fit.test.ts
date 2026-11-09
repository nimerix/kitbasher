import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Quaternion, Vector3 } from 'three';
import { anchorGaps, fitAnchors } from '../../src/core/anchor-fit';
import { partMatrix, vec } from '../../src/core/geometry';
import { anchorError } from '../../src/core/constraints';
import { useEditor } from '../../src/core/store';
import { parseScene, readSceneFile, sceneFileBlob } from '../../src/core/scene-file';
import { serializeScene } from '../helpers/legacy-scene';
import type { FitAnchor, Part, SceneDocument, Vec3 } from '../../src/core/types';

function fixture(
  points: Vec3[] = [
    [-5, 0, 0],
    [5, 0, 0],
    [0, 8, 0],
  ],
) {
  const part: Part = {
    id: 'moving',
    name: 'Moving',
    geometry: new BoxGeometry(10, 16, 2),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aabbcc',
    visible: true,
    locked: false,
    source: 'test',
    anchors: points.map((point, i) => ({ id: String(i), point, target: [...point] })),
  };
  const scene: SceneDocument = { name: 'Anchors', parts: [part], joints: [] };
  return { part, scene, anchors: part.anchors! };
}
const original = useEditor.getState();
afterEach(() => useEditor.setState(original));

describe('rigid anchor fitting', () => {
  it('rotates about two unchanged anchors when the third target lies on its rigid arc', () => {
    const { scene, anchors, part } = fixture();
    const positions = Array.from(part.geometry.getAttribute('position').array);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.08);
    const targets = anchors.map((a) => ({
      ...a,
      target: vec(a.target).applyQuaternion(rotation).toArray(),
    }));
    const next = fitAnchors(scene, part.id, targets)[0];
    expect(Math.max(...anchorGaps(next))).toBeLessThan(1e-7);
    expect(next.quaternion[0]).toBeCloseTo(rotation.x, 7);
    expect(next.geometry).toBe(part.geometry);
    expect(Array.from(next.geometry.getAttribute('position').array)).toEqual(positions);
    expect(next.scale).toEqual(part.scale);
    expect(part.quaternion).toEqual([0, 0, 0, 1]);
  });

  it('balances an impossible displacement without stretching the triangle', () => {
    const { scene, anchors, part } = fixture();
    const targets = anchors.map((a, i): FitAnchor => ({
      ...a,
      target: i === 2 ? [0, 9, 0] : a.target,
    }));
    const next = fitAnchors(scene, part.id, targets)[0];
    expect(next.position[1]).toBeCloseTo(1 / 3, 7);
    expect(anchorGaps(next)[2]).toBeCloseTo(2 / 3, 7);
    const before = anchors.map((a) => vec(a.point).applyMatrix4(partMatrix(part)));
    const after = anchors.map((a) => vec(a.point).applyMatrix4(partMatrix(next)));
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < i; j++)
        expect(after[i].distanceTo(after[j])).toBeCloseTo(before[i].distanceTo(before[j]), 9);
    expect(next.anchors![0].target).toEqual(anchors[0].target);
  });

  it.each([1, 2, 3])('handles %i collinear anchors without arbitrary spin', (count) => {
    const { part, anchors, scene } = fixture(
      Array.from({ length: count }, (_, i) => [i * 5, 0, 0]),
    );
    const targets = anchors.map((a) => ({
      ...a,
      target: vec(a.target)
        .add(new Vector3(0, 0.1, 0))
        .toArray(),
    }));
    const next = fitAnchors(scene, part.id, targets)[0];
    expect(next.quaternion).toEqual(part.quaternion);
    expect(next.position[1]).toBeCloseTo(0.1, 9);
    expect(Math.max(...anchorGaps(next))).toBeLessThan(1e-8);
  });

  it('fits two anchors with the smallest rotation and no added twist', () => {
    const { part, anchors, scene } = fixture([
      [-5, 0, 0],
      [5, 0, 0],
    ]);
    const rotation = new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.02);
    const next = fitAnchors(
      scene,
      part.id,
      anchors.map((a) => ({ ...a, target: vec(a.target).applyQuaternion(rotation).toArray() })),
    )[0];
    expect(Math.max(...anchorGaps(next))).toBeLessThan(1e-7);
    expect(next.quaternion[0]).toBeCloseTo(0, 9);
    expect(next.quaternion[1]).toBeCloseTo(0, 9);
  });

  it('preserves a rotated, mirrored, nonuniform scale exactly', () => {
    const { part, anchors, scene } = fixture();
    part.position = [100, -20, 4];
    part.scale = [2, -3, 0.4];
    part.quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.4).toArray();
    const delta = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), 0.01);
    const next = fitAnchors(
      scene,
      part.id,
      anchors.map((a) => ({
        ...a,
        target: vec(a.point).applyMatrix4(partMatrix(part)).applyQuaternion(delta).toArray(),
      })),
    )[0];
    expect(Math.max(...anchorGaps(next))).toBeLessThan(1e-7);
    expect(next.scale).toEqual([2, -3, 0.4]);
    expect(next.geometry).toBe(part.geometry);
  });

  it('respects a locked parent and connected joint even if targets cannot be met', () => {
    const { scene, part, anchors } = fixture();
    const parent = { ...part, id: 'parent', locked: true, anchors: undefined };
    scene.parts.push(parent);
    const joint = {
      id: 'joint',
      name: 'Joint',
      parentId: parent.id,
      childId: part.id,
      parentAnchor: [0, 0, 0] as Vec3,
      childAnchor: [0, 0, 0] as Vec3,
      restRotation: [0, 0, 0, 1] as [number, number, number, number],
      rotationLocks: [true, true, true] as [boolean, boolean, boolean],
      keepConnected: true,
    };
    scene.joints.push(joint);
    const next = fitAnchors(
      scene,
      part.id,
      anchors.map((a) => ({
        ...a,
        target: vec(a.target)
          .add(new Vector3(0, 1, 0))
          .toArray(),
      })),
    );
    expect(anchorError(next, joint)).toBeLessThan(1e-9);
    expect(next[1]).toBe(parent);
    expect(next[0].position).toEqual(part.position);
    expect(Math.min(...anchorGaps(next[0]))).toBeCloseTo(1);
  });

  it('keeps retained plane constraints authoritative', () => {
    const { scene, part, anchors } = fixture();
    const target = { ...part, id: 'plane', locked: true, anchors: undefined };
    scene.parts.push(target);
    scene.constraints = [
      {
        id: 'mate',
        name: 'Mate',
        sourceId: part.id,
        targetId: target.id,
        sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        kind: 'mate',
        angle: 0,
        offset: 0,
        opposed: false,
        enabled: true,
      },
    ];
    const next = fitAnchors(
      scene,
      part.id,
      anchors.map((a) => ({
        ...a,
        target: vec(a.target)
          .add(new Vector3(0, 0, 1))
          .toArray(),
      })),
    );
    expect(next[0].position[2]).toBeCloseTo(0, 7);
    expect(next[1]).toBe(target);
    expect(Math.min(...anchorGaps(next[0]))).toBeCloseTo(1);
  });

  it('persists targets and attachment points in both scene formats and validates them', async () => {
    const { scene } = fixture();
    expect((await readSceneFile(sceneFileBlob(scene))).parts[0].anchors).toEqual(
      scene.parts[0].anchors,
    );
    const legacy = serializeScene(scene);
    expect(parseScene(legacy).parts[0].anchors).toEqual(scene.parts[0].anchors);
    legacy.parts[0].anchors![0].target = [NaN, 0, 0];
    expect(() => parseScene(legacy)).toThrow('invalid fit anchors');
  });

  it('makes a drag one undo step and restores both placement and targets on redo', () => {
    const { scene, part, anchors } = fixture();
    const state = useEditor.getState();
    state.setScene(scene);
    state.moveFitAnchor(part.id, anchors[2].id, [0, 8.1, 0], true, scene);
    state.moveFitAnchor(part.id, anchors[2].id, [0, 8.2, 0], false, scene);
    expect(useEditor.getState().past).toHaveLength(1);
    const final = useEditor.getState().scene;
    state.undo();
    expect(useEditor.getState().scene).toBe(scene);
    state.redo();
    expect(useEditor.getState().scene).toBe(final);
    expect(final.parts[0].anchors![2].target).toEqual([0, 8.2, 0]);
  });

  it('rejects edits to locked or hidden parts and nonfinite targets', () => {
    const { scene, part, anchors } = fixture();
    const state = useEditor.getState();
    state.setScene(scene);
    state.moveFitAnchor(part.id, anchors[0].id, [NaN, 0, 0]);
    expect(useEditor.getState().scene).toBe(scene);
    part.locked = true;
    state.moveFitAnchor(part.id, anchors[0].id, [1, 0, 0]);
    expect(useEditor.getState().scene).toBe(scene);
    part.locked = false;
    part.visible = false;
    state.moveFitAnchor(part.id, anchors[0].id, [1, 0, 0]);
    expect(useEditor.getState().scene).toBe(scene);
  });

  it('adds and removes anchors with history and rebases a copy onto its new placement', () => {
    const { scene, part } = fixture([]);
    const state = useEditor.getState();
    state.setScene(scene);
    state.select(part.id);
    state.setTool('anchors');
    state.addFitAnchor({ partId: part.id, point: [5, 0, 0], normal: [1, 0, 0] });
    const anchor = useEditor.getState().scene.parts[0].anchors![0];
    expect(anchor.target).toEqual([5, 0, 0]);
    state.duplicateSelected();
    const copy = useEditor.getState().scene.parts[1];
    expect(copy.anchors![0].id).not.toBe(anchor.id);
    expect(anchorGaps(copy)).toEqual([0]);
    state.removeFitAnchor(part.id, anchor.id);
    expect(useEditor.getState().scene.parts[0].anchors).toEqual([]);
    state.undo();
    expect(useEditor.getState().scene.parts[0].anchors).toEqual([anchor]);
  });
});
