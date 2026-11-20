import { describe, expect, it } from 'vitest';
import { applyEdge, solveEdge } from '../../src/core/refine-edge';
import { creaseInput, flattenDab, smoothDab } from '../../src/core/refine-brush';
import { cloneRefineMesh, weldedCorner } from '../../src/core/refine-mesh';
import { trianglesUnderBrush, verticesUnderBrush } from '../../src/core/refine-paint';
import type { Vec3 } from '../../src/core/types';
import { chainPieces, modelOf, pointOn } from '../helpers/refine';
import {
  brokenTriangles,
  capAt,
  dabAt,
  jitteredCrest,
  movedBetween,
  movedOutsideRadius,
  rippleAmplitude,
} from '../helpers/refine-brush';
import { heightAt } from '../helpers/refine-region';
import { rippledSphere, rivetedPlate, softBox } from '../helpers/soft-edges';

describe('Refine brushes', () => {
  it('selects only connected surface under the brush', () => {
    const model = modelOf(softBox([2, 0.25, 1], 0.1));
    const { mesh, topology } = model;
    const { triangle, position } = pointOn(mesh, [0.3, 0.25, 0.2]);
    // 0.4 mm is the brief's brush; at 0.6 mm the bottom face lies within reach through the plate.
    for (const radius of [0.4, 0.6]) {
      const triangles = trianglesUnderBrush(mesh, topology, triangle, position, radius);
      const { vertices, falloff } = verticesUnderBrush(mesh, topology, triangle, position, radius);
      expect(triangles.length).toBeGreaterThan(0);
      expect(vertices.length).toBeGreaterThan(0);
      for (const t of triangles)
        for (const k of [0, 1, 2] as const)
          expect(mesh.position[weldedCorner(mesh, t, k) * 3 + 1]).toBeGreaterThan(0);
      for (const v of vertices) expect(mesh.position[v * 3 + 1]).toBeGreaterThan(0);
      vertices.forEach((v, i) => {
        const d = Math.hypot(...[0, 1, 2].map((a) => mesh.position[v * 3 + a] - position[a]));
        expect(d).toBeLessThan(radius);
        expect(falloff[i]).toBeCloseTo((1 - (d / radius) ** 2) ** 2, 6);
      });
    }
  });

  it('smooths under the brush and nowhere else', () => {
    const model = modelOf(rippledSphere(3));
    const out = cloneRefineMesh(model.mesh, false);
    const dab = { ...dabAt(out, [0, 3, 0]), radius: 0.8, strength: 1 };
    for (let i = 0; i < 20; i++) smoothDab(out, model.topology, dab);
    expect(rippleAmplitude(out, 3, capAt([0, 3, 0], 0.4))).toBeLessThan(
      0.5 * rippleAmplitude(model.mesh, 3, capAt([0, 3, 0], 0.4)),
    );
    expect(movedOutsideRadius(model.mesh, out, [0, 3, 0], 0.8)).toBe(0);
  });

  it('returns and marks exactly the vertices a dab moved', () => {
    const model = modelOf(rippledSphere(3));
    for (const brush of [smoothDab, flattenDab]) {
      const out = cloneRefineMesh(model.mesh, false);
      const dab = { ...dabAt(out, [1, 2.5, 1.3]), radius: 0.8, strength: 0.7 };
      const moved = brush(out, model.topology, dab);
      expect(moved.length).toBeGreaterThan(0);
      expect([...moved]).toEqual(movedBetween(model.mesh.position, out.position));
      const touched = [...out.touched.keys()].filter((v) => out.touched[v]);
      expect(touched).toEqual([...moved]);
      expect(movedOutsideRadius(model.mesh, out, dab.center, 0.8)).toBe(0);
    }
  });

  it('flattens under the brush, rivets included', () => {
    const { geometry, rivets } = rivetedPlate();
    const model = modelOf(geometry);
    const out = cloneRefineMesh(model.mesh, false);
    const rivet = rivets[1];
    const dab = { ...dabAt(out, [rivet.x, 0.75, rivet.z]), radius: 0.8, strength: 1 };
    for (let i = 0; i < 20; i++) flattenDab(out, model.topology, dab);
    expect(Math.abs(heightAt(out, rivet.x, rivet.z) - 0.5)).toBeLessThan(0.03);
    expect(movedOutsideRadius(model.mesh, out, dab.center, 0.8)).toBe(0);
  });

  it('never folds or collapses a triangle under 50 full-strength dabs', () => {
    // Dabs across the edges and a corner of a rippled, noisy box: unchecked, flattening folds them.
    const model = modelOf(softBox([1.5, 1, 1], 0.1, { ripple: 0.04, noise: 0.02, seed: 4 }));
    const { mesh, topology } = model;
    const out = cloneRefineMesh(mesh, false);
    const centres: Vec3[] = [
      [1.5, 1, 0],
      [1.5, 1, 1],
      [0, 1, 1],
      [1.4, 0.9, 0.2],
    ];
    const dabs = centres.map((c) => ({ ...dabAt(out, c), radius: 0.8, strength: 1 }));
    let broken = 0;
    for (let i = 0; i < 50; i++) {
      const before = out.position.slice();
      const brush = i % 2 ? flattenDab : smoothDab;
      const moved = brush(out, topology, dabs[i % dabs.length]);
      broken += brokenTriangles(out, topology, before, out.position, moved);
    }
    expect(broken).toBe(0);
  });

  it('turns a freehand stroke into a guide that sharpens the edge', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const stroke = jitteredCrest(model.mesh, -1.2, 1.2, 0.05); // points every 0.1 mm, 0.05 mm of hand jitter
    const input = creaseInput(stroke, 0.6, 1)!;
    expect(input.segments[0].kind).toBe('spline');
    expect(input.segments[0].points.length).toBeGreaterThanOrEqual(4);
    expect(input).toMatchObject({ joints: [], closed: false, width: 0.6, strength: 1 });
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    const out = cloneRefineMesh(model.mesh, true);
    const cut = applyEdge(out, model.topology, solve, 1, true).cut!;
    expect(chainPieces(out, cut.chain)).toHaveLength(1);
    const chain = [...cut.chain].filter((v) => Math.abs(out.position[v * 3]) <= 0.6);
    expect(chain.length).toBeGreaterThan(0);
    for (const v of chain)
      expect(Math.hypot(out.position[v * 3 + 1] - 1.5, out.position[v * 3 + 2] - 1)).toBeLessThan(
        0.03,
      );
  });

  it('ignores a stroke shorter than the radius', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const shortStroke = jitteredCrest(model.mesh, 0, 0.4, 0.02);
    expect(creaseInput(shortStroke, 0.6, 1)).toBeNull();
  });
});
