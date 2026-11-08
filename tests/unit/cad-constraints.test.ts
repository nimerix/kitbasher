import { afterEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Matrix4,
  PlaneGeometry,
  Quaternion,
  Vector3,
} from 'three';
import {
  facesUnderBrush,
  faceAdjacency,
  contiguousRemainder,
  readFace,
} from '../../src/core/surfaces';
import { fitPatchPlane, worldPlane } from '../../src/core/planes';
import {
  constraintsFromPatches,
  planeConstraintResidual,
  solvePlaneConstraints,
  validatePlaneConstraints,
} from '../../src/core/plane-constraints';
import { anchorError } from '../../src/core/constraints';
import { PrecisionDrag } from '../../src/core/precision';
import { parseScene } from '../../src/core/scene-file';
import { serializeScene } from '../helpers/legacy-scene';
import { captureComponents, instantiateComponents } from '../../src/core/clipboard';
import { solveAlignment } from '../../src/core/alignment';
import { partMatrix } from '../../src/core/geometry';
import { useEditor } from '../../src/core/store';
import type {
  AssemblyOperation,
  Joint,
  Part,
  PlaneConstraint,
  PlaneConstraintKind,
  SceneDocument,
  SurfacePatch,
  Vec3,
} from '../../src/core/types';

function part(id: string, geometry: BufferGeometry = new PlaneGeometry(12, 12, 3, 3)): Part {
  return {
    id,
    name: id,
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#aaaaaa',
    visible: true,
    locked: false,
    source: 'test',
  };
}
const patch = (part: Part): SurfacePatch => ({
  partId: part.id,
  faces: Array.from(
    { length: (part.geometry.index?.count ?? part.geometry.getAttribute('position').count) / 3 },
    (_, i) => i,
  ),
});
function constraint(
  kind: PlaneConstraintKind = 'mate',
  sourceId = 'source',
  targetId = 'target',
): PlaneConstraint {
  return {
    id: 'c',
    name: 'Plate mate',
    sourceId,
    targetId,
    sourcePlane: { point: [0, 0, 0], normal: [0, 0, 1] },
    targetPlane: { point: [0, 0, 0], normal: [0, 0, 1] },
    kind,
    angle: 35,
    offset: 2,
    opposed: false,
    enabled: true,
  };
}
const original = useEditor.getState();
afterEach(() => useEditor.setState(original));

function strip(bent = false, separate = false) {
  const values: number[] = [];
  for (let x = 0; x < 3; x++) {
    const height = (x: number) => (bent ? Math.max(x - 1, 0) * 0.4 : 0);
    const a = [x, 0, height(x)],
      b = [x + 1, 0, height(x + 1)],
      c = [x + 1, 1, height(x + 1)],
      d = [x, 1, height(x)];
    values.push(...a, ...b, ...c, ...a, ...c, ...d);
  }
  if (separate) values.push(0, 1.1, 0, 1, 1.1, 0, 1, 2.1, 0, 0, 1.1, 0, 1, 2.1, 0, 0, 2.1, 0);
  return new BufferGeometry().setAttribute(
    'position',
    new BufferAttribute(new Float32Array(values), 3),
  );
}

it('rejects isotropic surface patches that do not define a unique fitted plane', () => {
  const source = part('ambiguous', new BoxGeometry(10, 10, 10));
  expect(() => fitPatchPlane(source, patch(source))).toThrow('flatter patch');
});

describe('AC-2: continuous gizmo precision', () => {
  it('accumulates fine increments without jumps when Shift toggles mid-drag', () => {
    const raw = new Matrix4(),
      motion = new PrecisionDrag(raw);
    expect(motion.update(new Matrix4().makeTranslation(10, 0, 0), 1)!.elements[12]).toBeCloseTo(10);
    expect(motion.update(new Matrix4().makeTranslation(10, 0, 0), 0.1)!.elements[12]).toBeCloseTo(
      10,
    );
    expect(motion.update(new Matrix4().makeTranslation(20, 0, 0), 0.1)!.elements[12]).toBeCloseTo(
      11,
    );
    expect(motion.update(new Matrix4().makeTranslation(20, 0, 0), 1)!.elements[12]).toBeCloseTo(11);
    expect(motion.update(new Matrix4().makeTranslation(30, 0, 0), 1)!.elements[12]).toBeCloseTo(21);
  });
  it('reduces rotation and scale about a distant pivot and retains one undo checkpoint', () => {
    const initial = new Matrix4().makeTranslation(30, -20, 3),
      motion = new PrecisionDrag(initial);
    const raw = new Matrix4().compose(
      new Vector3(30, -20, 3),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 1),
      new Vector3(2, 2, 2),
    );
    const delta = motion.update(raw, 0.1)!,
      position = new Vector3(),
      rotation = new Quaternion(),
      scale = new Vector3();
    delta.clone().multiply(initial).decompose(position, rotation, scale);
    expect(position.toArray()).toEqual([30, -20, 3]);
    expect(rotation.angleTo(new Quaternion())).toBeCloseTo(0.1, 8);
    expect(scale.x).toBeCloseTo(2 ** 0.1, 8);
    const source = part('source');
    useEditor.getState().setScene({ name: 'Precision', parts: [source], joints: [] });
    useEditor.getState().transform('source', { position: [10, 0, 0] }, true);
    useEditor.getState().transform('source', { position: [11, 0, 0] }, false);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts[0].position).toEqual([0, 0, 0]);
  });
});

describe('AC-3/4: connected plane paint', () => {
  it('welds duplicate nonindexed edges, caches adjacency, and excludes disconnected coplanar surfaces', () => {
    const source = part('source', strip(false, true));
    const hit = { partId: source.id, point: [0.5, 0.5, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
    expect(facesUnderBrush(source, hit, 10, 0)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(faceAdjacency(source.geometry)).toBe(faceAdjacency(source.geometry));
    const selected: SurfacePatch = { ...patch(source), faces: [0, 1], seed: { ...hit, face: 0 } };
    const island = { ...hit, point: [0.5, 1.6, 0] as Vec3 };
    expect(facesUnderBrush(source, island, 0.2, 6, { patch: selected })).toEqual([]);
  });
  it('keeps the original seed plane across later strokes and respects both distance and angle', () => {
    const source = part('source', strip(true));
    const hit = { partId: source.id, point: [0.5, 0.5, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
    const plane = { enabled: true, angle: 30, distance: 0.1 };
    const faces = facesUnderBrush(source, hit, 10, 0, { plane });
    expect(faces).toEqual([0, 1]);
    const selected = { partId: source.id, faces, seed: { ...hit, face: 0 } };
    const next = {
      ...hit,
      point: [1.5, 0.5, 0.2] as Vec3,
      normal: readFace(source.geometry, 2).getNormal(new Vector3()).toArray(),
    };
    expect(facesUnderBrush(source, next, 10, 2, { plane, patch: selected })).toEqual([]);
    expect(
      facesUnderBrush(source, hit, 10, 0, { plane: { ...plane, angle: 5, distance: 100 } }),
    ).toEqual([0, 1]);
    expect(facesUnderBrush(source, hit, 10, 0)).toEqual([0, 1, 2, 3, 4, 5]);
  });
  it('retains one component after erasing a bridge and rejects a remote subsequent store stroke', () => {
    const source = part('source', strip(false, true));
    expect(contiguousRemainder(source.geometry, [0, 1, 4, 5], 0)).toEqual([0, 1]);
    expect(contiguousRemainder(source.geometry, [4, 5, 6, 7])).toHaveLength(2);
    useEditor.getState().setScene({ name: 'Paint', parts: [source], joints: [] });
    useEditor.getState().select(source.id);
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({ mode: 'surface' });
    useEditor.getState().setBrush({ radius: 0.2 });
    const hit = { partId: source.id, point: [0.5, 0.5, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
    useEditor.getState().paintSurface(hit, 0, false, true);
    useEditor.getState().endPaintStroke();
    const before = useEditor.getState().operation.surfacePairs[0].source;
    expect(
      useEditor.getState().paintSurface({ ...hit, point: [0.5, 1.6, 0] }, 6, false, true),
    ).toBe(false);
    expect(useEditor.getState().operation.surfacePairs[0].source).toBe(before);
  });
});

describe('AC-5: fitted planes and coarse alignment', () => {
  it('fits identical planes across tessellation, distant origins, and nonuniform scale', () => {
    for (const segments of [1, 9]) {
      const source = part('source', new PlaneGeometry(12, 12, segments, segments));
      source.position = [120000, 30, -80000];
      source.scale = [2, 0.5, 3];
      source.quaternion = new Quaternion().setFromEuler(new Euler(0.4, -0.2, 0.7)).toArray();
      const fit = fitPatchPlane(source, patch(source)),
        world = worldPlane(source, fit.plane);
      expect(world.point.distanceTo(new Vector3(...source.position))).toBeLessThan(1e-8);
      expect(
        world.normal.angleTo(
          new Vector3(0, 0, 1).applyQuaternion(new Quaternion(...source.quaternion)),
        ),
      ).toBeLessThan(1e-7);
      expect(fit.rms).toBeLessThan(1e-6);
      expect(fit.area).toBeCloseTo(144, 5);
    }
  });
  it.each(['mate', 'parallel', 'perpendicular', 'angle'] as const)(
    'applies %s with one pair, keeping available translation freedom',
    (kind) => {
      const source = part('source'),
        target = part('target');
      source.position = [11, -7, 8];
      source.quaternion = new Quaternion().setFromEuler(new Euler(0.3, 0.4, 0.2)).toArray();
      target.locked = true;
      const op: AssemblyOperation = {
        ...original.operation,
        mode: 'surface',
        sourceId: source.id,
        targetId: target.id,
        surfaceMethod: kind,
        planeAngle: 42,
        flipNormal: false,
        offset: 1.5,
        surfacePairs: [{ id: 'pair', source: patch(source), target: patch(target) }],
      };
      const scene: SceneDocument = { name: kind, parts: [source, target], joints: [] };
      const result = solveAlignment(scene, op),
        placed = result.parts[0];
      const c = constraintsFromPatches(scene, op)[0];
      expect(planeConstraintResidual(result.parts, c).satisfied).toBe(true);
      expect(placed.position[0]).toBeCloseTo(11, 7);
      expect(placed.position[1]).toBeCloseTo(-7, 7);
      expect(placed.position[2]).toBeCloseTo(kind === 'mate' ? 1.5 : 8, 7);
      expect(result.parts[1]).toBe(target);
      expect(placed.scale).toEqual(source.scale);
    },
  );
  it('rejects empty and degenerate painted planes', () => {
    const source = part('source');
    expect(() => fitPatchPlane(source, { partId: source.id, faces: [] })).toThrow('measurable');
    expect(() => fitPatchPlane(source, { partId: source.id, faces: [999999] })).toThrow(
      'missing triangle',
    );
    source.geometry = new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), 3),
    );
    expect(() => fitPatchPlane(source, { partId: source.id, faces: [0] })).toThrow('measurable');
  });
});

describe('AC-6/7: persistent plane relationships', () => {
  function scene(): SceneDocument {
    const source = part('source'),
      target = part('target');
    source.position = [5, 6, 2];
    return {
      name: 'Constrained assembly',
      parts: [source, target],
      joints: [],
      constraints: [constraint()],
    };
  }
  it('projects source moves while preserving planar sliding, twist, target movement, and undo/redo', () => {
    useEditor.getState().setScene(scene());
    useEditor.getState().transform('source', { position: [14, -9, 20] });
    expect(useEditor.getState().scene.parts[0].position).toEqual([14, -9, 2]);
    useEditor.getState().transform('source', {
      quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.5).toArray(),
    });
    expect(useEditor.getState().scene.parts[0].quaternion[2]).toBeCloseTo(Math.sin(0.25));
    useEditor.getState().transform('target', {
      position: [0, 0, 12],
      quaternion: new Quaternion().setFromEuler(new Euler(0.3, 0.1, 0)).toArray(),
    });
    const current = useEditor.getState().scene;
    expect(planeConstraintResidual(current.parts, current.constraints![0]).satisfied).toBe(true);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts[1].position).toEqual([0, 0, 0]);
    useEditor.getState().redo();
    expect(useEditor.getState().scene.parts[1].position).toEqual([0, 0, 12]);
  });
  it('uses every plane pair together and propagates a chain in dependency order', () => {
    const source = part('source'),
      target = part('target'),
      root = part('root');
    root.locked = true;
    const first = constraint(),
      second = { ...constraint('mate', 'target', 'root'), id: 'c2' };
    const document: SceneDocument = {
      name: 'Chain',
      parts: [source, target, root],
      joints: [],
      constraints: [first, second],
    };
    const parts = solvePlaneConstraints(document, document.parts);
    expect(parts[0].position[2]).toBeCloseTo(4);
    expect(parts[1].position[2]).toBeCloseTo(2);
    const twoPlanes = scene();
    twoPlanes.constraints!.push({
      ...constraint(),
      id: 'second plane',
      offset: 0,
      sourcePlane: { point: [0, 0, 0], normal: [1, 0, 0] },
      targetPlane: { point: [0, 0, 0], normal: [1, 0, 0] },
    });
    const placed = solvePlaneConstraints(twoPlanes, twoPlanes.parts);
    expect(placed[0].position).toEqual([0, 6, 2]);
    expect(twoPlanes.constraints!.every((c) => planeConstraintResidual(placed, c).satisfied)).toBe(
      true,
    );
  });
  it('edits angle/offset, suppresses, reconnects, deletes, and retains new painted constraints', () => {
    useEditor.getState().setScene(scene());
    useEditor.getState().updateConstraint('c', { offset: 3 });
    expect(useEditor.getState().scene.parts[0].position[2]).toBeCloseTo(3);
    useEditor.getState().updateConstraint('c', { kind: 'angle', angle: 28 });
    const changed = useEditor.getState().scene;
    expect(planeConstraintResidual(changed.parts, changed.constraints![0]).satisfied).toBe(true);
    useEditor.getState().updateConstraint('c', { enabled: false });
    useEditor.getState().transform('source', { position: [20, 0, 20], quaternion: [0, 0, 0, 1] });
    expect(useEditor.getState().scene.parts[0].position[2]).toBe(20);
    useEditor.getState().updateConstraint('c', { enabled: true });
    expect(
      planeConstraintResidual(
        useEditor.getState().scene.parts,
        useEditor.getState().scene.constraints![0],
      ).satisfied,
    ).toBe(true);
    useEditor.getState().removeConstraint('c');
    expect(useEditor.getState().scene.constraints).toHaveLength(0);
    const [source, target] = useEditor.getState().scene.parts;
    useEditor.getState().select('source');
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({
      mode: 'surface',
      sourceId: 'source',
      targetId: 'target',
      surfaceMethod: 'mate',
      retainConstraint: true,
      flipNormal: false,
    });
    useEditor.getState().setOperation({
      surfacePairs: [{ id: 'patch', source: patch(source), target: patch(target) }],
    });
    useEditor.getState().applyAlignment();
    expect(useEditor.getState().tool).toBe('select');
    expect(useEditor.getState().scene.constraints).toHaveLength(1);
    expect(
      planeConstraintResidual(
        useEditor.getState().scene.parts,
        useEditor.getState().scene.constraints![0],
      ).satisfied,
    ).toBe(true);
  });
  it('rejects conflicting planes, cycles, locked followers, and invalid parameters without mutating the scene', () => {
    const document = scene();
    expect(() =>
      solvePlaneConstraints(
        {
          ...document,
          constraints: [...document.constraints!, { ...constraint(), id: 'conflict', offset: 3 }],
        },
        document.parts,
      ),
    ).toThrow('Cannot satisfy');
    expect(() =>
      validatePlaneConstraints({
        ...document,
        constraints: [
          ...document.constraints!,
          { ...constraint('mate', 'target', 'source'), id: 'cycle' },
        ],
      }),
    ).toThrow('circular');
    document.parts[0].locked = true;
    useEditor.getState().setScene(document);
    const before = useEditor.getState().scene;
    useEditor.getState().transform('target', { position: [0, 0, 10] });
    expect(useEditor.getState().scene).toBe(before);
    expect(useEditor.getState().toast?.message).toContain('Cannot satisfy');
    useEditor.getState().updateConstraint('c', { angle: NaN });
    expect(useEditor.getState().scene).toBe(before);
  });
  it('coexists with a free joint axis and refuses to break a fixed joint', () => {
    const document = scene();
    document.parts[0].position = [0, 0, 0];
    document.parts[1].locked = true;
    const joint: Joint = {
      id: 'j',
      name: 'Hinge',
      parentId: 'target',
      childId: 'source',
      parentAnchor: [0, 0, 0],
      childAnchor: [0, 0, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, false, true],
      keepConnected: true,
    };
    document.joints = [joint];
    document.constraints = [
      { ...constraint('parallel'), targetPlane: { point: [0, 0, 0], normal: [1, 0, 0] } },
    ];
    const parts = solvePlaneConstraints(document, document.parts);
    expect(anchorError(parts, joint)).toBeLessThan(1e-7);
    expect(planeConstraintResidual(parts, document.constraints[0]).satisfied).toBe(true);
    document.joints = [{ ...joint, rotationLocks: [true, true, true] }];
    expect(() => solvePlaneConstraints(document, document.parts)).toThrow('Cannot satisfy');
  });
  it('round trips constraints, accepts old scenes, and rejects malformed frames or references', () => {
    const document = scene(),
      file = serializeScene(document);
    const loaded = parseScene(JSON.parse(JSON.stringify(file)));
    expect(loaded.constraints).toEqual(document.constraints);
    delete file.constraints;
    expect(parseScene(file).constraints).toEqual([]);
    file.constraints = [{ ...constraint(), sourcePlane: { point: [0, 0, 0], normal: [0, 0, 0] } }];
    expect(() => parseScene(file)).toThrow('invalid plane');
    file.constraints = [{ ...constraint(), sourceId: 'missing' }];
    expect(() => parseScene(file)).toThrow('existing parts');
  });
  it('copies only internal constraints, remaps endpoints, and cleans up delete/cut/merge with undo', () => {
    const document = scene();
    expect(captureComponents(document, ['source']).constraints).toHaveLength(0);
    const copies = instantiateComponents(
      captureComponents(document, ['source', 'target']),
      document.parts,
    );
    expect(copies.constraints).toHaveLength(1);
    expect(copies.constraints[0].id).not.toBe('c');
    expect(copies.constraints[0].sourceId).toBe(copies.parts[0].id);
    expect(copies.constraints[0].targetId).toBe(copies.parts[1].id);
    expect(planeConstraintResidual(copies.parts, copies.constraints[0]).satisfied).toBe(true);
    useEditor.getState().setScene(document);
    useEditor.getState().select('source');
    useEditor.getState().deleteSelected();
    expect(useEditor.getState().scene.constraints).toHaveLength(0);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.constraints).toHaveLength(1);
    useEditor.getState().select('source');
    useEditor.getState().copySelected(true);
    expect(useEditor.getState().scene.constraints).toHaveLength(0);
    useEditor.getState().undo();
    useEditor.getState().replaceWithMerged(part('merged'), ['source', 'target']);
    expect(useEditor.getState().scene.constraints).toHaveLength(0);
    useEditor.getState().undo();
    expect(
      partMatrix(useEditor.getState().scene.parts[0]).equals(partMatrix(document.parts[0])),
    ).toBe(true);
  });
});
