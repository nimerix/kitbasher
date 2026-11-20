import { describe, expect, it } from 'vitest';
import { cloneRefineMesh, foldedTriangles } from '../../src/core/refine-mesh';
import { type RegionInput, applyRegion, solveRegion } from '../../src/core/refine-region';
import { fitSweep, projectToSweep } from '../../src/core/refine-sweep';
import { maxDistance, modelFrom, modelOf, topFace } from '../helpers/refine';
import {
  allVertices,
  collapsedTriangles,
  distanceMoved,
  indicesWhere,
} from '../helpers/refine-region';
import {
  type CrossSection,
  type TubePath,
  elbowPath,
  elbowSurface,
  flatSided,
  halfTurned,
  helixPath,
  joined,
  mean,
  oval,
  round,
  sBendPath,
  straightPath,
  straightTube,
  sweptTube,
  swelling,
  sweptTubeModel,
  tapered,
  torusDistance,
  torusOffset,
  tubeTriangles,
  tubeTrianglesWhere,
} from '../helpers/refine-sweep';
import { softBox, softElbow } from '../helpers/soft-edges';

const sweepInput = (triangles: Uint32Array, options: Partial<RegionInput> = {}): RegionInput => ({
  triangles,
  treatment: 'shape',
  shape: 'sweep',
  strength: 1,
  keepDetail: true,
  detail: null,
  blend: null,
  ...options,
});
type Model = ReturnType<typeof modelOf>;
const run = (model: Model, input: RegionInput) => {
  const solve = solveRegion(model.mesh, model.topology, input, model.noise)!;
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  return { solve, out };
};
/** The upper third of the elbow's circumference: what a user sees and paints from above. */
const upperThird = (_: number, y: number) => y > 0.5;

/** The fitted sweep of a swept tube, and how far its interior points move onto it at most. */
function fitTube(
  path: TubePath,
  length: number,
  radius: CrossSection,
  ripple: number,
  noise: number,
) {
  const { points, normals, interior } = sweptTube(path, length, radius, ripple);
  const fit = fitSweep(points, normals, noise, null, 0.06);
  if (!fit) return null;
  const projected = new Float32Array(3);
  let farthest = 0;
  for (let i = 0; i < interior.length; i++) {
    if (!interior[i]) continue;
    const [x, y, z] = points.subarray(i * 3, i * 3 + 3);
    projectToSweep(fit.sweep, x, y, z, projected);
    farthest = Math.max(farthest, Math.hypot(projected[0] - x, projected[1] - y, projected[2] - z));
  }
  return { ...fit, farthest };
}

/** Solves a swept tube's painted stretch at `noise`; null when refused, else its largest move. */
function solveTube(
  path: TubePath,
  length: number,
  radius: CrossSection,
  ripple: number,
  noise: number,
  keepDetail: boolean,
) {
  const { model, triangles } = sweptTubeModel(path, length, radius, ripple);
  const solve = solveRegion(
    model.mesh,
    model.topology,
    sweepInput(triangles, { keepDetail }),
    noise,
  );
  if (!solve) return null;
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  let largest = 0;
  for (const v of solve.vertices) largest = Math.max(largest, distanceMoved(model.mesh, out, v));
  return { solve, largest };
}

describe('fitSweep', () => {
  it('recovers an elbow as a round tube on an arc', () => {
    const [points, normals] = elbowSurface(softElbow(4, 1));
    const { sweep } = fitSweep(points, normals, 0.004)!;
    expect(sweep.pathKind).toBe('arc');
    expect(sweep.round).toBe(true);
    expect(Math.abs(mean(sweep.profile) - 1)).toBeLessThan(0.01);
    expect(
      maxDistance(sweep.path.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 4) + Math.abs(y)),
    ).toBeLessThan(0.04);
  });

  it('recovers an elbow from a third of its circumference', () => {
    const [points, normals] = elbowSurface(softElbow(4, 1), upperThird);
    const { sweep } = fitSweep(points, normals, 0.004)!;
    // The bins the patch never reaches take the round profile's mean, not a guess.
    expect(sweep.round).toBe(true);
    expect(sweep.profile.every(Number.isFinite)).toBe(true);
    expect(Math.abs(mean(sweep.profile) - 1)).toBeLessThan(0.01);
    expect(
      maxDistance(sweep.path.points, (x, y, z) => Math.abs(Math.hypot(x, z) - 4) + Math.abs(y)),
    ).toBeLessThan(0.04);
    const projected = new Float32Array(3);
    let farthest = 0;
    for (let i = 0; i < points.length; i += 3) {
      projectToSweep(sweep, points[i], points[i + 1], points[i + 2], projected);
      const [x, y, z] = projected;
      farthest = Math.max(farthest, Math.abs(torusOffset(x, y, z, 4, 1)));
    }
    expect(farthest).toBeLessThan(0.01);
  });

  it('fills profile bins without data from their neighbours on an out-of-round tube', () => {
    // 60% of the circumference of an elbow squashed to 1.1 wide and 0.9 tall.
    const [a, b] = [1.1, 0.9];
    const [points, normals] = elbowSurface(softElbow(4, 1, { ripple: 0 }), (_, y) => y > -0.3);
    const squashed = points.map((v, i) => {
      if (i % 3 === 1) return v * b;
      const rho = Math.hypot(points[i - (i % 3)], points[i - (i % 3) + 2]);
      return (v * (4 + (rho - 4) * a)) / rho;
    });
    const { sweep } = fitSweep(squashed, normals, 0.004)!;
    expect(sweep.round).toBe(false);
    const data = Array.from(sweep.profile);
    expect(data.every(Number.isFinite)).toBe(true);
    expect(Math.min(...data)).toBeGreaterThan(0.85);
    expect(Math.max(...data)).toBeLessThan(1.2);
    // The patch projects onto the squashed tube itself, out to its edges.
    const projected = new Float32Array(3);
    let farthest = 0;
    for (let i = 0; i < squashed.length; i += 3) {
      projectToSweep(sweep, squashed[i], squashed[i + 1], squashed[i + 2], projected);
      const [x, y, z] = projected;
      farthest = Math.max(farthest, Math.abs(Math.hypot((Math.hypot(x, z) - 4) / a, y / b) - 1));
    }
    // The ellipse's algebraic distance overstates the true one by up to 1 / 0.9.
    expect(farthest).toBeLessThan(0.015);
  });

  it('follows a spline when the centre line is not an arc', () => {
    const half = elbowSurface(softElbow(4, 1, { ripple: 0 }), (x, _, z) => z < x);
    const p = 4 * Math.SQRT1_2;
    const [points, normals] = joined(half, halfTurned(half, p, p));
    const { sweep, rms } = fitSweep(points, normals, 0.004)!;
    expect(sweep.pathKind).toBe('spline');
    expect(rms).toBeLessThan(2 * 0.004);
  });

  it('fits a straight tube on a straight path', () => {
    const [points, normals] = straightTube([0, 0, 0], [0, 0, 8], 1);
    const { sweep } = fitSweep(points, normals, 0.004)!;
    expect(sweep.round).toBe(true);
    expect(Math.abs(mean(sweep.profile) - 1)).toBeLessThan(0.005);
    expect(maxDistance(sweep.path.points, (x, y) => Math.hypot(x, y))).toBeLessThan(0.01);
  });

  it('returns null for a patch with no tube in it', () => {
    const [points, normals] = topFace(softBox([2, 1.5, 1], 0.3));
    expect(fitSweep(points, normals, 0.004)).toBeNull();
  });

  it('returns null when the tube changes radius along its length', () => {
    const thin = elbowSurface(softElbow(4, 1), (x, _, z) => z < x);
    const fat = elbowSurface(softElbow(4, 1.3), (x, _, z) => z >= x);
    const [points, normals] = joined(thin, fat);
    expect(fitSweep(points, normals, 0.004)).toBeNull();
  });

  it('follows a one-turn helix along its whole length', () => {
    const fit = fitTube(helixPath, 20.5, round, 0, 0.004)!;
    expect(fit.sweep.pathKind).toBe('spline');
    expect(fit.farthest).toBeLessThan(0.005);
  });

  it('refuses a tube that a stretch of its path leaves, though most of it fits', () => {
    // A sleeve 0.06 proud over 2.5 mm of a quarter turn about 6.3 mm long: wider than the tube.
    const sleeve: CrossSection = (_, t) => (Math.abs(t - 0.5) < 0.2 ? 1.06 : 1);
    expect(fitTube(elbowPath(4), 2 * Math.PI, sleeve, 0, 0.004)).toBeNull();
  });

  it('refuses a tube whose radius drifts by 0.12 mm under 0.012 mm ripple', () => {
    expect(fitTube(straightPath(8), 8, tapered(0.12), 0.012, 0.012)).toBeNull();
    // The same tube without the drift fits, its interior within the ripple.
    expect(fitTube(straightPath(8), 8, round, 0.012, 0.012)!.farthest).toBeLessThan(0.013);
  });

  it('fits an elbow 10% out of round with its free profile', () => {
    const fit = fitTube(elbowPath(4), 2 * Math.PI, oval(0.1), 0, 0.004)!;
    expect(fit.sweep.round).toBe(false);
    expect(fit.farthest).toBeLessThan(0.005);
  });

  it('keeps the flat along a flat-sided tube', () => {
    const fit = fitTube(straightPath(8), 8, flatSided, 0, 0.004)!;
    expect(fit.sweep.round).toBe(false);
    expect(Math.abs(Math.min(...fit.sweep.profile) - 0.85)).toBeLessThan(0.01);
  });

  it('returns null when the centre line folds back on itself', () => {
    // Two tubes meeting at a 30 degree point.
    const tip = 15 * (Math.PI / 180);
    const [points, normals] = joined(
      straightTube([0, 0, 0], [8 * Math.cos(tip), 0, 8 * Math.sin(tip)], 0.5),
      straightTube([0, 0, 0], [8 * Math.cos(tip), 0, -8 * Math.sin(tip)], 0.5),
    );
    expect(fitSweep(points, normals, 0.004)).toBeNull();
  });
});

describe('solveRegion with a sweep', () => {
  it('snaps an elbow region onto the true torus', () => {
    const model = modelOf(softElbow(4, 1));
    const { solve, out } = run(model, sweepInput(tubeTriangles(model.mesh)));
    expect(solve.fitted).toBe('sweep');
    const base = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    expect(base.length).toBeGreaterThan(5000);
    for (const i of base) expect(torusDistance(out, solve.vertices[i], 4, 1)).toBeLessThan(0.005);
  });

  it('snaps a third of the circumference onto the true torus', () => {
    const model = modelOf(softElbow(4, 1));
    const { solve, out } = run(model, sweepInput(tubeTrianglesWhere(model.mesh, upperThird)));
    expect(solve.fits.filter(Boolean)).toEqual(['sweep']);
    const base = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    expect(base.length).toBeGreaterThan(1500);
    for (const i of base) expect(torusDistance(out, solve.vertices[i], 4, 1)).toBeLessThan(0.005);
  });

  it('keeps a clamp standing off the tube with Keep detail on', () => {
    const source = modelOf(softElbow(4, 1)).mesh;
    // A band 0.15 mm high and about 1 mm wide around the tube, halfway round the bend.
    const clamp = (x: number, z: number) => {
      const u = (Math.atan2(z, x) - Math.PI / 4) / 0.125;
      return Math.abs(u) < 1 ? 0.15 * (1 - u * u) ** 2 : 0;
    };
    for (let v = 0; v < source.weldedCount; v++) {
      const [x, y, z] = source.position.subarray(v * 3, v * 3 + 3);
      const rho = Math.hypot(x, z);
      const r = Math.hypot(rho - 4, y);
      const lift = clamp(x, z);
      if (!(lift > 0) || !(r > 0)) continue;
      const scale = (r + lift) / r;
      const rho2 = 4 + (rho - 4) * scale;
      source.position.set([(x * rho2) / rho, y * scale, (z * rho2) / rho], v * 3);
    }
    const model = modelFrom(source);
    const { solve, out } = run(model, sweepInput(tubeTriangles(model.mesh)));
    expect(solve.fitted).toBe('sweep');
    let before = 0,
      after = 0;
    for (let v = 0; v < model.mesh.weldedCount; v++) {
      before = Math.max(before, torusDistance(model.mesh, v, 4, 1));
      after = Math.max(after, torusDistance(out, v, 4, 1));
    }
    expect(before).toBeGreaterThan(0.14);
    expect(Math.abs(after - before)).toBeLessThan(0.02);
    const base = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    for (const i of base) expect(torusDistance(out, solve.vertices[i], 4, 1)).toBeLessThan(0.005);
  });

  it('moves nothing outside the region and collapses or turns over no triangle', () => {
    const model = modelOf(softElbow(4, 1));
    const triangles = tubeTrianglesWhere(model.mesh, upperThird);
    const { solve, out } = run(model, sweepInput(triangles));
    const inside = new Set(solve.vertices);
    for (let v = 0; v < model.mesh.weldedCount; v++)
      if (!inside.has(v)) expect(distanceMoved(model.mesh, out, v)).toBe(0);
    expect(collapsedTriangles(model.mesh, out)).toBe(0);
    expect(
      foldedTriangles(out, model.topology, model.mesh.position, allVertices(model.mesh)),
    ).toHaveLength(0);
  });

  it('changes nothing visible when run again over its own result', () => {
    // Weight 1 and clear of detail: by 0.001 mm at most. The blend band, which each run moves
    // only part way, and the moves eased into detail: by 0.01 mm at most.
    const model = modelOf(softElbow(4, 1));
    const input = sweepInput(tubeTriangles(model.mesh));
    const first = run(model, input);
    const second = run({ ...modelFrom(first.out), noise: model.noise }, input);
    let settled = 0;
    first.solve.vertices.forEach((v, i) => {
      const full = first.solve.weight[i] === 1 && first.solve.detail[i] === 0;
      if (full) settled++;
      expect(distanceMoved(first.out, second.out, v)).toBeLessThan(full ? 0.001 : 0.01);
    });
    expect(settled).toBeGreaterThan(5000);
  });

  it('snaps a one-turn helix within the noise with Keep detail off, or refuses it', () => {
    const tube = solveTube(helixPath, 20.5, round, 0, 0.012, false);
    expect(tube?.solve.fitted).toBe('sweep');
    expect(tube!.largest).toBeLessThan(0.012);
  });

  it('refuses a 0.12 mm taper under 0.012 mm ripple', () => {
    for (const keepDetail of [false, true])
      expect(solveTube(straightPath(8), 8, tapered(0.12), 0.012, 0.012, keepDetail)).toBeNull();
  });

  it('refuses a tube that swells or narrows by 0.1 mm along its length and returns', () => {
    // Offsets that cancel end to end: a bulge, a waist, and a radius high at both ends.
    const ends: CrossSection = (_, t) => 1 + 0.05 * Math.cos(2 * Math.PI * t);
    for (const radius of [swelling(0.1), swelling(-0.1), ends])
      for (const keepDetail of [false, true])
        expect(solveTube(straightPath(12), 12, radius, 0, 0.012, keepDetail)).toBeNull();
    // The same length of tube, constant under 0.012 mm ripple, still fits.
    expect(solveTube(straightPath(12), 12, round, 0.012, 0.012, false)?.solve.fitted).toBe('sweep');
  });

  it('snaps an elbow 10% out of round onto itself', () => {
    const tube = solveTube(elbowPath(4), 2 * Math.PI, oval(0.1), 0, 0.004, false)!;
    expect(tube.solve.fitted).toBe('sweep');
    expect(tube.largest).toBeLessThan(0.005);
  });

  it('changes nothing visible when run again along a spline', () => {
    // As over the elbow: weight 1 and clear of detail by 0.001 mm at most, the rest by 0.01 mm.
    const { model, triangles } = sweptTubeModel(sBendPath, 2 * Math.PI, round, 0.012);
    const input = sweepInput(triangles);
    const first = run({ ...model, noise: 0.012 }, input);
    expect(first.solve.fitted).toBe('sweep');
    const second = run({ ...modelFrom(first.out), noise: 0.012 }, input);
    let settled = 0;
    first.solve.vertices.forEach((v, i) => {
      const full = first.solve.weight[i] === 1 && first.solve.detail[i] === 0;
      if (full) settled++;
      expect(distanceMoved(first.out, second.out, v)).toBeLessThan(full ? 0.001 : 0.01);
    });
    expect(settled).toBeGreaterThan(5000);
  });

  it('never picks a sweep under Auto', () => {
    const model = modelOf(softElbow(4, 1));
    const solve = (triangles: Uint32Array, shape: RegionInput['shape']) =>
      solveRegion(model.mesh, model.topology, sweepInput(triangles, { shape }), model.noise);
    // The middle third of the bend, which Sweep fits, Auto takes as a cylinder.
    const middle = tubeTrianglesWhere(model.mesh, (x, _, z) => {
      const phi = Math.atan2(z, x);
      return phi > Math.PI / 6 && phi < Math.PI / 3;
    });
    expect(solve(middle, 'sweep')?.fits).toEqual(['sweep']);
    expect(solve(middle, 'auto')?.fits).toEqual(['cylinder']);
    // The whole bend, which no shape fits, Auto refuses.
    expect(solve(tubeTriangles(model.mesh), 'auto')).toBeNull();
  });

  it('returns null for a sweep over a flat face', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const triangles = indicesOfTop(model);
    expect(solveRegion(model.mesh, model.topology, sweepInput(triangles), model.noise)).toBeNull();
  });
});

function indicesOfTop(model: Model) {
  const kept: number[] = [];
  const { mesh } = model;
  for (let t = 0; t < mesh.triangleCount; t++) {
    let inside = true;
    for (let k = 0; k < 3; k++) {
      const v = mesh.weldOf[mesh.corners[t * 3 + k]] * 3;
      const [x, y, z] = [mesh.position[v], mesh.position[v + 1], mesh.position[v + 2]];
      inside &&= y > 1.4 && Math.abs(x) < 1.6 && Math.abs(z) < 0.6;
    }
    if (inside) kept.push(t);
  }
  return Uint32Array.from(kept);
}
