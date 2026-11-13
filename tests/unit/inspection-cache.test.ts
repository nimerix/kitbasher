import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, PlaneGeometry } from 'three';
import { Evaluator } from 'three-bvh-csg';
import { partMatrix } from '../../src/core/geometry';
import { inspectMeshes } from '../../src/core/inspection';
import { InspectionCache, inspectionInput, scopeInspection } from '../../src/core/inspection-cache';
import type { Part } from '../../src/core/types';

function part(id: string, x = 0): Part {
  return {
    id,
    name: id,
    geometry: new BoxGeometry(10, 10, 10),
    position: [x, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    visible: true,
    locked: false,
    color: '#ffffff',
    source: 'test',
  };
}

function inspect(parts: Part[], distance = 0.5) {
  return inspectMeshes({
    distance,
    meshes: parts.map((part) => ({
      id: part.id,
      name: part.name,
      positions: new Float32Array(part.geometry.getAttribute('position').array),
      indices: new Uint32Array(part.geometry.index!.array),
      matrix: partMatrix(part).toArray(),
    })),
  });
}

describe('inspection result reuse', () => {
  it('reuses all-parts results for selections without leaking third-party contact surfaces', () => {
    const parts = [part('a'), part('b', 8), part('c', 16)];
    const cache = new InspectionCache();
    const all = inspect(parts);
    cache.set(inspectionInput(parts, 0.5), all);
    expect(all.surfaces).toHaveLength(4);

    for (const selected of [
      [parts[0], parts[1]],
      [parts[0], parts[2]],
    ]) {
      const result = cache.get(inspectionInput(selected, 0.5));
      expect(result).toEqual(inspect(selected));
      // Projection shares completed overlay buffers; it never reruns or copies geometry.
      result!.surfaces.forEach((surface) => expect(all.surfaces).toContain(surface));
    }
    expect(cache.get(inspectionInput([...parts].reverse(), 0.5))).toBe(all);
  });

  it('filters open-mesh warnings and counts solid checks for distant pairs too', () => {
    const parts = [part('a'), part('b', 30), part('open', 60)];
    parts[2].geometry = new PlaneGeometry(10, 10);
    const all = inspect(parts);
    expect(all.warnings).toHaveLength(1);
    expect(scopeInspection(all, new Set(['a', 'b']))).toEqual(inspect(parts.slice(0, 2)));
    expect(scopeInspection(all, new Set(['a', 'open']))).toEqual(inspect([parts[0], parts[2]]));
  });

  it('retains failed solid checks and global partial-analysis warnings in projections', () => {
    const parts = [part('a'), part('b', 8), part('c', 30)];
    const evaluate = vi.spyOn(Evaluator.prototype, 'evaluate').mockImplementation(() => {
      throw new Error('test intersection failure');
    });
    try {
      const all = inspect(parts);
      expect(scopeInspection(all, new Set(['a', 'b']))).toEqual(inspect(parts.slice(0, 2)));
      expect(scopeInspection(all, new Set(['a', 'c']))).toEqual(inspect([parts[0], parts[2]]));
      all.warnings.push({ partIds: [], message: 'Surface band is incomplete' });
      expect(scopeInspection(all, new Set(['a', 'c'])).warnings).toEqual([
        { partIds: [], message: 'Surface band is incomplete' },
      ]);
    } finally {
      evaluate.mockRestore();
    }
  });

  it('invalidates changed placement, geometry, or distance while ignoring display metadata', () => {
    const parts = [part('a'), part('b', 8)];
    const cache = new InspectionCache();
    const result = inspect(parts);
    cache.set(inspectionInput(parts, 0.5), result);
    expect(
      cache.get(
        inspectionInput(
          [{ ...parts[0], color: '#123456', locked: true, visible: false }, parts[1]],
          0.5,
        ),
      ),
    ).toBe(result);
    for (const patch of [
      { position: [1, 0, 0] },
      { quaternion: [0, 1, 0, 0] },
      { scale: [2, 1, 1] },
      { geometry: new BoxGeometry(20, 20, 20) },
      { name: 'Renamed part' },
    ] as Partial<Part>[]) {
      expect(cache.get(inspectionInput([{ ...parts[0], ...patch }, parts[1]], 0.5))).toBeNull();
    }
    expect(cache.get(inspectionInput(parts, 0.75))).toBeNull();
    expect(cache.get(inspectionInput([...parts, part('new')], 0.5))).toBeNull();
    parts[0].geometry.translate(1, 0, 0);
    expect(cache.get(inspectionInput(parts, 0.5))).toBeNull();
  });

  it('keeps disjoint completed selections and never uses a subset as a full result', () => {
    const parts = [part('a'), part('b', 30), part('c', 60)];
    const cache = new InspectionCache();
    for (const selected of [parts.slice(0, 2), parts.slice(1)]) {
      cache.set(inspectionInput(selected, 0.5), inspect(selected));
    }
    expect(cache.get(inspectionInput(parts, 0.5))).toBeNull();
    expect(cache.get(inspectionInput(parts.slice(0, 2), 0.5))).toEqual(inspect(parts.slice(0, 2)));
    const all = inspect(parts);
    cache.set(inspectionInput(parts, 0.5), all);
    expect(cache.get(inspectionInput(parts, 0.5))).toBe(all);
  });
});
