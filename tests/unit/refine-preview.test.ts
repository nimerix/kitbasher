import { describe, expect, it, vi } from 'vitest';
import { Box3, BufferGeometry, DoubleSide, Matrix4, PlaneGeometry, Ray, Vector3 } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import {
  buildRefineMesh,
  buildTopology,
  cloneRefineMesh,
  moveVertex,
  type RefineMesh,
  writeRefinedGeometry,
} from '../../src/core/refine-mesh';
import { patchRefinedGeometry, patchRefinedVertices } from '../../src/core/refine-preview';

const identity = new Matrix4();

/** The node buffers of a tree, for comparing two trees' bounds. */
const nodes = (tree: MeshBVH) =>
  MeshBVH.serialize(tree, { cloneBuffers: true }).roots.map((root) => new Float32Array(root));

/** Whether a box or sphere holds every vertex of `geometry`. */
const holds = (box: Pick<Box3, 'containsPoint'>, geometry: BufferGeometry) => {
  const position = geometry.getAttribute('position');
  const point = new Vector3();
  for (let i = 0; i < position.count; i++)
    if (!box.containsPoint(point.fromBufferAttribute(position, i))) return false;
  return true;
};

function grid(segments: number) {
  const source = new PlaneGeometry(8, 8, segments, segments).toNonIndexed();
  const mesh = buildRefineMesh(source, identity);
  const topology = buildTopology(mesh);
  const preview = writeRefinedGeometry(source, identity, mesh);
  preview.boundsTree = new MeshBVH(preview, { indirect: true, targetLeafSize: 10 });
  // Refitted once, so its bounds are as tight as a refit leaves them.
  preview.boundsTree.refit();
  return { source, mesh, topology, preview };
}

/** Moves the welded vertices `vertices` up by `lift`, in place. */
const lift = (mesh: RefineMesh, vertices: number[], by: number) => {
  for (const v of vertices)
    moveVertex(
      mesh,
      v,
      mesh.position[v * 3],
      mesh.position[v * 3 + 1],
      mesh.position[v * 3 + 2] + by,
    );
};

describe('patchRefinedVertices', () => {
  it('refits the picking tree where triangles moved, as a whole refit would', () => {
    const { source, mesh, topology, preview } = grid(60);
    const next = cloneRefineMesh(mesh, false);
    const shown = { touched: mesh.touched.slice(), crease: mesh.crease };
    const moved = Array.from({ length: 40 }, (_, i) => 1000 + i * 37);
    lift(next, moved, 0.3);
    expect(patchRefinedVertices(preview, source, identity, shown, next, topology, moved)).toBe(
      true,
    );
    const patched = nodes(preview.boundsTree as MeshBVH);
    preview.boundsTree!.refit();
    expect(patched).toEqual(nodes(preview.boundsTree as MeshBVH));
    expect(holds(preview.boundingBox!, preview)).toBe(true);
    expect(holds(preview.boundingSphere!, preview)).toBe(true);
  });

  it('grows the bounds on a diffing patch too', () => {
    const { source, mesh, topology, preview } = grid(20);
    const next = cloneRefineMesh(mesh, false);
    lift(next, [5], 2);
    expect(patchRefinedGeometry(preview, source, identity, mesh, next, topology)).toBe(true);
    expect(holds(preview.boundingBox!, preview)).toBe(true);
    expect(holds(preview.boundingSphere!, preview)).toBe(true);
    const patched = nodes(preview.boundsTree as MeshBVH);
    preview.boundsTree!.refit();
    expect(patched).toEqual(nodes(preview.boundsTree as MeshBVH));
  });

  it('matches whole refits over 3,000 seeded rays after local and far-moving dabs', () => {
    const source = new PlaneGeometry(12, 9, 48, 36);
    source.clearGroups();
    for (let group = 0; group < 4; group++) source.addGroup(group * 2592, 2592, 0);
    const start = buildRefineMesh(source, identity);
    const topology = buildTopology(start);
    const mesh = cloneRefineMesh(start, false);
    const preview = writeRefinedGeometry(source, identity, mesh);
    const tree = new MeshBVH(preview, { indirect: true, targetLeafSize: 6 });
    preview.boundsTree = tree;
    const wholeGeometry = preview.clone();
    const whole = MeshBVH.deserialize(MeshBVH.serialize(tree), wholeGeometry, { setIndex: false });
    let seed = 0x5a3fe28;
    const random = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;
    const hits = (index: MeshBVH, ray: Ray) =>
      index
        .raycast(ray, DoubleSide)
        .map((hit) => hit.faceIndex!)
        .sort((a, b) => a - b);
    let rays = 0,
      farHits = 0,
      mismatches = 0;
    for (let round = 0; round < 40; round++) {
      const shown = { touched: mesh.touched.slice(), crease: mesh.crease };
      const x = Math.floor(random() * 41) + 2,
        y = Math.floor(random() * 29) + 2;
      const dx = round % 5 === 0 ? 15 : (random() - 0.5) * 0.06;
      const changed: number[] = [];
      for (let row = y; row < y + 4; row++)
        for (let column = x; column < x + 4; column++) {
          const v = row * 49 + column;
          changed.push(v);
          moveVertex(
            mesh,
            v,
            start.position[v * 3] + dx,
            start.position[v * 3 + 1],
            0.07 + random() * 0.05,
          );
        }
      expect(patchRefinedVertices(preview, source, identity, shown, mesh, topology, changed)).toBe(
        true,
      );
      const fresh = writeRefinedGeometry(source, identity, mesh);
      wholeGeometry.getAttribute('position').array.set(fresh.getAttribute('position').array);
      whole.refit();
      for (let sample = 0; sample < 75; sample++) {
        const focus = sample % 3 !== 0;
        const px = focus
          ? start.position[changed[5] * 3] + dx + random() * 0.22
          : random() * 27 - 6;
        const py = focus
          ? start.position[changed[5] * 3 + 1] - random() * 0.22
          : random() * 9 - 4.5;
        const ray = new Ray(new Vector3(px, py, 3), new Vector3(0, 0, -1));
        const expected = hits(whole, ray);
        rays++;
        if (px > 6 && expected.length) farHits++;
        if (JSON.stringify(hits(tree, ray)) !== JSON.stringify(expected)) mismatches++;
      }
      fresh.dispose();
    }
    expect(rays).toBe(3000);
    expect(farHits).toBeGreaterThan(0);
    expect(mismatches).toBe(0);
  });

  it('refits whole, and throws nothing, when the tree is not laid out as expected', () => {
    const source = new PlaneGeometry(4, 4, 12, 12);
    const start = buildRefineMesh(source, identity);
    const topology = buildTopology(start);
    const next = cloneRefineMesh(start, false);
    const preview = writeRefinedGeometry(source, identity, start);
    const tree = new MeshBVH(preview, { indirect: true });
    preview.boundsTree = tree;
    const data = MeshBVH.serialize(tree);
    const serialize = vi
      .spyOn(MeshBVH, 'serialize')
      .mockReturnValue({ ...data, roots: [new ArrayBuffer(33)] });
    const refit = vi.spyOn(tree, 'refit');
    try {
      moveVertex(next, 80, 11, 0, 0.1);
      expect(patchRefinedVertices(preview, source, identity, start, next, topology, [80])).toBe(
        true,
      );
      expect(refit).toHaveBeenCalledWith();
      const fresh = writeRefinedGeometry(source, identity, next);
      expect(preview.getAttribute('position').array).toEqual(fresh.getAttribute('position').array);
    } finally {
      serialize.mockRestore();
    }
  });
});

const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1];

it.skipIf(!process.env.KITBASHER_REFINE_BENCH)(
  'patches one vertex and an 800-vertex dab on 430,000 vertices within a frame',
  () => {
    const source = new PlaneGeometry(86, 50, 859, 499).toNonIndexed();
    const mesh = buildRefineMesh(source, identity);
    const topology = buildTopology(mesh);
    expect(mesh.weldedCount).toBe(430_000);
    const preview = writeRefinedGeometry(source, identity, mesh);
    preview.boundsTree = new MeshBVH(preview, { indirect: true, targetLeafSize: 10 });
    // A moved mesh, so the preview is past its first write.
    const base = cloneRefineMesh(mesh, false);
    lift(base, [0], 0.001);
    patchRefinedGeometry(preview, source, identity, mesh, base, topology);
    const centre = 215_000 + 300;
    const disc: number[] = [];
    for (let row = -14; row <= 14; row++)
      for (let column = -14; column <= 14; column++)
        if (row * row + column * column <= 14 * 14 && disc.length < 800)
          disc.push(centre + row * 860 + column);
    const timings = { oneDiff: [] as number[], oneListed: [] as number[], dab: [] as number[] };
    let shown = base;
    for (let i = 0; i < 11; i++) {
      const one = cloneRefineMesh(shown, false);
      lift(one, [centre], 0.001);
      let t = performance.now();
      expect(patchRefinedGeometry(preview, source, identity, shown, one, topology)).toBe(true);
      timings.oneDiff.push(performance.now() - t);
      const listed = cloneRefineMesh(one, false);
      lift(listed, [centre], 0.001);
      t = performance.now();
      patchRefinedVertices(preview, source, identity, one, listed, topology, [centre]);
      timings.oneListed.push(performance.now() - t);
      const dab = cloneRefineMesh(listed, false);
      lift(dab, disc, 0.001);
      t = performance.now();
      patchRefinedVertices(preview, source, identity, listed, dab, topology, disc);
      timings.dab.push(performance.now() - t);
      shown = dab;
    }
    const result = Object.fromEntries(
      Object.entries(timings).map(([name, values]) => [name, median(values.slice(1))]),
    );
    console.log('refine preview patch, ms (median)', result);
    // A diffing patch also scans every vertex for what changed; it is reported, not held to 2 ms.
    expect(result.oneListed).toBeLessThan(2);
    expect(result.dab).toBeLessThan(5);
  },
  120_000,
);
