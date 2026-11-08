import { afterEach, describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  Euler,
  Quaternion,
  Triangle,
  Vector3,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { partMatrix, partPivot, poseAtPivot, transformFromMatrix } from '../../src/core/geometry';
import { surfaceAlignment, surfaceResidual } from '../../src/core/surface-fit';
import { facesUnderBrush } from '../../src/core/surfaces';
import { solveAlignment } from '../../src/core/alignment';
import { anchorError } from '../../src/core/constraints';
import { selectionOrbitCenter } from '../../src/core/navigation';
import { parseScene, serializeScene } from '../../src/core/scene-file';
import { useEditor } from '../../src/core/store';
import type { AssemblyOperation, Part, SurfacePair, Vec3 } from '../../src/core/types';

function fixture(reverse = false, subdivisions = 3, fourthOffset = 0) {
  const positions: number[] = [],
    patches: number[][] = [];
  const centers = [
    [-12, 0, 0],
    [12, 0, 0],
    [0, 22, 0],
    [20 + fourthOffset, 24, 0],
  ];
  for (const center of centers) {
    const faces: number[] = [];
    for (let x = 0; x < subdivisions; x++)
      for (let y = 0; y < subdivisions; y++) {
        const point = (dx: number, dy: number) =>
          new Vector3(
            center[0] - 3 + ((x + dx) * 6) / subdivisions,
            center[1] - 3 + ((y + dy) * 6) / subdivisions,
            0,
          ).toArray();
        const a = point(0, 0),
          b = point(1, 0),
          c = point(1, 1),
          d = point(0, 1);
        faces.push(positions.length / 9, positions.length / 9 + 1);
        positions.push(
          ...a,
          ...(reverse ? c : b),
          ...(reverse ? b : c),
          ...a,
          ...(reverse ? d : c),
          ...(reverse ? c : d),
        );
      }
    patches.push(faces);
  }
  return {
    geometry: new BufferGeometry().setAttribute(
      'position',
      new BufferAttribute(new Float32Array(positions), 3),
    ),
    patches,
  };
}
function part(id: string, geometry: BufferGeometry): Part {
  return {
    id,
    name: id,
    geometry,
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked: false,
    source: 'surface test',
  };
}
function setup(count = 3, targetSegments = 3, fourthOffset = 0) {
  const a = fixture(),
    b = fixture(true, targetSegments, fourthOffset);
  const source = part('moving', a.geometry),
    target = part('target', b.geometry);
  const surfacePairs: SurfacePair[] = a.patches.slice(0, count).map((faces, i) => ({
    id: `pair-${i}`,
    source: { partId: source.id, faces },
    target: { partId: target.id, faces: b.patches[i] },
  }));
  const op: AssemblyOperation = {
    ...useEditor.getState().operation,
    mode: 'surface',
    sourceId: source.id,
    targetId: target.id,
    surfacePairs,
    pairs: [],
    pending: null,
    activeSurface: null,
    flipNormal: true,
    offset: 0,
  };
  return { source, target, op };
}
const original = useEditor.getState();
afterEach(() => useEditor.setState(original));

describe('painted contact fitting', () => {
  it('recovers a rigid placement from painted surfaces with different tessellation and opposite normals', () => {
    const { source, target, op } = setup(4, 11);
    source.position = [-20, 14, -8];
    source.quaternion = new Quaternion().setFromEuler(new Euler(0.5, -0.3, 0.8)).toArray();
    target.position = [17, 11, 5];
    target.quaternion = new Quaternion().setFromEuler(new Euler(-0.4, 0.6, -0.2)).toArray();
    const result = surfaceAlignment(source, target, op);
    const placed = transformFromMatrix(source, result.matrix.clone().multiply(partMatrix(source)));
    expect(result.rms).toBeLessThan(0.00001);
    expect(
      new Vector3(...placed.position).distanceTo(new Vector3(...target.position)),
    ).toBeLessThan(0.00001);
    expect(
      new Quaternion(...placed.quaternion).angleTo(new Quaternion(...target.quaternion)),
    ).toBeLessThan(0.00001);
    placed.scale.forEach((value, i) => expect(value).toBeCloseTo(source.scale[i], 10));
    expect(surfaceResidual(placed, target, op)).toBeLessThan(0.00001);
  });
  it('uses every pair, including a fourth inconsistent patch, in the least-squares fit', () => {
    const { source, target, op } = setup(4, 3, 2);
    const first = surfaceAlignment(source, target, {
      ...op,
      surfacePairs: op.surfacePairs.slice(0, 3),
    });
    const all = surfaceAlignment(source, target, op);
    expect(first.rms).toBeLessThan(1e-6);
    expect(
      new Vector3()
        .setFromMatrixPosition(all.matrix)
        .distanceTo(new Vector3().setFromMatrixPosition(first.matrix)),
    ).toBeGreaterThan(0.01);
    expect(all.rms).toBeGreaterThan(0.01);
  });
  it('fits a positive contact clearance along target normals', () => {
    const { source, target, op } = setup();
    op.offset = 1.5;
    const result = surfaceAlignment(source, target, op);
    expect(new Vector3().setFromMatrixPosition(result.matrix).z).toBeCloseTo(-1.5, 5);
    expect(result.rms).toBeLessThan(1e-5);
  });
  it('requires three complete, spatially useful pairs on the chosen parts', () => {
    const { source, target, op } = setup();
    expect(() =>
      surfaceAlignment(source, target, { ...op, surfacePairs: op.surfacePairs.slice(0, 2) }),
    ).toThrow('three complete');
    expect(() =>
      surfaceAlignment(source, target, {
        ...op,
        surfacePairs: [...op.surfacePairs, { id: 'empty', source: null, target: null }],
      }),
    ).toThrow('incomplete');
    expect(() =>
      surfaceAlignment(source, target, {
        ...op,
        surfacePairs: op.surfacePairs.map((pair) => ({
          ...pair,
          source: { ...pair.source!, partId: 'wrong' },
        })),
      }),
    ).toThrow('same moving');
    expect(() =>
      surfaceAlignment(source, target, {
        ...op,
        surfacePairs: op.surfacePairs.map((pair) => ({
          ...pair,
          source: op.surfacePairs[0].source,
          target: op.surfacePairs[0].target,
        })),
      }),
    ).toThrow('Spread');
  });
  it('keeps a fixed target and connected anchor, reporting the actual constrained contact error', () => {
    const { source, target, op } = setup();
    target.position = [5, 10, 8];
    target.locked = true;
    const parent = part('parent', new BoxGeometry(1, 1, 1));
    parent.locked = true;
    const joint = {
      id: 'joint',
      name: 'Pinned',
      parentId: parent.id,
      childId: source.id,
      parentAnchor: [0, 0, 0] as Vec3,
      childAnchor: [0, 0, 0] as Vec3,
      restRotation: [0, 0, 0, 1] as [number, number, number, number],
      rotationLocks: [true, true, true] as [boolean, boolean, boolean],
      keepConnected: true,
    };
    const result = solveAlignment(
      { name: 'Pinned fit', parts: [source, target, parent], joints: [joint] },
      op,
    );
    const placed = result.parts.find((part) => part.id === source.id)!;
    expect(result.constrained).toBe(true);
    expect(result.rms).toBeGreaterThan(5);
    expect(anchorError(result.parts, joint)).toBeLessThan(1e-8);
    expect(result.rms).toBeCloseTo(surfaceResidual(placed, target, op), 8);
    expect(result.parts.find((part) => part.id === target.id)).toBe(target);
  });
});

describe('surface paint brush', () => {
  it('clears a reference-plane target when switching to painting and keeps valid part targets', () => {
    const { source, target } = setup();
    useEditor.getState().setScene({ name: 'Targets', parts: [source, target], joints: [] });
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({ mode: 'plane', targetId: 'reference-plane' });
    useEditor.getState().setOperation({ mode: 'surface' });
    expect(useEditor.getState().operation.targetId).toBeNull();
    useEditor.getState().setOperation({ mode: 'plane', targetId: target.id });
    useEditor.getState().setOperation({ mode: 'surface' });
    expect(useEditor.getState().operation.targetId).toBe(target.id);
    expect(useEditor.getState().operation.surfacePairs).toHaveLength(1);
  });
  it('uses world-space radius on scaled meshes, selects multiple triangles, and respects the face direction', () => {
    const geometry = new BoxGeometry(10, 10, 0.1, 12, 12, 1),
      source = part('a', geometry);
    source.scale = [2, 0.5, 1];
    const hit = { partId: 'a', point: [0, 0, 0.05] as Vec3, normal: [0, 0, 1] as Vec3 };
    const faces = facesUnderBrush(source, hit, 1.2, 600);
    expect(faces.length).toBeGreaterThan(4);
    const normal = new Vector3(),
      tri = new Triangle();
    for (const face of faces) {
      const positions = geometry.getAttribute('position'),
        index = geometry.index!;
      tri.a.fromBufferAttribute(positions, index.getX(face * 3));
      tri.b.fromBufferAttribute(positions, index.getX(face * 3 + 1));
      tri.c.fromBufferAttribute(positions, index.getX(face * 3 + 2));
      expect(tri.getNormal(normal).z).toBeGreaterThan(0.9);
    }
    geometry.boundsTree = new MeshBVH(geometry, { indirect: true });
    expect(facesUnderBrush(source, hit, 1.2, 600)).toEqual(faces);
  });
  it('paints and erases actual triangle sets, and restores a whole stroke', () => {
    const { source, target } = setup();
    useEditor.getState().setScene({ name: 'Brush', parts: [source, target], joints: [] });
    useEditor.getState().select(source.id);
    useEditor.getState().setTool('align');
    useEditor.getState().setOperation({ mode: 'surface' });
    const hit = { partId: source.id, point: [-12, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 };
    expect(useEditor.getState().paintSurface(hit, 0, false, true)).toBe(true);
    useEditor.getState().endPaintStroke();
    const painted = useEditor.getState().operation.surfacePairs[0].source!.faces;
    expect(painted.length).toBeGreaterThan(1);
    useEditor.getState().paintSurface(hit, 0, true, true);
    useEditor.getState().endPaintStroke();
    expect(useEditor.getState().operation.surfacePairs[0].source?.faces).toHaveLength(0);
    useEditor.getState().undoPaintStroke();
    expect(useEditor.getState().operation.surfacePairs[0].source!.faces).toEqual(painted);
  });
});

describe('picked model pivots', () => {
  it('holds a custom pivot fixed for rotation and nonuniform scale, and follows translation for orbit', () => {
    const source = part('a', new BoxGeometry(10, 10, 10));
    source.pivot = [5, 4, 3];
    source.scale = [1.5, 0.7, 2];
    const pivot = partPivot(source);
    const moved = poseAtPivot(source, {
      quaternion: new Quaternion().setFromEuler(new Euler(0.8, 0.5, -0.3)).toArray(),
      scale: [2, 1, 0.6],
    });
    expect(partPivot(moved).distanceTo(pivot)).toBeLessThan(1e-8);
    moved.position[0] += 8;
    expect(
      selectionOrbitCenter([moved], ['a'])!.distanceTo(pivot.clone().add(new Vector3(8, 0, 0))),
    ).toBeLessThan(1e-8);
    expect(partPivot(moved, [0, 0, 0]).distanceTo(new Vector3(...moved.position))).toBeLessThan(
      1e-8,
    );
  });
  it('supports click, undo/redo, reset, scene save/reopen, and legacy scenes', () => {
    const source = part('a', new BoxGeometry(10, 10, 10));
    useEditor.getState().setScene({ name: 'Pivots', parts: [source], joints: [] });
    useEditor.getState().setPivotPicking(true);
    useEditor.getState().setPartPivot({ partId: source.id, point: [5, 2, 1], normal: [1, 0, 0] });
    expect(useEditor.getState().pivotPicking).toBe(false);
    const scene = useEditor.getState().scene;
    expect(parseScene(JSON.parse(JSON.stringify(serializeScene(scene)))).parts[0].pivot).toEqual([
      5, 2, 1,
    ]);
    useEditor.getState().undo();
    expect(useEditor.getState().scene.parts[0].pivot).toBeUndefined();
    useEditor.getState().redo();
    expect(useEditor.getState().scene.parts[0].pivot).toEqual([5, 2, 1]);
    useEditor.getState().clearPartPivot('a');
    expect(useEditor.getState().scene.parts[0].pivot).toBeUndefined();
    const file = serializeScene(scene);
    file.parts[0].pivot = [NaN, 0, 0];
    expect(() => parseScene(file)).toThrow('invalid part');
    delete file.parts[0].pivot;
    expect(parseScene(file).parts[0].pivot).toBeUndefined();
  });
});
