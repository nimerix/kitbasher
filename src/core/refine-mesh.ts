import { BufferAttribute, BufferGeometry, Matrix3, type Matrix4, type TypedArray } from 'three';
import { weldedPositionIndex } from './mesh-topology';

const unused = 0xffffffff;

export interface RefineMesh {
  /** World position per welded vertex. Grows when triangles are cut. */
  position: Float32Array;
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
  const world = new Float32Array(weldedCount * 3);
  const seen = new Uint8Array(weldedCount);
  const e = matrixWorld.elements;
  for (let i = 0; i < indices.length; i++) {
    const vertex = corners[i];
    const welded = indices[i];
    weldOf[vertex] = welded;
    if (seen[welded]) continue;
    seen[welded] = 1;
    const x = position.getX(vertex),
      y = position.getY(vertex),
      z = position.getZ(vertex);
    world[welded * 3] = e[0] * x + e[4] * y + e[8] * z + e[12];
    world[welded * 3 + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
    world[welded * 3 + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  }
  const source = geometry.getAttribute('color');
  const colorSize = source ? source.itemSize : 0;
  let color: Float32Array | null = null;
  if (source) {
    color = new Float32Array(vertexCount * colorSize);
    for (let v = 0; v < vertexCount; v++)
      for (let k = 0; k < colorSize; k++) color[v * colorSize + k] = source.getComponent(v, k);
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
  };
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
  position: Float32Array,
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

/** Triangles among those around `vertices` whose normal now opposes its normal at `before`. */
export function foldedTriangles(
  mesh: RefineMesh,
  topology: RefineTopology,
  before: Float32Array,
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
 */
function fansAround(mesh: RefineMesh, welded: number, triangles: Uint32Array) {
  const fan = Int32Array.from(triangles, (_, i) => i);
  const root = (i: number): number => (fan[i] === i ? i : (fan[i] = root(fan[i])));
  const others = Array.from(triangles, (t) =>
    ([0, 1, 2] as const).map((k) => weldedCorner(mesh, t, k)).filter((w) => w !== welded),
  );
  const blocked = mesh.crease[welded] === 1;
  for (let i = 0; i < triangles.length; i++)
    for (let j = i + 1; j < triangles.length; j++)
      if (others[i].some((w) => others[j].includes(w) && !(blocked && mesh.crease[w])))
        fan[root(i)] = root(j);
  return Int32Array.from(fan, (_, i) => root(i));
}

export function writeRefinedGeometry(
  source: BufferGeometry,
  matrixWorld: Matrix4,
  mesh: RefineMesh,
): BufferGeometry {
  const sourcePosition = source.getAttribute('position');
  const sourceNormal = source.getAttribute('normal');
  const { weldOf, corners, touched, triangleCount, vertexCount } = mesh;
  const cornerCount = triangleCount * 3;

  // Mesh-local position of every touched welded vertex, computed once so duplicates share bits.
  const inverse = matrixWorld.clone().invert().elements;
  const local = new Float32Array(mesh.weldedCount * 3);
  for (let v = 0; v < mesh.weldedCount; v++) {
    if (!touched[v]) continue;
    const x = mesh.position[v * 3],
      y = mesh.position[v * 3 + 1],
      z = mesh.position[v * 3 + 2];
    local[v * 3] = inverse[0] * x + inverse[4] * y + inverse[8] * z + inverse[12];
    local[v * 3 + 1] = inverse[1] * x + inverse[5] * y + inverse[9] * z + inverse[13];
    local[v * 3 + 2] = inverse[2] * x + inverse[6] * y + inverse[10] * z + inverse[14];
  }

  // Outward world normal of each corner at a touched vertex, from its fan; world to local by Mᵀ.
  const toLocal = new Matrix3().setFromMatrix4(matrixWorld).transpose().elements;
  const cornerNormal = new Float32Array(cornerCount * 3);
  const cornerFan = new Int32Array(cornerCount).fill(-1);
  const { triangleStart, trianglesOf } = trianglesAround(mesh);
  const cross = new Float64Array(3);
  for (let v = 0; v < mesh.weldedCount; v++) {
    if (!touched[v]) continue;
    const triangles = trianglesOf.subarray(triangleStart[v], triangleStart[v + 1]);
    const fan = fansAround(mesh, v, triangles);
    const sum = new Float64Array(triangles.length * 3);
    for (let i = 0; i < triangles.length; i++) {
      faceCross(mesh, mesh.position, triangles[i], cross);
      for (let axis = 0; axis < 3; axis++) sum[fan[i] * 3 + axis] += cross[axis];
    }
    for (let i = 0; i < triangles.length; i++) {
      const t = triangles[i];
      const [x, y, z] = sum.subarray(fan[i] * 3, fan[i] * 3 + 3);
      for (const k of [0, 1, 2] as const) {
        const c = t * 3 + k;
        if (weldOf[corners[c]] !== v) continue;
        cornerFan[c] = fan[i];
        normalizeInto(
          toLocal[0] * x + toLocal[3] * y + toLocal[6] * z,
          toLocal[1] * x + toLocal[4] * y + toLocal[7] * z,
          toLocal[2] * x + toLocal[5] * y + toLocal[8] * z,
          cornerNormal.subarray(c * 3, c * 3 + 3),
        );
      }
    }
  }

  // Output vertex of each corner, and the geometry vertex and corner each output vertex copies.
  let index: Uint32Array | null = null,
    from: Uint32Array,
    normalFrom: Int32Array;
  if (mesh.indexed) {
    const vertexOf = (index = corners.slice(0, cornerCount));
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
    from = corners.subarray(0, cornerCount);
    normalFrom = Int32Array.from(cornerFan, (fan, c) => (fan >= 0 ? c : -1));
  }

  const count = from.length;
  const position = new Float32Array(count * 3);
  const normal = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const g = from[i];
    const v = weldOf[g];
    if (v !== unused && touched[v]) position.set(local.subarray(v * 3, v * 3 + 3), i * 3);
    else {
      position[i * 3] = sourcePosition.getX(g);
      position[i * 3 + 1] = sourcePosition.getY(g);
      position[i * 3 + 2] = sourcePosition.getZ(g);
    }
    const c = normalFrom[i];
    if (c >= 0) normal.set(cornerNormal.subarray(c * 3, c * 3 + 3), i * 3);
    else {
      normal[i * 3] = sourceNormal.getX(g);
      normal[i * 3 + 1] = sourceNormal.getY(g);
      normal[i * 3 + 2] = sourceNormal.getZ(g);
    }
  }

  const result = new BufferGeometry();
  result.setAttribute('position', new BufferAttribute(position, 3));
  result.setAttribute('normal', new BufferAttribute(normal, 3));
  const sourceColor = source.getAttribute('color');
  if (mesh.color && sourceColor) {
    const size = mesh.colorSize;
    const ColorArray = (sourceColor.array as TypedArray).constructor as new (
      length: number,
    ) => TypedArray;
    const color = new BufferAttribute(new ColorArray(count * size), size, sourceColor.normalized);
    for (let i = 0; i < count; i++)
      for (let k = 0; k < size; k++) color.setComponent(i, k, mesh.color[from[i] * size + k]);
    result.setAttribute('color', color);
  }
  if (index) result.setIndex(new BufferAttribute(index, 1));
  result.computeBoundingBox();
  result.computeBoundingSphere();
  return result;
}
