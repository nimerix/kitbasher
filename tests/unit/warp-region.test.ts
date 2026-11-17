import { describe, expect, it } from 'vitest';
import { BoxGeometry, PlaneGeometry, SphereGeometry } from 'three';
import { triangleCount } from '../../src/core/geometry';
import { buildWarpRegion, WarpRole } from '../../src/core/warp-region';

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
    expect(soup.triangles.length).toBe(indexed.triangles.length);
  });
});
