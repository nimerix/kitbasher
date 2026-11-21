import { BoxGeometry, Matrix4 } from 'three';
import { describe, expect, it } from 'vitest';
import { type RefineMesh, cloneRefineMesh, foldedTriangles } from '../../src/core/refine-mesh';
import {
  type RegionInput,
  type RegionSolve,
  applyRegion,
  solveRegion,
} from '../../src/core/refine-region';
import { smoothTargets } from '../../src/core/refine-smooth';
import { maxMove, modelFrom, modelOf, movedOutside } from '../helpers/refine';
import {
  allTriangles,
  allVertices,
  borderDistances,
  collapsedTriangles,
  displacementOf,
  chainOf,
  distanceFromDetail,
  distanceMoved,
  heightAbovePlate,
  heightAt,
  indicesWhere,
  interiorOf,
  largestJump,
  meanRadius,
  refineBoxEdge,
  refineBoxEdgeOf,
  rippleAmplitude,
  spread,
  surfaceHeight,
  trianglesWhere,
} from '../helpers/refine-region';
import { rippledSphere, rivetedPlate, softBox, softCylinder } from '../helpers/soft-edges';
import { dimpledPlate, foldedSheet, heightGrid, warpedPlate } from '../helpers/soft-regions';

const topRegion = (mesh: RefineMesh): Uint32Array =>
  trianglesWhere(mesh, (x, y, z) => y > 0.42 && Math.abs(x) < 2.6 && Math.abs(z) < 1.6);
const flatten = (triangles: Uint32Array, options: Partial<RegionInput> = {}): RegionInput => ({
  triangles,
  treatment: 'flatten',
  shape: 'auto',
  strength: 1,
  keepDetail: true,
  detail: null,
  blend: null,
  ...options,
});
const smooth = (triangles: Uint32Array, options: Partial<RegionInput> = {}): RegionInput =>
  flatten(triangles, { treatment: 'smooth', ...options });
/** Vertex indices of the solve at full weight that are not detail and not eased into it. */
const fullWeight = (solve: RegionSolve) =>
  indicesWhere(solve, (w, d) => w === 1 && d === 0).map((i) => solve.vertices[i]);
const run = (model: ReturnType<typeof modelOf>, input: RegionInput) => {
  const solve = solveRegion(model.mesh, model.topology, input, model.noise)!;
  const out = cloneRefineMesh(model.mesh, false);
  applyRegion(out, solve);
  return { solve, out };
};
const wallRegion = (mesh: RefineMesh) =>
  trianglesWhere(mesh, (x, y, z) => Math.abs(y) < 0.6 && Math.hypot(x, z) > 1.3);

describe('solveRegion and applyRegion', () => {
  it('flattens a plate and keeps its rivets', () => {
    const { geometry, rivets } = rivetedPlate();
    const model = modelOf(geometry);
    const { solve, out } = run(model, flatten(topRegion(model.mesh)));
    expect(solve.fitted).toBe('plane');
    const base = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    expect(base.length).toBeGreaterThan(1000);
    for (const i of base)
      expect(Math.abs(out.position[solve.vertices[i] * 3 + 1] - 0.5)).toBeLessThan(0.005);
    for (const rivet of rivets)
      expect(
        Math.abs(heightAt(out, rivet.x, rivet.z) - 0.5 - heightAbovePlate(model.mesh, rivet)),
      ).toBeLessThan(0.01);
  });

  it('reports the settings it used, so taking one off Auto at that value changes nothing', () => {
    const model = modelOf(rivetedPlate().geometry);
    const region = topRegion(model.mesh);
    const auto = run(model, flatten(region));
    const [used] = auto.solve.resolved;
    expect(used!.blend).toBeGreaterThan(0);
    expect(used!.scale).toBeGreaterThan(0);
    expect(used!.detail).toBeGreaterThan(0);
    const manual = run(model, flatten(region, { ...used! }));
    expect(manual.solve.resolved[0]).toEqual(used);
    expect(manual.out.position).toEqual(auto.out.position);
    // A set value is reported as set, and no offset is reported when no detail is looked for.
    const set = run(model, flatten(region, { blend: 0.5, keepDetail: false })).solve.resolved[0]!;
    expect(set).toMatchObject({ blend: 0.5, detail: null });
  });

  it('flattens rivets too when Keep detail is off', () => {
    const { geometry, rivets } = rivetedPlate();
    const model = modelOf(geometry);
    const { out } = run(model, flatten(topRegion(model.mesh), { keepDetail: false }));
    for (const rivet of rivets)
      expect(Math.abs(heightAt(out, rivet.x, rivet.z) - 0.5)).toBeLessThan(0.01);
  });

  it('keeps recessed detail like raised detail', () => {
    const { geometry, dimples } = dimpledPlate();
    const model = modelOf(geometry);
    const { solve, out } = run(model, flatten(topRegion(model.mesh)));
    expect(solve.fitted).toBe('plane');
    for (const dimple of dimples) {
      const depth = heightAbovePlate(model.mesh, dimple);
      expect(depth).toBeLessThan(-0.2);
      expect(Math.abs(heightAt(out, dimple.x, dimple.z) - 0.5 - depth)).toBeLessThan(0.01);
    }
  });

  it('smooths a sphere without shrinking it', () => {
    const model = modelOf(rippledSphere(3));
    const all = Uint32Array.from({ length: model.mesh.triangleCount }, (_, i) => i);
    const { out } = run(model, smooth(all, { keepDetail: false }));
    expect(rippleAmplitude(out)).toBeLessThan(0.25 * rippleAmplitude(model.mesh));
    expect(Math.abs(meanRadius(out) - meanRadius(model.mesh)) / 3).toBeLessThan(0.005);
  });

  // The fixture's waves lengthen near six points, past the default reach; a 2.2 mm reach spans them.
  it("smooths the sphere's lengthened waves at a 2.2 mm scale", () => {
    const model = modelOf(rippledSphere(3));
    const all = Uint32Array.from({ length: model.mesh.triangleCount }, (_, i) => i);
    const { out } = run(model, smooth(all, { keepDetail: false, scale: 2.2 }));
    expect(rippleAmplitude(out)).toBeLessThan(0.12 * rippleAmplitude(model.mesh));
    expect(Math.abs(meanRadius(out) - meanRadius(model.mesh)) / 3).toBeLessThan(0.005);
  });

  it('smooths a cylinder wall and a flat face without moving them', () => {
    const tube = modelOf(softCylinder(1.5, 1, 0.3));
    const wall = run(tube, smooth(wallRegion(tube.mesh), { keepDetail: false }));
    const wallBase = fullWeight(wall.solve);
    expect(wallBase.length).toBeGreaterThan(500);
    const radius = (p: number[]) => Math.hypot(p[0], p[2]);
    const [wallBefore, wallAfter] = [tube.mesh, wall.out].map((m) => spread(m, wallBase, radius));
    expect(Math.abs(wallAfter.mean - wallBefore.mean) / 1.5).toBeLessThan(0.005);
    expect(wallAfter.rms).toBeLessThan(0.2 * wallBefore.rms);

    const box = modelOf(softBox([2, 1.5, 1], 0.3));
    const top = trianglesWhere(
      box.mesh,
      (x, y, z) => y > 1.4 && Math.abs(x) < 1.7 && Math.abs(z) < 0.7,
    );
    const face = run(box, smooth(top, { keepDetail: false }));
    const faceBase = fullWeight(face.solve);
    expect(faceBase.length).toBeGreaterThan(500);
    const height = (p: number[]) => p[1];
    const [faceBefore, faceAfter] = [box.mesh, face.out].map((m) => spread(m, faceBase, height));
    expect(Math.abs(faceAfter.mean - faceBefore.mean) / 1.5).toBeLessThan(0.005);
    expect(faceAfter.rms).toBeLessThan(0.2 * faceBefore.rms);
  });

  it('keeps the rivets under Smooth with Keep detail on', () => {
    const { geometry, rivets } = rivetedPlate();
    const model = modelOf(geometry);
    const { out } = run(model, smooth(topRegion(model.mesh), { keepDetail: true }));
    expect(maxMove(model.mesh, out)).toBeGreaterThan(0);
    for (const rivet of rivets)
      expect(
        Math.abs(heightAbovePlate(out, rivet) - heightAbovePlate(model.mesh, rivet)),
      ).toBeLessThan(0.01);
  });

  it('recovers a cylinder with Shape and names it with Auto', () => {
    const model = modelOf(softCylinder(1.5, 1, 0.3));
    const { solve, out } = run(model, {
      ...flatten(wallRegion(model.mesh)),
      treatment: 'shape',
      shape: 'auto',
    });
    expect(solve.fitted).toBe('cylinder');
    const base = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    expect(base.length).toBeGreaterThan(1000);
    for (const i of base) {
      const v = solve.vertices[i] * 3;
      expect(Math.abs(Math.hypot(out.position[v], out.position[v + 2]) - 1.5)).toBeLessThan(0.005);
    }
  });

  it('does nothing at strength 0 and grows steadily with strength', () => {
    const model = modelOf(rivetedPlate().geometry);
    const moved = (strength: number) =>
      maxMove(model.mesh, run(model, flatten(topRegion(model.mesh), { strength })).out);
    expect(moved(0)).toBe(0);
    const [quarter, half, full] = [moved(0.25), moved(0.5), moved(1)];
    expect(quarter).toBeGreaterThan(0);
    expect(quarter).toBeLessThan(half);
    expect(half).toBeLessThan(full);
  });

  it('leaves the border and everything outside bit-identical', () => {
    const model = modelOf(rivetedPlate().geometry);
    const triangles = topRegion(model.mesh);
    const interior = interiorOf(model.mesh, model.topology, triangles);
    for (const treatment of ['flatten', 'smooth'] as const) {
      const { out } = run(model, flatten(triangles, { treatment }));
      expect(maxMove(model.mesh, out)).toBeGreaterThan(0);
      expect(movedOutside(model.mesh, out, interior)).toBe(0);
    }
  });

  it('fades in across the blend band', () => {
    const model = modelOf(rivetedPlate().geometry);
    const triangles = topRegion(model.mesh);
    const blend = 0.3;
    const solve = solveRegion(
      model.mesh,
      model.topology,
      flatten(triangles, { blend, keepDetail: false }),
      model.noise,
    )!;
    const distance = borderDistances(model, triangles, solve);
    let inBand = 0;
    distance.forEach((d, i) => {
      const w = solve.weight[i];
      if (d === 0) expect(w).toBe(0);
      else if (d < blend - 1e-9) {
        inBand++;
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThan(1);
      } else if (d > blend + 1e-9) expect(w).toBe(1);
    });
    expect(inBand).toBeGreaterThan(100);
  });

  /** Moves of each vertex of the first solve over a run and over a second run on its result. */
  const twice = (model: ReturnType<typeof modelOf>, input: RegionInput) => {
    const first = run(model, input);
    const second = run({ ...modelFrom(first.out), noise: model.noise }, input);
    const clear = distanceFromDetail(model, first.solve);
    return Array.from(first.solve.vertices, (v, i) => ({
      settled: first.solve.weight[i] === 1 && clear[i] > 4 * model.step,
      before: distanceMoved(model.mesh, first.out, v),
      after: distanceMoved(first.out, second.out, v),
    }));
  };
  const plateAndTube = () => {
    const plate = modelOf(rivetedPlate().geometry);
    const tube = modelOf(softCylinder(1.5, 1, 0.3));
    return [
      twice(plate, flatten(topRegion(plate.mesh))),
      twice(tube, { ...flatten(wallRegion(tube.mesh)), treatment: 'shape' }),
    ];
  };

  it('changes nothing visible when run again over its own result', () => {
    // Weight 1 and over four edges from detail and edges: still. Elsewhere: by 0.01 mm at most.
    for (const moves of plateAndTube()) {
      expect(moves.filter((m) => m.settled).length).toBeGreaterThan(500);
      for (const { settled, after } of moves) expect(after).toBeLessThan(settled ? 0.001 : 0.01);
    }
  });

  it('flattens a low, wide warp that Keep detail would otherwise keep', () => {
    for (const [peak, kept] of [
      [0.045, false],
      [0.09, true],
    ] as const) {
      const model = modelOf(warpedPlate(peak));
      const { solve, out } = run(model, flatten(topRegion(model.mesh), { detail: 0.03 }));
      const height = heightAt(out, 0, 0) - spread(out, fullWeight(solve), (p) => p[1]).mean;
      if (kept) expect(height).toBeGreaterThan((2 / 3) * peak);
      else expect(Math.abs(height)).toBeLessThan(0.01);
    }
  });

  it('never moves a refined edge under Flatten, and eases the face into it', () => {
    const { out } = refineBoxEdge();
    const model = modelFrom(out);
    const across = trianglesWhere(out, (x, y, z) => Math.abs(x) < 1 && y > 1 && z > 0.5);
    const { solve, out: flat } = run(model, flatten(across, { keepDetail: false }));
    expect(maxMove(out, flat)).toBeGreaterThan(0);
    const chain = chainOf(out);
    for (const v of chain) expect(distanceMoved(out, flat, v)).toBe(0);
    const eased = indicesWhere(solve, (_, d) => d === 2);
    expect(eased.length).toBeGreaterThan(0);
  });

  it('keeps an accepted edge crisp when a region across it is smoothed', () => {
    const { out } = refineBoxEdge();
    const model = modelFrom(out);
    const across = trianglesWhere(out, (x, y, z) => Math.abs(x) < 1 && y > 1 && z > 0.5);
    const solve = solveRegion(
      model.mesh,
      model.topology,
      { ...flatten(across, { keepDetail: false }), treatment: 'smooth' },
      model.noise,
    )!;
    const smoothed = cloneRefineMesh(model.mesh, false);
    applyRegion(smoothed, solve);
    expect(maxMove(out, smoothed)).toBeGreaterThan(0);
    const chain = chainOf(out);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain) expect(distanceMoved(out, smoothed, v)).toBe(0);
  });

  it('gives a flat face with a crisp border when flattened first and edged second', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    const top = trianglesWhere(
      model.mesh,
      (x, y, z) => y > 1.4 && Math.abs(x) < 1.7 && Math.abs(z) < 0.7,
    );
    const { solve, out: flat } = run(model, flatten(top));
    const { out } = refineBoxEdgeOf(modelFrom(flat));
    const face = indicesWhere(solve, (w, d) => w === 1 && d === 0);
    expect(face.length).toBeGreaterThan(500);
    for (const i of face)
      expect(Math.abs(out.position[solve.vertices[i] * 3 + 1] - 1.5)).toBeLessThan(0.005);
    const chain = chainOf(out).filter((v) => Math.abs(out.position[v * 3]) <= 1);
    expect(chain.length).toBeGreaterThan(20);
    for (const v of chain)
      expect(Math.hypot(out.position[v * 3 + 1] - 1.5, out.position[v * 3 + 2] - 1)).toBeLessThan(
        0.02,
      );
  });

  it('returns null for a region too small to fit', () => {
    const model = modelOf(softBox([2, 1.5, 1], 0.3));
    expect(
      solveRegion(model.mesh, model.topology, flatten(new Uint32Array([0])), model.noise),
    ).toBeNull();
  });

  it('never collapses or turns over a triangle, holding faces turned away from the fit', () => {
    const model = modelOf(new BoxGeometry(4, 3, 0.08, 12, 9, 1));
    const all = allTriangles(model.mesh);
    const solve = solveRegion(
      model.mesh,
      model.topology,
      flatten(all, { keepDetail: false }),
      0.01,
    );
    const out = cloneRefineMesh(model.mesh, false);
    if (solve) applyRegion(out, solve);
    expect(collapsedTriangles(model.mesh, out)).toBe(0);
    expect(
      foldedTriangles(out, model.topology, model.mesh.position, allVertices(model.mesh)),
    ).toHaveLength(0);
    // The faces turned away from the fitted plane keep their place.
    for (let v = 0; v < model.mesh.weldedCount; v++)
      if (model.mesh.position[v * 3 + 2] < 0) expect(distanceMoved(model.mesh, out, v)).toBe(0);
  });

  it('fits each edge-connected patch on its own', () => {
    const model = modelOf(heightGrid((x) => (x < 0 ? 0.15 : -0.15)));
    const triangles = trianglesWhere(
      model.mesh,
      (x, y) => Math.abs(x) > 0.5 && Math.abs(x) < 2.6 && Math.abs(y) < 1.6,
    );
    const { solve, out } = run(model, flatten(triangles, { keepDetail: false }));
    expect(solve.fits).toEqual(['plane', 'plane']);
    expect(solve.fitted).toBe('plane');
    let checked = 0;
    for (let v = 0; v < model.mesh.weldedCount; v++) {
      const [x, y] = [model.mesh.position[v * 3], model.mesh.position[v * 3 + 1]];
      if (Math.abs(x) < 1 || Math.abs(x) > 2.1 || Math.abs(y) > 1.1) continue;
      checked++;
      expect(distanceMoved(model.mesh, out, v)).toBeLessThan(0.005);
    }
    expect(checked).toBeGreaterThan(1000);
  });

  it('reads no sample farther along the surface than its scale', () => {
    // Moving the far side of a fold, 0.77 mm away along the surface but 0.12 mm away in space.
    const fit = (rise: number) => {
      const model = modelOf(foldedSheet(rise));
      const vertices = allVertices(model.mesh);
      const source = vertices.find((v) => {
        const p = model.mesh.position;
        return (
          Math.abs(p[v * 3] - 0.4) < 1e-6 && Math.abs(p[v * 3 + 1]) < 1e-6 && p[v * 3 + 2] === 0
        );
      })!;
      const free = Uint8Array.from(vertices, (v) => Number(v === source));
      const target = smoothTargets(
        model.mesh,
        model.topology,
        vertices,
        free,
        0.6,
        1,
        model.mesh.crease,
      );
      return Array.from(target.subarray(source * 3, source * 3 + 3));
    };
    const [before, after] = [fit(0), fit(0.08)];
    expect(Math.hypot(...after.map((value, axis) => value - before[axis]))).toBeLessThan(1e-6);
  });

  it('keeps an ordinary crest under Smooth with Keep detail on', () => {
    // A softened right-angle crest, and the same crest unsoftened, inside the smoothed region.
    for (const soften of [0.05, 0]) {
      const model = modelOf(heightGrid((x) => soften - Math.hypot(x, soften)));
      const { out } = run(model, smooth(allTriangles(model.mesh), { keepDetail: true }));
      let crest = 0;
      for (let v = 0; v < model.mesh.weldedCount; v++) {
        const [x, y] = [model.mesh.position[v * 3], model.mesh.position[v * 3 + 1]];
        if (Math.abs(x) > 1e-6 || Math.abs(y) > 1.4) continue;
        crest++;
        expect(Math.abs(out.position[v * 3 + 2] - model.mesh.position[v * 3 + 2])).toBeLessThan(
          0.01,
        );
      }
      expect(crest).toBeGreaterThan(50);
    }
  });

  it('moves each island of detail as one, at the least weight of its vertices', () => {
    // A rivet on a raised pad, the brush ending on its flank, at half strength.
    const rivet = (x: number, y: number) => {
      const r = Math.hypot(x - 0.25, y);
      return (
        0.11 * Math.min(1, Math.max(0, (0.95 - r) / 0.2)) +
        0.29 * Math.max(0, 1 - (r / 0.37) ** 2) ** 2
      );
    };
    for (const [right, moves] of [
      [0.53, false],
      [1.5, true],
    ] as const) {
      const model = modelOf(heightGrid(rivet));
      const triangles = trianglesWhere(
        model.mesh,
        (x, y) => x < right && x > -2.75 && Math.abs(y) < 1.8,
      );
      const input = flatten(triangles, { strength: 0.5, detail: 0.13 });
      const { solve, out } = run(model, input);
      const island = indicesWhere(solve, (_, d) => d === 1).map((i) => solve.vertices[i]);
      expect(island.length).toBeGreaterThan(100);
      const first = displacementOf(model.mesh, out, island[0]);
      if (moves) expect(Math.hypot(...first)).toBeGreaterThan(0.01);
      else expect(Math.hypot(...first)).toBe(0);
      for (const v of island) {
        const d = displacementOf(model.mesh, out, v);
        expect(Math.hypot(...d.map((value, axis) => value - first[axis]))).toBeLessThan(1e-5);
      }
    }
  });

  it('eases the base continuously where two islands meet', () => {
    // Two rivets 0.16 mm apart on a wave the flattening removes, so they carry opposite moves.
    const model = modelOf(
      heightGrid((x, y) => {
        const dome = (cx: number) =>
          0.2 * Math.max(0, 1 - (Math.hypot(x - cx, y) / 0.12) ** 2) ** 2;
        return 0.05 * Math.sin((Math.PI * x) / 0.5) + dome(-0.2) + dome(0.2);
      }),
    );
    const triangles = trianglesWhere(model.mesh, (x, y) => Math.abs(x) < 2.6 && Math.abs(y) < 1.6);
    const { solve, out } = run(model, flatten(triangles, { detail: 0.1 }));
    expect(
      new Set(
        indicesWhere(solve, (_, d) => d === 1).map((i) =>
          Math.sign(model.mesh.position[solve.vertices[i] * 3]),
        ),
      ),
    ).toEqual(new Set([-1, 1]));
    // Between the islands no step beyond the wave's own slope, measured away from them.
    const between = largestJump(
      model,
      solve,
      out,
      (x, y) => Math.abs(x) < 0.15 && Math.abs(y) < 0.2,
    );
    const away = largestJump(
      model,
      solve,
      out,
      (x, y) => Math.abs(x) > 0.6 && Math.abs(x) < 2 && Math.abs(y) < 0.2,
    );
    expect(between).toBeLessThan(away + 0.001);
  });

  it('checks the positions it writes, which are 64-bit and written unchanged', () => {
    // A fine sheet far from the origin, where a 32-bit target would round its triangles away.
    const model = modelOf(
      heightGrid(() => 0, 64, 20, -0.064, -0.02, 0.002),
      new Matrix4().makeTranslation(32_768, 0, 0),
    );
    const { mesh, topology } = model;
    for (let v = 0; v < mesh.weldedCount; v++)
      if (Math.abs(mesh.position[v * 3] - 32_768) < 1e-8) mesh.crease[v] = 1;
    const solve = solveRegion(
      mesh,
      topology,
      flatten(allTriangles(mesh), { keepDetail: false }),
      0.01,
    )!;
    expect(solve.target).toBeInstanceOf(Float64Array);
    const out = cloneRefineMesh(mesh, false);
    const written = applyRegion(out, solve);
    expect(written.length).toBeGreaterThan(0);
    expect(collapsedTriangles(mesh, out)).toBe(0);
    expect(foldedTriangles(out, topology, mesh.position, written)).toHaveLength(0);
    const index = new Map(Array.from(solve.vertices, (v, i) => [v, i]));
    for (const v of written)
      for (let axis = 0; axis < 3; axis++)
        expect(out.position[v * 3 + axis]).toBe(solve.target[index.get(v)! * 3 + axis]);
  });

  it('refuses the whole selection when one patch still fails its triangle check', () => {
    // A boss whose cliff faces away from the plane, under a 68 degree ramp: every round of holding
    // leaves the next ring of the ramp folding over the held one. Beside it, a separate rippled patch.
    const model = modelOf(
      heightGrid(
        (x, y) => {
          const r = Math.hypot(x, y);
          if (x > 2) return 0.01 * Math.sin(8 * x) * Math.sin(8 * y);
          if (r > 0.8) return 0;
          if (r > 0.75) return (0.6 * (0.8 - r)) / 0.05;
          return 0.6 + 2.5 * Math.min(0.75 - r, 0.6);
        },
        120,
        40,
        -2,
        -1,
      ),
    );
    const boss = trianglesWhere(model.mesh, (x, y) => Math.abs(x) < 1.9 && Math.abs(y) < 0.95);
    const ripple = trianglesWhere(model.mesh, (x, y) => x > 2.3 && x < 3.9 && Math.abs(y) < 0.95);
    const solve = (triangles: Uint32Array) =>
      solveRegion(
        model.mesh,
        model.topology,
        flatten(triangles, { keepDetail: false }),
        model.noise,
      );
    expect(solve(boss)).toBeNull();
    const alone = run(model, flatten(ripple, { keepDetail: false }));
    expect(alone.solve.fits).toEqual(['plane']);
    expect(maxMove(model.mesh, alone.out)).toBeGreaterThan(0.001);
    expect(solve(Uint32Array.from([...boss, ...ripple]))).toBeNull();
  });

  it('settles a painted cap on a second Flatten', () => {
    // No detail and no crease: the blend band is most of the region, and its weights change as the
    // cap flattens, so a fit that switched between sample sets would move the whole cap again.
    const model = modelOf(heightGrid((x, y) => -0.9 * (x * x + y * y), 28, 28, -0.7, -0.7));
    const cap = trianglesWhere(model.mesh, (x, y) => Math.hypot(x, y) < 0.31);
    const moves = twice({ ...model, noise: 0.01 }, flatten(cap, { keepDetail: false }));
    expect(moves.filter((m) => m.settled).length).toBeGreaterThan(10);
    for (const { settled, after } of moves) expect(after).toBeLessThan(settled ? 0.001 : 0.01);
  });

  it('flattens a painted disc onto its full-weight flat centre past a low-weight outer ring', () => {
    const model = modelOf(
      heightGrid(
        (x, y) => {
          const u = Math.min(1, Math.max(0, (Math.hypot(x, y) - 0.1) / 0.06));
          return 0.025 * u * u * (3 - 2 * u);
        },
        24,
        24,
        -0.72,
        -0.72,
        0.06,
      ),
    );
    const { mesh, topology } = model;
    const disc = trianglesWhere(mesh, (x, y) => Math.hypot(x, y) < 0.33);
    const solve = solveRegion(mesh, topology, flatten(disc, { keepDetail: false }), 0.001)!;
    expect(solve).not.toBeNull();
    const centre = Array.from(solve.vertices).findIndex(
      (v) => Math.hypot(mesh.position[v * 3], mesh.position[v * 3 + 1]) < 1e-6,
    );
    expect(solve.weight[centre]).toBe(1);
    // The flat centre holds most of the weight the fit gives the base, the blend to the 8th power.
    let total = 0,
      flat = 0;
    solve.vertices.forEach((v, i) => {
      const w = solve.weight[i] ** 8;
      total += w;
      if (Math.abs(mesh.position[v * 3 + 2]) < 1e-6) flat += w;
    });
    expect(flat / total).toBeGreaterThan(0.7);
    expect(Math.abs(solve.target[centre * 3 + 2])).toBeLessThan(0.005);
  });

  it('keeps a shallow groove at a set offset, and a deep one at the automatic offset', () => {
    for (const [depth, detail] of [
      [0.06, 0.03],
      [0.15, null],
    ] as const) {
      const model = modelOf(
        heightGrid(
          (x, y) =>
            0.004 * Math.cos(18 * x) * Math.cos(18 * y) -
            depth * Math.max(0, 1 - (y / 0.15) ** 2) ** 2,
        ),
      );
      const triangles = trianglesWhere(
        model.mesh,
        (x, y) => Math.abs(x) < 2.6 && Math.abs(y) < 1.6,
      );
      const { out } = run(model, smooth(triangles, { detail }));
      const grooveDepth = (mesh: RefineMesh, x: number) =>
        (surfaceHeight(mesh, x, -0.4) + surfaceHeight(mesh, x, 0.4)) / 2 -
        surfaceHeight(mesh, x, 0);
      for (const x of [-1, -0.5, 0, 0.5, 1]) {
        expect(grooveDepth(model.mesh, x)).toBeGreaterThan(depth - 0.01);
        expect(Math.abs(grooveDepth(out, x) - grooveDepth(model.mesh, x))).toBeLessThan(0.01);
      }
    }
  });
});
