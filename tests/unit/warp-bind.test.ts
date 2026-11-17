import { describe, expect, it } from 'vitest';
import { PlaneGeometry, SphereGeometry } from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { bindPoint, bindRegion, warpBindingNodes } from '../../src/core/warp-bind';
import { buildWarpGrid } from '../../src/core/warp-grid';
import { buildWarpRegion, WarpRole } from '../../src/core/warp-region';

const K = warpBindingNodes;

async function sphere() {
  const region = buildWarpRegion(new SphereGeometry(10, 64, 48), [...Array(1500).keys()]);
  const grid = await buildWarpGrid(region, 0);
  return { region, grid, binding: bindRegion(region, grid, region.rest) };
}

describe('bindRegion', () => {
  it('binds each node vertex to itself alone', async () => {
    const { grid, binding } = await sphere();
    for (let k = 0; k < grid.nodes.length; k++) {
      const v = grid.nodes[k];
      expect(binding.node[v * K]).toBe(k);
      expect(binding.weight[v * K]).toBe(1);
      for (let j = 1; j < K; j++) {
        expect(binding.node[v * K + j]).toBe(0xffffffff);
        expect(binding.weight[v * K + j]).toBe(0);
      }
    }
  });

  it('gives every interior vertex weights summing to 1', async () => {
    const { region, binding } = await sphere();
    let checked = 0;
    for (let v = 0; v < region.weldedCount; v++) {
      if (region.role[v] !== WarpRole.Interior) continue;
      let sum = 0;
      for (let j = 0; j < K; j++) sum += binding.weight[v * K + j];
      expect(Math.abs(sum - 1)).toBeLessThan(1e-6);
      checked++;
    }
    expect(checked).toBeGreaterThan(0);
  });

  it('leaves outside vertices unbound', async () => {
    const { region, binding } = await sphere();
    for (let v = 0; v < region.weldedCount; v++)
      if (region.role[v] === WarpRole.Outside)
        for (let j = 0; j < K; j++) {
          expect(binding.node[v * K + j]).toBe(0xffffffff);
          expect(binding.weight[v * K + j]).toBe(0);
        }
  });

  it('does not bind across a thin wall', async () => {
    const lower = new PlaneGeometry(20, 20, 10, 10).rotateX(-Math.PI / 2);
    const upper = new PlaneGeometry(20, 20, 10, 10).rotateX(-Math.PI / 2).translate(0, 0.5, 0);
    const strip = new PlaneGeometry(20, 0.5, 10, 1).rotateY(Math.PI / 2).translate(10, 0.25, 0);
    const sheet = mergeVertices(mergeGeometries([lower, upper, strip]));
    const region = buildWarpRegion(sheet, null);
    const grid = await buildWarpGrid(region, 0);
    const binding = bindRegion(region, grid, region.rest);

    const lowerNodes = new Set<number>();
    const upperNodes = new Set<number>();
    for (let k = 0; k < grid.nodes.length; k++)
      (region.rest[grid.nodes[k] * 3 + 1] < 0.25 ? lowerNodes : upperNodes).add(k);
    expect(lowerNodes.size).toBeGreaterThan(0);
    expect(upperNodes.size).toBeGreaterThan(0);

    const bad: number[] = [];
    let lowerVertices = 0;
    for (let v = 0; v < region.weldedCount; v++) {
      if (region.rest[v * 3 + 1] > 1e-4 || region.rest[v * 3] > 0) continue;
      lowerVertices++;
      for (let j = 0; j < K; j++) {
        const n = binding.node[v * K + j];
        if (n !== 0xffffffff && !lowerNodes.has(n)) bad.push(v);
      }
    }
    expect(bad).toEqual([]);
    expect(lowerVertices).toBeGreaterThan(0);
  });
});

describe('bindPoint', () => {
  it('at a corner equals that vertex binding', async () => {
    const { region, grid, binding } = await sphere();
    let t = 0;
    for (; t < region.faces.length; t++) {
      const v = region.triangles[t * 3];
      if (region.role[v] === WarpRole.Interior) break;
    }
    const v = region.triangles[t * 3];
    const point = bindPoint(region, grid, binding, region.faces[t], [1, 0, 0]);
    const expected = new Map<number, number>();
    for (let j = 0; j < K; j++)
      if (binding.node[v * K + j] !== 0xffffffff)
        expected.set(binding.node[v * K + j], binding.weight[v * K + j]);
    expect(point.node.length).toBe(expected.size);
    point.node.forEach((n, i) => expect(point.weight[i]).toBeCloseTo(expected.get(n)!, 6));
  });

  it('throws for a face outside the region', async () => {
    const { region, grid, binding } = await sphere();
    expect(() => bindPoint(region, grid, binding, 3000, [1, 0, 0])).toThrow(
      'Face is not in the warp region.',
    );
  });
});
