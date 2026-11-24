import {
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  FrontSide,
  MathUtils,
  Matrix4,
  Mesh,
  Quaternion,
  Sphere,
  Triangle,
  Vector3,
  type Intersection,
  type Raycaster,
} from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { SculptBrush } from './types';

export type { SculptBrush } from './types';

interface SculptHit {
  point: Vector3;
  normal: Vector3;
  face: number;
  tangent?: Vector3;
  grab?: Vector3;
}

export interface SculptDab extends SculptHit {
  radius: number;
  strength: number;
  detail: number;
  minEdge: number;
  brush: SculptBrush;
  falloff: 'soft' | 'linear' | 'hard';
  inverted?: boolean;
  pinch?: number;
  softenMask?: boolean;
  aspect?: number;
  mirror?: SculptHit;
}

type Face = [number, number, number];
type Attribute = ReturnType<BufferGeometry['getAttribute']>;
type AttributeArray = BufferAttribute['array'];
interface Split {
  vertexCount: number;
  weld: number;
  faces: { id: number; previous: Face; child: number }[];
}
interface SculptSample {
  footprint: Footprint;
  weight: number;
  mirrored: boolean;
}
interface Incidence {
  weldOf: Uint32Array<ArrayBuffer>;
  representative: Uint32Array<ArrayBuffer>;
  faceStart: Uint32Array<ArrayBuffer>;
  incidentFaces: Uint32Array<ArrayBuffer>;
  adjacent: Int32Array<ArrayBuffer>;
  edits: ReadonlyMap<number, ReadonlySet<number>>;
}

let latestIncidence:
  | {
      source: WeakRef<BufferGeometry>;
      position: Attribute;
      index: BufferAttribute | null;
      incidence: Incidence;
    }
  | undefined;

export function clearSculptIncidence() {
  latestIncidence = undefined;
}

function rememberIncidence(source: BufferGeometry, incidence: Incidence) {
  latestIncidence = {
    source: new WeakRef(source),
    position: source.getAttribute('position'),
    index: source.index,
    incidence,
  };
}

const maxSplitsPerDab = 192;
/** Source meshes larger than this remain brushable at their available density. */
const maxRefinedFaceCount = 1_200_000;
const inheritedFaceLimits = new WeakMap<BufferGeometry, number>();
const maskName = 'sculptMask';

/** Exact coincident vertices share connectivity without welding a nearby thin shell. */
function weldVertices(position: Attribute) {
  const capacity = 2 ** Math.ceil(Math.log2(Math.max(16, position.count * 1.5)));
  const table = new Uint32Array(capacity);
  const weldOf = new Uint32Array(position.count);
  const representative = new Uint32Array(position.count);
  const coordinate = new Float64Array(1);
  const bits = new Uint32Array(coordinate.buffer);
  function hash(value: number) {
    coordinate[0] = value || 0;
    const mixed = Math.imul(bits[0] ^ bits[1], 0x85ebca6b);
    return mixed ^ (mixed >>> 16);
  }
  let count = 0;
  for (let vertex = 0; vertex < position.count; vertex++) {
    const x = position.getX(vertex);
    const y = position.getY(vertex);
    const z = position.getZ(vertex);
    let slot = (hash(x) ^ Math.imul(hash(y), 31) ^ Math.imul(hash(z), 961)) & (capacity - 1);
    while (table[slot]) {
      const candidate = representative[table[slot] - 1];
      if (
        position.getX(candidate) === x &&
        position.getY(candidate) === y &&
        position.getZ(candidate) === z
      )
        break;
      slot = (slot + 1) & (capacity - 1);
    }
    if (!table[slot]) {
      representative[count] = vertex;
      table[slot] = ++count;
    }
    weldOf[vertex] = table[slot] - 1;
  }
  return { weldOf, representative: representative.slice(0, count) };
}

/** CSR incidence stays compact for indexed scans and for duplicated render vertices at seams. */
function buildFaceIncidence(weldOf: Uint32Array, weldCount: number, corners: ArrayLike<number>) {
  const faceStart = new Uint32Array(weldCount + 1);
  for (let corner = 0; corner < corners.length; corner++) faceStart[weldOf[corners[corner]] + 1]++;
  for (let weld = 0; weld < weldCount; weld++) faceStart[weld + 1] += faceStart[weld];
  const next = faceStart.slice(0, -1);
  const incidentFaces = new Uint32Array(corners.length);
  for (let corner = 0; corner < corners.length; corner++)
    incidentFaces[next[weldOf[corners[corner]]]++] = Math.floor(corner / 3);
  return { faceStart, incidentFaces };
}

/** Link corners through edges, then give each disconnected fan its own render vertex. */
function weldSeams(position: Attribute, corners: Uint32Array) {
  const { weldOf: coordinateOf, representative } = weldVertices(position);
  const { faceStart, incidentFaces } = buildFaceIncidence(
    coordinateOf,
    representative.length,
    corners,
  );
  const parent = Uint32Array.from(corners, (_vertex, corner) => corner);
  function root(corner: number) {
    while (parent[corner] !== corner) {
      parent[corner] = parent[parent[corner]];
      corner = parent[corner];
    }
    return corner;
  }
  const adjacent = new Int32Array(corners.length).fill(-1);
  const valid = new Uint8Array(corners.length / 3);
  const point = new Vector3(),
    left = new Vector3(),
    right = new Vector3();
  function validTriangle(face: number) {
    if (valid[face]) return valid[face] === 1;
    const corner = face * 3;
    point.fromBufferAttribute(position, corners[corner]);
    left.fromBufferAttribute(position, corners[corner + 1]).sub(point);
    right.fromBufferAttribute(position, corners[corner + 2]).sub(point);
    const area = left.cross(right).lengthSq();
    valid[face] = Number.isFinite(area) && area > 0 ? 1 : 2;
    return valid[face] === 1;
  }

  for (let corner = 0; corner < corners.length; corner++) {
    const face = Math.floor(corner / 3);
    const end = face * 3 + ((corner + 1) % 3);
    const u = corners[corner];
    const v = corners[end];
    if (u === v) {
      parent[root(end)] = root(corner);
      continue;
    }
    const a = coordinateOf[u],
      b = coordinateOf[v];
    // Looking up the smaller fan avoids walking a high-valence center for every spoke.
    const smaller = faceStart[a + 1] - faceStart[a] <= faceStart[b + 1] - faceStart[b] ? a : b;
    let reverse = -1;
    let matchCount = 0;
    let previous = -1;
    for (let i = faceStart[smaller]; i < faceStart[smaller + 1]; i++) {
      const neighbor = incidentFaces[i];
      if (neighbor === face || neighbor === previous) continue;
      previous = neighbor;
      const start = neighbor * 3;
      let shared = false;
      for (let edge = 0; edge < 3; edge++) {
        const p = start + edge;
        const q = start + ((edge + 1) % 3);
        if (coordinateOf[corners[p]] === b && coordinateOf[corners[q]] === a) {
          shared = true;
          reverse = p;
          if (neighbor > face && corners[q] === u && corners[p] === v) {
            parent[root(q)] = root(corner);
            parent[root(p)] = root(end);
          }
        } else if (coordinateOf[corners[p]] === a && coordinateOf[corners[q]] === b) {
          shared = true;
          if (neighbor > face && corners[p] === u && corners[q] === v) {
            parent[root(p)] = root(corner);
            parent[root(q)] = root(end);
          }
        }
      }
      if (shared) matchCount++;
    }
    const match = Math.floor(reverse / 3);
    if (matchCount === 1 && a !== b && reverse !== -1) adjacent[corner] = reverse;
    else if (matchCount > 1) adjacent[corner] = -2;
    if (
      a !== b &&
      matchCount === 1 &&
      match > face &&
      (corners[reverse] !== v || corners[match * 3 + ((reverse + 1) % 3)] !== u) &&
      validTriangle(face) &&
      validTriangle(match)
    ) {
      parent[root(match * 3 + ((reverse + 1) % 3))] = root(corner);
      parent[root(reverse)] = root(end);
    }
  }

  const weldOf = new Uint32Array(position.count);
  const weldByRoot = new Uint32Array(corners.length);
  const used = new Uint8Array(position.count);
  const fanRepresentative: number[] = [];
  const copies: number[] = [];
  const copyByFan = new Map<number, Map<number, number>>();
  for (let corner = 0; corner < corners.length; corner++) {
    const original = corners[corner];
    const fan = root(corner);
    if (!weldByRoot[fan]) {
      weldByRoot[fan] = fanRepresentative.length + 1;
      fanRepresentative.push(original);
    }
    const weld = weldByRoot[fan] - 1;
    if (!used[original]) {
      used[original] = 1;
      weldOf[original] = weld;
    } else if (weldOf[original] !== weld) {
      let byVertex = copyByFan.get(weld);
      if (!byVertex) copyByFan.set(weld, (byVertex = new Map()));
      let duplicate = byVertex.get(original);
      if (duplicate === undefined) {
        duplicate = position.count + copies.length;
        copies.push(original);
        byVertex.set(original, duplicate);
        if (fanRepresentative[weld] === original) fanRepresentative[weld] = duplicate;
      }
      corners[corner] = duplicate;
    }
  }
  for (let vertex = 0; vertex < weldOf.length; vertex++) {
    if (used[vertex]) continue;
    weldOf[vertex] = fanRepresentative.length;
    fanRepresentative.push(vertex);
  }
  const vertices = copies.length ? resize(weldOf, position.count + copies.length) : weldOf;
  for (const [weld, byVertex] of copyByFan)
    for (const duplicate of byVertex.values()) vertices[duplicate] = weld;
  return {
    weldOf: vertices,
    representative: Uint32Array.from(fanRepresentative),
    adjacent,
    copies,
  };
}

function resize<T extends AttributeArray>(array: T, length: number): T {
  const ArrayType = array.constructor as new (length: number) => T;
  const result = new ArrayType(length);
  result.set(array.subarray(0, length));
  return result;
}

function renderAttribute(source: Attribute) {
  const attribute = source.clone();
  return attribute.setUsage(DynamicDrawUsage);
}

class Footprint {
  readonly normal: Vector3;
  readonly tangent: Vector3;
  readonly cross: Vector3;
  private readonly aspect: number;
  private readonly triangle = new Triangle();
  private readonly offset = new Vector3();

  constructor(
    readonly hit: SculptHit,
    readonly radius: number,
    aspect: number,
  ) {
    this.aspect = MathUtils.clamp(aspect, 0.1, 1);
    this.normal = hit.normal.clone().normalize();
    this.tangent = hit.tangent?.clone() ?? new Vector3();
    this.tangent.addScaledVector(this.normal, -this.tangent.dot(this.normal));
    if (this.tangent.lengthSq() < 1e-8) {
      const axis = Math.abs(this.normal.x) < 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 1, 0);
      this.tangent.crossVectors(axis, this.normal);
    }
    this.tangent.normalize();
    this.cross = new Vector3().crossVectors(this.normal, this.tangent);
  }

  private project(point: Vector3, target: Vector3) {
    const offset = this.offset.subVectors(point, this.hit.point);
    return target.set(
      offset.dot(this.tangent),
      offset.dot(this.cross) / this.aspect,
      offset.dot(this.normal),
    );
  }

  overlaps(a: Vector3, b: Vector3, c: Vector3) {
    const triangle = this.triangle;
    const squared = this.radius ** 2;
    if (
      this.project(a, triangle.a).lengthSq() < squared ||
      this.project(b, triangle.b).lengthSq() < squared ||
      this.project(c, triangle.c).lengthSq() < squared
    )
      return true;
    return triangle.closestPointToPoint(origin, this.offset).lengthSq() < squared;
  }

  distance(point: Vector3) {
    return this.project(point, this.offset).length() / this.radius;
  }
}

const origin = new Vector3();

export class SculptMesh {
  readonly geometry = new BufferGeometry();
  detailLimited = false;

  private readonly world: Matrix4;
  private readonly inverse: Matrix4;
  private readonly orientation: number;
  private readonly source: BufferGeometry;
  private readonly initialVertices: number;
  private readonly initialFaces: number;
  private readonly faceLimit: number;
  private vertexCount: number;
  private faceCount: number;
  private weldCount = 0;
  private weldOf = new Uint32Array(0);
  private representative = new Uint32Array(0);
  private faceStart = new Uint32Array(0);
  private incidentFaces = new Uint32Array(0);
  private adjacent = new Int32Array(0);
  private baseEdits: ReadonlyMap<number, ReadonlySet<number>> = new Map();
  private incidentEdits = new Map<number, Set<number>>();
  private readonly editedFaces = new Set<number>();
  private grabSamples: Map<number, SculptSample> | undefined;
  private changed = false;
  private readonly facePoints = [new Vector3(), new Vector3(), new Vector3()];
  private readonly faceEdges = [new Vector3(), new Vector3()];

  constructor(source: BufferGeometry, matrixWorld: Matrix4, mask?: Float32Array) {
    this.source = source;
    this.world = matrixWorld.clone();
    this.inverse = matrixWorld.clone().invert();
    this.orientation = Math.sign(matrixWorld.determinant());
    this.initialVertices = this.vertexCount = source.getAttribute('position').count;
    this.initialFaces = this.faceCount = Math.floor((source.index?.count ?? this.vertexCount) / 3);
    const localBudget = Math.min(65_536, Math.max(4096, Math.ceil(this.initialFaces * 0.2)));
    this.faceLimit =
      inheritedFaceLimits.get(source) ??
      Math.min(maxRefinedFaceCount, this.initialFaces + localBudget);
    this.geometry.name = source.name;
    this.geometry.userData = { ...source.userData };
    for (const [name, attribute] of Object.entries(source.attributes))
      this.geometry.setAttribute(name, renderAttribute(attribute));
    const indices = new Uint32Array(this.faceCount * 3);
    for (let corner = 0; corner < indices.length; corner++)
      indices[corner] = source.index?.getX(corner) ?? corner;
    this.geometry.setIndex(new BufferAttribute(indices, 1).setUsage(DynamicDrawUsage));
    this.geometry.groups = source.groups.map((group) => ({ ...group }));
    this.geometry.setDrawRange(0, indices.length);
    const weights = new Float32Array(this.vertexCount);
    if (mask) weights.set(mask.subarray(0, this.vertexCount));
    this.geometry.setAttribute(
      maskName,
      new BufferAttribute(weights, 1).setUsage(DynamicDrawUsage),
    );
    this.geometry.boundingBox = source.boundingBox?.clone() ?? null;
    this.geometry.boundingSphere = source.boundingSphere?.clone() ?? null;
    if (!this.geometry.boundingBox) this.geometry.computeBoundingBox();
    if (!this.geometry.boundingSphere) this.geometry.computeBoundingSphere();
  }

  getMask() {
    return (this.geometry.getAttribute(maskName).array as Float32Array).slice(
      0,
      this.changed ? this.vertexCount : this.initialVertices,
    );
  }

  /** Build or reuse incidence before pen-down when the controller has an idle opportunity. */
  prepare() {
    if (this.faceStart.length) return;
    const cached = latestIncidence;
    if (
      cached?.source.deref() === this.source &&
      cached.position === this.source.getAttribute('position') &&
      cached.index === this.source.index
    ) {
      const { weldOf, representative, faceStart, incidentFaces, adjacent, edits } =
        cached.incidence;
      this.weldOf = weldOf;
      this.representative = representative;
      this.weldCount = representative.length;
      this.faceStart = faceStart;
      this.incidentFaces = incidentFaces;
      this.adjacent = adjacent;
      this.baseEdits = edits;
      return;
    }
    this.buildIncidence();
    if (this.vertexCount !== this.initialVertices) return;
    rememberIncidence(this.source, {
      weldOf: this.weldOf,
      representative: this.representative,
      faceStart: this.faceStart,
      incidentFaces: this.incidentFaces,
      adjacent: this.adjacent,
      edits: this.baseEdits,
    });
  }

  /** Unedited faces remain in the source index. Test edited faces at their live positions. */
  raycast(raycaster: Raycaster, mesh: Mesh, hits: Intersection[]) {
    const tree = this.source.boundsTree;
    if (!(tree instanceof MeshBVH) || Array.isArray(mesh.material)) {
      const found: Intersection[] = [];
      Mesh.prototype.raycast.call(mesh, raycaster, found);
      found.sort((a, b) => a.distance - b.distance);
      hits.push(...(raycaster.firstHitOnly ? found.slice(0, 1) : found));
      return;
    }
    const world = mesh.matrixWorld;
    const ray = raycaster.ray.clone().applyMatrix4(this.inverse);
    if (this.geometry.boundingBox && !ray.intersectsBox(this.geometry.boundingBox)) return;
    const worldStep = ray.at(1, new Vector3()).applyMatrix4(world).distanceTo(raycaster.ray.origin);
    const near = raycaster.near / worldStep;
    const far = raycaster.far / worldStep;
    const side = mesh.material.side;
    let sourceHits: Intersection[] = [];
    if (raycaster.firstHitOnly) {
      const first = tree.raycastFirst(ray, side, near, far);
      if (first)
        sourceHits = this.editedFaces.has(first.faceIndex!)
          ? tree.raycast(ray, side, near, far)
          : [first];
    } else sourceHits = tree.raycast(ray, side, near, far);
    const found: Intersection[] = [];
    for (const hit of sourceHits) {
      if (this.editedFaces.has(hit.faceIndex!)) continue;
      hit.point.applyMatrix4(world);
      hit.distance = hit.point.distanceTo(raycaster.ray.origin);
      hit.object = mesh;
      found.push(hit);
    }

    const position = this.attribute('position');
    const a = new Vector3(),
      b = new Vector3(),
      c = new Vector3(),
      point = new Vector3();
    for (const faceIndex of this.editedFaces) {
      const [ia, ib, ic] = this.face(faceIndex);
      a.fromBufferAttribute(position, ia);
      b.fromBufferAttribute(position, ib);
      c.fromBufferAttribute(position, ic);
      const contact =
        side === BackSide
          ? ray.intersectTriangle(c, b, a, true, point)
          : ray.intersectTriangle(a, b, c, side === FrontSide, point);
      if (!contact) continue;
      point.applyMatrix4(world);
      const distance = point.distanceTo(raycaster.ray.origin);
      if (distance < raycaster.near || distance > raycaster.far) continue;
      found.push({
        distance,
        point: point.clone(),
        object: mesh,
        faceIndex,
        face: {
          a: ia,
          b: ib,
          c: ic,
          normal: Triangle.getNormal(a, b, c, new Vector3()),
          materialIndex: 0,
        },
      });
    }
    found.sort((a, b) => a.distance - b.distance);
    hits.push(...(raycaster.firstHitOnly ? found.slice(0, 1) : found));
  }

  invertMask() {
    return this.replaceMask((value) => 1 - value);
  }

  clearMask() {
    return this.replaceMask(() => 0);
  }

  private replaceMask(replace: (value: number) => number) {
    const attribute = this.attribute(maskName);
    let changed = false;
    for (let vertex = 0; vertex < this.vertexCount; vertex++) {
      const value = attribute.getX(vertex);
      const next = Math.fround(replace(value));
      if (value === next) continue;
      attribute.setX(vertex, next);
      changed = true;
    }
    if (changed) {
      attribute.addUpdateRange(0, this.vertexCount);
      attribute.needsUpdate = true;
    }
    return changed;
  }

  private attribute(name: string) {
    return this.geometry.getAttribute(name) as BufferAttribute;
  }

  private face(id: number): Face {
    const index = this.geometry.index!.array;
    const start = id * 3;
    return [index[start], index[start + 1], index[start + 2]];
  }

  private buildIncidence() {
    const faces = (this.geometry.index!.array as Uint32Array).subarray(0, this.faceCount * 3);
    const { weldOf, representative, adjacent, copies } = weldSeams(
      this.attribute('position'),
      faces,
    );
    if (copies.length) {
      this.ensureCapacity(this.vertexCount + copies.length, this.faceCount);
      for (const attribute of Object.values(this.geometry.attributes) as BufferAttribute[]) {
        const { array, itemSize } = attribute;
        for (let copy = 0; copy < copies.length; copy++) {
          const source = copies[copy] * itemSize;
          array.copyWithin((this.vertexCount + copy) * itemSize, source, source + itemSize);
        }
        attribute.needsUpdate = true;
      }
      this.vertexCount += copies.length;
      this.syncCounts();
      this.geometry.index!.needsUpdate = true;
    }
    const capacity = this.attribute('position').array.length / 3;
    this.weldOf = capacity === weldOf.length ? weldOf : resize(weldOf, capacity);
    this.representative =
      capacity === weldOf.length ? representative : resize(representative, capacity);
    this.adjacent = adjacent;
    this.weldCount = representative.length;
    const { faceStart, incidentFaces } = buildFaceIncidence(
      weldOf,
      this.weldCount,
      this.geometry.index!.array.subarray(0, this.faceCount * 3),
    );
    this.faceStart = faceStart;
    this.incidentFaces = incidentFaces;
  }

  private incidence(weld: number): Iterable<number> {
    const edited = this.incidentEdits.get(weld) ?? this.baseEdits.get(weld);
    if (edited) return edited;
    if (weld + 1 >= this.faceStart.length) return [];
    return this.incidentFaces.subarray(this.faceStart[weld], this.faceStart[weld + 1]);
  }

  private editIncidence(id: number, vertices: Face, add: boolean) {
    for (const vertex of vertices) {
      const weld = this.weldOf[vertex];
      let faces = this.incidentEdits.get(weld);
      if (!faces) this.incidentEdits.set(weld, (faces = new Set(this.incidence(weld))));
      if (add) faces.add(id);
      else faces.delete(id);
    }
  }

  private worldAt(vertex: number, target = new Vector3()) {
    return target.fromBufferAttribute(this.attribute('position'), vertex).applyMatrix4(this.world);
  }

  private maskAt(weld: number) {
    const attribute = this.attribute(maskName);
    if (this.vertexCount === this.weldCount) return attribute.getX(this.representative[weld]);
    let protection = 0;
    for (const face of this.incidence(weld)) {
      for (const vertex of this.face(face))
        if (this.weldOf[vertex] === weld) protection = Math.max(protection, attribute.getX(vertex));
    }
    return protection;
  }

  private neighbors(a: number, b: number) {
    const faces: number[] = [];
    const index = this.geometry.index!.array;
    const weldOf = this.weldOf;
    let previous = -1;
    for (const id of this.incidence(a)) {
      if (previous === id) continue;
      previous = id;
      const corner = id * 3;
      if (
        weldOf[index[corner]] === b ||
        weldOf[index[corner + 1]] === b ||
        weldOf[index[corner + 2]] === b
      )
        faces.push(id);
      if (faces.length > 2) break;
    }
    return faces;
  }

  private edgeSlot(vertices: Face, a: number, b: number) {
    return vertices.findIndex((vertex, i) => {
      const u = this.weldOf[vertex];
      const v = this.weldOf[vertices[(i + 1) % 3]];
      return (u === a && v === b) || (u === b && v === a);
    });
  }

  private validFace(vertices: Face) {
    const a = this.worldAt(vertices[0]);
    const ab = this.worldAt(vertices[1]).sub(a);
    const ac = this.worldAt(vertices[2]).sub(a);
    const area = ab.cross(ac).lengthSq();
    return Number.isFinite(area) && area > 0;
  }

  /** An edge with a third incident face, reversed adjacency, or a degenerate face is a boundary. */
  private splittableFaces(a: number, b: number) {
    const faces = this.neighbors(a, b);
    if (!faces.length || faces.length > 2) return [];
    const first = this.face(faces[0]);
    const start = this.edgeSlot(first, a, b);
    if (start === -1 || !this.validFace(first)) return [];
    if (faces.length === 2) {
      const second = this.face(faces[1]);
      const end = this.edgeSlot(second, a, b);
      if (
        end === -1 ||
        this.weldOf[first[start]] === this.weldOf[second[end]] ||
        !this.validFace(second)
      )
        return [];
    }
    return faces;
  }

  private overlaps(id: number, footprint: Footprint) {
    const index = this.geometry.index!.array;
    const start = id * 3;
    const a = this.worldAt(index[start], this.facePoints[0]);
    const b = this.worldAt(index[start + 1], this.facePoints[1]);
    const c = this.worldAt(index[start + 2], this.facePoints[2]);
    const normal = this.faceEdges[0].subVectors(b, a).cross(this.faceEdges[1].subVectors(c, a));
    const facing = normal.dot(footprint.normal) * this.orientation;
    return Number.isFinite(facing) && facing > 0 && footprint.overlaps(a, b, c);
  }

  private patch(footprint: Footprint) {
    const faces = new Set<number>();
    const seed = footprint.hit.face;
    if (seed < 0 || seed >= this.faceCount || !Number.isInteger(seed)) return faces;
    const visited = new Uint8Array(this.faceCount);
    visited[seed] = 1;
    const queue = [seed];
    const index = this.geometry.index!.array;
    const weldOf = this.weldOf;
    const enqueue = (neighbor: number) => {
      if (visited[neighbor]) return;
      visited[neighbor] = 1;
      queue.push(neighbor);
    };
    for (let i = 0; i < queue.length; i++) {
      const face = queue[i];
      if (!this.overlaps(face, footprint)) continue;
      faces.add(face);
      const start = face * 3;
      for (let edge = 0; edge < 3; edge++) {
        const a = weldOf[index[start + edge]];
        const b = weldOf[index[start + ((edge + 1) % 3)]];
        const reverse = this.adjacent[start + edge];
        if (
          reverse === undefined ||
          reverse === -2 ||
          this.incidentEdits.has(a) ||
          this.baseEdits.has(a)
        ) {
          const incidents = this.splittableFaces(a, b);
          if (incidents.length === 2) enqueue(incidents[0] === face ? incidents[1] : incidents[0]);
        } else if (reverse >= 0) {
          const neighbor = Math.floor(reverse / 3);
          const end = neighbor * 3 + ((reverse + 1) % 3);
          if (weldOf[index[reverse]] === b && weldOf[index[end]] === a) enqueue(neighbor);
        }
      }
    }
    return faces;
  }

  private setFace(id: number, vertices: Face) {
    const index = this.geometry.index!;
    index.array.set(vertices, id * 3);
    index.addUpdateRange(id * 3, 3);
  }

  private ensureCapacity(vertices: number, faces: number) {
    const position = this.attribute('position');
    const index = this.geometry.index!;
    if (vertices <= position.array.length / 3 && faces <= index.array.length / 3) return;
    // Three's GPU buffers cannot be resized. Release them only when the reserved capacity grows.
    this.geometry.dispose();
    const vertexCapacity = Math.max(
      vertices,
      Math.ceil((position.array.length / 3) * 1.25),
      this.initialVertices + 512,
    );
    const faceCapacity = Math.max(
      faces,
      Math.ceil((index.array.length / 3) * 1.25),
      this.initialFaces + 512,
    );
    for (const [name, attribute] of Object.entries(this.geometry.attributes)) {
      const old = attribute as BufferAttribute;
      const next = new BufferAttribute(
        resize(old.array, vertexCapacity * old.itemSize),
        old.itemSize,
        old.normalized,
      );
      next.name = old.name;
      this.geometry.setAttribute(name, next.setUsage(DynamicDrawUsage));
    }
    this.geometry.setIndex(
      new BufferAttribute(resize(index.array, faceCapacity * 3), 1).setUsage(DynamicDrawUsage),
    );
    this.weldOf = resize(this.weldOf, vertexCapacity);
    this.representative = resize(this.representative, vertexCapacity);
  }

  private syncCounts() {
    for (const attribute of Object.values(this.geometry.attributes))
      Object.assign(attribute, { count: this.vertexCount });
    const index = this.geometry.index!;
    Object.assign(index, { count: this.faceCount * 3 });
    this.geometry.setDrawRange(0, this.faceCount * 3);
  }

  private splitEdge(a: number, b: number, faces: number[]) {
    const edit: Split = { vertexCount: this.vertexCount, weld: this.weldCount, faces: [] };
    this.ensureCapacity(this.vertexCount + faces.length, this.faceCount + faces.length);
    const weld = this.weldCount++;
    const edges: { a: number; b: number; vertex: number }[] = [];
    const protection = (this.maskAt(a) + this.maskAt(b)) * 0.5;
    for (const id of faces) {
      const previous = this.face(id);
      const start = this.edgeSlot(previous, a, b);
      const u = previous[start];
      const v = previous[(start + 1) % 3];
      const w = previous[(start + 2) % 3];
      const repeated = edges.find((edge) => edge.a === v && edge.b === u);
      const midpoint = repeated?.vertex ?? this.vertexCount++;
      if (!repeated) {
        for (const attr of Object.values(this.geometry.attributes) as BufferAttribute[]) {
          for (let axis = 0; axis < attr.itemSize; axis++)
            attr.setComponent(
              midpoint,
              axis,
              (attr.getComponent(u, axis) + attr.getComponent(v, axis)) * 0.5,
            );
          attr.addUpdateRange(midpoint * attr.itemSize, attr.itemSize);
        }
        const normals = this.geometry.getAttribute('normal');
        if (normals) {
          const normal = new Vector3().fromBufferAttribute(normals, midpoint).normalize();
          normals.setXYZ(midpoint, normal.x, normal.y, normal.z);
        }
        this.attribute(maskName).setX(midpoint, protection);
        this.weldOf[midpoint] = weld;
        this.representative[weld] = midpoint;
        edges.push({ a: u, b: v, vertex: midpoint });
      }
      const left: Face = [u, midpoint, w];
      const right: Face = [midpoint, v, w];
      this.editIncidence(id, previous, false);
      const child = this.faceCount++;
      this.setFace(id, left);
      this.setFace(child, right);
      this.editIncidence(id, left, true);
      this.editIncidence(child, right, true);
      this.appendGroups(id, child);
      edit.faces.push({ id, previous, child });
    }
    return edit;
  }

  private appendGroups(id: number, child: number) {
    const groups = this.geometry.groups;
    const matching = groups.filter(({ start, count }) => id * 3 >= start && id * 3 < start + count);
    for (const group of matching) this.geometry.addGroup(child * 3, 3, group.materialIndex);
  }

  private rollback(splits: Split[], groupCount: number) {
    for (let i = splits.length - 1; i >= 0; i--) {
      const { vertexCount, weld, faces } = splits[i];
      for (const { id, previous, child } of faces) {
        this.editIncidence(id, this.face(id), false);
        this.editIncidence(child, this.face(child), false);
        this.setFace(id, previous);
        this.editIncidence(id, previous, true);
      }
      this.incidentEdits.delete(weld);
      this.vertexCount = vertexCount;
      this.weldCount = weld;
      this.faceCount -= faces.length;
    }
    this.geometry.groups.length = groupCount;
    this.syncCounts();
  }

  private refine(settings: SculptDab, brushes: { footprint: Footprint; faces: Set<number> }[]) {
    const splits: Split[] = [];
    const target = Math.max(
      settings.minEdge * 2,
      settings.radius * MathUtils.lerp(0.95, 0.22, settings.detail),
    );
    const minEdgeSquared = (settings.minEdge ?? 0) ** 2;
    const queue =
      brushes.length === 1
        ? [...brushes[0].faces]
        : [...new Set(brushes.flatMap(({ faces }) => [...faces]))];
    const edited = new Set<number>();
    const points = [new Vector3(), new Vector3(), new Vector3()];
    const targetSquared = target ** 2;
    for (let i = 0; i < queue.length; i++) {
      const id = queue[i];
      if (
        edited.has(id) &&
        !brushes.some(({ faces, footprint }) => faces.has(id) && this.overlaps(id, footprint))
      )
        continue;
      const vertices = this.face(id);
      for (let corner = 0; corner < 3; corner++) this.worldAt(vertices[corner], points[corner]);
      if (
        points[0].distanceToSquared(points[1]) <= targetSquared &&
        points[1].distanceToSquared(points[2]) <= targetSquared &&
        points[2].distanceToSquared(points[0]) <= targetSquared
      )
        continue;
      if (
        settings.brush !== 'mask' &&
        vertices.every((vertex) => this.maskAt(this.weldOf[vertex]) === 1)
      )
        continue;
      let longest = targetSquared;
      let choice: { a: number; b: number; faces: number[] } | undefined;
      for (let edge = 0; edge < 3; edge++) {
        const next = (edge + 1) % 3;
        const length = points[edge].distanceToSquared(points[next]);
        if (length <= longest) continue;
        const a = this.weldOf[vertices[edge]];
        const b = this.weldOf[vertices[next]];
        const faces = this.splittableFaces(a, b);
        if (!faces.length) continue;
        const middle = points[edge].clone().lerp(points[next], 0.5);
        if (
          faces.some((incident) =>
            this.face(incident).some((vertex) => {
              const weld = this.weldOf[vertex];
              return (
                weld !== a &&
                weld !== b &&
                this.worldAt(vertex).distanceToSquared(middle) < minEdgeSquared
              );
            }),
          )
        )
          continue;
        longest = length;
        choice = { a, b, faces };
      }
      if (!choice) continue;
      if (this.faceCount + choice.faces.length > this.faceLimit) {
        this.detailLimited = true;
        break;
      }
      if (splits.length >= maxSplitsPerDab) break;
      const split = this.splitEdge(choice.a, choice.b, choice.faces);
      splits.push(split);
      for (const { id: parent, child } of split.faces) {
        for (const { faces } of brushes) if (faces.has(parent)) faces.add(child);
        edited.add(parent);
        edited.add(child);
        queue.push(parent, child);
      }
    }
    for (const { faces, footprint } of brushes)
      for (const id of edited) if (faces.has(id) && !this.overlaps(id, footprint)) faces.delete(id);
    return splits;
  }

  private weight(footprint: Footprint, point: Vector3, settings: SculptDab) {
    const distance = footprint.distance(point);
    if (!(distance < 1)) return 0;
    const weight = 1 - distance;
    switch (settings.falloff) {
      case 'linear':
        return weight;
      case 'hard':
        return 1;
      case 'soft':
        return weight * weight * (3 - 2 * weight);
    }
  }

  private neighborsOf(weld: number, footprint: Footprint) {
    const neighbors = new Set<number>();
    for (const id of this.incidence(weld)) {
      const face = this.face(id);
      const a = this.worldAt(face[0]);
      const b = this.worldAt(face[1]).sub(a);
      const c = this.worldAt(face[2]).sub(a);
      if (!(b.cross(c).dot(footprint.normal) * this.orientation > 0)) continue;
      for (const vertex of face) {
        const neighbor = this.weldOf[vertex];
        if (neighbor !== weld && this.splittableFaces(weld, neighbor).length)
          neighbors.add(neighbor);
      }
    }
    return neighbors;
  }

  private surfaceNormal(weld: number) {
    const normal = new Vector3();
    const seen = new Set<number>();
    for (const id of this.incidence(weld)) {
      if (seen.has(id)) continue;
      seen.add(id);
      const face = this.face(id);
      const a = this.worldAt(face[0]);
      const b = this.worldAt(face[1]).sub(a);
      const c = this.worldAt(face[2]).sub(a);
      normal.add(b.cross(c));
    }
    return normal.multiplyScalar(this.orientation).normalize();
  }

  private displacement(
    weld: number,
    point: Vector3,
    footprint: Footprint,
    settings: SculptDab,
    strength: number,
    mirrored: boolean,
  ) {
    const { hit, normal } = footprint;
    const sign = settings.inverted ? -1 : 1;
    const height = new Vector3().subVectors(point, hit.point).dot(normal);
    const depth = settings.radius * strength;
    switch (settings.brush) {
      case 'draw':
        return normal.clone().multiplyScalar(sign * depth * 0.2);
      case 'inflate':
        return this.surfaceNormal(weld).multiplyScalar(sign * depth * 0.2);
      case 'grab':
        return (
          (mirrored ? settings.mirror?.grab : settings.grab)?.clone().multiplyScalar(strength) ??
          new Vector3()
        );
      case 'flatten':
        return normal.clone().multiplyScalar(-height * strength);
      case 'clay': {
        const layer = Math.max(0, settings.radius * 0.16 - sign * height);
        return normal
          .clone()
          .multiplyScalar(sign * Math.min(layer, settings.radius * 0.22) * strength);
      }
      case 'crease': {
        const toward = new Vector3().subVectors(hit.point, point);
        toward.addScaledVector(normal, -toward.dot(normal));
        if (hit.tangent) toward.addScaledVector(footprint.tangent, -toward.dot(footprint.tangent));
        return toward
          .multiplyScalar(MathUtils.clamp(settings.pinch ?? 0.5, 0, 1) * strength * 0.4)
          .addScaledVector(normal, -sign * depth * 0.22);
      }
      case 'smooth': {
        const neighbors = this.neighborsOf(weld, footprint);
        if (neighbors.size < 2) return new Vector3();
        const center = new Vector3();
        for (const neighbor of neighbors) center.add(this.worldAt(this.representative[neighbor]));
        center.divideScalar(neighbors.size).sub(point);
        const surface = this.surfaceNormal(weld);
        return surface.multiplyScalar(center.dot(surface) * strength * 0.65);
      }
      case 'mask':
        return new Vector3();
    }
  }

  private renderVertices(weld: number) {
    if (this.vertexCount === this.weldCount) return [this.representative[weld]];
    const vertices = new Set<number>();
    for (const id of this.incidence(weld))
      for (const vertex of this.face(id)) if (this.weldOf[vertex] === weld) vertices.add(vertex);
    return vertices;
  }

  private localFaceCross(id: number, cross = new Vector3()) {
    const index = this.geometry.index!.array;
    const start = id * 3;
    const position = this.attribute('position');
    const a = this.facePoints[0].fromBufferAttribute(position, index[start]);
    cross
      .fromBufferAttribute(position, index[start + 1])
      .sub(a)
      .cross(this.facePoints[1].fromBufferAttribute(position, index[start + 2]).sub(a));
    return Number.isFinite(cross.lengthSq()) ? cross : cross.set(0, 0, 0);
  }

  private applyMoves(moves: Map<number, Vector3>) {
    const position = this.attribute('position');
    const bounds = this.geometry.boundingBox;
    const sphere = this.geometry.boundingSphere;
    let first = this.vertexCount;
    let last = -1;
    const batch = moves.size > 4096;
    for (const [weld, local] of moves) {
      for (const vertex of this.renderVertices(weld)) {
        position.setXYZ(vertex, local.x, local.y, local.z);
        if (batch) {
          first = Math.min(first, vertex);
          last = Math.max(last, vertex);
        } else position.addUpdateRange(vertex * 3, 3);
      }
      bounds?.expandByPoint(local);
      if (sphere) sphere.radius = Math.max(sphere.radius, local.distanceTo(sphere.center));
    }
    if (batch) position.addUpdateRange(first * 3, (last - first + 1) * 3);
    position.needsUpdate = true;
  }

  /** Accumulate area-weighted render normals in flat buffers for widely affected surfaces. */
  private deformDense(
    moves: Map<number, Vector3>,
    changedFaces: Set<number>,
    output: BufferAttribute,
  ) {
    const index = this.geometry.index!.array;
    const affected = new Uint8Array(this.vertexCount);
    let first = this.vertexCount;
    let last = -1;
    for (const face of changedFaces) {
      for (let corner = face * 3; corner < face * 3 + 3; corner++) {
        const vertex = index[corner];
        affected[vertex] = 1;
        first = Math.min(first, vertex);
        last = Math.max(last, vertex);
      }
    }
    const size = (last - first + 1) * 3;
    const faceCross = new Vector3();
    const accumulate = () => {
      const sums = new Float64Array(size);
      for (let face = 0; face < this.faceCount; face++) {
        const corner = face * 3;
        const a = index[corner];
        const b = index[corner + 1];
        const c = index[corner + 2];
        if (!(affected[a] || affected[b] || affected[c])) continue;
        this.localFaceCross(face, faceCross);
        // Repeated corners form a zero-area face and contribute nothing.
        for (let offset = 0; offset < 3; offset++) {
          const vertex = index[corner + offset];
          if (!affected[vertex]) continue;
          const component = (vertex - first) * 3;
          sums[component] += faceCross.x;
          sums[component + 1] += faceCross.y;
          sums[component + 2] += faceCross.z;
        }
      }
      return sums;
    };
    const before = accumulate();
    this.applyMoves(moves);
    const after = accumulate();
    const previous = new Vector3();
    const current = new Vector3();
    const normal = new Vector3();
    const rotate = new Quaternion();
    for (let vertex = first; vertex <= last; vertex++) {
      if (!affected[vertex]) continue;
      const component = (vertex - first) * 3;
      previous.fromArray(before, component);
      current.fromArray(after, component);
      if (!previous.lengthSq() || !current.lengthSq()) continue;
      rotate.setFromUnitVectors(previous.normalize(), current.normalize());
      normal.fromBufferAttribute(output, vertex).applyQuaternion(rotate).normalize();
      output.setXYZ(vertex, normal.x, normal.y, normal.z);
    }
    output.addUpdateRange(first * 3, size);
    output.needsUpdate = true;
  }

  private deform(moves: Map<number, Vector3>) {
    const outputNormals = this.geometry.getAttribute('normal') as BufferAttribute | undefined;
    const changedFaces = new Set<number>();
    for (const weld of moves.keys())
      for (const face of this.incidence(weld)) changedFaces.add(face);
    for (const face of changedFaces) this.editedFaces.add(face);
    if (outputNormals && changedFaces.size > Math.max(4096, this.faceCount / 8)) {
      this.deformDense(moves, changedFaces, outputNormals);
      return;
    }
    const normals = new Map<number, Vector3>();
    const renderFaces = new Map<number, Set<number>>();
    const faceBefore = new Map<number, Vector3>();
    if (outputNormals) {
      for (const face of changedFaces) {
        for (const vertex of this.face(face)) {
          if (renderFaces.has(vertex)) continue;
          const fan = new Set<number>();
          for (const incident of this.incidence(this.weldOf[vertex])) {
            if (!this.face(incident).includes(vertex)) continue;
            fan.add(incident);
            if (!faceBefore.has(incident)) faceBefore.set(incident, this.localFaceCross(incident));
          }
          renderFaces.set(vertex, fan);
          const normal = new Vector3();
          for (const incident of fan) normal.add(faceBefore.get(incident)!);
          normals.set(vertex, normal.normalize());
        }
      }
    }
    this.applyMoves(moves);
    if (outputNormals) {
      const after = new Map<number, Vector3>();
      const rotate = new Quaternion();
      const normal = new Vector3();
      for (const [vertex, fan] of renderFaces) {
        const current = new Vector3();
        for (const face of fan) {
          if (!after.has(face)) after.set(face, this.localFaceCross(face));
          current.add(after.get(face)!);
        }
        const previous = normals.get(vertex)!;
        if (!previous.lengthSq() || !current.lengthSq()) continue;
        rotate.setFromUnitVectors(previous, current.normalize());
        normal.fromBufferAttribute(outputNormals, vertex).applyQuaternion(rotate).normalize();
        outputNormals.setXYZ(vertex, normal.x, normal.y, normal.z);
        outputNormals.addUpdateRange(vertex * 3, 3);
      }
      outputNormals.needsUpdate = true;
    }
  }

  dab(settings: SculptDab) {
    if (!(settings.radius > 0 && settings.strength > 0) || !this.orientation) return false;
    if (settings.brush !== 'grab') this.grabSamples = undefined;
    else if (!settings.grab?.lengthSq() && !settings.mirror?.grab?.lengthSq()) return false;
    this.prepare();
    const groupCount = this.geometry.groups.length;
    let samples = this.grabSamples;
    let splits: Split[] = [];
    if (!samples) {
      const hits: SculptHit[] = [settings];
      if (settings.mirror) hits.push(settings.mirror);
      const brushes = hits.map((hit, index) => {
        const footprint = new Footprint(hit, settings.radius, settings.aspect ?? 1);
        return { footprint, faces: this.patch(footprint), mirrored: index === 1 };
      });
      splits = this.refine(settings, brushes);
      samples = new Map();
      const visited = new Uint8Array(this.weldCount);
      const index = this.geometry.index!.array;
      const point = new Vector3();
      for (const { footprint, faces, mirrored } of brushes) {
        const pass = mirrored ? 2 : 1;
        for (const face of faces) {
          for (let i = face * 3; i < face * 3 + 3; i++) {
            const vertex = index[i];
            const weld = this.weldOf[vertex];
            if (visited[weld] === pass) continue;
            visited[weld] = pass;
            const weight = this.weight(footprint, this.worldAt(vertex, point), settings);
            if (weight > (samples.get(weld)?.weight ?? 0))
              samples.set(weld, { footprint, weight, mirrored });
          }
        }
      }
    }
    const moves = new Map<number, Vector3>();
    const masks = new Map<number, number>();
    for (const [weld, { footprint, weight, mirrored }] of samples) {
      const protection = this.maskAt(weld);
      const strength = Math.min(1, settings.strength) * weight;
      if (settings.brush === 'mask') {
        let next = protection + (settings.inverted ? -strength : strength);
        if (settings.softenMask) {
          const neighbors = this.neighborsOf(weld, footprint);
          if (!neighbors.size) continue;
          let mean = 0;
          for (const neighbor of neighbors) mean += this.maskAt(neighbor);
          next = MathUtils.lerp(protection, mean / neighbors.size, strength);
        }
        next = Math.fround(MathUtils.clamp(next, 0, 1));
        if (next !== protection) masks.set(weld, next);
      } else if (protection < 1) {
        const vertex = this.representative[weld];
        const point = this.worldAt(vertex);
        const displacement = this.displacement(
          weld,
          point,
          footprint,
          settings,
          strength * (1 - protection),
          mirrored,
        );
        if (!(displacement.lengthSq() > 1e-24)) continue;
        const local = point.add(displacement).applyMatrix4(this.inverse);
        const before = new Vector3().fromBufferAttribute(this.attribute('position'), vertex);
        if (![local.x, local.y, local.z].every(Number.isFinite)) continue;
        if (this.attribute('position').array instanceof Float32Array)
          local.set(Math.fround(local.x), Math.fround(local.y), Math.fround(local.z));
        if (!local.equals(before)) moves.set(weld, local);
      }
    }
    if (!moves.size && !masks.size) {
      if (splits.length) this.rollback(splits, groupCount);
      return false;
    }
    if (settings.brush === 'grab') this.grabSamples = samples;
    if (splits.length) {
      this.syncCounts();
      for (const attribute of Object.values(this.geometry.attributes) as BufferAttribute[])
        attribute.needsUpdate = true;
      this.geometry.index!.needsUpdate = true;
      for (const split of splits)
        for (const { id, child } of split.faces) {
          this.editedFaces.add(id);
          this.editedFaces.add(child);
        }
    }
    if (moves.size) this.deform(moves);
    if (masks.size) {
      const mask = this.attribute(maskName);
      const batch = masks.size > 4096;
      let first = this.vertexCount;
      let last = -1;
      for (const [weld, value] of masks) {
        for (const vertex of this.renderVertices(weld)) {
          mask.setX(vertex, value);
          if (batch) {
            first = Math.min(first, vertex);
            last = Math.max(last, vertex);
          } else mask.addUpdateRange(vertex, 1);
        }
      }
      if (batch) mask.addUpdateRange(first, last - first + 1);
      mask.needsUpdate = true;
    }
    this.changed ||= moves.size > 0 || this.vertexCount !== this.initialVertices;
    return true;
  }

  private refitPicking(geometry: BufferGeometry) {
    const sourceTree = this.source.boundsTree;
    if (
      !(sourceTree instanceof MeshBVH) ||
      this.faceCount !== this.initialFaces ||
      !this.editedFaces.size
    )
      return;
    const dirtyBounds = new Box3();
    const sourcePosition = this.source.getAttribute('position');
    const point = new Vector3();
    for (const face of this.editedFaces) {
      for (let offset = 0; offset < 3; offset++) {
        const corner = face * 3 + offset;
        const vertex = this.source.index?.getX(corner) ?? corner;
        dirtyBounds.expandByPoint(point.fromBufferAttribute(sourcePosition, vertex));
      }
    }
    const nodes = new Set<number>();
    sourceTree.shapecast({
      intersectsBounds: (bounds, _leaf, _score, _depth, node) => {
        if (!bounds.intersectsBox(dirtyBounds)) return false;
        nodes.add(node);
        return true;
      },
    });
    const data = MeshBVH.serialize(sourceTree, { cloneBuffers: false });
    const roots = data.roots.map((root) => root.slice(0));
    const tree = MeshBVH.deserialize({ ...data, roots }, geometry, { setIndex: false });
    tree.refit(nodes);
    geometry.boundsTree = tree;
  }

  finish() {
    if (!this.changed) return null;
    const geometry = new BufferGeometry();
    geometry.name = this.geometry.name;
    geometry.userData = { ...this.geometry.userData };
    for (const [name, attribute] of Object.entries(this.geometry.attributes)) {
      if (name === maskName) continue;
      const { array, itemSize, normalized } = attribute;
      geometry.setAttribute(
        name,
        new BufferAttribute(array.slice(0, this.vertexCount * itemSize), itemSize, normalized),
      );
    }
    if (this.source.index || this.faceCount !== this.initialFaces) {
      const index = this.geometry.index!.array.slice(0, this.faceCount * 3) as Uint32Array;
      geometry.setIndex(
        new BufferAttribute(this.vertexCount <= 65_536 ? Uint16Array.from(index) : index, 1),
      );
    }
    geometry.groups = this.geometry.groups.map((group) => ({ ...group }));
    geometry.computeBoundingBox();
    if (geometry.boundingBox && this.geometry.boundingSphere) {
      const bounds = this.geometry.boundingSphere;
      geometry.boundingSphere = new Sphere(bounds.center.clone(), bounds.radius);
    }
    this.refitPicking(geometry);
    inheritedFaceLimits.set(geometry, this.faceLimit);
    if (this.faceStart.length)
      rememberIncidence(geometry, {
        weldOf:
          this.weldOf.length === this.vertexCount
            ? this.weldOf
            : this.weldOf.slice(0, this.vertexCount),
        representative:
          this.representative.length === this.weldCount
            ? this.representative
            : this.representative.slice(0, this.weldCount),
        faceStart: this.faceStart,
        incidentFaces: this.incidentFaces,
        adjacent: this.adjacent,
        edits: new Map([
          ...this.baseEdits,
          ...Array.from(this.incidentEdits, ([vertex, faces]) => [vertex, new Set(faces)] as const),
        ]),
      });
    return geometry;
  }
}
