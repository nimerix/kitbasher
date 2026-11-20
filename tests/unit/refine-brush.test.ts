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
  levelAndSpread,
  movedBetween,
  movedOutsideRadius,
  movedWhere,
  rippleAmplitude,
} from '../helpers/refine-brush';
import { heightAt } from '../helpers/refine-region';
import { foldedStrip, rippledSphere, rivetedPlate, softBox, softStep } from '../helpers/soft-edges';

const exact = { step: 0.06, ripple: 0, noise: 0 };
const brushes = [smoothDab, flattenDab];

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

  it('keeps a dab near the rim of a thin plate off its back face', () => {
    const model = modelOf(softBox([2, 0.125, 1.5], 0.05, exact));
    const dab = { ...dabAt(model.mesh, [1.63, 0.125, 0]), radius: 0.8 };
    const back = (p: Vec3) => p[1] < 0;
    const { vertices } = verticesUnderBrush(
      model.mesh,
      model.topology,
      dab.triangle,
      dab.center,
      0.8,
    );
    expect(vertices.filter((v) => model.mesh.position[v * 3 + 1] < 0)).toHaveLength(0);
    for (const brush of brushes) {
      const out = cloneRefineMesh(model.mesh, false);
      expect(brush(out, model.topology, dab).length).toBeGreaterThan(0);
      expect(movedWhere(model.mesh, out, back)).toBe(0);
    }
  });

  it('keeps a dab from reaching round a fold onto the layer below', () => {
    const model = modelOf(foldedStrip(0.06, exact, { gap: 0.3, reach: 1.2, under: -0.65 }));
    const dab = { ...dabAt(model.mesh, [0.85, 0.6, 0]), radius: 0.8 };
    const below = (p: Vec3) => p[1] < 0.34;
    for (const brush of brushes) {
      const out = cloneRefineMesh(model.mesh, false);
      expect(brush(out, model.topology, dab).length).toBeGreaterThan(0);
      expect(movedWhere(model.mesh, out, below)).toBe(0);
    }
  });

  it('keeps a dab on the floor of an inside corner off the wall', () => {
    const model = modelOf(softStep(0, exact));
    const dab = { ...dabAt(model.mesh, [0.42, 0, 0]), radius: 0.8 };
    const wall = (p: Vec3) => p[1] > 0.12;
    for (const brush of brushes) {
      const out = cloneRefineMesh(model.mesh, false);
      brush(out, model.topology, dab);
      expect(movedWhere(model.mesh, out, wall)).toBe(0);
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

  it('flattens the plate between two rivets without tilting toward them', () => {
    const { geometry } = rivetedPlate();
    const model = modelOf(geometry);
    const out = cloneRefineMesh(model.mesh, false);
    // The plate between the rivets at x = 0 and x = 2 on z = 1, clear of their feet.
    const between = (p: Vec3) => p[1] > 0.4 && p[0] > 0.6 && p[0] < 1.4 && Math.abs(p[2] - 1) < 0.4;
    const before = levelAndSpread(model.mesh, between);
    for (let x = 0.6; x <= 1.41; x += 0.1)
      flattenDab(out, model.topology, { ...dabAt(out, [x, 0.5, 1]), radius: 0.8, strength: 0.5 });
    const after = levelAndSpread(out, between);
    expect(after.spread).toBeLessThan(0.5 * before.spread);
    expect(Math.abs(after.level - before.level)).toBeLessThan(0.005);
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

  it('gives a stroke ceil(length / (4 radius)) + 3 controls', () => {
    const stroke = Array.from({ length: 24 }, (_, i) => ({
      triangle: 0,
      position: [0.1 * i, 0.035 * (i % 2 ? 1 : -1), 0] as Vec3,
    }));
    let length = 0;
    for (let i = 1; i < stroke.length; i++)
      length += Math.hypot(
        ...[0, 1, 2].map((a) => stroke[i].position[a] - stroke[i - 1].position[a]),
      );
    const input = creaseInput(stroke, 0.6, 0.8)!;
    expect(input.segments[0].points).toHaveLength(Math.ceil(length / 2.4) + 3);
  });

  it('turns a stroke retraced along a crest into one guide over it', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3, exact));
    const forward = jitteredCrest(model.mesh, -1.2, 1.2, 0);
    const there = creaseInput(forward, 0.6, 1)!.segments[0].points;
    const input = creaseInput([...forward, ...forward.slice(0, -1).reverse()], 0.6, 1)!;
    const points = input.segments[0].points;
    expect(points).toHaveLength(there.length);
    points.forEach((p, i) => {
      expect(
        Math.hypot(...[0, 1, 2].map((a) => p.position[a] - there[i].position[a])),
      ).toBeLessThan(1e-9);
      if (i) expect(p.position[0]).toBeGreaterThan(points[i - 1].position[0]);
    });
    expect(solveEdge(model.mesh, model.topology, input, model.noise)).not.toBeNull();
  });

  it('ignores a stroke shorter than the radius', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const shortStroke = jitteredCrest(model.mesh, 0, 0.4, 0.02);
    expect(creaseInput(shortStroke, 0.6, 1)).toBeNull();
  });
});
