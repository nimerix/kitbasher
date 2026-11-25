import { describe, expect, it } from 'vitest';
import { applyEdge, solveEdge } from '../../src/core/refine-edge';
import { creaseInput, flattenDab, smoothDab } from '../../src/core/refine-brush';
import type { GuidePoint } from '../../src/core/refine-band';
import { type RefineMesh, cloneRefineMesh, weldedCorner } from '../../src/core/refine-mesh';
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
import {
  foldedStrip,
  rippledSphere,
  rivetedPlate,
  slottedPlate,
  softBox,
  softStep,
} from '../helpers/soft-edges';

const exact = { step: 0.06, ripple: 0, noise: 0 };

const crease = (
  model: ReturnType<typeof modelOf>,
  stroke: GuidePoint[],
  radius: number,
  strength: number,
) => creaseInput(model.mesh, model.topology, model.noise, stroke, radius, strength);

/** Largest distance of a curve's points with |x| <= `within` from softBox([2, 1.5, 1])'s top front edge. */
function onBoxEdge(curve: ArrayLike<number>, within: number) {
  let worst = 0;
  for (let k = 0; k < curve.length; k += 3)
    if (Math.abs(curve[k]) <= within)
      worst = Math.max(worst, Math.hypot(curve[k + 1] - 1.5, curve[k + 2] - 1));
  return worst;
}

/** Distance from the sharp rim of slottedPlate(1, ...)'s slot, at height 1. */
function offSlotRim(p: Vec3) {
  const [x, , z] = p;
  const across = Math.abs(x) <= 1.5 ? Math.abs(z) - 1 : Math.hypot(Math.abs(x) - 1.5, z) - 1;
  return Math.hypot(across, p[1] - 1);
}

/**
 * A stroke on slottedPlate(1, ...)'s top, `out` mm from the slot's rim: from x = -1 along z < 0, round
 * the end at x = 1.5 and back along z > 0, or, `closed`, on round the other end to where it began.
 */
function slotStroke(mesh: RefineMesh, out: number, closed: boolean) {
  const r = 1 + out;
  const points: Vec3[] = [];
  for (let x = -1; x < 1.5; x += 0.1) points.push([x, 1, -r]);
  for (let a = -Math.PI / 2; a < Math.PI / 2; a += 0.1 / r)
    points.push([1.5 + r * Math.cos(a), 1, r * Math.sin(a)]);
  for (let x = 1.5; x > (closed ? -1.5 : -1); x -= 0.1) points.push([x, 1, r]);
  if (closed) {
    for (let a = Math.PI / 2; a < (3 * Math.PI) / 2; a += 0.1 / r)
      points.push([-1.5 + r * Math.cos(a), 1, r * Math.sin(a)]);
    for (let x = -1.5; x <= -0.8; x += 0.1) points.push([x, 1, -r]);
  }
  return points.map((p) => pointOn(mesh, p));
}

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

  it('fades the brush toward the facing limit instead of stopping at a step', () => {
    const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3, exact));
    const { triangle, position } = pointOn(mesh, [0, 1.5, 0.55]);
    const radius = 0.8;
    const { vertices, falloff } = verticesUnderBrush(mesh, topology, triangle, position, radius);
    const inside = new Set(vertices);
    const { neighbourStart, neighbours } = topology;
    const distance = (v: number) =>
      Math.hypot(...[0, 1, 2].map((a) => mesh.position[v * 3 + a] - position[a]));
    let edge = 0;
    vertices.forEach((v, i) => {
      for (let j = neighbourStart[v]; j < neighbourStart[v + 1]; j++) {
        const other = neighbours[j];
        // Left out by where it faces, not by how far it is.
        if (inside.has(other) || distance(other) > 0.9 * radius) continue;
        edge++;
        expect(falloff[i]).toBeLessThan(0.5 * (1 - (distance(v) / radius) ** 2) ** 2);
      }
    });
    expect(edge).toBeGreaterThan(0);
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

  it('turns a freehand stroke along a straight edge into a line that sharpens it', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const stroke = jitteredCrest(model.mesh, -1.2, 1.2, 0.05); // points every 0.1 mm, 0.05 mm of hand jitter
    const input = crease(model, stroke, 0.6, 1)!;
    expect(input.segments.map((s) => s.kind)).toEqual(['line']);
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

  for (const [where, z, y] of [
    ['on the face beside the rounding', 0.5, 1.5],
    ['on the wall below the rounding', 1, 1],
  ] as const)
    it(`finds the edge from a stroke ${where}`, () => {
      const model = modelOf(softBox([2, 1.5, 1], 0.3));
      const stroke = Array.from({ length: 25 }, (_, i) =>
        pointOn(model.mesh, [-1.2 + 0.1 * i, y, z]),
      );
      const input = crease(model, stroke, 0.6, 1)!;
      expect(input.segments.map((s) => s.kind)).toEqual(['line']);
      // The guide lies on the rounding, where the solve reads the edge.
      for (const { position: p } of input.segments[0].points)
        expect(Math.abs(Math.hypot(p[1] - 1.2, p[2] - 0.7) - 0.3)).toBeLessThan(0.03);
      const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
      expect(solve).not.toBeNull();
      expect(onBoxEdge(solve.curve.points, 0.8)).toBeLessThan(0.005);
    });

  it('fits a stroke round the end of a slot as a line, an arc and a line', () => {
    const model = modelOf(slottedPlate(1, 0.3));
    // On the plate 0.2 mm out from the rounding: down one side, round the end and back.
    const stroke = slotStroke(model.mesh, 0.5, false);
    const input = crease(model, stroke, 0.6, 1)!;
    expect(input.segments.map((s) => s.kind)).toEqual(['line', 'arc', 'line']);
    expect(input.joints).toEqual(['smooth', 'smooth']);
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    const curve = solve.curve.points;
    for (let k = 0; k < curve.length; k += 3)
      if (curve[k] > -0.4)
        expect(offSlotRim([curve[k], curve[k + 1], curve[k + 2]])).toBeLessThan(0.02);
  });

  it('closes a stroke that comes back round to its start', () => {
    const model = modelOf(slottedPlate(1, 0.3));
    const input = crease(model, slotStroke(model.mesh, 0.5, true), 0.6, 1)!;
    expect(input.closed).toBe(true);
    expect(input.segments.map((s) => s.kind).sort()).toEqual(['arc', 'arc', 'line', 'line']);
    expect(input.joints).toEqual(['smooth', 'smooth', 'smooth', 'smooth']);
    expect(solveEdge(model.mesh, model.topology, input, model.noise)).not.toBeNull();
  });

  it('splits a stroke round a corner into two lines meeting sharply', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    // Along the top's front edge to the corner at x = 2, then back along its side edge.
    const stroke = [
      ...Array.from({ length: 16 }, (_, i) => pointOn(model.mesh, [0.2 + 0.1 * i, 1.5, 0.5])),
      ...Array.from({ length: 11 }, (_, i) => pointOn(model.mesh, [1.5, 1.5, 0.4 - 0.1 * i])),
    ];
    const input = crease(model, stroke, 0.6, 1)!;
    expect(input.segments.map((s) => s.kind)).toEqual(['line', 'line']);
    expect(input.joints).toEqual(['sharp']);
    const corner = input.segments[0].points[1].position;
    expect(Math.hypot(corner[0] - 2, corner[1] - 1.5, corner[2] - 1)).toBeLessThan(0.3);
    // The second arm runs on the edge, by the box's other corner.
    const end = input.segments[1].points[1].position;
    expect(Math.abs(Math.hypot(end[0] - 1.7, end[1] - 1.2) - 0.3)).toBeLessThan(0.03);
    const solve = solveEdge(model.mesh, model.topology, input, model.noise)!;
    expect(solve).not.toBeNull();
    // The first arm on the box's sharp edge, clear of the corner. Where three faces meet the solve
    // itself is unsteady, whoever places the guide, so the second arm is not measured.
    const curve = solve.curve.points;
    for (let k = 0; k < curve.length; k += 3)
      if (curve[k] < 1.4 && curve[k] > 0.6)
        expect(Math.hypot(curve[k + 1] - 1.5, curve[k + 2] - 1)).toBeLessThan(0.005);
  });

  it('turns a stroke retraced along a crest into one guide over it', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3, exact));
    const forward = jitteredCrest(model.mesh, -1.2, 1.2, 0);
    const there = crease(model, forward, 0.6, 1)!.segments;
    const input = crease(model, [...forward, ...forward.slice(0, -1).reverse()], 0.6, 1)!;
    expect(input.segments).toEqual(there);
    expect(solveEdge(model.mesh, model.topology, input, model.noise)).not.toBeNull();
  });

  it('keeps the stroke as the guide where it finds no edge', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const stroke = Array.from({ length: 13 }, (_, i) =>
      pointOn(model.mesh, [-0.6 + 0.1 * i, 1.5, 0]),
    );
    const input = crease(model, stroke, 0.25, 1)!;
    expect(input.segments.map((s) => s.kind)).toEqual(['line']);
    for (const { position: p } of input.segments[0].points)
      expect(Math.abs(p[2])).toBeLessThan(0.01);
    expect(solveEdge(model.mesh, model.topology, input, model.noise)).toBeNull();
  });

  it('ignores a stroke shorter than the radius', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const shortStroke = jitteredCrest(model.mesh, 0, 0.4, 0.02);
    expect(crease(model, shortStroke, 0.6, 1)).toBeNull();
  });
});
