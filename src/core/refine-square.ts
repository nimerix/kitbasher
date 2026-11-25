import { cutAlongField } from './refine-cut';
import {
  type RefineMesh,
  type RefineTopology,
  buildTopology,
  cloneRefineMesh,
  moveVertex,
  trimRefineMesh,
} from './refine-mesh';

export interface SquareInput {
  /** How far each rounding moves to its sharp corner, 0 to 1. */
  strength: number;
  /** The widest rounding, mm, measured across its arc. */
  reach: number;
  /** 1 for each welded vertex that may move; null lets every vertex move. */
  free: Uint8Array | null;
}

export interface SquareOutcome {
  /** The mesh with its corners rebuilt and cut along the new edges. */
  mesh: RefineMesh;
  topology: RefineTopology;
  /** Each triangle the cut split, with the triangles that now cover it, itself first. */
  children: Map<number, number[]>;
  /** Welded vertices on the rebuilt edges, where the rounding moved most of the way. */
  edge: Uint32Array;
  /** Welded vertices that moved. */
  moved: number;
  /** Vertices that moved less so that no triangle turns over. */
  held: number;
}

const degree = Math.PI / 180;
/** Faces meet at 90 degrees give or take this many. */
const angleTolerance = 25;
/** A face patch grows to faces within this angle of its mean normal... */
const patchAngle = 10;
/** ...across edges whose two faces turn by less than this. */
const stepAngle = 8;
/** A patch smaller than this many median edges squared is not a face... */
const patchEdges = 12;
/** ...nor is one narrower than this many median edges, such as a strip along a rounding. */
const faceEdges = 3;
/** Faces a patch's plane is fitted from lie within this many median edges of where it is read. */
const fitEdges = 4;
/** Plane fits leave out this many rings of faces at a patch's rim, where it turns into the rounding. */
const rimRings = 2;
/** Fitted planes are averaged with their neighbours' this many times. */
const settleRounds = 4;
/** A run of rebuilt corner shorter than this many median edges is left out. */
const runEdges = 10;
/** Moves ease in over this many median edges from where a run of corner ends. */
const taperEdges = 3;
/** The cut follows the corner where a vertex lands within this many median edges of it. */
const bandEdges = 2;
/** A circular rounding's middle moves 0.41 of its radius and its arc is 1.57 radii: moves longer than
 * this share of the distance to the two faces are misfits. */
const spanShare = 0.35;
/** A rebuilt edge vertex is marked a crease when it moved at least this share of the way. */
const creaseShare = 0.75;
/** Times a vertex's move is halved for a triangle it would turn over before it is dropped. */
const halvings = 6;
const none = -1;
const maxPlanes = 3;

/**
 * Rebuilds rounded edges where two faces meet at about 90 degrees, outside and inside, as sharp
 * corners, and cuts the mesh along them.
 *
 * The surface is first split into patches of faces whose normals stay within `patchAngle` of their
 * mean; a patch that curves tighter than `reach` is a rounding, not a face. Each vertex finds the
 * nearest patches within `reach` and fits each one's plane from that patch's faces near it. Between
 * two faces at 90 degrees, a rounding vertex lies inside both planes (an outside corner) or outside
 * both (an inside one); it moves along its normal until it meets the sharp corner the planes make,
 * as a ray cast against them. Three faces at 90 degrees make a box corner, cast against all three.
 * Planes are averaged with matching neighbours' so the corner runs smoothly, runs shorter than
 * `runEdges` are dropped, and moves ease in where a run ends. The mesh is then cut where vertices
 * change from landing on one plane to the other, and each new vertex is placed on the corner line, so
 * the edge runs along triangle edges. A move that would turn a triangle over is halved until it does
 * not.
 */
export function squareCorners(
  source: RefineMesh,
  topology: RefineTopology,
  noise: number,
  step: number,
  input: SquareInput,
  progress: (fraction: number) => void = () => {},
  check: () => void = () => {},
): SquareOutcome {
  const strength = Math.min(1, Math.max(0, input.strength || 0));
  const reach = Math.max(input.reach, 2 * step);
  const tri = weldedTriangles(source);
  const position = source.position;
  const n = source.weldedCount;
  const sign = source.flipped ? -1 : 1;
  const face = faceData(tri, position, sign);
  const adjacent = faceNeighbours(tri, topology);
  check();
  const patches = growPatches(adjacent, face, step, reach);
  progress(0.15);
  check();
  const near = nearestPatches(n, topology, position, patches.label, reach);
  progress(0.3);
  check();
  const normal = vertexNormals(n, topology, face);
  const inner = interiorVertices(n, topology, patches.label);
  const solve = new Solve(n);
  fitVertices(topology, position, face, patches, near, normal, inner, solve, {
    noise,
    step,
    reach,
    free: input.free,
    check,
  });
  progress(0.6);
  check();
  const tolerance = Math.max(3 * noise, 0.5 * step);
  const slack = Math.max(2 * noise, 0.05 * step);
  settle(topology, position, normal, solve, tolerance, slack, reach);
  fillGaps(topology, position, normal, solve, inner, tolerance, slack, reach, input.free);
  dropShortRuns(topology, position, solve, runEdges * step);
  const weight = taper(topology, position, solve, inner, taperEdges * step);
  for (let v = 0; v < n; v++) weight[v] *= strength;
  progress(0.7);
  check();
  const field = cornerField(topology, position, normal, solve, bandEdges * step, tolerance);
  const listed: number[] = [];
  for (let v = 0; v < n; v++) if (!Number.isNaN(field[v])) listed.push(v);
  const mesh = cloneRefineMesh(source, true);
  const plane = new Float64Array(8);
  const corner = new Float64Array(3);
  const cut = listed.length
    ? cutAlongField(
        mesh,
        topology,
        Uint32Array.from(listed),
        Float32Array.from(listed, (v) => field[v]),
        (x, y, z, out, a, b, t) => {
          for (let k = 0; k < 8; k++)
            plane[k] = solve.planes[a * 12 + k] * (1 - t) + solve.planes[b * 12 + k] * t;
          for (const o of [0, 4]) {
            const length = Math.hypot(plane[o], plane[o + 1], plane[o + 2]);
            for (let k = 0; k < 3; k++) plane[o + k] /= length;
          }
          onCorner(x, y, z, plane, 0, corner);
          const w = weight[a] * (1 - t) + weight[b] * t;
          out[0] = x + w * (corner[0] - x);
          out[1] = y + w * (corner[1] - y);
          out[2] = z + w * (corner[2] - z);
        },
      )
    : null;
  progress(0.85);
  check();
  const children = cut?.children ?? new Map<number, number[]>();
  const onEdge = new Set(cut?.chain ?? []);
  const movers: number[] = [];
  for (let v = 0; v < n; v++) if (solve.K[v] && weight[v] > 0 && !onEdge.has(v)) movers.push(v);
  const grown = trimRefineMesh(mesh);
  const grownTopology = cut ? buildTopology(grown) : topology;
  const held = moveHoldingFolds(source, grown, grownTopology, children, movers, solve, weight);
  // Edge vertices where the rounding moved most of the way become creases, so later steps hold
  // them and shading keeps the edge sharp.
  const edge: number[] = [];
  for (const v of onEdge) {
    let sum = 0,
      count = 0;
    for (let i = grownTopology.neighbourStart[v]; i < grownTopology.neighbourStart[v + 1]; i++) {
      const w = grownTopology.neighbours[i];
      if (w < n && solve.K[w]) {
        sum += weight[w];
        count++;
      }
    }
    if (count && sum / count >= creaseShare) edge.push(v);
  }
  edge.sort((a, b) => a - b);
  let moved = 0;
  for (let v = 0; v < grown.weldedCount; v++)
    if (
      v >= n ||
      grown.position[v * 3] !== source.position[v * 3] ||
      grown.position[v * 3 + 1] !== source.position[v * 3 + 1] ||
      grown.position[v * 3 + 2] !== source.position[v * 3 + 2]
    )
      moved++;
  progress(1);
  return {
    mesh: grown,
    topology: grownTopology,
    children,
    edge: Uint32Array.from(edge),
    moved,
    held,
  };
}

function weldedTriangles(mesh: RefineMesh) {
  const tri = new Uint32Array(mesh.triangleCount * 3);
  for (let i = 0; i < tri.length; i++) tri[i] = mesh.weldOf[mesh.corners[i]];
  return tri;
}

interface Faces {
  tri: Uint32Array;
  normal: Float64Array;
  area: Float64Array;
  centre: Float64Array;
}

/** Outward unit normal, area and centroid of each triangle. */
function faceData(tri: Uint32Array, p: Float64Array, sign: number): Faces {
  const count = tri.length / 3;
  const normal = new Float64Array(count * 3),
    area = new Float64Array(count),
    centre = new Float64Array(count * 3);
  for (let t = 0; t < count; t++) {
    const a = tri[t * 3] * 3,
      b = tri[t * 3 + 1] * 3,
      c = tri[t * 3 + 2] * 3;
    const ux = p[b] - p[a],
      uy = p[b + 1] - p[a + 1],
      uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a],
      vy = p[c + 1] - p[a + 1],
      vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy,
      y = uz * vx - ux * vz,
      z = ux * vy - uy * vx;
    const length = Math.sqrt(x * x + y * y + z * z);
    area[t] = length / 2;
    const scale = length > 0 ? sign / length : 0;
    normal[t * 3] = x * scale;
    normal[t * 3 + 1] = y * scale;
    normal[t * 3 + 2] = z * scale;
    for (let k = 0; k < 3; k++) centre[t * 3 + k] = (p[a + k] + p[b + k] + p[c + k]) / 3;
  }
  return { tri, normal, area, centre };
}

/** The triangle across each triangle's edge from corner k to k + 1, or -1 on an open or shared edge. */
function faceNeighbours(tri: Uint32Array, topology: RefineTopology) {
  const count = tri.length / 3;
  const adjacent = new Int32Array(count * 3).fill(none);
  const { triangleStart, trianglesOf } = topology;
  for (let t = 0; t < count; t++)
    for (let k = 0; k < 3; k++) {
      const a = tri[t * 3 + k],
        b = tri[t * 3 + ((k + 1) % 3)];
      let other = none,
        found = 0;
      for (let i = triangleStart[a]; i < triangleStart[a + 1]; i++) {
        const s = trianglesOf[i];
        if (s !== t && (tri[s * 3] === b || tri[s * 3 + 1] === b || tri[s * 3 + 2] === b)) {
          other = s;
          found++;
        }
      }
      if (found === 1) adjacent[t * 3 + k] = other;
    }
  return adjacent;
}

function vertexNormals(n: number, topology: RefineTopology, face: Faces) {
  const { triangleStart, trianglesOf } = topology;
  const out = new Float64Array(n * 3);
  for (let v = 0; v < n; v++) {
    let x = 0,
      y = 0,
      z = 0;
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) {
      const t = trianglesOf[i];
      x += face.normal[t * 3] * face.area[t];
      y += face.normal[t * 3 + 1] * face.area[t];
      z += face.normal[t * 3 + 2] * face.area[t];
    }
    const length = Math.sqrt(x * x + y * y + z * z);
    const scale = length > 0 ? 1 / length : 0;
    out[v * 3] = x * scale;
    out[v * 3 + 1] = y * scale;
    out[v * 3 + 2] = z * scale;
  }
  return out;
}

interface Patches {
  /** Patch of each triangle, or -1. */
  label: Int32Array;
  count: number;
  /** Rings of faces in from each face's patch rim, up to 255. */
  depth: Uint8Array;
}

/**
 * Grows patches from the flattest faces outward over edges that turn less than `stepAngle`, keeping
 * each face within `patchAngle` of the patch's mean normal. Normals are first averaged twice with
 * edge neighbours within 30 degrees so noise does not stop growth. A patch is kept when it is at least
 * `patchEdges` squared median edges and curves no tighter than `reach`: its normals' spread over its
 * extent, across the direction they spread in.
 */
function growPatches(adjacent: Int32Array, face: Faces, step: number, reach: number): Patches {
  const { area, centre } = face;
  const count = area.length;
  let normal = face.normal;
  const within = Math.cos(30 * degree);
  for (let round = 0; round < 2; round++) {
    const next = normal.slice();
    for (let t = 0; t < count; t++) {
      let x = normal[t * 3] * area[t],
        y = normal[t * 3 + 1] * area[t],
        z = normal[t * 3 + 2] * area[t];
      for (let k = 0; k < 3; k++) {
        const s = adjacent[t * 3 + k];
        if (s < 0 || dot(normal, t, normal, s) < within) continue;
        x += normal[s * 3] * area[s];
        y += normal[s * 3 + 1] * area[s];
        z += normal[s * 3 + 2] * area[s];
      }
      const length = Math.sqrt(x * x + y * y + z * z);
      const scale = length > 0 ? 1 / length : 0;
      next[t * 3] = x * scale;
      next[t * 3 + 1] = y * scale;
      next[t * 3 + 2] = z * scale;
    }
    normal = next;
  }
  const bend = new Float64Array(count);
  for (let t = 0; t < count; t++) {
    let worst = 0;
    for (let k = 0; k < 3; k++) {
      const s = adjacent[t * 3 + k];
      if (s >= 0) worst = Math.max(worst, 1 - dot(normal, t, normal, s));
    }
    bend[t] = worst;
  }
  const order = Uint32Array.from({ length: count }, (_, i) => i).sort((a, b) => bend[a] - bend[b]);
  const label = new Int32Array(count).fill(none);
  const meanLimit = Math.cos(patchAngle * degree),
    stepLimit = Math.cos(stepAngle * degree);
  const seedLimit = 1 - stepLimit;
  const queue = new Uint32Array(count);
  // Per patch: area, then sums for the normal's and the centroid's mean and second moments.
  const moments: number[] = [];
  let patches = 0;
  for (const seed of order) {
    if (bend[seed] > seedLimit) break;
    if (label[seed] >= 0) continue;
    const id = patches++;
    let head = 0,
      tail = 0;
    queue[tail++] = seed;
    label[seed] = id;
    let mx = 0,
      my = 0,
      mz = 0;
    const sums = new Float64Array(moment);
    while (head < tail) {
      const t = queue[head++];
      const a = area[t];
      const nx = normal[t * 3],
        ny = normal[t * 3 + 1],
        nz = normal[t * 3 + 2];
      mx += nx * a;
      my += ny * a;
      mz += nz * a;
      const n = [nx, ny, nz],
        c = [centre[t * 3], centre[t * 3 + 1], centre[t * 3 + 2]];
      sums[0] += a;
      for (let i = 0; i < 3; i++) {
        sums[1 + i] += a * n[i];
        sums[4 + i] += a * c[i];
        for (let j = 0; j < 3; j++) {
          sums[7 + i * 3 + j] += a * c[i] * c[j];
          sums[16 + i * 3 + j] += a * n[i] * c[j];
        }
      }
      const ml = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
      for (let k = 0; k < 3; k++) {
        const s = adjacent[t * 3 + k];
        if (s < 0 || label[s] >= 0) continue;
        if (dot(normal, t, normal, s) < stepLimit) continue;
        if ((normal[s * 3] * mx + normal[s * 3 + 1] * my + normal[s * 3 + 2] * mz) / ml < meanLimit)
          continue;
        label[s] = id;
        queue[tail++] = s;
      }
    }
    moments.push(...sums);
  }
  const minArea = patchEdges * step * step;
  const remap = new Int32Array(patches).fill(none);
  let kept = 0;
  for (let i = 0; i < patches; i++) {
    const m = moments.slice(i * moment, (i + 1) * moment);
    const shape = patchShape(m, step);
    if (m[0] < minArea || shape.width < faceEdges * step || shape.curvature * reach > 1) continue;
    remap[i] = kept++;
  }
  for (let t = 0; t < count; t++) if (label[t] >= 0) label[t] = remap[label[t]];
  const depth = new Uint8Array(count).fill(255);
  let ring: number[] = [];
  for (let t = 0; t < count; t++) {
    if (label[t] < 0) continue;
    for (let k = 0; k < 3; k++) {
      const s = adjacent[t * 3 + k];
      if (s < 0 || label[s] !== label[t]) {
        depth[t] = 0;
        ring.push(t);
        break;
      }
    }
  }
  for (let d = 1; d <= rimRings && ring.length; d++) {
    const next: number[] = [];
    for (const t of ring)
      for (let k = 0; k < 3; k++) {
        const s = adjacent[t * 3 + k];
        if (s >= 0 && label[s] === label[t] && depth[s] === 255) {
          depth[s] = d;
          next.push(s);
        }
      }
    ring = next;
  }
  return { label, count: kept, depth };
}

/** Area-weighted sums kept per patch: area, normal, centroid, centroid by centroid, normal by centroid. */
const moment = 25;

/**
 * A patch's narrowest width, mm, from the spread of its centroids across its tangent plane, and how
 * tightly it curves, 1/mm at most: the largest singular value of the least-squares linear map from
 * position to normal in that plane (its shape operator), with the spread padded by a quarter edge so
 * a narrow patch does not read as sharp.
 */
function patchShape(m: ArrayLike<number>, step: number) {
  const flat = { width: Infinity, curvature: 0 };
  const w = m[0];
  if (!(w > 0)) return flat;
  const n = [m[1] / w, m[2] / w, m[3] / w];
  const c = [m[4] / w, m[5] / w, m[6] / w];
  const xx = (i: number, j: number) => m[7 + i * 3 + j] / w - c[i] * c[j];
  const nx = (i: number, j: number) => m[16 + i * 3 + j] / w - n[i] * c[j];
  const length = Math.hypot(n[0], n[1], n[2]);
  if (!(length > 0)) return flat;
  const normal = n.map((v) => v / length);
  const helper = Math.abs(normal[0]) < 0.6 ? [1, 0, 0] : [0, 1, 0];
  const u = [
    normal[1] * helper[2] - normal[2] * helper[1],
    normal[2] * helper[0] - normal[0] * helper[2],
    normal[0] * helper[1] - normal[1] * helper[0],
  ];
  const ul = Math.hypot(u[0], u[1], u[2]);
  for (let i = 0; i < 3; i++) u[i] /= ul;
  const v = [
    normal[1] * u[2] - normal[2] * u[1],
    normal[2] * u[0] - normal[0] * u[2],
    normal[0] * u[1] - normal[1] * u[0],
  ];
  const axes = [u, v];
  const project = (f: (i: number, j: number) => number, a: number[], b: number[]) => {
    let sum = 0;
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) sum += a[i] * f(i, j) * b[j];
    return sum;
  };
  // Positions' covariance in the tangent plane, and the normals' covariance with them.
  const p11 = project(xx, u, u),
    p12 = project(xx, u, v),
    p22 = project(xx, v, v);
  const least = (p11 + p22) / 2 - Math.sqrt(((p11 - p22) / 2) ** 2 + p12 * p12);
  // A strip of uniform width spreads its centroids by width^2 / 12 across it.
  const width = Math.sqrt(12 * Math.max(0, least));
  const pad = (step / 4) ** 2;
  const a11 = p11 + pad,
    a22 = p22 + pad;
  const det = a11 * a22 - p12 * p12;
  if (!(det > 0)) return { width, curvature: 0 };
  const inverse = [
    [a22 / det, -p12 / det],
    [-p12 / det, a11 / det],
  ];
  const q = axes.map((a) => axes.map((b) => project(nx, a, b)));
  const s = [0, 1].map((i) => [0, 1].map((j) => q[i][0] * inverse[0][j] + q[i][1] * inverse[1][j]));
  // Largest singular value of the 2 x 2 map.
  const a = s[0][0] ** 2 + s[1][0] ** 2,
    b = s[0][0] * s[0][1] + s[1][0] * s[1][1],
    d = s[0][1] ** 2 + s[1][1] ** 2;
  return { width, curvature: Math.sqrt((a + d) / 2 + Math.sqrt(((a - d) / 2) ** 2 + b * b)) };
}

/** A binary min-heap of entries (key, vertex, patch, source). */
class Heap {
  private key: number[] = [];
  private data: number[] = [];
  get size() {
    return this.key.length;
  }
  push(key: number, a: number, b: number, c: number) {
    let i = this.key.length;
    this.key.push(key);
    this.data.push(a, b, c);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.key[parent] <= key) break;
      this.swap(i, parent);
      i = parent;
    }
  }
  /** Pops the least entry into `out` as key, a, b, c. */
  pop(out: number[]) {
    out[0] = this.key[0];
    out[1] = this.data[0];
    out[2] = this.data[1];
    out[3] = this.data[2];
    const last = this.key.length - 1;
    this.swap(0, last);
    this.key.pop();
    this.data.length -= 3;
    const size = this.key.length;
    for (let i = 0; ;) {
      const l = i * 2 + 1,
        r = l + 1;
      let m = i;
      if (l < size && this.key[l] < this.key[m]) m = l;
      if (r < size && this.key[r] < this.key[m]) m = r;
      if (m === i) break;
      this.swap(i, m);
      i = m;
    }
  }
  private swap(i: number, j: number) {
    const k = this.key[i];
    this.key[i] = this.key[j];
    this.key[j] = k;
    for (let a = 0; a < 3; a++) {
      const d = this.data[i * 3 + a];
      this.data[i * 3 + a] = this.data[j * 3 + a];
      this.data[j * 3 + a] = d;
    }
  }
}

interface Nearest {
  /** Up to `maxPlanes` per vertex, nearest first: patch, distance along the surface, and the
   * vertex of that patch it was reached from. */
  patch: Int32Array;
  distance: Float64Array;
  from: Int32Array;
  count: Uint8Array;
}

/** The nearest patches to each vertex within `reach`, by distance along mesh edges. */
function nearestPatches(
  n: number,
  topology: RefineTopology,
  p: Float64Array,
  label: Int32Array,
  reach: number,
): Nearest {
  const { triangleStart, trianglesOf, neighbourStart, neighbours } = topology;
  const patch = new Int32Array(n * maxPlanes).fill(none);
  const distance = new Float64Array(n * maxPlanes).fill(Infinity);
  const from = new Int32Array(n * maxPlanes).fill(none);
  const count = new Uint8Array(n);
  const heap = new Heap();
  for (let v = 0; v < n; v++)
    for (let i = triangleStart[v]; i < triangleStart[v + 1]; i++) {
      const l = label[trianglesOf[i]];
      if (l < 0) continue;
      let seen = false;
      for (let j = triangleStart[v]; j < i && !seen; j++) seen = label[trianglesOf[j]] === l;
      if (!seen) heap.push(0, v, l, v);
    }
  const has = (v: number, l: number) => {
    for (let k = 0; k < count[v]; k++) if (patch[v * maxPlanes + k] === l) return true;
    return false;
  };
  const entry = [0, 0, 0, 0];
  while (heap.size) {
    heap.pop(entry);
    const [d, v, l, s] = entry;
    if (count[v] >= maxPlanes || has(v, l)) continue;
    const k = v * maxPlanes + count[v]++;
    patch[k] = l;
    distance[k] = d;
    from[k] = s;
    for (let i = neighbourStart[v]; i < neighbourStart[v + 1]; i++) {
      const w = neighbours[i];
      if (count[w] >= maxPlanes || has(w, l)) continue;
      const next =
        d +
        Math.hypot(p[w * 3] - p[v * 3], p[w * 3 + 1] - p[v * 3 + 1], p[w * 3 + 2] - p[v * 3 + 2]);
      if (next <= reach) heap.push(next, w, l, s);
    }
  }
  return { patch, distance, from, count };
}

/** Per vertex: how many planes it is squared against (0, 2 or 3), the planes, and its target. */
class Solve {
  readonly K: Uint8Array;
  /** Up to three planes per vertex, each a unit normal and offset. */
  readonly planes: Float64Array;
  /** 1 for an outside corner, -1 for an inside one. */
  readonly kind: Int8Array;
  readonly target: Float64Array;
  constructor(n: number) {
    this.K = new Uint8Array(n);
    this.planes = new Float64Array(n * 12);
    this.kind = new Int8Array(n);
    this.target = new Float64Array(n * 3);
  }
}

/**
 * Casts a ray from `p` along the normal, out of an outside corner or into an inside one, against
 * `count` planes from `base`, to where it leaves the region inside them all or enters the region
 * inside any. Null when `p` is not inside them all, or outside them all, by `slack`, or the normal
 * turns from a plane.
 */
function rayCast(
  p: ArrayLike<number>,
  normal: ArrayLike<number>,
  planes: Float64Array,
  base: number,
  count: number,
  slack: number,
) {
  let sum = 0,
    inside = true,
    outside = true;
  for (let i = 0; i < count; i++) {
    const o = base + i * 4;
    const s = planes[o] * p[0] + planes[o + 1] * p[1] + planes[o + 2] * p[2] - planes[o + 3];
    if (planes[o] * normal[0] + planes[o + 1] * normal[1] + planes[o + 2] * normal[2] < 0.05)
      return null;
    sum += s;
    if (s > slack) inside = false;
    if (s < -slack) outside = false;
  }
  const kind = inside && sum < 0 ? 1 : outside && sum > 0 ? -1 : 0;
  if (!kind) return null;
  let t = Infinity;
  for (let i = 0; i < count; i++) {
    const o = base + i * 4;
    const s = planes[o] * p[0] + planes[o + 1] * p[1] + planes[o + 2] * p[2] - planes[o + 3];
    const c = planes[o] * normal[0] + planes[o + 1] * normal[1] + planes[o + 2] * normal[2];
    t = Math.min(t, Math.max(0, (-kind * s) / c));
  }
  return { kind, t };
}

interface FitOptions {
  noise: number;
  step: number;
  reach: number;
  free: Uint8Array | null;
  check: () => void;
}

/** Whether every triangle around `v` is in one patch. */
function interiorVertices(n: number, topology: RefineTopology, label: Int32Array) {
  const { triangleStart, trianglesOf } = topology;
  const inner = new Uint8Array(n);
  for (let v = 0; v < n; v++) {
    let l = none - 1;
    let one = triangleStart[v + 1] > triangleStart[v];
    for (let i = triangleStart[v]; i < triangleStart[v + 1] && one; i++) {
      const f = label[trianglesOf[i]];
      if (f < 0 || (l !== none - 1 && f !== l)) one = false;
      l = f;
    }
    inner[v] = +one;
  }
  return inner;
}

/** Fits each vertex in a rounding between faces at 90 degrees, and casts it to their corner. */
function fitVertices(
  topology: RefineTopology,
  position: Float64Array,
  face: Faces,
  patches: Patches,
  near: Nearest,
  normal: Float64Array,
  inner: Uint8Array,
  solve: Solve,
  options: FitOptions,
) {
  const n = inner.length;
  const { noise, step, reach, free, check } = options;
  const cache = new Map<number, Float64Array | null>();
  const stamp = new Int32Array(n);
  const mark = { value: 0 };
  const planeOf = (s: number, l: number) => {
    const key = s * (patches.count + 1) + l;
    let plane = cache.get(key);
    if (plane === undefined) {
      plane = localPlane(topology, position, face, patches, s, l, fitEdges * step, stamp, mark);
      cache.set(key, plane);
    }
    return plane;
  };
  const slack = Math.max(2 * noise, 0.05 * step);
  const low = Math.cos((90 + angleTolerance) * degree),
    high = Math.cos((90 - angleTolerance) * degree);
  const square = (a: Float64Array, b: Float64Array) => {
    const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    return d >= low && d <= high;
  };
  const trial = new Float64Array(12);
  const found: (Float64Array | null)[] = [null, null, null];
  const pairs = [
    [0, 1],
    [0, 2],
    [1, 2],
  ];
  for (let v = 0; v < n; v++) {
    if ((v & 4095) === 0) check();
    const count = near.count[v];
    if (count < 2 || inner[v] || (free && !free[v])) continue;
    let planes = 0;
    for (let k = 0; k < count; k++) {
      found[k] = planeOf(near.from[v * maxPlanes + k], near.patch[v * maxPlanes + k]);
      if (found[k]) planes++;
    }
    if (planes < 2) continue;
    const p = position.subarray(v * 3, v * 3 + 3),
      nv = normal.subarray(v * 3, v * 3 + 3);
    let chosen: number[] | null = null;
    let cast: ReturnType<typeof rayCast> = null;
    if (
      count === 3 &&
      found[0] &&
      found[1] &&
      found[2] &&
      square(found[0], found[1]) &&
      square(found[0], found[2]) &&
      square(found[1], found[2])
    ) {
      for (let k = 0; k < 3; k++) trial.set(found[k]!, k * 4);
      cast = rayCast(p, nv, trial, 0, 3, slack);
      if (cast) chosen = [0, 1, 2];
    }
    for (const [i, j] of pairs) {
      if (chosen) break;
      if (j >= count || !found[i] || !found[j] || !square(found[i]!, found[j]!)) continue;
      trial.set(found[i]!, 0);
      trial.set(found[j]!, 4);
      cast = rayCast(p, nv, trial, 0, 2, slack);
      if (cast) chosen = [i, j];
    }
    if (!chosen || !cast) continue;
    let span = 0;
    for (const c of chosen) span += near.distance[v * maxPlanes + c];
    if (cast.t > 0.6 * reach || cast.t > spanShare * span + 2 * noise) continue;
    solve.K[v] = chosen.length;
    chosen.forEach((c, i) => solve.planes.set(found[c]!, v * 12 + i * 4));
    solve.kind[v] = cast.kind;
  }
}

/**
 * The plane of patch `l` around vertex `s`: from that patch's faces within `radius`, leaving out its
 * rim where it can, the area-weighted mean normal of the faces within 8 degrees of their mean, through
 * their area-weighted mean centroid.
 */
function localPlane(
  topology: RefineTopology,
  position: Float64Array,
  face: Faces,
  patches: Patches,
  s: number,
  l: number,
  radius: number,
  stamp: Int32Array,
  mark: { value: number },
): Float64Array | null {
  const { triangleStart, trianglesOf, neighbourStart, neighbours } = topology;
  const { label, depth } = patches;
  const px = position[s * 3],
    py = position[s * 3 + 1],
    pz = position[s * 3 + 2];
  const r2 = radius * radius;
  const id = ++mark.value;
  const queue = [s];
  stamp[s] = id;
  const faces = new Set<number>();
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q];
    let inPatch = false;
    for (let i = triangleStart[u]; i < triangleStart[u + 1]; i++) {
      const t = trianglesOf[i];
      if (label[t] !== l) continue;
      inPatch = true;
      faces.add(t);
    }
    if (!inPatch) continue;
    for (let i = neighbourStart[u]; i < neighbourStart[u + 1]; i++) {
      const w = neighbours[i];
      if (stamp[w] === id) continue;
      const dx = position[w * 3] - px,
        dy = position[w * 3 + 1] - py,
        dz = position[w * 3 + 2] - pz;
      if (dx * dx + dy * dy + dz * dz > r2) continue;
      stamp[w] = id;
      queue.push(w);
    }
  }
  let list = [...faces];
  if (list.length < 3) return null;
  for (let least = rimRings; least > 0; least--) {
    const inner = list.filter((t) => depth[t] >= least);
    if (inner.length >= 6) {
      list = inner;
      break;
    }
  }
  const { normal, area, centre } = face;
  let mx = 0,
    my = 0,
    mz = 0;
  for (const t of list) {
    mx += normal[t * 3] * area[t];
    my += normal[t * 3 + 1] * area[t];
    mz += normal[t * 3 + 2] * area[t];
  }
  let length = Math.sqrt(mx * mx + my * my + mz * mz);
  if (!(length > 0)) return null;
  mx /= length;
  my /= length;
  mz /= length;
  const close = Math.cos(8 * degree);
  let nx = 0,
    ny = 0,
    nz = 0,
    cx = 0,
    cy = 0,
    cz = 0,
    total = 0,
    kept = 0;
  for (const t of list) {
    if (normal[t * 3] * mx + normal[t * 3 + 1] * my + normal[t * 3 + 2] * mz < close) continue;
    const a = area[t];
    nx += normal[t * 3] * a;
    ny += normal[t * 3 + 1] * a;
    nz += normal[t * 3 + 2] * a;
    cx += centre[t * 3] * a;
    cy += centre[t * 3 + 1] * a;
    cz += centre[t * 3 + 2] * a;
    total += a;
    kept++;
  }
  if (kept < 3 || !(total > 0)) return null;
  length = Math.sqrt(nx * nx + ny * ny + nz * nz);
  nx /= length;
  ny /= length;
  nz /= length;
  return Float64Array.of(nx, ny, nz, (nx * cx + ny * cy + nz * cz) / total);
}

/** Whether plane j of w is plane i of v: normals within 12 degrees and heights at `p` within `tolerance`. */
function matches(
  planes: Float64Array,
  v: number,
  i: number,
  w: number,
  j: number,
  p: ArrayLike<number>,
  tolerance: number,
) {
  const a = v * 12 + i * 4,
    b = w * 12 + j * 4;
  if (planes[a] * planes[b] + planes[a + 1] * planes[b + 1] + planes[a + 2] * planes[b + 2] < 0.978)
    return false;
  const sa = planes[a] * p[0] + planes[a + 1] * p[1] + planes[a + 2] * p[2] - planes[a + 3];
  const sb = planes[b] * p[0] + planes[b + 1] * p[1] + planes[b + 2] * p[2] - planes[b + 3];
  return Math.abs(sa - sb) < tolerance;
}

/** Casts a fitted vertex to its target, or unfits it. */
function cast(
  v: number,
  position: Float64Array,
  normal: Float64Array,
  solve: Solve,
  slack: number,
  reach: number,
) {
  const p = position.subarray(v * 3, v * 3 + 3),
    nv = normal.subarray(v * 3, v * 3 + 3);
  const result = rayCast(p, nv, solve.planes, v * 12, solve.K[v], slack);
  if (!result || result.t > 0.6 * reach) {
    solve.K[v] = 0;
    return;
  }
  solve.kind[v] = result.kind;
  for (let a = 0; a < 3; a++) solve.target[v * 3 + a] = p[a] + result.kind * result.t * nv[a];
}

/** Averages each plane with the matching planes of fitted neighbours, then casts again. */
function settle(
  topology: RefineTopology,
  position: Float64Array,
  normal: Float64Array,
  solve: Solve,
  tolerance: number,
  slack: number,
  reach: number,
) {
  const { neighbourStart, neighbours } = topology;
  const { K, planes, kind } = solve;
  const n = K.length;
  for (let round = 0; round < settleRounds; round++) {
    const next = planes.slice();
    for (let v = 0; v < n; v++) {
      if (!K[v]) continue;
      const p = position.subarray(v * 3, v * 3 + 3);
      for (let i = 0; i < K[v]; i++) {
        const base = v * 12 + i * 4;
        let x = planes[base],
          y = planes[base + 1],
          z = planes[base + 2];
        // Offsets are averaged as each plane's height at v, so planes read far along do not skew it.
        let height = x * p[0] + y * p[1] + z * p[2] - planes[base + 3];
        let count = 1;
        for (let e = neighbourStart[v]; e < neighbourStart[v + 1]; e++) {
          const w = neighbours[e];
          if (!K[w] || kind[w] !== kind[v]) continue;
          for (let j = 0; j < K[w]; j++) {
            if (!matches(planes, v, i, w, j, p, tolerance)) continue;
            const b = w * 12 + j * 4;
            x += planes[b];
            y += planes[b + 1];
            z += planes[b + 2];
            height +=
              planes[b] * p[0] + planes[b + 1] * p[1] + planes[b + 2] * p[2] - planes[b + 3];
            count++;
            break;
          }
        }
        const length = Math.sqrt(x * x + y * y + z * z);
        x /= length;
        y /= length;
        z /= length;
        next[base] = x;
        next[base + 1] = y;
        next[base + 2] = z;
        next[base + 3] = x * p[0] + y * p[1] + z * p[2] - height / count;
      }
    }
    planes.set(next);
  }
  for (let v = 0; v < n; v++) if (K[v]) cast(v, position, normal, solve, slack, reach);
}

/** A vertex in a rounding left unfitted between fitted neighbours on one pair of planes takes them. */
function fillGaps(
  topology: RefineTopology,
  position: Float64Array,
  normal: Float64Array,
  solve: Solve,
  inner: Uint8Array,
  tolerance: number,
  slack: number,
  reach: number,
  free: Uint8Array | null,
) {
  const { neighbourStart, neighbours } = topology;
  const { K, planes, kind } = solve;
  const n = K.length;
  const mean = new Float64Array(8);
  for (let round = 0; round < 2; round++) {
    const added: [number, Float64Array][] = [];
    for (let v = 0; v < n; v++) {
      if (K[v] || inner[v] || (free && !free[v])) continue;
      let first = none;
      for (let e = neighbourStart[v]; e < neighbourStart[v + 1] && first < 0; e++)
        if (K[neighbours[e]] === 2) first = neighbours[e];
      if (first < 0) continue;
      const p = position.subarray(v * 3, v * 3 + 3);
      mean.fill(0);
      let count = 0;
      for (let e = neighbourStart[v]; e < neighbourStart[v + 1]; e++) {
        const w = neighbours[e];
        if (K[w] !== 2 || kind[w] !== kind[first]) continue;
        let swap: boolean;
        if (
          matches(planes, first, 0, w, 0, p, tolerance) &&
          matches(planes, first, 1, w, 1, p, tolerance)
        )
          swap = false;
        else if (
          matches(planes, first, 0, w, 1, p, tolerance) &&
          matches(planes, first, 1, w, 0, p, tolerance)
        )
          swap = true;
        else continue;
        for (let h = 0; h < 2; h++) {
          const from = w * 12 + (swap ? 1 - h : h) * 4;
          for (let k = 0; k < 4; k++) mean[h * 4 + k] += planes[from + k];
        }
        count++;
      }
      if (count < 2) continue;
      for (const b of [0, 4]) {
        const length = Math.hypot(mean[b], mean[b + 1], mean[b + 2]);
        for (let k = 0; k < 3; k++) mean[b + k] /= length;
        mean[b + 3] /= count;
      }
      const result = rayCast(p, normal.subarray(v * 3, v * 3 + 3), mean, 0, 2, slack);
      if (result && result.t <= 0.6 * reach) added.push([v, mean.slice()]);
    }
    for (const [v, plane] of added) {
      K[v] = 2;
      planes.set(plane, v * 12);
      cast(v, position, normal, solve, slack, reach);
    }
    if (!added.length) break;
  }
}

/** Unfits runs of fitted vertices whose extent is under `least` mm. */
function dropShortRuns(
  topology: RefineTopology,
  position: Float64Array,
  solve: Solve,
  least: number,
) {
  const { neighbourStart, neighbours } = topology;
  const { K } = solve;
  const n = K.length;
  const seen = new Uint8Array(n);
  const queue: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (!K[seed] || seen[seed]) continue;
    seen[seed] = 1;
    queue.length = 0;
    queue.push(seed);
    const low = [Infinity, Infinity, Infinity],
      high = [-Infinity, -Infinity, -Infinity];
    for (let q = 0; q < queue.length; q++) {
      const v = queue[q];
      for (let a = 0; a < 3; a++) {
        low[a] = Math.min(low[a], position[v * 3 + a]);
        high[a] = Math.max(high[a], position[v * 3 + a]);
      }
      for (let e = neighbourStart[v]; e < neighbourStart[v + 1]; e++) {
        const w = neighbours[e];
        if (!K[w] || seen[w]) continue;
        seen[w] = 1;
        queue.push(w);
      }
    }
    if (Math.hypot(high[0] - low[0], high[1] - low[1], high[2] - low[2]) < least)
      for (const v of queue) K[v] = 0;
  }
}

/**
 * The share of its move each fitted vertex makes: none beside an unfitted vertex in a rounding,
 * easing to all `length` mm from it along fitted vertices.
 */
function taper(
  topology: RefineTopology,
  position: Float64Array,
  solve: Solve,
  inner: Uint8Array,
  length: number,
) {
  const { neighbourStart, neighbours } = topology;
  const { K } = solve;
  const n = K.length;
  const distance = new Float64Array(n).fill(Infinity);
  const heap = new Heap();
  for (let v = 0; v < n; v++) {
    if (K[v] || inner[v]) continue;
    let beside = false;
    for (let e = neighbourStart[v]; e < neighbourStart[v + 1] && !beside; e++)
      beside = K[neighbours[e]] > 0;
    if (!beside) continue;
    distance[v] = 0;
    heap.push(0, v, 0, 0);
  }
  const entry = [0, 0, 0, 0];
  while (heap.size) {
    heap.pop(entry);
    const d = entry[0],
      v = entry[1];
    if (d > distance[v]) continue;
    for (let e = neighbourStart[v]; e < neighbourStart[v + 1]; e++) {
      const w = neighbours[e];
      if (!K[w]) continue;
      const next =
        d +
        Math.hypot(
          position[w * 3] - position[v * 3],
          position[w * 3 + 1] - position[v * 3 + 1],
          position[w * 3 + 2] - position[v * 3 + 2],
        );
      if (next >= distance[w] || next > length) continue;
      distance[w] = next;
      heap.push(next, w, 0, 0);
    }
  }
  const weight = new Float64Array(n);
  for (let v = 0; v < n; v++) {
    if (!K[v]) continue;
    const x = Math.min(1, distance[v] / length);
    weight[v] = x * x * (3 - 2 * x);
  }
  return weight;
}

/**
 * The field the cut follows: for each vertex squared against two planes whose target lies within
 * `band` of their corner, positive where it lands on its first plane and negative on its second.
 * Neighbours' first planes are matched so the sign means the same along a run; a vertex beside one on
 * another pair of planes is left out, so the cut never joins two edges.
 */
function cornerField(
  topology: RefineTopology,
  position: Float64Array,
  normal: Float64Array,
  solve: Solve,
  band: number,
  tolerance: number,
) {
  const { K, planes, target, kind } = solve;
  const n = K.length;
  const field = new Float64Array(n).fill(NaN);
  const corner = new Float64Array(3);
  for (let v = 0; v < n; v++) {
    if (K[v] !== 2) continue;
    onCorner(target[v * 3], target[v * 3 + 1], target[v * 3 + 2], planes, v * 12, corner);
    if (
      Math.hypot(
        corner[0] - target[v * 3],
        corner[1] - target[v * 3 + 1],
        corner[2] - target[v * 3 + 2],
      ) > band
    )
      continue;
    const b = v * 12;
    const px = position[v * 3],
      py = position[v * 3 + 1],
      pz = position[v * 3 + 2];
    const nx = normal[v * 3],
      ny = normal[v * 3 + 1],
      nz = normal[v * 3 + 2];
    const sA = planes[b] * px + planes[b + 1] * py + planes[b + 2] * pz - planes[b + 3];
    const sB = planes[b + 4] * px + planes[b + 5] * py + planes[b + 6] * pz - planes[b + 7];
    const cA = planes[b] * nx + planes[b + 1] * ny + planes[b + 2] * nz;
    const cB = planes[b + 4] * nx + planes[b + 5] * ny + planes[b + 6] * nz;
    // Outside a corner the ray meets the first plane first where this is positive; inside, the
    // second, so the inside sign is turned.
    field[v] = (sA * cB - sB * cA) * kind[v];
  }
  const { neighbourStart, neighbours } = topology;
  const swap = (v: number) => {
    const first = planes.slice(v * 12, v * 12 + 4);
    planes.copyWithin(v * 12, v * 12 + 4, v * 12 + 8);
    planes.set(first, v * 12 + 4);
    field[v] = -field[v];
  };
  const seen = new Uint8Array(n);
  const drop = new Uint8Array(n);
  const queue: number[] = [];
  for (let seed = 0; seed < n; seed++) {
    if (Number.isNaN(field[seed]) || seen[seed]) continue;
    seen[seed] = 1;
    queue.length = 0;
    queue.push(seed);
    for (let q = 0; q < queue.length; q++) {
      const v = queue[q];
      const p = position.subarray(v * 3, v * 3 + 3);
      for (let e = neighbourStart[v]; e < neighbourStart[v + 1]; e++) {
        const w = neighbours[e];
        if (Number.isNaN(field[w])) continue;
        const same =
          matches(planes, v, 0, w, 0, p, tolerance) && matches(planes, v, 1, w, 1, p, tolerance);
        const crossed =
          !same &&
          matches(planes, v, 0, w, 1, p, tolerance) &&
          matches(planes, v, 1, w, 0, p, tolerance);
        if ((!same && !crossed) || (seen[w] && crossed)) {
          drop[v] = drop[w] = 1;
          continue;
        }
        if (seen[w]) continue;
        if (crossed) swap(w);
        seen[w] = 1;
        queue.push(w);
      }
    }
  }
  for (let v = 0; v < n; v++) if (drop[v]) field[v] = NaN;
  return field;
}

/** The nearest point to (x, y, z) on the line where the two planes from `base` meet. */
function onCorner(
  x: number,
  y: number,
  z: number,
  planes: ArrayLike<number>,
  base: number,
  out: Float64Array,
) {
  const b = base;
  const sA = planes[b] * x + planes[b + 1] * y + planes[b + 2] * z - planes[b + 3],
    sB = planes[b + 4] * x + planes[b + 5] * y + planes[b + 6] * z - planes[b + 7];
  const g =
    planes[b] * planes[b + 4] + planes[b + 1] * planes[b + 5] + planes[b + 2] * planes[b + 6];
  const det = 1 - g * g;
  const alpha = (sA - g * sB) / det,
    beta = (sB - g * sA) / det;
  out[0] = x - alpha * planes[b] - beta * planes[b + 4];
  out[1] = y - alpha * planes[b + 1] - beta * planes[b + 5];
  out[2] = z - alpha * planes[b + 2] - beta * planes[b + 6];
}

/**
 * Moves each mover its weighted share toward its target in `mesh`, halving the moves of the corners
 * of any triangle that would face against the triangle it was cut from in `source`, up to `halvings`
 * times, then leaving those still at fault where they were. Returns how many moved less.
 */
function moveHoldingFolds(
  source: RefineMesh,
  mesh: RefineMesh,
  topology: RefineTopology,
  children: Map<number, number[]>,
  movers: number[],
  solve: Solve,
  weight: Float64Array,
) {
  if (!movers.length) return 0;
  const sourceTri = weldedTriangles(source);
  const parent = new Int32Array(mesh.triangleCount);
  for (let t = 0; t < mesh.triangleCount; t++) parent[t] = t;
  for (const [t, kids] of children) for (const kid of kids) parent[kid] = t;
  const p0 = source.position;
  const reference = (t: number, out: Float64Array) => {
    const s = parent[t];
    cross(p0, sourceTri[s * 3], sourceTri[s * 3 + 1], sourceTri[s * 3 + 2], out);
  };
  const corner = (t: number, k: number) => mesh.weldOf[mesh.corners[t * 3 + k]];
  const start = new Float64Array(movers.length * 3);
  movers.forEach((v, i) => start.set(mesh.position.subarray(v * 3, v * 3 + 3), i * 3));
  const share = new Float64Array(movers.length).fill(1);
  const index = new Map<number, number>();
  movers.forEach((v, i) => index.set(v, i));
  const place = () =>
    movers.forEach((v, i) => {
      for (let a = 0; a < 3; a++) {
        const from = start[i * 3 + a];
        mesh.position[v * 3 + a] = from + share[i] * weight[v] * (solve.target[v * 3 + a] - from);
      }
    });
  const was = new Float64Array(3),
    now = new Float64Array(3);
  const flagged = new Set<number>();
  const reduced = new Uint8Array(movers.length);
  for (let round = 0; round <= halvings; round++) {
    place();
    flagged.clear();
    for (const v of movers)
      for (let e = topology.triangleStart[v]; e < topology.triangleStart[v + 1]; e++) {
        const t = topology.trianglesOf[e];
        reference(t, was);
        cross(mesh.position, corner(t, 0), corner(t, 1), corner(t, 2), now);
        if (was[0] * now[0] + was[1] * now[1] + was[2] * now[2] > 0) continue;
        for (let k = 0; k < 3; k++) {
          const i = index.get(corner(t, k as 0 | 1 | 2));
          if (i !== undefined) flagged.add(i);
        }
      }
    if (!flagged.size) break;
    for (const i of flagged) {
      reduced[i] = 1;
      share[i] = round === halvings ? 0 : share[i] / 2;
    }
    if (round === halvings) place();
  }
  for (const v of movers)
    moveVertex(mesh, v, mesh.position[v * 3], mesh.position[v * 3 + 1], mesh.position[v * 3 + 2]);
  let held = 0;
  for (let i = 0; i < movers.length; i++) held += reduced[i];
  return held;
}

function cross(p: Float64Array, a: number, b: number, c: number, out: Float64Array) {
  const ux = p[b * 3] - p[a * 3],
    uy = p[b * 3 + 1] - p[a * 3 + 1],
    uz = p[b * 3 + 2] - p[a * 3 + 2];
  const vx = p[c * 3] - p[a * 3],
    vy = p[c * 3 + 1] - p[a * 3 + 1],
    vz = p[c * 3 + 2] - p[a * 3 + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
}

const dot = (x: Float64Array, i: number, y: Float64Array, j: number) =>
  x[i * 3] * y[j * 3] + x[i * 3 + 1] * y[j * 3 + 1] + x[i * 3 + 2] * y[j * 3 + 2];
