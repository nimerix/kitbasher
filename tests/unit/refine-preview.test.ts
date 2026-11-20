import { describe, expect, it } from 'vitest';
import { Box3, BufferGeometry, Matrix4, PlaneGeometry, Vector3 } from 'three';
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
