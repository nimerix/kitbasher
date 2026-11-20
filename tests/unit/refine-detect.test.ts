import { describe, expect, it } from 'vitest';
import { vertexCurvature } from '../../src/core/refine-curvature';
import { type RefineProposal, detectDefaults, detectFeatures } from '../../src/core/refine-detect';
import { solveEdge } from '../../src/core/refine-edge';
import { type RefineMesh, medianEdgeLength, weldedCorner } from '../../src/core/refine-mesh';
import type { Vec3 } from '../../src/core/types';
import { modelOf } from '../helpers/refine';
import {
  type EdgeProposal,
  boxCrestVertices,
  dentedDome,
  drawnPoints,
  guidePoints,
  matchedBoxEdges,
  pocketedPlate,
  polylineLength,
  proposalPositions,
  trianglesWhere,
} from '../helpers/refine-detect';
import {
  extrudedProfile,
  heightField,
  rivetedPlate,
  softBox,
  softCylinder,
} from '../helpers/soft-edges';

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

const clean = { step: 0.06, noise: 0, ripple: 0 };
const defaults = { triangles: null, ...detectDefaults };
const distance = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const drawnLength = ({ input }: EdgeProposal) => polylineLength(drawnPoints(input));
const ends = ({ input }: EdgeProposal) => {
  const points = guidePoints(input);
  return [points[0].position, points[points.length - 1].position];
};
const corner = (mesh: RefineMesh, t: number, k: 0 | 1 | 2): Vec3 => {
  const w = weldedCorner(mesh, t, k) * 3;
  return [mesh.position[w], mesh.position[w + 1], mesh.position[w + 2]];
};

describe('detectFeatures between faces', () => {
  it('proposes no edge along the crown or flank of a tube lying on a plate', () => {
    const profile: [number, number][] = [
      [-2, 0],
      [-0.5, 0],
      [-0.5, 0.6],
      [0.5, 0.6],
      [0.5, 0],
      [2, 0],
    ];
    const { mesh, topology, noise } = modelOf(extrudedProfile(profile, [0.05, 0.5, 0.5, 0.05], 4));
    const found = detectFeatures(mesh, topology, noise, defaults);
    // The tube's centre is 0.1 above the plate; only the creases at its foot may be proposed.
    for (const edge of edgesOf(found))
      for (const { position } of guidePoints(edge.input)) expect(position[1]).toBeLessThan(0.2);
  });

  it('proposes nothing on a shallow round dent in a dome', () => {
    const { mesh, topology, noise } = modelOf(heightField(1.5, dentedDome));
    expect(edgesOf(detectFeatures(mesh, topology, noise, defaults))).toHaveLength(0);
  });

  it('keeps two convex crests 0.3 mm apart as two proposals on their crests', () => {
    const a = 0.15 + 0.05 * (1 - 1 / Math.SQRT2);
    const profile: [number, number][] = [
      [-2, 0],
      [-a, 0],
      [-a, 0.65],
      [a, 0.65],
      [a, 0],
      [2, 0],
    ];
    const { mesh, topology, noise } = modelOf(
      extrudedProfile(profile, [0.05, 0.05, 0.05, 0.05], 4, clean),
    );
    const upper = edgesOf(detectFeatures(mesh, topology, noise, defaults)).filter((e) =>
      guidePoints(e.input).every((p) => p.position[1] > 0.5),
    );
    expect(upper).toHaveLength(2);
    expect(upper.map((e) => Math.sign(guidePoints(e.input)[0].position[0])).sort()).toEqual([
      -1, 1,
    ]);
    for (const e of upper)
      for (const p of drawnPoints(e.input))
        expect(Math.abs(Math.abs(p[0]) - 0.15)).toBeLessThan(0.1);
  });

  it('splits an L-shaped crest at its turn and keeps each arm on the crest to the corner', () => {
    // A 45 degree ramp with 0.1 mm rounded transitions, turning 90 degrees in plan at the origin.
    const ramp = (d: number) => {
      if (d <= -0.05) return 0.65;
      if (d < 0.05) return 0.65 - (d + 0.05) ** 2 / 0.2;
      if (d <= 0.6) return 0.65 - d;
      if (d < 0.7) return (0.7 - d) ** 2 / 0.2;
      return 0;
    };
    const { mesh, topology, noise } = modelOf(
      heightField(
        3,
        (x, z) => {
          const delta = Math.abs(x - z);
          return ramp(Math.max(x, z) + (delta < 0.1 ? (0.1 - delta) ** 2 / 0.4 : 0));
        },
        clean,
      ),
    );
    const upper = edgesOf(detectFeatures(mesh, topology, noise, defaults)).filter((e) =>
      guidePoints(e.input).every((p) => p.position[1] > 0.55),
    );
    expect(upper).toHaveLength(2);
    expect(upper.every((e) => e.input.segments[0].kind === 'line')).toBe(true);
    for (const e of upper) for (const p of drawnPoints(e.input)) expect(p[1]).toBeGreaterThan(0.6);
    const atCorner = upper.flatMap(ends).filter((p) => Math.hypot(p[0], p[2]) <= 0.15);
    expect(atCorner).toHaveLength(2);
    expect(distance(atCorner[0], atCorner[1])).toBeLessThanOrEqual(0.15);
  });

  it('carries each edge of a box to both of its corners', () => {
    const half: Vec3 = [2, 1.5, 1];
    const { mesh, topology, noise } = modelOf(softBox(half, 0.3));
    const edges = edgesOf(detectFeatures(mesh, topology, noise, defaults));
    expect(edges).toHaveLength(12);
    expect(matchedBoxEdges(edges, half, 0.15)).toBe(12);
    const allEnds = edges.flatMap(ends);
    for (const sx of [-1, 1])
      for (const sy of [-1, 1])
        for (const sz of [-1, 1]) {
          const sharp: Vec3 = [sx * half[0], sy * half[1], sz * half[2]];
          const near = allEnds.filter((p) => distance(p, sharp) <= 0.3);
          expect(near).toHaveLength(3);
          for (const p of near)
            for (const q of near) expect(distance(p, q)).toBeLessThanOrEqual(0.15);
        }
  });

  it('draws no edge shorter than minLength', () => {
    const box = modelOf(softBox([2, 1.5, 1], 0.3));
    const riveted = modelOf(rivetedPlate().geometry);
    for (const { mesh, topology, noise } of [box, riveted])
      for (const minLength of [0.5, 1.5, 5])
        for (const edge of edgesOf(
          detectFeatures(mesh, topology, noise, { ...defaults, minLength }),
        ))
          expect(drawnLength(edge)).toBeGreaterThanOrEqual(minLength);
    const { mesh, topology, noise } = box;
    expect(
      edgesOf(detectFeatures(mesh, topology, noise, { ...defaults, minLength: 5 })),
    ).toHaveLength(0);
  });

  it('does not bridge an unpainted row across an edge', () => {
    const { mesh, topology } = modelOf(
      extrudedProfile(
        [
          [-2, 0],
          [0, 0],
          [0, 2],
        ],
        [0.12],
        6,
        clean,
      ),
    );
    const left = trianglesWhere(mesh, (_, __, z) => z <= 1e-7);
    const right = trianglesWhere(mesh, (_, __, z) => z >= 0.059);
    const triangles = Uint32Array.from([...left, ...right]);
    const found = detectFeatures(mesh, topology, 0.004, { ...defaults, triangles });
    const edges = edgesOf(found);
    expect(edges).toHaveLength(2);
    for (const edge of edges)
      expect(drawnPoints(edge.input).some((p) => p[2] > 0.001 && p[2] < 0.059)).toBe(false);
    const painted = new Set(triangles);
    for (const edge of edges)
      for (const point of guidePoints(edge.input)) expect(painted.has(point.triangle)).toBe(true);
    for (const region of regionsOf(found))
      for (const t of region.triangles) expect(painted.has(t)).toBe(true);
  });

  it('keeps a flatten region off the wall beyond a small fillet', () => {
    const profile: [number, number][] = [
      [-0.69, 0],
      [0, 0],
      [0, -0.4],
    ];
    const { mesh, topology } = modelOf(extrudedProfile(profile, [0.06], 6, clean));
    const masks = regionsOf(detectFeatures(mesh, topology, 0.013, defaults))
      .filter((r) => r.treatment === 'flatten')
      .map((r) => Array.from(r.triangles));
    const all = (t: number, keep: (p: Vec3) => boolean) =>
      ([0, 1, 2] as const).every((k) => keep(corner(mesh, t, k)));
    const parts = masks.map((mask) => ({
      plane: mask.filter((t) => all(t, (p) => p[0] < -0.14)).length,
      wall: mask.filter((t) => all(t, (p) => p[1] < -0.08)).length,
    }));
    expect(parts.some((p) => p.plane > 100)).toBe(true);
    for (const p of parts) expect(p.plane === 0 || p.wall === 0).toBe(true);
  });

  it('includes the rivets standing on a plate in its flatten region', () => {
    const { geometry, rivets } = rivetedPlate();
    const { mesh, topology, noise } = modelOf(geometry);
    const flat = regionsOf(detectFeatures(mesh, topology, noise, defaults)).filter(
      (r) => r.treatment === 'flatten' && r.keepDetail,
    );
    const caps = trianglesWhere(
      mesh,
      (x, y, z) => y > 0.6 && rivets.some((r) => Math.hypot(x - r.x, z - r.z) < r.radius),
    );
    expect(caps.length).toBeGreaterThan(100);
    const mask = new Set(flat.flatMap((r) => Array.from(r.triangles)));
    expect(Array.from(caps).filter((t) => !mask.has(t))).toEqual([]);
  });

  it('leaves a pocket out of the plate around it', () => {
    const { mesh, topology, noise } = modelOf(heightField(2.5, pocketedPlate));
    const found = detectFeatures(mesh, topology, noise, defaults);
    const plate = regionsOf(found)
      .filter((r) => r.treatment === 'flatten')
      .sort((a, b) => b.triangles.length - a.triangles.length)[0];
    expect(plate).toBeDefined();
    const floor = Array.from(plate.triangles).filter((t) =>
      ([0, 1, 2] as const).some((k) => corner(mesh, t, k)[1] < -0.15),
    );
    expect(floor).toEqual([]);
  });
});
