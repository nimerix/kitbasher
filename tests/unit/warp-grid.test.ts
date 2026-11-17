import { describe, expect, it } from 'vitest';
import { BoxGeometry, SphereGeometry } from 'three';
import { buildWarpGrid, warpDensityNodes } from '../../src/core/warp-grid';
import { buildWarpRegion, WarpRole } from '../../src/core/warp-region';

describe('buildWarpGrid', () => {
  it('keeps every border vertex as a fixed node', async () => {
    const g = new SphereGeometry(10, 64, 48);
    const faces = [...Array(1500).keys()];
    const region = buildWarpRegion(g, faces);
    const grid = await buildWarpGrid(region, 0);
    for (let v = 0; v < region.weldedCount; v++)
      if (region.role[v] === WarpRole.Border) {
        expect(grid.nodeOf[v]).not.toBe(0xffffffff);
        expect(grid.fixed[grid.nodeOf[v]]).toBe(1);
      }
  });
  it('approaches the requested node count on a whole mesh', async () => {
    const region = buildWarpRegion(new SphereGeometry(10, 128, 96), null);
    const grid = await buildWarpGrid(region, 3);
    expect(grid.nodes.length).toBeGreaterThan(warpDensityNodes[3] * 0.5);
    expect(grid.nodes.length).toBeLessThan(warpDensityNodes[3] * 2);
  });
  it('uses the region itself when it is already coarser than the target', async () => {
    const region = buildWarpRegion(new BoxGeometry(4, 4, 4), null);
    expect((await buildWarpGrid(region, 6)).nodes.length).toBe(region.weldedCount);
  });
  it('builds symmetric, deduplicated adjacency without self edges', async () => {
    const grid = await buildWarpGrid(buildWarpRegion(new SphereGeometry(10, 64, 48), null), 1);
    const has = (a: number, b: number) =>
      grid.edges.subarray(grid.edgeStart[a], grid.edgeStart[a + 1]).includes(b);
    for (let n = 0; n < grid.nodes.length; n++) {
      const row = grid.edges.subarray(grid.edgeStart[n], grid.edgeStart[n + 1]);
      expect(new Set(row).size).toBe(row.length);
      for (const m of row) {
        expect(m).not.toBe(n);
        expect(has(m, n)).toBe(true);
      }
    }
  });
});
