import type { BufferGeometry } from 'three';

/** Same 1e-5 quantization and first-use ordering as Three.js mergeVertices,
 * but only build the topology index, without strings or copied attributes. */
export function weldedPositionIndex(geometry: BufferGeometry, mode: 'closed' | 'csg' = 'closed') {
  const position = geometry.getAttribute('position'),
    source = geometry.index;
  const count = source?.count ?? position.count;
  const capacity = 2 ** Math.ceil(Math.log2(Math.max(16, Math.min(count, position.count) * 1.5)));
  const table = new Uint32Array(capacity);
  const remap = new Int32Array(position.count).fill(-1);
  const indices = new Uint32Array(count);
  const mask = capacity - 1;
  // CSG's half-edge map intentionally uses a different tolerance and int32 wrapping.
  const quantize =
    mode === 'csg'
      ? (value: number) => (value * 1_000_000 + 0.5) | 0
      : (value: number) => Math.trunc(value * 100_000 + 0.5);
  const hash = (value: number) =>
    Math.imul(value | 0, 0x45d9f3b) ^ (Math.floor(value / 4294967296) | 0);
  let vertices = 0;
  for (let i = 0; i < count; i++) {
    const vertex = source ? source.getX(i) : i;
    if (remap[vertex] < 0) {
      const x = quantize(position.getX(vertex));
      const y = quantize(position.getY(vertex));
      const z = quantize(position.getZ(vertex));
      let slot = (hash(x) ^ Math.imul(hash(y), 31) ^ Math.imul(hash(z), 961)) & mask;
      while (table[slot]) {
        const candidate = table[slot] - 1;
        if (
          quantize(position.getX(candidate)) === x &&
          quantize(position.getY(candidate)) === y &&
          quantize(position.getZ(candidate)) === z
        ) {
          remap[vertex] = remap[candidate];
          break;
        }
        slot = (slot + 1) & mask;
      }
      if (remap[vertex] < 0) {
        table[slot] = vertex + 1;
        remap[vertex] = vertices++;
      }
    }
    indices[i] = remap[vertex];
  }
  return { indices, vertices };
}

/** Numeric edge keys avoid allocating a string and a Map entry for every edge. */
export function hasClosedEdges(
  indices: ArrayLike<number>,
  vertexCount: number,
  skipDegenerate = false,
) {
  if (vertexCount * vertexCount > Number.MAX_SAFE_INTEGER)
    throw new Error('This mesh is too large to check its edges safely.');
  const edges = new Float64Array(indices.length);
  let count = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i],
      b = indices[i + 1],
      c = indices[i + 2];
    if (skipDegenerate && (a === b || b === c || a === c)) continue;
    edges[count++] = Math.min(a, b) * vertexCount + Math.max(a, b);
    edges[count++] = Math.min(b, c) * vertexCount + Math.max(b, c);
    edges[count++] = Math.min(c, a) * vertexCount + Math.max(c, a);
  }
  const sorted = edges.subarray(0, count).sort();
  for (let i = 0; i < count; i += 2) {
    if (sorted[i] !== sorted[i + 1] || (i + 2 < count && sorted[i] === sorted[i + 2])) return false;
  }
  return true;
}
