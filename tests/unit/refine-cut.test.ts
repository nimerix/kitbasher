import { describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry, Matrix4, SphereGeometry, Vector3 } from 'three';
import { weldedPositionIndex } from '../../src/core/mesh-topology';
import { buildTopology, cloneRefineMesh, writeRefinedGeometry } from '../../src/core/refine-mesh';
import { cutAlongField, remapTriangles } from '../../src/core/refine-cut';
import {
  closed,
  closedMesh,
  cornerTetrahedron,
  edgeLoops,
  loops,
  meshMinTriangleArea,
  modelOf,
  movedOutside,
  octahedron,
  offChainMismatches,
  reversedAgainst,
  straddling,
  straddlingTriangles,
  trianglesWhollyOn,
  writtenVertexOf,
} from '../helpers/refine';
import { type SoftOptions, extrudedProfile, softBox } from '../helpers/soft-edges';

const cases = [
  ['unindexed', {}],
  ['indexed', { indexed: true }],
] as const;

// Cut the box by the plane x = 0.013: an awkward offset so snaps and splits both occur.
const cutBox = (options: SoftOptions, geometry = softBox([2, 1.5, 1], 0.3, options)) => {
  const { mesh, topology } = modelOf(geometry);
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const field = Float32Array.from(ids, (i) => cut.position[i * 3] - 0.013);
  const result = cutAlongField(cut, topology, ids, field, (_x, y, z, out) =>
    out.set([0.013, y, z]),
  );
  return { mesh, cut, result };
};

describe.each(cases)('cutAlongField, %s', (_, options) => {
  const run = () => cutBox(options);
  it('leaves no triangle straddling the cut', () => {
    const { cut } = run();
    expect(straddling(cut, (x) => x - 0.013, 1e-6)).toBe(0);
  });
  it('stays closed with no zero-area triangle and no triangle wholly on the cut', () => {
    const { cut, result } = run();
    expect(closedMesh(cut)).toBe(true);
    expect(meshMinTriangleArea(cut)).toBeGreaterThan(1e-8);
    expect(trianglesWhollyOn(cut, result.chain)).toBe(0);
  });
  it('forms one closed loop of mesh edges', () => {
    const { cut, result } = run();
    expect(loops(cut, result.chain)).toEqual([result.chain.length]);
  });
  it('reports one closed loop of segments through the whole chain and skips nothing', () => {
    const { result } = run();
    expect(edgeLoops(result.edges, result.chain)).toEqual([result.chain.length]);
    expect(result.skipped.length).toBe(0);
  });
  it('moves nothing off the cut and marks the chain', () => {
    const { mesh, cut, result } = run();
    expect(movedOutside(mesh, cut, result.chain)).toBe(0);
    expect([...result.chain].every((v) => cut.crease[v] === 1 && cut.touched[v] === 1)).toBe(true);
  });
  it('writes a closed geometry whose duplicates agree', () => {
    const { cut } = run();
    const out = writeRefinedGeometry(softBox([2, 1.5, 1], 0.3, options), new Matrix4(), cut);
    expect(closed(out)).toBe(true);
  });
});

it('splits instead of snapping when a snap would put a triangle wholly on the cut', () => {
  // Corners (1,0,0) and (0,1,0) are on the zero set; the origin is 0.05 of the way to (0,0,1).
  const { mesh, topology } = modelOf(cornerTetrahedron(false));
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const p = (i: number, axis: number) => cut.position[i * 3 + axis];
  const field = Float32Array.from(ids, (i) => 0.05 - p(i, 2) - 0.05 * (p(i, 0) + p(i, 1)));
  const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) => out.set([x, y, z]));
  expect(movedOutside(mesh, cut, result.chain)).toBe(0);
  expect(result.chain.length).toBe(3);
  expect(trianglesWhollyOn(cut, result.chain)).toBe(0);
  expect(closedMesh(cut)).toBe(true);
  const split = result.chain[2];
  expect([0, 1, 2].map((axis) => p(split, axis))).toEqual([0, 0, Math.fround(0.1)]);
});

it('drops a split whose placement would collapse a triangle', () => {
  // Corners (0,1,0) and (0,0,1) are on the zero set; the refused snap of the origin is at t = 0.0625
  // along the x axis, and projecting onto x = 0 puts any split of that edge on the origin.
  const { mesh, topology } = modelOf(cornerTetrahedron(false));
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const p = (i: number, axis: number) => cut.position[i * 3 + axis];
  const fn = (x: number, y: number, z: number) => x - 0.0625 + 0.0625 * (y + z);
  const field = Float32Array.from(ids, (i) => fn(p(i, 0), p(i, 1), p(i, 2)));
  const result = cutAlongField(cut, topology, ids, field, (_x, y, z, out) => out.set([0, y, z]));
  expect(closedMesh(cut)).toBe(true);
  expect(meshMinTriangleArea(cut)).toBeGreaterThan(1e-9);
  expect(movedOutside(mesh, cut, result.chain)).toBe(0);
  expect([...result.skipped]).toEqual(straddlingTriangles(cut, fn, 1e-6));
  expect(result.skipped.length).toBeGreaterThan(0);
});

it('refuses a placement that would reverse a triangle against the one it is cut from', () => {
  // Every point on the plane x = 0.013 is placed 0.2 mm along +x, past the next column of vertices.
  const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const fn = (x: number) => x - 0.013;
  const field = Float32Array.from(ids, (i) => fn(cut.position[i * 3]));
  const result = cutAlongField(cut, topology, ids, field, (_x, y, z, out) =>
    out.set([0.213, y, z]),
  );
  const parentOf = new Map<number, number>();
  for (const [parent, children] of result.children)
    for (const child of children) parentOf.set(child, parent);
  expect(reversedAgainst(mesh, cut, parentOf)).toBe(0);
  expect(result.skipped.length).toBeGreaterThan(0);
  expect([...result.skipped]).toEqual(straddlingTriangles(cut, fn, 1e-6));
  expect(closedMesh(cut)).toBe(true);
  expect(meshMinTriangleArea(cut)).toBeGreaterThan(1e-12);
});

it('leaves a split that is not a crease where the zero set crosses rather than drop it', () => {
  // The same placement as above, but no point is a crease: refused splits stay unplaced on their edge.
  const { mesh, topology } = modelOf(softBox([2, 1.5, 1], 0.3));
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const field = Float32Array.from(ids, (i) => cut.position[i * 3] - 0.013);
  const result = cutAlongField(cut, topology, ids, field, (_x, y, z, out) => {
    out.set([0.213, y, z]);
    return false;
  });
  const parentOf = new Map<number, number>();
  for (const [parent, children] of result.children)
    for (const child of children) parentOf.set(child, parent);
  expect(reversedAgainst(mesh, cut, parentOf)).toBe(0);
  expect(result.skipped).toHaveLength(0);
  expect([...result.chain].some((v) => Math.abs(cut.position[v * 3] - 0.013) < 1e-6)).toBe(true);
  expect([...result.chain].every((v) => cut.crease[v] === 0)).toBe(true);
  expect(closedMesh(cut)).toBe(true);
  expect(meshMinTriangleArea(cut)).toBeGreaterThan(1e-12);
});

it('keeps a placement off a vertex joined neither to the band nor to its one-ring', () => {
  // Two closed tetrahedra 0.35 mm apart; the lower one's apex is placed on a corner of the upper one.
  const base = cornerTetrahedron(false).getAttribute('position');
  const points: number[] = [];
  for (const lift of [0, 0.41])
    for (let i = 0; i < base.count; i++)
      points.push(base.getX(i) * 0.06, base.getY(i) * 0.06, base.getZ(i) * 0.06 + lift);
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(points), 3));
  geometry.computeVertexNormals();
  const { mesh, topology } = modelOf(geometry);
  const cut = cloneRefineMesh(mesh, true);
  const z = (v: number) => mesh.position[v * 3 + 2];
  const all = Uint32Array.from({ length: mesh.weldedCount }, (_, i) => i);
  const ids = all.filter((v) => z(v) < 0.2);
  const apex = ids.find((v) => z(v) > 0.05)!;
  const target = all.find(
    (v) => z(v) > 0.4 && mesh.position[v * 3] === 0 && mesh.position[v * 3 + 1] === 0,
  )!;
  const field = Float32Array.from(ids, (v) => (v === apex ? 0 : 1));
  cutAlongField(cut, topology, ids, field, (x, y, _z, out) => out.set([x, y, z(target)]));
  expect(cut.position[apex * 3 + 2]).toBe(z(apex));
  const written = writeRefinedGeometry(geometry, new Matrix4(), cut);
  expect(weldedPositionIndex(written).vertices).toBe(8);
});

// A 115 degree edge rounded with r 0.1 mm: its band moved onto the two planes, then cut on the
// plane between them with each point placed on the corner line, as `applyEdge` does.
const cutRoundedCorner = (facing: boolean) => {
  const turn = (-115 * Math.PI) / 180;
  const geometry = extrudedProfile(
    [
      [-1.2, 0],
      [0, 0],
      [1.2 * Math.cos(turn), 1.2 * Math.sin(turn)],
    ],
    [0.1],
    2,
  );
  const { mesh, topology } = modelOf(geometry);
  const planes = [
    [0, 1, 0],
    [-Math.sin(turn), Math.cos(turn), 0],
  ];
  const along = (n: number[], x: number, y: number) => n[0] * x + n[1] * y;
  const fn = (x: number, y: number) =>
    Math.abs(along(planes[0], x, y)) - Math.abs(along(planes[1], x, y));
  const cut = cloneRefineMesh(mesh, true);
  const band: number[] = [];
  for (let v = 0; v < cut.weldedCount; v++) {
    const [x, y, z] = [0, 1, 2].map((a) => cut.position[v * 3 + a]);
    if (Math.hypot(x, y) > 0.4) continue;
    const n = planes[fn(x, y) < 0 ? 0 : 1];
    const d = along(n, x, y);
    cut.position.set([x - d * n[0], y - d * n[1], z], v * 3);
    band.push(v);
  }
  const ids = Uint32Array.from(band);
  const field = Float32Array.from(ids, (v) => fn(cut.position[v * 3], cut.position[v * 3 + 1]));
  const result = cutAlongField(
    cut,
    topology,
    ids,
    field,
    (_x, _y, z, out) => out.set([0, 0, z]),
    undefined,
    facing ? (_x, _y, _z, side, out) => out.set(planes[side > 0 ? 1 : 0]) : undefined,
  );
  return { cut, result, straddling: straddlingTriangles(cut, fn, 1e-6) };
};

it('judges children against the surface they belong to on a 115 degree edge', () => {
  const without = cutRoundedCorner(false);
  expect(without.result.skipped.length).toBeGreaterThan(0);
  const { cut, result, straddling } = cutRoundedCorner(true);
  expect(result.skipped.length).toBe(0);
  expect(straddling).toEqual([]);
  expect(result.chain.length).toBeGreaterThan(0);
  expect(meshMinTriangleArea(cut)).toBeGreaterThan(1e-9);
});

// A seeded generator, so the planes are the same on every run.
const seeded = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

it.each(cases)(
  'cuts random planes through the box closed and reports what straddles, %s',
  (_, options) => {
    const geometry = softBox([2, 1.5, 1], 0.3, options);
    const { mesh, topology } = modelOf(geometry);
    const next = seeded(20261119);
    for (let plane = 0; plane < 50; plane++) {
      const n = [next() - 0.5, next() - 0.5, next() - 0.5];
      const length = Math.hypot(...n);
      const [nx, ny, nz] = n.map((v) => v / length);
      const d = (next() - 0.5) * 1.5;
      const fn = (x: number, y: number, z: number) => nx * x + ny * y + nz * z - d;
      const cut = cloneRefineMesh(mesh, true);
      const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
      const p = (i: number, axis: number) => cut.position[i * 3 + axis];
      const field = Float32Array.from(ids, (i) => fn(p(i, 0), p(i, 1), p(i, 2)));
      const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) => {
        const f = fn(x, y, z);
        out.set([x - f * nx, y - f * ny, z - f * nz]);
      });
      expect(closedMesh(cut)).toBe(true);
      expect(closed(writeRefinedGeometry(geometry, new Matrix4(), cut))).toBe(true);
      expect(meshMinTriangleArea(cut)).toBeGreaterThanOrEqual(1e-12);
      expect(straddling(cut, fn, 1e-6)).toBe(result.skipped.length);
      const onChain = new Set(result.chain);
      for (let v = 0; v < cut.weldedCount; v++)
        if (cut.touched[v]) expect(onChain.has(v)).toBe(true);
    }
  },
  // 50 cuts per case, about 2 s alone and over the default 5 s on a loaded machine.
  60_000,
);

it('leaves a chord between two snapped vertices out of the segments', () => {
  // +x and +y snap; the edge between them has -z and +z, both negative, on its two sides.
  const { topology, mesh } = modelOf(octahedron(false));
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const p = (i: number, axis: number) => cut.position[i * 3 + axis];
  const at = (x: number, y: number) => ids.find((i) => p(i, 0) === x && p(i, 1) === y)!;
  const [px, py] = [at(1, 0), at(0, 1)];
  const field = Float32Array.from(ids, (i) =>
    i === px || i === py ? -0.05 : p(i, 0) === -1 || p(i, 1) === -1 ? 1 : -1,
  );
  const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) => out.set([x, y, z]));
  expect([...result.chain]).toEqual(expect.arrayContaining([px, py]));
  expect(loops(cut, result.chain)).toEqual([-1]);
  const segments = Array.from({ length: result.edges.length / 2 }, (_, i) =>
    [result.edges[i * 2], result.edges[i * 2 + 1]].sort().join(),
  );
  expect(segments).not.toContain([px, py].sort().join());
  expect(edgeLoops(result.edges, result.chain)).toEqual([result.chain.length]);
});

it('drops a midpoint retry that lands on an unrelated vertex', () => {
  // The -x corner sits on the midpoint of the +x to +z edge. Only +x is positive, barely, so every
  // split next to it collapses, is retried at t = 0.5, and the +x to +z retry lands on that corner.
  const geometry = octahedron(false);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++)
    if (position.getX(i) === -1) position.setXYZ(i, 0.5, 0, 0.5);
  geometry.computeVertexNormals();
  const { mesh, topology } = modelOf(geometry);
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const p = (i: number, axis: number) => cut.position[i * 3 + axis];
  const px = ids.find((i) => p(i, 0) === 1)!,
    pz = ids.find((i) => p(i, 2) === 1)!;
  const field = Float32Array.from(ids, (i) => (i === px ? 1e-9 : -1));
  const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) => out.set([x, y, z]), 0);
  expect(result.chain.length).toBe(3);
  expect(closedMesh(cut)).toBe(true);
  expect(closed(writeRefinedGeometry(geometry, new Matrix4(), cut))).toBe(true);
  const onDroppedEdge = Array.from({ length: cut.triangleCount }, (_, t) => t).filter((t) => {
    const corners = [0, 1, 2].map((k) => cut.weldOf[cut.corners[t * 3 + k]]);
    return corners.includes(px) && corners.includes(pz);
  });
  expect(onDroppedEdge.length).toBe(2);
  expect([...result.skipped]).toEqual(onDroppedEdge);
});

it('keeps a midpoint retry clear of an unrelated vertex in the mesh-local scale', () => {
  // The midpoint-retry octahedron above, scaled by 100, with the -x corner 3e-6 off the midpoint:
  // 3e-4 apart in world space, yet one weld cell apart once written back.
  const geometry = octahedron(false);
  const position = geometry.getAttribute('position');
  for (let i = 0; i < position.count; i++)
    if (position.getX(i) === -1) position.setXYZ(i, 0.500003, 0, 0.5);
  geometry.computeVertexNormals();
  const matrix = new Matrix4().makeScale(100, 100, 100);
  const { mesh, topology } = modelOf(geometry, matrix);
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const px = ids.find((i) => cut.position[i * 3] === 100)!;
  const field = Float32Array.from(ids, (i) => (i === px ? 1e-9 : -1));
  cutAlongField(cut, topology, ids, field, (x, y, z, out) => out.set([x, y, z]), 0);
  expect(closedMesh(cut)).toBe(true);
  expect(closed(writeRefinedGeometry(geometry, matrix, cut))).toBe(true);
});

it('leaves a translated octahedron closed when an exact-zero placement is refused', () => {
  // +z is exactly on the zero set and is placed onto +x, which is refused; it stays where it is.
  const geometry = octahedron(false);
  const matrix = new Matrix4().makeTranslation(new Vector3(1234.567, -987.654, 4321.0987));
  const { mesh, topology } = modelOf(geometry, matrix);
  const cut = cloneRefineMesh(mesh, true);
  const ids = Uint32Array.from({ length: cut.weldedCount }, (_, i) => i);
  const world = (x: number, y: number, z: number) => new Vector3(x, y, z).applyMatrix4(matrix);
  const near = (point: Vector3, x: number, y: number, z: number) =>
    point.distanceTo(new Vector3(x, y, z)) < 1e-3;
  const at = (point: Vector3) =>
    ids.find((i) =>
      near(point, cut.position[i * 3], cut.position[i * 3 + 1], cut.position[i * 3 + 2]),
    )!;
  const plusX = world(1, 0, 0),
    plusZ = world(0, 0, 1);
  const [px, py, pz] = [at(plusX), at(world(0, 1, 0)), at(plusZ)];
  const field = Float32Array.from(ids, (i) => (i === pz ? 0 : i === px || i === py ? 1 : -1));
  const result = cutAlongField(cut, topology, ids, field, (x, y, z, out) =>
    out.set(near(plusZ, x, y, z) ? plusX.toArray() : [x, y, z]),
  );
  expect(result.chain).toContain(pz);
  const written = writeRefinedGeometry(geometry, matrix, cut);
  expect(closed(written)).toBe(true);
  expect(offChainMismatches(geometry, written, cut, result.chain)).toBe(0);
  // The refused vertex stayed put, so it keeps its source bits rather than a round trip's.
  const source = cut.weldOf.indexOf(pz);
  const out = writtenVertexOf(written, cut, pz);
  const stored = (g: BufferGeometry, i: number) =>
    Array.from(g.getAttribute('position').array.slice(i * 3, i * 3 + 3));
  expect(stored(written, out)).toEqual(stored(geometry, source));
});

const ramp = (x: number) => (x + 2) / 4;

it('interpolates colour at a split', () => {
  const geometry = softBox([2, 1.5, 1], 0.3);
  const position = geometry.getAttribute('position');
  const colors = new Float32Array(position.count * 3);
  for (let i = 0; i < position.count; i++) colors.set([ramp(position.getX(i)), 0.5, 0.25], i * 3);
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
  const { cut } = cutBox({}, geometry);
  expect(cut.vertexCount).toBeGreaterThan(cut.sourceVertexCount);
  for (let g = cut.sourceVertexCount; g < cut.vertexCount; g++) {
    expect(Math.abs(cut.color![g * 3] - ramp(0.013))).toBeLessThan(1e-4);
    expect(Math.abs(cut.color![g * 3 + 1] - 0.5)).toBeLessThan(1e-4);
    expect(Math.abs(cut.color![g * 3 + 2] - 0.25)).toBeLessThan(1e-4);
  }
});

it('remaps a painted set through the children map', () => {
  const { mesh, result } = cutBox({});
  // Paint every third source triangle, so split and unsplit ones are both painted.
  const painted = Uint32Array.from({ length: Math.ceil(mesh.triangleCount / 3) }, (_, i) => i * 3);
  const remapped = new Set(remapTriangles(painted, result.children));
  const split = [...painted].filter((t) => result.children.has(t));
  expect(split.length).toBeGreaterThan(0);
  for (const t of painted) {
    expect(remapped.has(t)).toBe(true);
    for (const child of result.children.get(t) ?? []) expect(remapped.has(child)).toBe(true);
  }
  const children = [...painted].flatMap((t) => result.children.get(t) ?? [t]);
  expect(remapped.size).toBe(new Set(children).size);
});

it('cuts a band of about 2,000 vertices in a mesh of 800,000 triangles in a fraction of a pass over it', () => {
  const { mesh, topology } = modelOf(new SphereGeometry(10, 640, 640));
  expect(mesh.triangleCount).toBeGreaterThanOrEqual(800_000);
  const band: number[] = [];
  for (let v = 0; v < mesh.weldedCount; v++)
    if (Math.abs(mesh.position[v * 3 + 1] - 0.013) < 0.075) band.push(v);
  expect(band.length).toBeGreaterThan(1500);
  expect(band.length).toBeLessThan(2500);
  const ids = Uint32Array.from(band);
  // Each cut, on a fresh copy, is timed next to one pass over the whole mesh, best of five of each,
  // so that load from other work on the machine falls on both alike.
  let time = Infinity,
    reference = Infinity;
  for (let run = 0; run < 5; run++) {
    const cut = cloneRefineMesh(mesh, true);
    const field = Float32Array.from(ids, (v) => cut.position[v * 3 + 1] - 0.013);
    let start = performance.now();
    const result = cutAlongField(cut, topology, ids, field, (x, _y, z, out) =>
      out.set([x, 0.013, z]),
    );
    time = Math.min(time, performance.now() - start);
    expect(result.chain.length).toBeGreaterThan(0);
    start = performance.now();
    buildTopology(mesh);
    reference = Math.min(reference, performance.now() - start);
  }
  console.log(
    `cutAlongField: ${ids.length} band vertices, ${time.toFixed(1)} ms; buildTopology ${reference.toFixed(1)} ms`,
  );
  // About a quarter of a pass alone: a cut that read the whole mesh would take a pass or more.
  expect(time / reference).toBeLessThan(1);
});
