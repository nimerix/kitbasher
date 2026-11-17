import { MeshoptSimplifier } from '../vendor/meshoptimizer/simplifier';
import { WarpRole, type WarpRegion } from './warp-region';

export const warpDensityNodes = [60, 120, 250, 500, 1000, 2000, 4000] as const;
export const defaultWarpDensity = 3;

export interface WarpGrid {
  /** Welded vertex id of each node. */
  nodes: Uint32Array;
  /** Node index of each welded vertex, 0xffffffff when not a node. */
  nodeOf: Uint32Array;
  /** 1 for nodes on the region border; they never move. */
  fixed: Uint8Array;
  /** Node index triples, for drawing. */
  triangles: Uint32Array;
  /** CSR node adjacency from grid triangles. */
  edgeStart: Uint32Array;
  edges: Uint32Array;
}

export async function buildWarpGrid(region: WarpRegion, density: number): Promise<WarpGrid> {
  await MeshoptSimplifier.ready;
  const level = Math.min(warpDensityNodes.length - 1, Math.max(0, Math.round(density)));
  const target = warpDensityNodes[level];

  const { weldedCount, role, rest } = region;
  const local = new Uint32Array(weldedCount).fill(0xffffffff);
  const welded: number[] = [];
  for (let v = 0; v < weldedCount; v++)
    if (role[v] !== WarpRole.Outside) {
      local[v] = welded.length;
      welded.push(v);
    }
  const positions = new Float32Array(welded.length * 3);
  for (let i = 0; i < welded.length; i++)
    positions.set(rest.subarray(welded[i] * 3, welded[i] * 3 + 3), i * 3);
  const indices = new Uint32Array(region.triangles.length);
  for (let i = 0; i < indices.length; i++) indices[i] = local[region.triangles[i]];

  const [simplified] = MeshoptSimplifier.simplify(
    indices,
    positions,
    3,
    Math.min(target * 6, indices.length),
    1,
    ['LockBorder'],
  );

  const nodeOf = new Uint32Array(weldedCount).fill(0xffffffff);
  const nodeList: number[] = [];
  const triangles = new Uint32Array(simplified.length);
  for (let i = 0; i < simplified.length; i++) {
    const w = welded[simplified[i]];
    if (nodeOf[w] === 0xffffffff) {
      nodeOf[w] = nodeList.length;
      nodeList.push(w);
    }
    triangles[i] = nodeOf[w];
  }
  const nodes = Uint32Array.from(nodeList);
  const fixed = new Uint8Array(nodes.length);
  for (let n = 0; n < nodes.length; n++) fixed[n] = role[nodes[n]] === WarpRole.Border ? 1 : 0;

  const count = nodes.length;
  const start = new Uint32Array(count + 1);
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k],
        b = triangles[i + ((k + 1) % 3)];
      if (a === b) continue;
      start[a + 1]++;
      start[b + 1]++;
    }
  for (let n = 0; n < count; n++) start[n + 1] += start[n];
  const raw = new Uint32Array(start[count]);
  const fill = start.slice(0, count);
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k],
        b = triangles[i + ((k + 1) % 3)];
      if (a === b) continue;
      raw[fill[a]++] = b;
      raw[fill[b]++] = a;
    }
  const edgeStart = new Uint32Array(count + 1);
  let written = 0;
  for (let n = 0; n < count; n++) {
    const row = raw.subarray(start[n], start[n + 1]).sort();
    edgeStart[n] = written;
    for (let i = 0; i < row.length; i++)
      if (i === 0 || row[i] !== row[i - 1]) raw[written++] = row[i];
  }
  edgeStart[count] = written;

  return { nodes, nodeOf, fixed, triangles, edgeStart, edges: raw.slice(0, written) };
}
