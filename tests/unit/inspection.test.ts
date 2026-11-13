import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4, PlaneGeometry, Quaternion, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { inspectMeshes, inspectionGeometry, solidVolume } from '../../src/core/inspection';
import type { InspectionMesh, InspectionProgress } from '../../src/core/inspection-types';

function box(id: string, x = 0, size = 10): InspectionMesh {
  const geometry = new BoxGeometry(size, size, size);
  return {
    id,
    name: id,
    positions: new Float32Array(geometry.getAttribute('position').array),
    indices: new Uint32Array(geometry.index!.array),
    matrix: new Matrix4().makeTranslation(x, 0, 0).toArray(),
  };
}

describe('interference inspection', () => {
  it('reports real stages and pair counts while leaving exact analysis unchanged', () => {
    const meshes = [box('a'), box('b', 8), box('far', 30)];
    const progress: InspectionProgress[] = [];
    const result = inspectMeshes({ meshes, distance: 0.5 }, (value) => progress.push(value));
    expect(result.pairs[0].volume).toBeCloseTo(200, 4);
    expect(result.checkedPairs).toBe(3);
    expect(
      progress.filter((value) => value.stage === 'pairs').map((value) => value.fraction),
    ).toEqual([0, 1 / 3, 2 / 3]);
    expect(progress.some((value) => value.stage === 'indexing' && value.fraction === 1)).toBe(true);
    expect(progress.find((value) => value.stage === 'overlap')).toMatchObject({
      detail: 'Calculating solid overlap for pair 1 of 3: a / b',
      fraction: null,
    });
    expect(progress.some((value) => value.stage === 'surfaces' && value.fraction === 1)).toBe(true);
    expect(progress.at(-1)).toMatchObject({ stage: 'finishing' });
    expect(
      progress.every(
        (value) => value.fraction === null || (value.fraction >= 0 && value.fraction <= 1),
      ),
    ).toBe(true);
  });

  it('returns the actual solid intersection and nearby surfaces without changing source meshes', () => {
    const meshes = [box('a'), box('b', 8)];
    const original = meshes.map((mesh) => Array.from(mesh.positions));
    const result = inspectMeshes({ meshes, distance: 0.5 });
    expect(result.overlaps).toHaveLength(1);
    expect(result.pairs[0].volume).toBeCloseTo(200, 4);
    expect(result.pairs[0].distance).toBeCloseTo(0, 5);
    expect(result.surfaces.map((surface) => surface.id)).toEqual(['a', 'b']);
    expect(result.checkedPairs).toBe(1);
    expect(result.solidPairs).toBe(1);
    expect(result.warnings).toEqual([]);
    expect(meshes.map((mesh) => Array.from(mesh.positions))).toEqual(original);
  });

  it('finds the full volume for coincident parts and clips the near band to its threshold', () => {
    const result = inspectMeshes({ meshes: [box('a'), box('b')], distance: 0.01 });
    expect(result.overlaps).toHaveLength(1);
    expect(result.pairs[0].volume).toBeCloseTo(1000, 5);
    expect(result.surfaces).toHaveLength(2);
    const nearby = inspectMeshes({ meshes: [box('a'), box('b', 10.25)], distance: 0.3 });
    // The face edge band is clipped at 0.3 mm, not expanded to entire coarse box faces.
    const surface = nearby.surfaces.find((item) => item.id === 'a')!;
    const bvh = new MeshBVH(inspectionGeometry(box('b', 10.25)));
    const hit = { point: new Vector3(), distance: 0, faceIndex: 0 };
    for (let i = 0; i < surface.positions.length; i += 3) {
      bvh.closestPointToPoint(new Vector3().fromArray(surface.positions, i), hit);
      expect(hit.distance).toBeLessThanOrEqual(0.3 + nearby.resolution + 1e-6);
    }
  });

  it('distinguishes separation, near contact, and touching without inventing overlap volume', () => {
    const near = inspectMeshes({ meshes: [box('a'), box('b', 10.25)], distance: 0.5 });
    expect(near.overlaps).toEqual([]);
    expect(near.surfaces).toHaveLength(2);
    expect(near.pairs[0].distance).toBeCloseTo(0.25, 6);
    const [a, b] = near.pairs[0].points.map((point) => new Vector3(...point));
    expect(a.distanceTo(b)).toBeCloseTo(0.25, 6);
    const outside = inspectMeshes({ meshes: [box('a'), box('b', 10.25)], distance: 0.2 });
    expect(outside.surfaces).toEqual([]);
    expect(outside.overlaps).toEqual([]);
    expect(outside.pairs).toEqual([]);
    const touching = inspectMeshes({ meshes: [box('a'), box('b', 10)], distance: 0.1 });
    expect(touching.overlaps).toEqual([]);
    expect(touching.surfaces).toHaveLength(2);
    expect(touching.pairs[0].volume).toBe(0);
    expect(touching.pairs[0].distance).toBeCloseTo(0, 6);
  });

  it('detects a fully contained part even when its surfaces are far from the outer shell', () => {
    const result = inspectMeshes({ meshes: [box('outer'), box('inner', 0, 2)], distance: 0.5 });
    expect(result.overlaps).toHaveLength(1);
    expect(result.pairs[0].volume).toBeCloseTo(8, 5);
    expect(result.pairs[0].distance).toBeCloseTo(4, 5);
    expect(result.surfaces).toEqual([]);
  });

  it('uses world transforms, including nonuniform scale and a reflection, at distant origins', () => {
    const a = box('a'),
      b = box('b');
    const pose = new Matrix4().compose(
      new Vector3(10000, -500, 1000),
      new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), 0.7),
      new Vector3(-2, 1, 0.5),
    );
    a.matrix = pose.toArray();
    b.matrix = pose
      .clone()
      .multiply(new Matrix4().makeTranslation(8, 0, 0))
      .toArray();
    const result = inspectMeshes({ meshes: [a, b], distance: 0.5 });
    expect(result.pairs[0].volume).toBeCloseTo(200, 1);
    expect(result.overlaps).toHaveLength(1);
    const geometry = inspectionGeometry(a);
    expect(solidVolume(geometry)).toBeCloseTo(1000, 1);
    geometry.dispose();
  });

  it('checks near surfaces on open scans while flagging the missing solid result', () => {
    const plane = new PlaneGeometry(100, 100);
    const a: InspectionMesh = {
      id: 'open',
      name: 'Open scan',
      positions: new Float32Array(plane.getAttribute('position').array),
      indices: new Uint32Array(plane.index!.array),
      matrix: new Matrix4().toArray(),
    };
    const b = box('small', 0, 2);
    b.matrix = new Matrix4().makeTranslation(0, 0, 1.2).toArray();
    const result = inspectMeshes({ meshes: [a, b], distance: 0.3 });
    expect(result.overlaps).toEqual([]);
    expect(result.solidPairs).toBe(0);
    expect(result.warnings[0]).toContain('Open scan');
    expect(result.pairs[0].volume).toBeNull();
    expect(result.pairs[0].distance).toBeCloseTo(0.2, 5);
    // The small contact patch is inside a coarse face: none of its original vertices is close.
    expect(
      result.surfaces.find((surface) => surface.id === 'open')!.positions.length,
    ).toBeGreaterThan(9);
    const positions = result.surfaces.find((surface) => surface.id === 'open')!.positions;
    for (let i = 0; i < positions.length; i += 3) {
      expect(Math.abs(positions[i])).toBeLessThan(1.5);
      expect(Math.abs(positions[i + 1])).toBeLessThan(1.5);
    }
  });

  it('rejects invalid distance settings', () => {
    for (const distance of [-1, Infinity, NaN])
      expect(() => inspectMeshes({ meshes: [box('a'), box('b')], distance })).toThrow('distance');
  });
});
