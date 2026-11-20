import {
  BufferAttribute,
  BufferGeometry,
  InterleavedBuffer,
  InterleavedBufferAttribute,
  type Matrix4,
  type TypedArray,
} from 'three';
import { weldedPositionIndex } from './mesh-topology';

const unused = 0xffffffff;

export interface RefineMesh {
  /** World position per welded vertex. Grows when triangles are cut. */
  position: Float64Array;
  weldedCount: number;
  /** Geometry vertex -> welded vertex. Grows with new geometry vertices. */
  weldOf: Uint32Array;
  vertexCount: number;
  /** Geometry vertex of each triangle corner. Triangle t of the mesh is face t of the written geometry. */
  corners: Uint32Array;
  triangleCount: number;
  /** Colour per geometry vertex, `colorSize` values each, or null. */
  color: Float32Array | null;
  colorSize: number;
  /** 1 once a welded vertex has moved or was created. */
  touched: Uint8Array;
  /** 1 when a welded vertex lies on a refined edge. */
  crease: Uint8Array;
  /** True when the part's world matrix mirrors, so triangle winding reads reversed. */
  flipped: boolean;
  sourceVertexCount: number;
  sourceTriangleCount: number;
  indexed: boolean;
  /**
   * World-space distance below which two distinct points could weld together once written back to
   * mesh-local coordinates and welded at 1e-5.
   */
  clearance: number;
}

export interface RefineTopology {
  /** CSR: triangles around each welded vertex. */
  triangleStart: Uint32Array;
  trianglesOf: Uint32Array;
  /** CSR: welded neighbours of each welded vertex, ascending. */
  neighbourStart: Uint32Array;
  neighbours: Uint32Array;
}

export function buildRefineMesh(geometry: BufferGeometry, matrixWorld: Matrix4): RefineMesh {
  const position = geometry.getAttribute('position');
  const index = geometry.index;
  const { indices, vertices: weldedCount } = weldedPositionIndex(geometry);
  const vertexCount = position.count;
  const corners = index ? Uint32Array.from(index.array) : Uint32Array.from(indices, (_, i) => i);
  const weldOf = new Uint32Array(vertexCount).fill(unused);
  for (let i = 0; i < indices.length; i++) weldOf[corners[i]] = indices[i];
  const world = new Float64Array(weldedCount * 3);
  const seen = new Uint8Array(weldedCount);
  const e = matrixWorld.elements;
  let largest = 0;
  // Each welded vertex takes the lowest geometry vertex's position, as write-back's representative.
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    // Every stored vertex counts: an unreferenced one still sets the scale write-back rounds at.
    for (let axis = 0; axis < 3; axis++)
      largest = Math.max(largest, Math.abs(decoded(position, vertex, axis)));
    const welded = weldOf[vertex];
    if (welded === unused) continue;
    if (seen[welded]) continue;
    seen[welded] = 1;
    worldOf(position, vertex, e, world, welded * 3);
  }
  let frobenius = 0;
  for (const k of [0, 1, 2, 4, 5, 6, 8, 9, 10]) frobenius += e[k] * e[k];
  const source = geometry.getAttribute('color');
  const colorSize = source ? source.itemSize : 0;
  let color: Float32Array | null = null;
  if (source) {
    color = new Float32Array(vertexCount * colorSize);
    for (let v = 0; v < vertexCount; v++)
      for (let k = 0; k < colorSize; k++) color[v * colorSize + k] = decoded(source, v, k);
  }
  return {
    position: world,
    weldedCount,
    weldOf,
    vertexCount,
    corners,
    triangleCount: indices.length / 3,
    color,
    colorSize,
    touched: new Uint8Array(weldedCount),
    crease: new Uint8Array(weldedCount),
    flipped: matrixWorld.determinant() < 0,
    sourceVertexCount: vertexCount,
    sourceTriangleCount: indices.length / 3,
    indexed: !!index,
    clearance: Math.max(1e-4, 16 * largest * 2 ** -23) * Math.sqrt(frobenius),
  };
}

/** World position of a source vertex, written at `offset` of `out`. */
function worldOf(
  position: Attribute,
  vertex: number,
  e: number[],
  out: Float64Array,
  offset: number,
) {
  const x = position.getX(vertex),
    y = position.getY(vertex),
    z = position.getZ(vertex);
  out[offset] = e[0] * x + e[4] * y + e[8] * z + e[12];
  out[offset + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
  out[offset + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
}

/** Copies position, touched and crease; copies weldOf, corners and colour only when `topology` is true. */
export function cloneRefineMesh(mesh: RefineMesh, topology: boolean): RefineMesh {
  return {
    ...mesh,
    position: mesh.position.slice(),
    touched: mesh.touched.slice(),
    crease: mesh.crease.slice(),
    weldOf: topology ? mesh.weldOf.slice() : mesh.weldOf,
    corners: topology ? mesh.corners.slice() : mesh.corners,
    color: topology && mesh.color ? mesh.color.slice() : mesh.color,
  };
}

export function weldedCorner(mesh: RefineMesh, triangle: number, corner: 0 | 1 | 2): number {
  return mesh.weldOf[mesh.corners[triangle * 3 + corner]];
}

function trianglesAround(mesh: RefineMesh) {
  const { weldedCount, triangleCount, weldOf, corners } = mesh;
  const start = new Uint32Array(weldedCount + 1);
  const each = (visit: (welded: number, triangle: number) => void) => {
    for (let t = 0; t < triangleCount; t++) {
      const a = weldOf[corners[t * 3]],
        b = weldOf[corners[t * 3 + 1]],
        c = weldOf[corners[t * 3 + 2]];
      visit(a, t);
      if (b !== a) visit(b, t);
      if (c !== a && c !== b) visit(c, t);
    }
  };
  each((welded) => start[welded + 1]++);
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const triangles = new Uint32Array(start[weldedCount]);
  const fill = start.slice(0, weldedCount);
  each((welded, t) => (triangles[fill[welded]++] = t));
  return { triangleStart: start, trianglesOf: triangles };
}

export function buildTopology(mesh: RefineMesh): RefineTopology {
  const { triangleStart, trianglesOf } = trianglesAround(mesh);
  const { weldedCount, triangleCount, weldOf, corners } = mesh;
  // Each triangle edge is stored in both directions, then sorted and deduplicated per vertex.
  const start = new Uint32Array(weldedCount + 1);
  const each = (visit: (a: number, b: number) => void) => {
    for (let c = 0; c < triangleCount * 3; c++) {
      const a = weldOf[corners[c]],
        b = weldOf[corners[c % 3 === 2 ? c - 2 : c + 1]];
      if (a !== b) visit(a, b);
    }
  };
  each((a, b) => (start[a + 1]++, start[b + 1]++));
  for (let v = 0; v < weldedCount; v++) start[v + 1] += start[v];
  const raw = new Uint32Array(start[weldedCount]);
  const fill = start.slice(0, weldedCount);
  each((a, b) => ((raw[fill[a]++] = b), (raw[fill[b]++] = a)));
  const neighbourStart = new Uint32Array(weldedCount + 1);
  let written = 0;
  for (let v = 0; v < weldedCount; v++) {
    const row = raw.subarray(start[v], start[v + 1]).sort();
    neighbourStart[v] = written;
    for (let i = 0; i < row.length; i++)
      if (i === 0 || row[i] !== row[i - 1]) raw[written++] = row[i];
  }
  neighbourStart[weldedCount] = written;
  return { triangleStart, trianglesOf, neighbourStart, neighbours: raw.slice(0, written) };
}

/** Unnormalized outward normal of a triangle at `position`: twice its area in length. */
function faceCross(
  mesh: RefineMesh,
  position: Float64Array,
  triangle: number,
  out: Float32Array | Float64Array,
) {
  const a = weldedCorner(mesh, triangle, 0) * 3,
    b = weldedCorner(mesh, triangle, 1) * 3,
    c = weldedCorner(mesh, triangle, 2) * 3;
  const ux = position[b] - position[a],
    uy = position[b + 1] - position[a + 1],
    uz = position[b + 2] - position[a + 2];
  const vx = position[c] - position[a],
    vy = position[c + 1] - position[a + 1],
    vz = position[c + 2] - position[a + 2];
  const sign = mesh.flipped ? -1 : 1;
  out[0] = sign * (uy * vz - uz * vy);
  out[1] = sign * (uz * vx - ux * vz);
  out[2] = sign * (ux * vy - uy * vx);
}

function normalizeInto(x: number, y: number, z: number, out: Float32Array) {
  const length = Math.hypot(x, y, z);
  if (length > 0) {
    out[0] = x / length;
    out[1] = y / length;
    out[2] = z / length;
  } else out.fill(0);
}

/** Outward unit normal of a triangle, honouring `flipped`. */
export function triangleNormal(mesh: RefineMesh, triangle: number, out: Float32Array): void {
  const cross = new Float64Array(3);
  faceCross(mesh, mesh.position, triangle, cross);
  normalizeInto(cross[0], cross[1], cross[2], out);
}

/** Area-weighted mean of the outward normals of the triangles around a welded vertex. */
export function vertexNormal(
  mesh: RefineMesh,
  topology: RefineTopology,
  welded: number,
  out: Float32Array,
): void {
  const cross = new Float64Array(3);
  let x = 0,
    y = 0,
    z = 0;
  for (let i = topology.triangleStart[welded]; i < topology.triangleStart[welded + 1]; i++) {
    faceCross(mesh, mesh.position, topology.trianglesOf[i], cross);
    x += cross[0];
    y += cross[1];
    z += cross[2];
  }
  normalizeInto(x, y, z, out);
}

/** Sets a welded vertex's position and marks it touched. */
export function moveVertex(
  mesh: RefineMesh,
  welded: number,
  x: number,
  y: number,
  z: number,
): void {
  mesh.position[welded * 3] = x;
  mesh.position[welded * 3 + 1] = y;
  mesh.position[welded * 3 + 2] = z;
  mesh.touched[welded] = 1;
}

/** `array` itself when it holds `length` values, otherwise a copy with room to grow. */
function room<T extends Float32Array | Float64Array | Uint32Array | Uint8Array>(
  array: T,
  length: number,
): T {
  if (array.length >= length) return array;
  const grown = new (array.constructor as new (length: number) => T)(
    Math.max(length, array.length * 2),
  );
  grown.set(array);
  return grown;
}

/** Appends a welded vertex at a world position, marked touched. */
export function addWeldedVertex(mesh: RefineMesh, x: number, y: number, z: number): number {
  const welded = mesh.weldedCount++;
  mesh.position = room(mesh.position, mesh.weldedCount * 3);
  mesh.touched = room(mesh.touched, mesh.weldedCount);
  mesh.crease = room(mesh.crease, mesh.weldedCount);
  mesh.crease[welded] = 0;
  moveVertex(mesh, welded, x, y, z);
  return welded;
}

/** Appends a geometry vertex of `welded`, with `color` when the mesh carries colour. */
export function addGeometryVertex(
  mesh: RefineMesh,
  welded: number,
  color?: ArrayLike<number>,
): number {
  const vertex = mesh.vertexCount++;
  mesh.weldOf = room(mesh.weldOf, mesh.vertexCount);
  mesh.weldOf[vertex] = welded;
  if (mesh.color) {
    mesh.color = room(mesh.color, mesh.vertexCount * mesh.colorSize);
    for (let k = 0; k < mesh.colorSize; k++)
      mesh.color[vertex * mesh.colorSize + k] = color ? color[k] : 0;
  }
  return vertex;
}

/** Sets the geometry vertices of a triangle's corners. */
export function setTriangle(mesh: RefineMesh, triangle: number, a: number, b: number, c: number) {
  mesh.corners[triangle * 3] = a;
  mesh.corners[triangle * 3 + 1] = b;
  mesh.corners[triangle * 3 + 2] = c;
}

/** Appends a triangle of three geometry vertices. */
export function addTriangle(mesh: RefineMesh, a: number, b: number, c: number): number {
  const triangle = mesh.triangleCount++;
  mesh.corners = room(mesh.corners, mesh.triangleCount * 3);
  setTriangle(mesh, triangle, a, b, c);
  return triangle;
}

/** Triangles among those around `vertices` whose normal now opposes its normal at `before`. */
export function foldedTriangles(
  mesh: RefineMesh,
  topology: RefineTopology,
  before: Float64Array,
  vertices: Uint32Array,
): Uint32Array {
  const was = new Float64Array(3),
    now = new Float64Array(3);
  const checked = new Set<number>();
  const folded: number[] = [];
  for (const v of vertices)
    for (let i = topology.triangleStart[v]; i < topology.triangleStart[v + 1]; i++) {
      const t = topology.trianglesOf[i];
      if (checked.has(t)) continue;
      checked.add(t);
      faceCross(mesh, before, t, was);
      faceCross(mesh, mesh.position, t, now);
      if (was[0] * now[0] + was[1] * now[1] + was[2] * now[2] < 0) folded.push(t);
    }
  return Uint32Array.from(folded.sort((a, b) => a - b));
}

/**
 * Splits the triangles around one welded vertex into fans: triangles joined across an edge from
 * `welded`, except an edge whose two ends both have `crease`. Returns the fan of each triangle.
 * `owner` is scratch space of -1 per welded vertex, left as found.
 */
function fansAround(mesh: RefineMesh, welded: number, triangles: Uint32Array, owner: Int32Array) {
  const fan = Int32Array.from(triangles, (_, i) => i);
  const root = (i: number) => {
    while (fan[i] !== i) i = fan[i] = fan[fan[i]];
    return i;
  };
  const blocked = mesh.crease[welded] === 1;
  for (let i = 0; i < triangles.length; i++)
    for (const k of [0, 1, 2] as const) {
      const w = weldedCorner(mesh, triangles[i], k);
      if (w === welded || (blocked && mesh.crease[w])) continue;
      if (owner[w] < 0) owner[w] = i;
      else fan[root(i)] = root(owner[w]);
    }
  for (const t of triangles)
    for (const k of [0, 1, 2] as const) owner[weldedCorner(mesh, t, k)] = -1;
  return Int32Array.from(fan, (_, i) => root(i));
}

type Attribute = BufferAttribute | InterleavedBufferAttribute;
type ArrayType = new (length: number) => TypedArray;

const isInterleaved = (attribute: Attribute): attribute is InterleavedBufferAttribute =>
  'isInterleavedBufferAttribute' in attribute;

const getters = ['getX', 'getY', 'getZ', 'getW'] as const;
const setters = ['setX', 'setY', 'setZ', 'setW'] as const;

/** Component `k` of item `i`, decoded from normalized integers or half floats. */
function decoded(attribute: Attribute, i: number, k: number): number {
  return k < 4 ? attribute[getters[k]](i) : attribute.getComponent(i, k);
}

/** Encodes `value` into component `k` of item `i` through the attribute's setters. */
function encode(attribute: Attribute, i: number, k: number, value: number) {
  if (k < 4) attribute[setters[k]](i, value);
  else attribute.setComponent(i, k, value);
}

/** The stored components of item `i`, as a view into the attribute's array. */
function storedItem(attribute: Attribute, i: number): TypedArray {
  const size = attribute.itemSize;
  if (!isInterleaved(attribute)) return attribute.array.subarray(i * size, i * size + size);
  const start = i * attribute.data.stride + attribute.offset;
  return attribute.data.array.subarray(start, start + size);
}

/** An empty attribute of `count` items with the class, array type, item size and normalization. */
function blankLike(attribute: Attribute, count: number): Attribute {
  const size = attribute.itemSize;
  const array = new (attribute.array.constructor as ArrayType)(count * size);
  if (isInterleaved(attribute)) {
    // The source's own classes, so a subclass keeps its accessors.
    const Buffer = attribute.data.constructor as typeof InterleavedBuffer;
    const Interleaved = attribute.constructor as typeof InterleavedBufferAttribute;
    return new Interleaved(new Buffer(array, size), size, 0, attribute.normalized);
  }
  const Class = attribute.constructor as new (
    array: TypedArray,
    itemSize: number,
    normalized: boolean,
  ) => BufferAttribute;
  return new Class(array, size, attribute.normalized);
}

const isFloat = (array: TypedArray) =>
  array instanceof Float32Array || array instanceof Float64Array;

/**
 * Output for a position or normal attribute. Without `promote` it keeps the source's storage. With
 * it, a plain float attribute keeps its array type and any other becomes a plain float attribute
 * wide enough that no two distinct source values round together.
 */
function vertexOutput(attribute: Attribute, count: number, promote: boolean) {
  const size = attribute.itemSize;
  let target: Attribute;
  if (!promote) target = blankLike(attribute, count);
  else {
    const array = attribute.array;
    const Array = isFloat(array)
      ? (array.constructor as ArrayType)
      : array instanceof Int32Array || array instanceof Uint32Array
        ? Float64Array
        : Float32Array;
    const normalized = Array === array.constructor && attribute.normalized;
    target = new BufferAttribute(new Array(count * size), size, normalized);
  }
  const bitwise = target.array.constructor === attribute.array.constructor;
  const copy = (from: number, to: number) => {
    if (bitwise) target.array.set(storedItem(attribute, from), to * size);
    else for (let k = 0; k < size; k++) target.array[to * size + k] = decoded(attribute, from, k);
  };
  return { target, copy };
}

/** True when nothing was moved, created or rewired, so the source can be returned as it is. */
function unchanged(mesh: RefineMesh) {
  if (mesh.vertexCount !== mesh.sourceVertexCount) return false;
  if (mesh.triangleCount !== mesh.sourceTriangleCount) return false;
  for (let v = 0; v < mesh.weldedCount; v++) if (mesh.touched[v]) return false;
  if (!mesh.indexed)
    for (let c = 0; c < mesh.triangleCount * 3; c++) if (mesh.corners[c] !== c) return false;
  return true;
}

export function writeRefinedGeometry(
  source: BufferGeometry,
  matrixWorld: Matrix4,
  mesh: RefineMesh,
): BufferGeometry {
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const sourceColor = mesh.color ? source.getAttribute('color') : undefined;
  const { weldOf, corners, touched, triangleCount, vertexCount, weldedCount } = mesh;
  const sourceVertexCount = mesh.sourceVertexCount;
  const cornerCount = triangleCount * 3;
  const result = new BufferGeometry();
  const index: Uint32Array | null = mesh.indexed ? corners.slice(0, cornerCount) : null;
  const finish = () => {
    if (index) result.setIndex(new BufferAttribute(index, 1));
    result.computeBoundingBox();
    result.computeBoundingSphere();
    return result;
  };
  if (unchanged(mesh)) {
    // Shared so attributes interleaved in one buffer stay together in the clone.
    const data = {};
    const clone = (attribute: Attribute) =>
      isInterleaved(attribute) ? attribute.clone(data) : attribute.clone();
    result.setAttribute('position', clone(sourcePosition));
    result.setAttribute('normal', clone(sourceNormal));
    if (sourceColor) result.setAttribute('color', clone(sourceColor));
    return finish();
  }

  // The source vertex whose position and normal each geometry vertex copies, or unused when moved.
  const representative = new Uint32Array(weldedCount).fill(unused);
  for (let g = 0; g < sourceVertexCount; g++) {
    const v = weldOf[g];
    if (v !== unused && representative[v] === unused) representative[v] = g;
  }
  const copies = new Uint32Array(vertexCount);
  for (let g = 0; g < vertexCount; g++) {
    const v = weldOf[g];
    if (v === unused) copies[g] = g;
    else if (touched[v] || representative[v] === unused) copies[g] = unused;
    else copies[g] = g < sourceVertexCount ? g : representative[v];
  }

  // A touched vertex back at its source's world position writes the source's own bits.
  const e = matrixWorld.elements;
  const start = new Float64Array(3);
  const restored = new Uint8Array(weldedCount);
  for (let v = 0; v < weldedCount; v++) {
    if (!touched[v] || representative[v] === unused) continue;
    worldOf(sourcePosition, representative[v], e, start, 0);
    restored[v] = +(
      start[0] === mesh.position[v * 3] &&
      start[1] === mesh.position[v * 3 + 1] &&
      start[2] === mesh.position[v * 3 + 2]
    );
  }

  // Mesh-local position of every moved welded vertex, computed once so duplicates share bits.
  const inverse = matrixWorld.clone().invert().elements;
  const local = new Float64Array(weldedCount * 3);
  for (let v = 0; v < weldedCount; v++) {
    if ((!touched[v] && representative[v] !== unused) || restored[v]) continue;
    const x = mesh.position[v * 3],
      y = mesh.position[v * 3 + 1],
      z = mesh.position[v * 3 + 2];
    local[v * 3] = inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12];
    local[v * 3 + 1] = inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13];
    local[v * 3 + 2] = inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14];
  }

  // Fan of each triangle around a moved vertex, aligned with `trianglesOf`, and of each corner.
  const { triangleStart, trianglesOf } = trianglesAround(mesh);
  const triangleFan = new Int32Array(trianglesOf.length);
  const cornerFan = new Int32Array(cornerCount).fill(-1);
  const owner = new Int32Array(weldedCount).fill(-1);
  for (let v = 0; v < weldedCount; v++) {
    if (!touched[v]) continue;
    const triangles = trianglesOf.subarray(triangleStart[v], triangleStart[v + 1]);
    const fan = fansAround(mesh, v, triangles, owner);
    triangleFan.set(fan, triangleStart[v]);
    for (let i = 0; i < triangles.length; i++)
      for (const k of [0, 1, 2] as const) {
        const c = triangles[i] * 3 + k;
        if (weldOf[corners[c]] === v) cornerFan[c] = fan[i];
      }
  }

  // Output vertex of each corner, and the geometry vertex and corner each output vertex copies.
  let from: Uint32Array, normalFrom: Int32Array;
  if (index) {
    const vertexOf = index;
    normalFrom = new Int32Array(vertexCount).fill(-1);
    const claimed = new Int32Array(vertexCount).fill(-1);
    const appended = new Map<number, number>();
    const appendedFrom: number[] = [];
    const appendedNormal: number[] = [];
    for (let c = 0; c < cornerCount; c++) {
      const g = corners[c];
      const fan = cornerFan[c];
      if (fan < 0 || claimed[g] === fan) continue;
      if (claimed[g] < 0) {
        claimed[g] = fan;
        normalFrom[g] = c;
        continue;
      }
      const key = g * cornerCount + fan;
      let vertex = appended.get(key);
      if (vertex === undefined) {
        vertex = vertexCount + appendedFrom.length;
        appended.set(key, vertex);
        appendedFrom.push(g);
        appendedNormal.push(c);
      }
      vertexOf[c] = vertex;
    }
    from = new Uint32Array(vertexCount + appendedFrom.length);
    for (let g = 0; g < vertexCount; g++) from[g] = g;
    from.set(appendedFrom, vertexCount);
    const normals = new Int32Array(from.length);
    normals.set(normalFrom);
    normals.set(appendedNormal, vertexCount);
    normalFrom = normals;
  } else {
    // One output vertex per corner, so an unsplit source triangle keeps its own slots.
    from = corners.subarray(0, cornerCount);
    normalFrom = Int32Array.from(cornerFan, (fan, c) => (fan >= 0 ? c : -1));
  }

  const count = from.length;
  // Promoted only when a moved or created vertex must be written; otherwise storage stays as is.
  let promote = false;
  for (let v = 0; v < weldedCount && !promote; v++) promote = touched[v] === 1;
  const position = vertexOutput(sourcePosition, count, promote);
  const outPosition = position.target;
  for (let i = 0; i < count; i++) {
    const g = from[i];
    const v = weldOf[g];
    if (copies[g] !== unused) position.copy(copies[g], i);
    else if (restored[v]) position.copy(g < sourceVertexCount ? g : representative[v], i);
    else outPosition.setXYZ(i, local[v * 3], local[v * 3 + 1], local[v * 3 + 2]);
  }

  // Normal of each corner at a moved vertex: area-weighted over its fan, from positions as written.
  const stride = outPosition.itemSize;
  const at = (c: number, axis: number) =>
    outPosition.array[(index ? index[c] : c) * stride + axis] as number;
  const cross = (t: number, out: Float64Array, offset: number) => {
    const a = t * 3;
    const u = [0, 1, 2].map((axis) => at(a + 1, axis) - at(a, axis)),
      w = [0, 1, 2].map((axis) => at(a + 2, axis) - at(a, axis));
    out[offset] += u[1] * w[2] - u[2] * w[1];
    out[offset + 1] += u[2] * w[0] - u[0] * w[2];
    out[offset + 2] += u[0] * w[1] - u[1] * w[0];
  };
  const cornerNormal = new Float32Array(cornerCount * 3);
  for (let v = 0; v < weldedCount; v++) {
    if (!touched[v]) continue;
    const begin = triangleStart[v],
      end = triangleStart[v + 1];
    const sum = new Float64Array((end - begin) * 3);
    for (let i = begin; i < end; i++) cross(trianglesOf[i], sum, triangleFan[i] * 3);
    for (let i = begin; i < end; i++)
      for (const k of [0, 1, 2] as const) {
        const c = trianglesOf[i] * 3 + k;
        if (weldOf[corners[c]] !== v) continue;
        const f = triangleFan[i] * 3;
        normalizeInto(sum[f], sum[f + 1], sum[f + 2], cornerNormal.subarray(c * 3, c * 3 + 3));
      }
  }

  const normal = vertexOutput(sourceNormal, count, promote);
  for (let i = 0; i < count; i++) {
    const g = from[i];
    const c = normalFrom[i];
    const normalSource = copies[g] !== unused ? copies[g] : g < sourceVertexCount ? g : unused;
    if (c >= 0)
      normal.target.setXYZ(
        i,
        cornerNormal[c * 3],
        cornerNormal[c * 3 + 1],
        cornerNormal[c * 3 + 2],
      );
    else if (normalSource !== unused) normal.copy(normalSource, i);
  }

  result.setAttribute('position', outPosition);
  result.setAttribute('normal', normal.target);
  if (mesh.color && sourceColor) {
    const size = mesh.colorSize;
    const color = blankLike(sourceColor, count);
    for (let i = 0; i < count; i++) {
      const g = from[i];
      if (g < sourceVertexCount) color.array.set(storedItem(sourceColor, g), i * size);
      else for (let k = 0; k < size; k++) encode(color, i, k, mesh.color[g * size + k]);
    }
    result.setAttribute('color', color);
  }
  return finish();
}
