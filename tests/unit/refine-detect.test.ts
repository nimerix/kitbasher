import { describe, expect, it } from 'vitest';
import { vertexCurvature } from '../../src/core/refine-curvature';
import { type RefineProposal, detectDefaults, detectFeatures } from '../../src/core/refine-detect';
import { solveEdge } from '../../src/core/refine-edge';
import { medianEdgeLength } from '../../src/core/refine-mesh';
import { modelOf } from '../helpers/refine';
import {
  type EdgeProposal,
  boxCrestVertices,
  guidePoints,
  matchedBoxEdges,
  proposalPositions,
  trianglesWhere,
} from '../helpers/refine-detect';
import { rivetedPlate, softBox, softCylinder } from '../helpers/soft-edges';

const edgesOf = (found: RefineProposal[]) =>
  found.filter((p): p is EdgeProposal => p.type === 'edge');
const regionsOf = (found: RefineProposal[]) =>
  found.flatMap((p) => (p.type === 'region' ? [p.input] : []));

describe('vertexCurvature', () => {
  it('measures curvature across a fillet and none along it', () => {
    const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
    const crest = boxCrestVertices(mesh, [2, 1.5, 1], 0.3);
    expect(crest.length).toBeGreaterThan(50);
    const { k1, k2, along } = vertexCurvature(
      mesh,
      topology,
      4 * medianEdgeLength(mesh),
      Uint32Array.from(crest),
    );
    crest.forEach((_, i) => {
      expect(Math.abs(k1[i]) / (1 / 0.3)).toBeGreaterThan(0.7);
      expect(Math.abs(k1[i]) / (1 / 0.3)).toBeLessThan(1.3);
      expect(Math.abs(k2[i])).toBeLessThan(0.5);
      // The fillets run along x.
      expect(Math.abs(along[i * 3])).toBeGreaterThan(0.95);
    });
  });
});

describe('detectFeatures', () => {
  it('proposes the 12 edges and 6 faces of a box', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    const edges = found.filter((p) => p.type === 'edge');
    expect(edges).toHaveLength(12);
    expect(edges.every((e) => e.input.segments[0].kind === 'line')).toBe(true);
    expect(matchedBoxEdges(edges, [2, 1.5, 1], 0.15)).toBe(12);
    const faces = found.filter((p) => p.type === 'region');
    expect(faces).toHaveLength(6);
    expect(faces.every((f) => f.input.treatment === 'flatten')).toBe(true);
  });

  it('proposes each piece as one open segment, sharp and of estimated width', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    for (const { input } of edgesOf(found)) {
      expect(input.segments).toHaveLength(1);
      expect(input.segments[0].points).toHaveLength(2);
      expect(input.joints).toEqual([]);
      expect(input.closed).toBe(false);
      expect(input.width).toBeNull();
      expect(input.strength).toBe(1);
    }
    for (const region of regionsOf(found)) {
      expect(region.strength).toBe(1);
      expect(region.keepDetail).toBe(true);
      expect(region.detail).toBeNull();
      expect(region.blend).toBeNull();
    }
  });

  it('proposes nothing on rivets', () => {
    const { geometry, rivets } = rivetedPlate();
    const { mesh, topology, noise } = modelOf(geometry);
    const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    for (const p of found.filter((p) => p.type === 'edge'))
      for (const point of p.input.segments.flatMap((s) => s.points))
        for (const r of rivets)
          expect(Math.hypot(point.position[0] - r.x, point.position[2] - r.z)).toBeGreaterThan(
            r.radius,
          );
  });

  it('proposes a rim as an arc and a wall as a cylinder', () => {
    const { mesh, topology, noise } = modelOf(softCylinder(1.5, 1, 0.3));
    const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    const edges = edgesOf(found);
    expect(edges).toHaveLength(2);
    const crest = 0.7 + 0.3 / Math.SQRT2;
    const heights = edges.map(({ input }) => {
      expect(input.segments).toHaveLength(1);
      expect(input.segments[0].kind).toBe('arc');
      expect(input.closed).toBe(true);
      expect(input.joints).toEqual(['smooth']);
      const points = guidePoints(input);
      for (const { position: p } of points)
        expect(Math.abs(Math.hypot(p[0], p[2]) - (1.2 + 0.3 / Math.SQRT2))).toBeLessThan(0.1);
      return points[0].position[1];
    });
    heights.sort((a, b) => a - b);
    expect(heights[0]).toBeCloseTo(-crest, 1);
    expect(heights[1]).toBeCloseTo(crest, 1);
    for (const { input } of edges) expect(solveEdge(mesh, topology, input, noise)).not.toBeNull();
    const regions = regionsOf(found);
    expect(regions).toHaveLength(3);
    expect(regions.filter((r) => r.treatment === 'shape' && r.shape === 'cylinder')).toHaveLength(
      1,
    );
    expect(regions.filter((r) => r.treatment === 'flatten')).toHaveLength(2);
  });

  it('looks only where asked', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const top = trianglesWhere(mesh, (_, y) => y > 1.2);
    const found = detectFeatures(mesh, topology, noise, { triangles: top, ...detectDefaults });
    expect(edgesOf(found).length).toBeGreaterThan(0);
    expect(regionsOf(found).length).toBeGreaterThan(0);
    const inside = new Set(top);
    for (const p of found) {
      for (const position of proposalPositions(mesh, p)) expect(position[1]).toBeGreaterThan(1);
      if (p.type === 'region') for (const t of p.input.triangles) expect(inside.has(t)).toBe(true);
      else for (const point of guidePoints(p.input)) expect(inside.has(point.triangle)).toBe(true);
    }
  });

  it('leaves the mesh bit-identical', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const before = mesh.position.slice();
    detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    expect(mesh.position).toEqual(before);
    expect(mesh.touched.some((t) => t === 1)).toBe(false);
  });

  it('every edge proposal solves', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const found = detectFeatures(mesh, topology, noise, { triangles: null, ...detectDefaults });
    const edges = edgesOf(found);
    expect(edges).toHaveLength(12);
    for (const { input } of edges) expect(solveEdge(mesh, topology, input, noise)).not.toBeNull();
  });

  it('stops when aborted and reports progress', () => {
    const { mesh, topology, noise } = modelOf(softBox([2, 1.5, 1], 0.3));
    const options = { triangles: null, ...detectDefaults };
    const controller = new AbortController();
    let calls = 0;
    const abort = () => {
      calls++;
      controller.abort();
    };
    let thrown: unknown;
    try {
      detectFeatures(mesh, topology, noise, options, abort, controller.signal);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect((thrown as DOMException).message).toBe('Detection cancelled');
    expect(calls).toBe(1);

    const fractions: number[] = [];
    detectFeatures(mesh, topology, noise, options, (f) => fractions.push(f));
    expect(fractions[0]).toBeLessThanOrEqual(0.05);
    for (let i = 1; i < fractions.length; i++) {
      expect(fractions[i]).toBeGreaterThan(fractions[i - 1]);
      expect(fractions[i] - fractions[i - 1]).toBeLessThanOrEqual(0.05);
    }
    expect(fractions.at(-1)).toBe(1);
  });
});
