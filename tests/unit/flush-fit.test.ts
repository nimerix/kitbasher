import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { solveAlignment } from '../../src/core/alignment';
import { solveFlushAlignment } from '../../src/core/flush-fit';
import { anchorError } from '../../src/core/constraints';
import { planeConstraintResidual } from '../../src/core/plane-constraints';
import { partMatrix } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import { serializeScene } from '../helpers/legacy-scene';
import { parseScene } from '../../src/core/scene-file';
import type {
  AssemblyOperation,
  Joint,
  Part,
  SceneDocument,
  SurfacePair,
} from '../../src/core/types';

function part(id: string): Part {
  const positions = [-10, 10].flatMap((center) =>
    Array.from(
      new PlaneGeometry(6, 6).toNonIndexed().translate(center, 0, 0).getAttribute('position').array,
    ),
  );
  return {
    id,
    name: id,
    geometry: new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3),
    ),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aaaaaa',
    visible: true,
    locked: false,
    source: 'test',
  };
}
function fixture() {
  const source = part('moving'),
    target = part('target');
  source.position = [-20, 4, 1];
  source.quaternion = new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.08).toArray();
  target.position = [20, 4, 0];
  const surfacePairs: SurfacePair[] = [0, 1].map((index) => ({
    id: `seam-${index}`,
    source: { partId: source.id, faces: [index * 2, index * 2 + 1] },
    target: { partId: target.id, faces: [index * 2, index * 2 + 1] },
  }));
  const scene: SceneDocument = { name: 'Flush seams', parts: [source, target], joints: [] };
  const operation: AssemblyOperation = {
    ...useEditor.getState().operation,
    mode: 'surface',
    surfaceMethod: 'flush',
    sourceId: source.id,
    targetId: target.id,
    surfacePairs,
    pairs: [],
    pending: null,
    activeSurface: { pairId: surfacePairs[0].id, side: 'source' },
  };
  return { source, target, scene, operation };
}
const original = useEditor.getState();
afterEach(() => useEditor.setState(original));

describe('painted flush fitting', () => {
  it('corrects tilt and height together without snapping neighboring patch centers together', () => {
    const { source, target, scene, operation } = fixture();
    const before = partMatrix(source).toArray();
    const result = solveFlushAlignment(scene, operation);
    expect(result.rms).toBeLessThan(0.0001);
    expect(result.angleError).toBeLessThan(0.001);
    expect(result.parts[0].position[0]).toBeCloseTo(-20, 5);
    expect(result.parts[0].position[1]).toBeCloseTo(4, 5);
    expect(result.parts[1]).toBe(target);
    expect(result.parts[0].geometry).toBe(source.geometry);
    expect(result.parts[0].scale).toEqual(source.scale);
    expect(partMatrix(source).toArray()).toEqual(before);
    expect(solveAlignment(scene, operation).parts).toEqual(result.parts);
  });

  it('accepts a single seam and keeps an already flush assembly still', () => {
    const { source, scene, operation } = fixture();
    source.position[2] = 0;
    source.quaternion = [0, 0, 0, 1];
    operation.surfacePairs = operation.surfacePairs.slice(0, 1);
    expect(solveFlushAlignment(scene, operation).parts).toBe(scene.parts);
  });

  it('balances every region and every stationary neighbor rather than only the last painted seam', () => {
    const { source, scene, operation } = fixture();
    source.quaternion = [0, 0, 0, 1];
    const neighbor = part('neighbor');
    neighbor.position = [0, 0, 1];
    scene.parts.push(neighbor);
    operation.surfacePairs[1].target!.partId = neighbor.id;
    const result = solveFlushAlignment(scene, operation);
    const reversed = solveFlushAlignment(scene, {
      ...operation,
      surfacePairs: [...operation.surfacePairs].reverse(),
    });
    expect(result.regionErrors).toHaveLength(2);
    expect(result.parts[0].position[2]).toBeGreaterThan(0.1);
    expect(result.parts[0].position[2]).toBeLessThan(0.9);
    expect(result.regionErrors.every((region) => region.distance < 0.5)).toBe(true);
    expect(result.constrained).toBe(true);
    expect(result.parts[1]).toBe(scene.parts[1]);
    expect(result.parts[2]).toBe(neighbor);
    result.parts[0].position.forEach((value, index) =>
      expect(value).toBeCloseTo(reversed.parts[0].position[index], 5),
    );
  });

  it('handles nonuniform scale and large world coordinates without changing scale', () => {
    const { source, target, scene, operation } = fixture();
    source.scale = [2, 0.5, 1.5];
    source.position = [10000, -20000, 301];
    target.position = [10040, -20000, 300];
    const result = solveFlushAlignment(scene, operation);
    expect(result.rms).toBeLessThan(0.001);
    expect(result.angleError).toBeLessThan(0.01);
    expect(result.parts[0].scale).toEqual(source.scale);
    expect(result.parts[0].position[0]).toBeCloseTo(source.position[0], 4);
  });

  it('rotates around an existing connected anchor and respects locked axes', () => {
    const { source, target, scene, operation } = fixture();
    source.position = [...target.position];
    const joint: Joint = {
      id: 'hinge',
      name: 'hinge',
      parentId: target.id,
      childId: source.id,
      parentAnchor: [0, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, false, true],
      keepConnected: true,
    };
    scene.joints = [joint];
    const result = solveFlushAlignment(scene, operation);
    expect(result.rms).toBeLessThan(0.001);
    expect(result.angleError).toBeLessThan(0.01);
    expect(anchorError(result.parts, joint)).toBeLessThan(1e-8);
    expect(result.parts[1]).toBe(target);
    joint.rotationLocks = [true, true, true];
    joint.restRotation = source.quaternion;
    const locked = solveFlushAlignment(scene, operation);
    expect(locked.parts[0].quaternion).toEqual(source.quaternion);
    expect(locked.constrained).toBe(true);
  });

  it('does not move a painted target even when it is a connected descendant', () => {
    const { source, target, scene, operation } = fixture();
    scene.joints = [
      {
        id: 'fixed',
        name: 'fixed',
        parentId: source.id,
        childId: target.id,
        parentAnchor: [0, 0, 0],
        childAnchor: [0, 0, 0],
        restRotation: [0, 0, 0, 1],
        rotationLocks: [false, false, false],
        keepConnected: true,
      },
    ];
    const result = solveFlushAlignment(scene, operation);
    expect(result.parts).toBe(scene.parts);
    expect(result.constrained).toBe(true);
  });

  it('preserves existing plane constraints instead of silently breaking another connection', () => {
    const { source, scene, operation } = fixture();
    const neighbor = part('anchored-neighbor');
    neighbor.position[2] = 1;
    scene.parts.push(neighbor);
    scene.constraints = [
      {
        id: 'keep-height',
        name: 'Keep existing height',
        sourceId: source.id,
        targetId: neighbor.id,
        sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
        kind: 'mate',
        angle: 0,
        offset: 0,
        opposed: false,
        enabled: true,
      },
    ];
    const result = solveFlushAlignment(scene, operation);
    expect(planeConstraintResidual(result.parts, scene.constraints[0]).satisfied).toBe(true);
    expect(result.rms).toBeCloseTo(1, 4);
    expect(result.constrained).toBe(true);
    expect(result.parts[2]).toBe(neighbor);
  });

  it('rejects incomplete, mismatched, missing and invalid painted regions', () => {
    const { source, scene, operation } = fixture();
    expect(() => solveFlushAlignment(scene, { ...operation, surfacePairs: [] })).toThrow(
      'both sides',
    );
    operation.surfacePairs[0].target!.faces = [];
    expect(() => solveFlushAlignment(scene, operation)).toThrow('both sides');
    operation.surfacePairs[0].target!.faces = [999];
    expect(() => solveFlushAlignment(scene, operation)).toThrow('missing triangle');
    operation.surfacePairs[0].target!.partId = source.id;
    expect(() => solveFlushAlignment(scene, operation)).toThrow('stationary part');
  });

  it('rejects opposing contact faces and locked moving parts', () => {
    const { source, scene, operation } = fixture();
    source.quaternion = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI).toArray();
    expect(() => solveFlushAlignment(scene, operation)).toThrow('outward surfaces');
    source.locked = true;
    expect(() => solveFlushAlignment(scene, operation)).toThrow('unlocked');
  });

  it('limits a local correction to 30 degrees and reports the remaining tilt', () => {
    const { source, scene, operation } = fixture();
    source.quaternion = new Quaternion()
      .setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 3)
      .toArray();
    const result = solveFlushAlignment(scene, operation);
    expect(
      new Quaternion(...source.quaternion).angleTo(new Quaternion(...result.parts[0].quaternion)),
    ).toBeLessThanOrEqual(Math.PI / 6 + 1e-6);
    expect(result.angleError).toBeGreaterThan(29);
    expect(result.constrained).toBe(true);
  });
});

describe('cross-seam paint state', () => {
  function start() {
    const fixtureState = fixture();
    fixtureState.scene.parts.push(part('neighbor'));
    useEditor.getState().setScene(fixtureState.scene);
    useEditor.getState().select('moving');
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({ mode: 'surface', surfaceMethod: 'flush' });
    return fixtureState;
  }
  function paint(partId: string, begin = false, erase = false) {
    return useEditor
      .getState()
      .paintSurface({ partId, point: [-10, 0, 0], normal: [0, 0, 1] }, 0, erase, begin);
  }
  it('paints both sides in one stroke and undoes both sides atomically', () => {
    start();
    expect(paint('moving', true)).toBe(true);
    expect(paint('target')).toBe(true);
    useEditor.getState().endPaintStroke();
    const pair = useEditor.getState().operation.surfacePairs[0];
    expect(pair.source!.faces.length).toBeGreaterThan(0);
    expect(pair.target!.faces.length).toBeGreaterThan(0);
    expect(useEditor.getState().paintHistory).toHaveLength(1);
    useEditor.getState().undoPaintStroke();
    expect(useEditor.getState().operation.surfacePairs[0]).toMatchObject({
      source: null,
      target: null,
    });
  });
  it('starts on the target, supports multiple neighbors, rejects a third part in one seam, and erases per hit', () => {
    start();
    expect(paint('target', true)).toBe(true);
    expect(paint('moving')).toBe(true);
    expect(paint('neighbor')).toBe(false);
    useEditor.getState().endPaintStroke();
    useEditor.getState().addSurfacePair();
    expect(paint('moving', true)).toBe(true);
    expect(paint('neighbor')).toBe(true);
    useEditor.getState().endPaintStroke();
    const pairs = useEditor.getState().operation.surfacePairs;
    expect(pairs.map((pair) => pair.target?.partId)).toEqual(['target', 'neighbor']);
    expect(paint('neighbor', true, true)).toBe(true);
    useEditor.getState().endPaintStroke();
    expect(useEditor.getState().operation.surfacePairs[1].target!.faces).toEqual([]);
    useEditor.getState().undoPaintStroke();
    expect(useEditor.getState().operation.surfacePairs).toEqual(pairs);
  });
  it('clears incompatible paint when switching methods', () => {
    start();
    paint('moving', true);
    paint('target');
    useEditor.getState().endPaintStroke();
    useEditor.getState().setOperation({ surfaceMethod: 'contact' });
    expect(useEditor.getState().operation.surfacePairs[0].source).toBeNull();
    expect(useEditor.getState().paintHistory).toEqual([]);
  });
  it('invalidates paint when any painted neighbor is removed', () => {
    start();
    paint('moving', true);
    paint('target');
    useEditor.getState().endPaintStroke();
    useEditor.getState().addSurfacePair();
    paint('moving', true);
    paint('neighbor');
    useEditor.getState().endPaintStroke();
    useEditor.getState().select('neighbor');
    useEditor.getState().deleteSelected();
    expect(useEditor.getState().operation.surfacePairs).toEqual([]);
    expect(useEditor.getState().paintHistory).toEqual([]);
  });
  it('applies the preview in one undoable edit and saves the resulting transforms', () => {
    const { scene, operation } = fixture();
    useEditor.getState().setScene(scene);
    useEditor.getState().setTool('align');
    useEditor.setState({ operation });
    const expected = solveAlignment(scene, operation).parts;
    useEditor.getState().applyAlignment();
    const applied = useEditor.getState().scene;
    expect(applied.parts).toEqual(expected);
    expect(applied.constraints).toEqual(scene.constraints);
    expect(parseScene(serializeScene(applied)).parts[0].position).toEqual(expected[0].position);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts).toEqual(scene.parts);
    useEditor.getState().redo();
    expect(useEditor.getState().scene.parts).toEqual(expected);
  });
});
