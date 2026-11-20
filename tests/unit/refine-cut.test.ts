import { describe, expect, it } from 'vitest';
import { BufferAttribute, Matrix4 } from 'three';
import { cloneRefineMesh, writeRefinedGeometry } from '../../src/core/refine-mesh';
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
  straddling,
  straddlingTriangles,
  trianglesWhollyOn,
} from '../helpers/refine';
import { type SoftOptions, softBox } from '../helpers/soft-edges';

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
    }
  },
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
