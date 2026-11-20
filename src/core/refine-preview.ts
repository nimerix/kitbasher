import { BufferAttribute, Vector3 } from 'three';
import type { BufferGeometry, InterleavedBufferAttribute, Matrix4, TypedArray } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { RefineMesh, RefineTopology } from './refine-mesh';

const unused = 0xffffffff;

type Attribute = BufferAttribute | InterleavedBufferAttribute;

const getters = ['getX', 'getY', 'getZ', 'getW'] as const;

/** Component `k` of item `i`, decoded as writeRefinedGeometry decodes it. */
const decoded = (attribute: Attribute, i: number, k: number): number =>
  k < 4 ? attribute[getters[k]](i) : attribute.getComponent(i, k);

function storedItem(attribute: Attribute, i: number): TypedArray {
  const size = attribute.itemSize;
  if (!('isInterleavedBufferAttribute' in attribute))
    return attribute.array.subarray(i * size, i * size + size);
  const start = i * attribute.data.stride + attribute.offset;
  return attribute.data.array.subarray(start, start + size);
}

/** Writes item `from` of `source` into item `to` of `target` as writeRefinedGeometry copies. */
function copyItem(source: Attribute, target: BufferAttribute, from: number, to: number) {
  const size = source.itemSize;
  if (target.array.constructor === source.array.constructor)
    target.array.set(storedItem(source, from), to * size);
  else for (let k = 0; k < size; k++) target.array[to * size + k] = decoded(source, from, k);
}

const anyTouched = (mesh: Pick<RefineMesh, 'touched'>, count: number) =>
  mesh.touched.subarray(0, count).includes(1);

const accessors = [
  'getX',
  'getY',
  'getZ',
  'getW',
  'getComponent',
  'setX',
  'setY',
  'setZ',
  'setXYZ',
  'setComponent',
] as const;

/**
 * Whether the writer stores an attribute the same way whether it keeps the source's storage or
 * writes its own: a plain float array read and written through BufferAttribute's own accessors.
 */
const plainFloat = (attribute: Attribute) =>
  !('isInterleavedBufferAttribute' in attribute) &&
  !attribute.normalized &&
  (attribute.array instanceof Float32Array || attribute.array instanceof Float64Array) &&
  accessors.every((name) => attribute[name] === BufferAttribute.prototype[name]);

/** The writer copies a colour attribute into one of its own; an interleaved one changes stride. */
const plainColor = (attribute: Attribute | undefined) =>
  !attribute || !('isInterleavedBufferAttribute' in attribute);

/** Per picking tree: the leaf node of each triangle and the parent of each node, by node id. */
const treeLeaves = new WeakMap<object, { leafOf: Uint32Array; parent: Int32Array }>();

/** Bytes and 32-bit words of one node of a three-mesh-bvh node buffer. */
const nodeBytes = 32,
  nodeWords = 8;

function leavesOf(tree: MeshBVH) {
  const cached = treeLeaves.get(tree);
  if (cached) return cached;
  const { roots, indirectBuffer } = MeshBVH.serialize(tree, { cloneBuffers: false });
  const leafOf = new Uint32Array(indirectBuffer!.length);
  const parent = new Int32Array(roots.reduce((sum, root) => sum + root.byteLength / nodeBytes, 0));
  let first = 0;
  for (const root of roots) {
    const words = new Uint32Array(root),
      halves = new Uint16Array(root);
    const id = (n32: number) => first + n32 / nodeWords;
    parent[first] = -1;
    const stack = [0];
    while (stack.length) {
      const n32 = stack.pop()!;
      if (halves[n32 * 2 + 15] === 0xffff) {
        const offset = words[n32 + 6],
          count = halves[n32 * 2 + 14];
        for (let i = offset; i < offset + count; i++)
          leafOf[tree.resolveTriangleIndex(i)] = id(n32);
        continue;
      }
      const left = n32 + nodeWords,
        right = n32 + words[n32 + 6] * nodeWords;
      parent[id(left)] = parent[id(right)] = id(n32);
      stack.push(left, right);
    }
    first += root.byteLength / nodeBytes;
  }
  const leaves = { leafOf, parent };
  treeLeaves.set(tree, leaves);
  return leaves;
}

/**
 * Refits the nodes over `triangles` and their ancestors only. A tree that is not indirect, or not
 * over `triangleCount` triangles, is refitted whole.
 */
function refitTriangles(tree: MeshBVH, triangles: Iterable<number>, triangleCount: number) {
  if (!tree.indirect) {
    tree.refit();
    return;
  }
  const { leafOf, parent } = leavesOf(tree);
  if (leafOf.length !== triangleCount) {
    tree.refit();
    return;
  }
  const nodes = new Set<number>();
  for (const t of triangles)
    for (let n = leafOf[t]; n >= 0 && !nodes.has(n); n = parent[n]) nodes.add(n);
  tree.refit(nodes);
}

const representatives = new WeakMap<
  Uint32Array,
  { vertexCount: number; weldedCount: number; first: Uint32Array }
>();

/** The lowest source vertex of each welded vertex, which a written vertex copies its bits from. */
function representativeOf(mesh: RefineMesh) {
  const cached = representatives.get(mesh.weldOf);
  if (cached?.vertexCount === mesh.vertexCount && cached.weldedCount === mesh.weldedCount)
    return cached.first;
  const first = new Uint32Array(mesh.weldedCount).fill(unused);
  for (let g = 0; g < mesh.sourceVertexCount; g++) {
    const v = mesh.weldOf[g];
    if (v !== unused && first[v] === unused) first[v] = g;
  }
  representatives.set(mesh.weldOf, {
    vertexCount: mesh.vertexCount,
    weldedCount: mesh.weldedCount,
    first,
  });
  return first;
}

/** writeRefinedGeometry's fans: triangles around `welded` joined across edges not on a crease. */
function fansAround(mesh: RefineMesh, welded: number, triangles: Uint32Array, owner: Int32Array) {
  const fan = Int32Array.from(triangles, (_, i) => i);
  const root = (i: number) => {
    while (fan[i] !== i) i = fan[i] = fan[fan[i]];
    return i;
  };
  const corner = (t: number, k: number) => mesh.weldOf[mesh.corners[t * 3 + k]];
  const blocked = mesh.crease[welded] === 1;
  for (let i = 0; i < triangles.length; i++)
    for (let k = 0; k < 3; k++) {
      const w = corner(triangles[i], k);
      if (w === welded || (blocked && mesh.crease[w])) continue;
      if (owner[w] < 0) owner[w] = i;
      else fan[root(i)] = root(owner[w]);
    }
  for (const t of triangles) for (let k = 0; k < 3; k++) owner[corner(t, k)] = -1;
  return Int32Array.from(fan, (_, i) => root(i));
}

/**
 * Writes `next` into `preview`, which holds writeRefinedGeometry(source, matrixWorld, shown), so
 * that it equals writeRefinedGeometry(source, matrixWorld, next). Only the vertices that moved and
 * the normals around them are written. Returns false, writing nothing, when the two meshes would
 * be written with different vertices or index: another topology, a first or last moved vertex,
 * or a fan split differently. The bounds grow over what moved rather than shrink, and the
 * preview's picking tree is refitted where triangles moved.
 */
export function patchRefinedGeometry(
  preview: BufferGeometry,
  source: BufferGeometry,
  matrixWorld: Matrix4,
  shown: RefineMesh,
  next: RefineMesh,
  topology: RefineTopology,
): boolean {
  if (!sameLayout(shown, next, topology)) return false;
  const moved: number[] = [];
  const creased: number[] = [];
  const [from, to] = [shown.position, next.position];
  const [wasTouched, isTouched] = [shown.touched, next.touched];
  const [wasCrease, isCrease] = [shown.crease, next.crease];
  const count = next.weldedCount;
  if (from !== to || wasTouched !== isTouched)
    for (let v = 0, p = 0; v < count; v++, p += 3)
      if (
        from[p] !== to[p] ||
        from[p + 1] !== to[p + 1] ||
        from[p + 2] !== to[p + 2] ||
        wasTouched[v] !== isTouched[v]
      )
        moved.push(v);
  if (wasCrease !== isCrease)
    for (let v = 0; v < count; v++) if (wasCrease[v] !== isCrease[v]) creased.push(v);
  return writeChanges(preview, source, matrixWorld, shown, next, topology, moved, creased);
}

/**
 * As patchRefinedGeometry when `next` differs from what the preview shows only at the welded
 * vertices `changed`, which costs time in proportion to them rather than to the mesh. `shown` gives
 * the touched and crease flags the preview was written with; its positions are not read, so `next`
 * may be the very mesh the preview was written from, moved in place since.
 */
export function patchRefinedVertices(
  preview: BufferGeometry,
  source: BufferGeometry,
  matrixWorld: Matrix4,
  shown: Pick<RefineMesh, 'touched' | 'crease'>,
  next: RefineMesh,
  topology: RefineTopology,
  changed: Iterable<number>,
): boolean {
  if (!sameLayout(next, next, topology)) return false;
  const moved = [...new Set(changed)];
  const creased = moved.filter((v) => shown.crease[v] !== next.crease[v]);
  return writeChanges(preview, source, matrixWorld, shown, next, topology, moved, creased);
}

const sameLayout = (shown: RefineMesh, next: RefineMesh, topology: RefineTopology) =>
  next.corners === shown.corners &&
  next.weldOf === shown.weldOf &&
  next.triangleCount === shown.triangleCount &&
  next.vertexCount === shown.vertexCount &&
  next.weldedCount === shown.weldedCount &&
  next.flipped === shown.flipped &&
  topology.triangleStart.length === next.weldedCount + 1;

function writeChanges(
  preview: BufferGeometry,
  source: BufferGeometry,
  matrixWorld: Matrix4,
  shownFlags: Pick<RefineMesh, 'touched' | 'crease'>,
  next: RefineMesh,
  topology: RefineTopology,
  moved: number[],
  creased: number[],
): boolean {
  const { weldOf, corners, weldedCount } = next;
  const { triangleStart, trianglesOf, neighbourStart, neighbours } = topology;
  const shown: RefineMesh = { ...next, touched: shownFlags.touched, crease: shownFlags.crease };
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  // Without a moved vertex the writer keeps the source's storage, which differs unless plain float.
  if (
    !(
      plainFloat(sourcePosition) &&
      plainFloat(sourceNormal) &&
      plainColor(next.color ? source.getAttribute('color') : undefined)
    ) &&
    !(anyTouched(shown, weldedCount) && anyTouched(next, weldedCount))
  )
    return false;
  if (!moved.length && !creased.length) return true;

  const owner = new Int32Array(weldedCount).fill(-1);
  const index = preview.index?.array as Uint32Array | undefined;
  const output = (c: number) => (index ? index[c] : c);
  const around = (v: number) => trianglesOf.subarray(triangleStart[v], triangleStart[v + 1]);
  // The written vertex of each corner at `v` follows its source vertex and, once moved, its fan.
  const grouping = (mesh: RefineMesh, v: number) => {
    const triangles = around(v);
    const fan = mesh.touched[v] ? fansAround(mesh, v, triangles, owner) : null;
    const base = triangles.length + 1;
    const first = new Map<number, number>();
    const groups: number[] = [];
    for (let i = 0; i < triangles.length; i++)
      for (let k = 0; k < 3; k++) {
        const c = triangles[i] * 3 + k;
        if (weldOf[corners[c]] !== v) continue;
        const key = corners[c] * base + (fan ? fan[i] : base - 1);
        if (!first.has(key)) first.set(key, first.size);
        groups.push(first.get(key)!);
      }
    return groups;
  };
  const layout = new Set<number>(creased);
  for (const v of creased)
    for (let i = neighbourStart[v]; i < neighbourStart[v + 1]; i++) layout.add(neighbours[i]);
  for (const v of moved) if (shown.touched[v] !== next.touched[v]) layout.add(v);
  for (const v of layout) {
    const before = grouping(shown, v),
      after = grouping(next, v);
    if (before.some((group, i) => group !== after[i])) return false;
  }

  const position = preview.getAttribute('position') as BufferAttribute;
  const normal = preview.getAttribute('normal') as BufferAttribute;
  const representative = representativeOf(next);
  const sourceCount = next.sourceVertexCount;
  const e = matrixWorld.elements;
  const inverse = matrixWorld.clone().invert().elements;
  const range = { position: [Infinity, -1], normal: [Infinity, -1] };
  const mark = (which: number[], o: number) => {
    which[0] = Math.min(which[0], o);
    which[1] = Math.max(which[1], o);
  };
  const eachCorner = (v: number, visit: (c: number, i: number) => void) => {
    const triangles = around(v);
    for (let i = 0; i < triangles.length; i++)
      for (let k = 0; k < 3; k++) {
        const c = triangles[i] * 3 + k;
        if (weldOf[corners[c]] === v) visit(c, i);
      }
  };

  for (const v of moved) {
    const p = v * 3;
    const r = representative[v];
    let copies = r !== unused;
    if (next.touched[v] && copies) {
      // A moved vertex back at its source's world position writes the source's own bits.
      const x = sourcePosition.getX(r),
        y = sourcePosition.getY(r),
        z = sourcePosition.getZ(r);
      copies =
        e[0] * x + e[4] * y + e[8] * z + e[12] === next.position[p] &&
        e[1] * x + e[5] * y + e[9] * z + e[13] === next.position[p + 1] &&
        e[2] * x + e[6] * y + e[10] * z + e[14] === next.position[p + 2];
    }
    const x = next.position[p],
      y = next.position[p + 1],
      z = next.position[p + 2];
    const lx = inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12],
      ly = inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13],
      lz = inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14];
    eachCorner(v, (c) => {
      const o = output(c),
        g = corners[c];
      if (copies) copyItem(sourcePosition, position, g < sourceCount ? g : r, o);
      else position.setXYZ(o, lx, ly, lz);
      mark(range.position, o);
    });
  }

  // Normals at moved vertices follow their fans, read from the written positions of the triangles.
  const normals = new Set<number>(layout);
  for (const v of moved) {
    normals.add(v);
    for (let i = neighbourStart[v]; i < neighbourStart[v + 1]; i++) normals.add(neighbours[i]);
  }
  const stride = position.itemSize;
  const written = position.array;
  const at = (c: number, axis: number) => written[output(c) * stride + axis] as number;
  const unit = new Float32Array(3);
  const movedSet = new Set(moved);
  for (const v of normals) {
    if (!next.touched[v]) {
      // An unmoved vertex keeps its source normal; only one that was moved before needs it back.
      if (!movedSet.has(v)) continue;
      const r = representative[v];
      eachCorner(v, (c) => {
        const o = output(c),
          g = corners[c];
        const from = r !== unused ? (g < sourceCount ? g : r) : g < sourceCount ? g : unused;
        if (from !== unused) copyItem(sourceNormal, normal, from, o);
        else normal.setXYZ(o, 0, 0, 0);
        mark(range.normal, o);
      });
      continue;
    }
    const triangles = around(v);
    const fan = fansAround(next, v, triangles, owner);
    const sum = new Float64Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
      const a = triangles[i] * 3,
        f = fan[i] * 3;
      const u = [0, 1, 2].map((axis) => at(a + 1, axis) - at(a, axis)),
        w = [0, 1, 2].map((axis) => at(a + 2, axis) - at(a, axis));
      sum[f] += u[1] * w[2] - u[2] * w[1];
      sum[f + 1] += u[2] * w[0] - u[0] * w[2];
      sum[f + 2] += u[0] * w[1] - u[1] * w[0];
    }
    eachCorner(v, (c, i) => {
      const f = fan[i] * 3;
      const length = Math.hypot(sum[f], sum[f + 1], sum[f + 2]);
      if (length > 0) {
        unit[0] = sum[f] / length;
        unit[1] = sum[f + 1] / length;
        unit[2] = sum[f + 2] / length;
      } else unit.fill(0);
      const o = output(c);
      normal.setXYZ(o, unit[0], unit[1], unit[2]);
      mark(range.normal, o);
    });
  }

  for (const [attribute, [low, high]] of [
    [position, range.position],
    [normal, range.normal],
  ] as const) {
    if (high < 0) continue;
    attribute.addUpdateRange(low * attribute.itemSize, (high - low + 1) * attribute.itemSize);
    attribute.needsUpdate = true;
  }
  // Bounds grow to take the moved vertices in, and the picking tree is refitted over the
  // triangles around them, so a patch costs time in proportion to what moved.
  const { boundingBox: box, boundingSphere: sphere } = preview;
  if (box && sphere) {
    const point = new Vector3();
    for (const v of moved)
      eachCorner(v, (c) => {
        point.fromBufferAttribute(position, output(c));
        box.expandByPoint(point);
        sphere.expandByPoint(point);
      });
  } else {
    preview.computeBoundingBox();
    preview.computeBoundingSphere();
  }
  const tree = preview.boundsTree as MeshBVH | undefined;
  if (tree && moved.length)
    refitTriangles(
      tree,
      moved.flatMap((v) => [...trianglesOf.subarray(triangleStart[v], triangleStart[v + 1])]),
      next.triangleCount,
    );
  return true;
}
