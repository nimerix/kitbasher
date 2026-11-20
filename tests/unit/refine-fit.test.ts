import { describe, expect, it } from 'vitest';
import { Matrix, solve } from 'ml-matrix';
import { Matrix4, Vector3 } from 'three';
import { buildRefineMesh, buildTopology, vertexNormal } from '../../src/core/refine-mesh';
import {
  type Shape,
  estimateNoise,
  fitAuto,
  fitShape,
  projectToShape,
  shapeDistance,
} from '../../src/core/refine-fit';
import {
  angleDeg,
  band,
  cappedFlat,
  coneBehindApex,
  coneSide,
  modelOf,
  noiseWhere,
  onTopFace,
  onWall,
  patch,
  sevenVertexFan,
  shapeRms,
  surfaceWhere,
  taperedTube,
  topFace,
  wall,
} from '../helpers/refine';
import {
  rippledSphere,
  rivetedPlate,
  softBox,
  softCylinder,
  softElbow,
} from '../helpers/soft-edges';

describe('fitShape', () => {
  it('fits a plane under rivets without tilting', () => {
    const [points, normals] = surfaceWhere(rivetedPlate().geometry, (_, y) => y > 0.4);
    const fit = fitShape(points, normals, 'plane', 0.004)!;
    const plane = fit.shape as Extract<Shape, { kind: 'plane' }>;
    expect(angleDeg(plane.normal, [0, 1, 0])).toBeLessThan(0.1);
    expect(Math.abs(plane.point[1] - 0.5)).toBeLessThan(0.002);
  });

  it('recovers a cylinder axis and radius', () => {
    const [points, normals] = wall(softCylinder(1.5, 1, 0.3));
    const c = fitShape(points, normals, 'cylinder', 0.004)!.shape as Extract<
      Shape,
      { kind: 'cylinder' }
    >;
    expect(Math.abs(c.radius - 1.5)).toBeLessThan(0.005);
    expect(Math.min(angleDeg(c.axis, [0, 1, 0]), angleDeg(c.axis, [0, -1, 0]))).toBeLessThan(0.2);
  });

  it('recovers a sphere and a cone', () => {
    const [points, normals] = patch(rippledSphere(3));
    const sphere = fitShape(points, normals, 'sphere', 0.004)!.shape as Extract<
      Shape,
      { kind: 'sphere' }
    >;
    expect(Math.abs(sphere.radius - 3)).toBeLessThan(0.005);
    const side = coneSide(1, 2, 0.004);
    const cone = fitShape(...side, 'cone', 0.004)!.shape as Extract<Shape, { kind: 'cone' }>;
    expect(
      Math.abs((cone.angle * 180) / Math.PI - (Math.atan(1 / 2) * 180) / Math.PI),
    ).toBeLessThan(0.2);
  });

  it('returns null for too few or collinear points', () => {
    expect(
      fitShape(new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]), new Float32Array(9), 'plane', 0.004),
    ).toBeNull();
  });
});

describe('fitShape against one-sided outliers and edge cases', () => {
  it('fits the plane under an off-centre cap standing above a minority of it', () => {
    const [points, normals] = cappedFlat();
    const fit = fitShape(points, normals, 'plane', 0.004)!;
    const plane = fit.shape as Extract<Shape, { kind: 'plane' }>;
    expect(angleDeg(plane.normal, [0, 1, 0])).toBeLessThan(0.5);
    // Offset of the plane from y = 0 along its normal.
    expect(Math.abs(shapeDistance(plane, 0.5, 0, 0.5))).toBeLessThan(0.005);
    expect(fit.within).toBe(true);
  });

  it('accepts exact coplanar points at zero noise', () => {
    const points = new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1, 1, 0, 1]);
    const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]);
    const fit = fitShape(points, normals, 'plane', 0)!;
    expect(fit).not.toBeNull();
    expect(fit.rms).toBe(0);
    expect(fit.within).toBe(true);
    const auto = fitAuto(points, normals, 0);
    expect(auto.shape.kind).toBe('plane');
    expect(auto.within).toBe(true);
  });

  it('measures a cone with points behind its apex by the distance it reports', () => {
    const { sample, clean } = coneBehindApex();
    const fit = fitShape(...sample, 'cone', 0.004)!;
    const cone = fit.shape as Extract<Shape, { kind: 'cone' }>;
    const distance = (x: number, y: number, z: number) => shapeDistance(cone, x, y, z);
    // The points behind the apex are dropped and the clean side is kept.
    expect(Math.abs(fit.rms - shapeRms(distance, sample[0], clean))).toBeLessThan(1e-6);
    expect(Math.hypot(cone.apex[0], cone.apex[1] - 1, cone.apex[2])).toBeLessThan(0.005);
  });

  it('fits a cylinder to a full band too short to tell from a plane by position', () => {
    const fit = fitShape(...band(1.5, 0.006), 'cylinder', 0.004)!;
    expect(fit).not.toBeNull();
    const cylinder = fit.shape as Extract<Shape, { kind: 'cylinder' }>;
    expect(Math.abs(cylinder.radius - 1.5)).toBeLessThan(0.005);
  });

  it('returns null for too few points', () => {
    const [points, normals] = coneSide(1, 2, 0.004);
    const first = (count: number) =>
      [points.slice(0, count * 3), normals.slice(0, count * 3)] as const;
    expect(fitShape(...first(2), 'plane', 0.004)).toBeNull();
    expect(fitShape(...first(3), 'sphere', 0.004)).toBeNull();
    expect(fitShape(...first(4), 'cylinder', 0.004)).toBeNull();
    expect(fitShape(...first(5), 'cone', 0.004)).toBeNull();
  });

  it('returns null for an exactly planar cloud requested as a sphere or cylinder', () => {
    const [points, normals] = cappedFlat();
    const flat = [
      points.slice(0, 625 * 3).map((v, k) => (k % 3 === 1 ? 0 : v)),
      normals.slice(0, 625 * 3),
    ] as const;
    expect(fitShape(...flat, 'sphere', 0.004)).toBeNull();
    expect(fitShape(...flat, 'cylinder', 0.004)).toBeNull();
  });
});

describe('fitAuto', () => {
  it('falls back to the lowest rms of every valid fit', () => {
    const sample = taperedTube(1.5, (0.5 * Math.PI) / 180, 0.02);
    const fits = (['plane', 'cylinder', 'cone', 'sphere'] as const)
      .map((kind) => fitShape(...sample, kind, 0.004))
      .filter((fit) => fit !== null);
    const auto = fitAuto(...sample, 0.004);
    expect(fits.every((fit) => !fit.within)).toBe(true);
    expect(auto.rms).toBe(Math.min(...fits.map((fit) => fit.rms)));
  });

  it('names the right shape automatically', () => {
    expect(fitAuto(...topFace(softBox([2, 1.5, 1], 0.3)), 0.004).shape.kind).toBe('plane');
    expect(fitAuto(...wall(softCylinder(1.5, 1, 0.3)), 0.004).shape.kind).toBe('cylinder');
    expect(fitAuto(...patch(rippledSphere(3)), 0.004).shape.kind).toBe('sphere');
  });

  it('says when nothing fits', () => {
    expect(fitAuto(...patch(softElbow(4, 1)), 0.004).within).toBe(false);
  });
});

describe('shapeDistance and projectToShape', () => {
  const shapes: Shape[] = [
    { kind: 'plane', point: [0.2, -0.1, 0.3], normal: [0, 0.6, 0.8] },
    { kind: 'sphere', center: [1, 0, -1], radius: 2 },
    { kind: 'sphere', center: [1, 0, -1], radius: -2 },
    { kind: 'cylinder', point: [0, 1, 0], axis: [0, 0, 1], radius: 0.7 },
    { kind: 'cylinder', point: [0, 1, 0], axis: [0, 0, 1], radius: -0.7 },
    { kind: 'cone', apex: [0, 2, 0], axis: [0, -1, 0], angle: 0.4 },
    { kind: 'cone', apex: [0, 2, 0], axis: [0, 1, 0], angle: Math.PI - 0.4 },
  ];
  const probes = [
    [1.3, -0.7, 0.4],
    [-0.6, 0.9, 1.8],
    [0.25, 0.1, -0.3],
    [2.1, -1.5, -2.2],
  ];

  it.each(shapes.map((shape) => [`${shape.kind} ${JSON.stringify(shape)}`, shape] as const))(
    'projects onto %s and reports signed distance',
    (_, shape) => {
      const out = new Float32Array(6);
      for (const [x, y, z] of probes) {
        projectToShape(shape, x, y, z, out, 3);
        const [px, py, pz] = out.subarray(3);
        expect(Math.abs(shapeDistance(shape, px, py, pz))).toBeLessThan(1e-5);
        const d = shapeDistance(shape, x, y, z);
        // The probe lies |d| from its projection, on the side its sign names.
        expect(Math.hypot(x - px, y - py, z - pz)).toBeCloseTo(Math.abs(d), 5);
        const across = [px - (x - px), py - (y - py), pz - (z - pz)];
        if (Math.abs(d) > 1e-3 && Math.abs(d) < 0.3)
          expect(Math.sign(shapeDistance(shape, across[0], across[1], across[2]))).toBe(
            -Math.sign(d),
          );
      }
    },
  );

  it('measures positive on the side the fitted normals face', () => {
    const outward = patch(rippledSphere(3));
    const inward = [outward[0], outward[1].map((v) => -v)] as const;
    const out = fitShape(...outward, 'sphere', 0.004)!.shape;
    const into = fitShape(...inward, 'sphere', 0.004)!.shape;
    expect(shapeDistance(out, 0, 0, 0)).toBeLessThan(0);
    expect(shapeDistance(into, 0, 0, 0)).toBeGreaterThan(0);
    const side = coneSide(1, 2, 0.004);
    const flipped = [side[0], side[1].map((v) => -v)] as const;
    expect(shapeDistance(fitShape(...side, 'cone', 0.004)!.shape, 0, 0, 0)).toBeLessThan(0);
    expect(shapeDistance(fitShape(...flipped, 'cone', 0.004)!.shape, 0, 0, 0)).toBeGreaterThan(0);
  });
});

describe('estimateNoise', () => {
  it('estimates noise near the fixture noise', () => {
    const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
    expect(estimateNoise(mesh, topology)).toBeGreaterThan(0.001);
    expect(estimateNoise(mesh, topology)).toBeLessThan(0.02);
  });

  it('includes the ripple and stays below it without one', () => {
    const noise = modelOf(softBox([2, 1.5, 1], 0.3)).noise;
    expect(noise).toBeGreaterThan(0.004);
    expect(noise).toBeLessThan(0.02);
    const smooth = modelOf(softBox([2, 1.5, 1], 0.3, { ripple: 0, noise: 0.004 })).noise;
    expect(smooth).toBeLessThan(0.006);
  });

  it('lets fitAuto accept rippled shapes and still reject the elbow', () => {
    const box = softBox([2, 1.5, 1], 0.3),
      cylinder = softCylinder(1.5, 1, 0.3),
      sphere = rippledSphere(3),
      elbow = softElbow(4, 1);
    const plane = fitAuto(...topFace(box), modelOf(box).noise);
    expect(plane.within).toBe(true);
    expect(plane.shape.kind).toBe('plane');
    const round = fitAuto(...wall(cylinder), modelOf(cylinder).noise);
    expect(round.within).toBe(true);
    expect(round.shape.kind).toBe('cylinder');
    const ball = fitAuto(...patch(sphere), modelOf(sphere).noise);
    expect(ball.within).toBe(true);
    expect(ball.shape.kind).toBe('sphere');
    expect(fitAuto(...patch(elbow), modelOf(elbow).noise).within).toBe(false);
  });

  it('absorbs curvature', () => {
    const box = softBox([2, 1.5, 1], 0.3),
      cylinder = softCylinder(1.5, 1, 0.3);
    const flat = noiseWhere(box, onTopFace(box));
    for (const curved of [modelOf(rippledSphere(3)).noise, noiseWhere(cylinder, onWall())]) {
      expect(curved).toBeGreaterThan(flat / 2);
      expect(curved).toBeLessThan(flat * 2);
    }
  });

  it('measures a seven-vertex neighbourhood whose quadric fit has full rank', () => {
    const geometry = sevenVertexFan([0.02, 0, 0.01, -0.01, 0.015, 0, -0.005]);
    const { mesh, topology } = modelOf(geometry);
    // Independently: least squares of the quadric height field in the frame of the mean normal.
    const local = buildRefineMesh(geometry, new Matrix4());
    const ring = buildTopology(local);
    const normal = new Float32Array(3);
    const sum = [0, 0, 0],
      centre = [0, 0, 0];
    for (let v = 0; v < 7; v++) {
      vertexNormal(local, ring, v, normal);
      for (let k = 0; k < 3; k++) {
        sum[k] += normal[k];
        centre[k] += local.position[v * 3 + k] / 7;
      }
    }
    const n = new Vector3(...sum).normalize();
    const u = new Vector3(1, 0, 0).cross(n).normalize(),
      w = n.clone().cross(u);
    const rows: number[][] = [],
      heights: number[][] = [];
    for (let v = 0; v < 7; v++) {
      const d = new Vector3(...[0, 1, 2].map((k) => local.position[v * 3 + k] - centre[k]));
      const [x, y] = [d.dot(u), d.dot(w)];
      rows.push([1, x, y, x * x, x * y, y * y]);
      heights.push([d.dot(n)]);
    }
    const design = new Matrix(rows);
    const coefficients = solve(design, new Matrix(heights));
    const residual = design.mmul(coefficients).sub(new Matrix(heights));
    const expected = Math.sqrt(residual.to1DArray().reduce((a, r) => a + r * r, 0) / 7);
    expect(expected).toBeGreaterThan(0.001);
    expect(Math.abs(estimateNoise(mesh, topology) - expected)).toBeLessThan(0.1 * expected);
  });

  it('runs in under a second on a 60,000 triangle sphere', () => {
    const { mesh, topology } = modelOf(rippledSphere(3));
    const start = performance.now();
    estimateNoise(mesh, topology);
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
