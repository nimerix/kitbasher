import { describe, expect, it } from 'vitest';
import { BoxGeometry, BufferAttribute, BufferGeometry, PlaneGeometry, SphereGeometry } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { buildWarpRegion, regionTriangleOf, WarpRole } from '../../src/core/warp-region';

describe('buildWarpRegion', () => {
  it('treats a whole closed mesh as interior with no border', () => {
    const r = buildWarpRegion(new SphereGeometry(10, 16, 12), null);
    expect(r.role.filter((x) => x === WarpRole.Border).length).toBe(0);
    expect(r.interiorCount).toBe(r.weldedCount);
  });
  it('treats painting every face the same as whole', () => {
    const g = new SphereGeometry(10, 16, 12);
    const all = [...Array(triangleCount(g)).keys()];
    expect(buildWarpRegion(g, all).role).toEqual(buildWarpRegion(g, null).role);
  });
  it('marks vertices shared with unpainted faces as border', () => {
    const g = new PlaneGeometry(10, 10, 4, 4);
    const r = buildWarpRegion(g, [10, 11, 12, 13, 18, 19, 20, 21]);
    expect(r.interiorCount).toBe(1);
    expect(r.role.filter((x) => x === WarpRole.Border).length).toBe(8);
  });
  it('welds a non-indexed mesh to the same topology as its indexed form', () => {
    const indexed = buildWarpRegion(new BoxGeometry(4, 4, 4, 2, 2, 2), null);
    const soup = buildWarpRegion(new BoxGeometry(4, 4, 4, 2, 2, 2).toNonIndexed(), null);
    expect(soup.weldedCount).toBe(indexed.weldedCount);
    expect(soup.triangles).toEqual(indexed.triangles);
  });
});

describe('buildWarpRegion interior lists', () => {
  it('lists the interior welded vertices and every geometry vertex of them, ascending', () => {
    for (const g of [
      new SphereGeometry(10, 16, 12, 0, Math.PI),
      new SphereGeometry(10, 16, 12, 0, Math.PI).toNonIndexed(),
    ]) {
      const r = buildWarpRegion(g, [...Array(120).keys()]);
      const interior = [...Array(r.weldedCount).keys()].filter(
        (v) => r.role[v] === WarpRole.Interior,
      );
      const vertices = [...r.weldOf.keys()].filter(
        (i) => r.weldOf[i] !== 0xffffffff && r.role[r.weldOf[i]] === WarpRole.Interior,
      );
      expect(interior.length).toBeGreaterThan(0);
      expect([...r.interior]).toEqual(interior);
      expect([...r.interiorVertices]).toEqual(vertices);
      expect(r.interiorCount).toBe(interior.length);
    }
  });
});

describe('buildWarpRegion outputs', () => {
  const painted = [10, 11, 12, 13, 18, 19, 20, 21];
  const plane = () => new PlaneGeometry(10, 10, 4, 4);
  const row = (r: ReturnType<typeof buildWarpRegion>, v: number) => [
    ...r.adjacency.subarray(r.adjacencyStart[v], r.adjacencyStart[v + 1]),
  ];

  it('lists the interior vertex neighbours sorted and distinct', () => {
    const g = plane();
    const r = buildWarpRegion(g, painted);
    const centre = r.weldOf[12];
    const neighbours = row(r, centre);
    expect(neighbours.length).toBe(6);
    expect(neighbours).toEqual([...new Set(neighbours)].sort((a, b) => a - b));
    expect(r.role[centre]).toBe(WarpRole.Interior);
  });
  it('builds symmetric adjacency with empty rows outside the region', () => {
    const r = buildWarpRegion(plane(), painted);
    for (let v = 0; v < r.weldedCount; v++) {
      if (r.role[v] === WarpRole.Outside) expect(row(r, v)).toEqual([]);
      for (const n of row(r, v)) expect(row(r, n)).toContain(v);
    }
    expect(r.adjacencyStart[r.weldedCount]).toBe(r.adjacency.length);
  });
  it('maps region faces to their welded corners', () => {
    const g = plane();
    const r = buildWarpRegion(g, painted);
    expect([...r.faces]).toEqual(painted);
    r.faces.forEach((face, t) => {
      for (let k = 0; k < 3; k++)
        expect(r.triangles[t * 3 + k]).toBe(r.weldOf[g.index!.getX(face * 3 + k)]);
    });
  });
  it('keeps the first-used vertex position as rest', () => {
    const g = new BoxGeometry(4, 4, 4, 2, 2, 2);
    const r = buildWarpRegion(g, null);
    const position = g.getAttribute('position');
    const first = new Map<number, number>();
    for (let i = 0; i < g.index!.count; i++) {
      const vertex = g.index!.getX(i);
      if (!first.has(r.weldOf[vertex])) first.set(r.weldOf[vertex], vertex);
    }
    for (const [welded, vertex] of first)
      expect([...r.rest.subarray(welded * 3, welded * 3 + 3)]).toEqual([
        position.getX(vertex),
        position.getY(vertex),
        position.getZ(vertex),
      ]);
  });
  it('flags a geometry vertex no face uses', () => {
    const g = new BufferGeometry();
    g.setAttribute(
      'position',
      new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 5, 5, 5]), 3),
    );
    g.setIndex([0, 1, 2]);
    const r = buildWarpRegion(g, null);
    expect(r.weldOf[3]).toBe(0xffffffff);
    expect(r.weldedCount).toBe(3);
  });
});

describe('regionTriangleOf', () => {
  it('finds each region face and returns -1 for faces outside the region', () => {
    const painted = [10, 11, 12, 13, 18, 19, 20, 21];
    const r = buildWarpRegion(new PlaneGeometry(10, 10, 4, 4), painted);
    painted.forEach((face, i) => expect(regionTriangleOf(r, face)).toBe(i));
    for (const face of [0, 9, 14, 17, 22, 31, -1]) expect(regionTriangleOf(r, face)).toBe(-1);
    expect(regionTriangleOf(buildWarpRegion(new PlaneGeometry(10, 10, 4, 4), []), 0)).toBe(-1);
  });
});
