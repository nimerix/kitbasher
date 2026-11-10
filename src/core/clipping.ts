import { Box3, BufferGeometry, DoubleSide, Line3, Matrix3, Matrix4, Quaternion, Ray } from 'three';
import { Triangle, Vector3 } from 'three';
import { Matrix, solve } from 'ml-matrix';
import { MeshBVH } from 'three-mesh-bvh';
import { isJointConnected } from './constraints';
import { partMatrix, quat, triangleCount, vec } from './geometry';
import { readFace } from './surfaces';
import type { ClipSettings, Joint, Part } from './types';

export const clipLimits = { min: 0, max: 5, step: 0.01 } as const;
export const defaultClipSettings: ClipSettings = { enabled: true, overlap: 0.1 };

const storageKey = 'kitbasher.avoid-clipping';

export function sanitizeClipSettings(value: unknown, fallback = defaultClipSettings): ClipSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const overlap = source.overlap;
  return {
    enabled: typeof source.enabled === 'boolean' ? source.enabled : fallback.enabled,
    overlap:
      typeof overlap === 'number' && Number.isFinite(overlap)
        ? Math.max(clipLimits.min, Math.min(clipLimits.max, overlap))
        : fallback.overlap,
  };
}

/** On in the app, and off outside a browser, where agents often embed parts on purpose. */
export function readClipSettings(): ClipSettings {
  if (typeof window === 'undefined') return { ...defaultClipSettings, enabled: false };
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? sanitizeClipSettings(JSON.parse(saved)) : defaultClipSettings;
  } catch {
    return defaultClipSettings;
  }
}

export function saveClipSettings(settings: ClipSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The setting still applies for this session when browser storage is unavailable.
  }
}

export interface ClipReport {
  /** Deepest remaining overlap between a moved part and any other part, in mm. */
  depth: number;
  /** How far the placement ended from the requested one, in mm. */
  moved: number;
  /** Ids of the parts that limited the placement. */
  blockers: string[];
  /** Overlap beyond the allowance remains, usually held by a joint, constraint, or tight fit. */
  unresolved: boolean;
}

export type ClipMode =
  /** Follow a continuous gesture from the current placement, sliding along other parts. */
  | 'drag'
  /** Find the nearest clear placement to the request, keeping overlap that already existed. */
  | 'adjust'
  /** Find the nearest clear placement to the request. */
  | 'fit';

// Building takes about 0.2 s per million triangles. Denser meshes are indexed in a worker.
const syncTriangles = 1_000_000;
const probeTarget = 3000;
const sampledTriangles = 400_000;
const detailedTriangles = 6000;

function treeOf(geometry: BufferGeometry) {
  if (geometry.boundsTree) return geometry.boundsTree as MeshBVH;
  const triangles = triangleCount(geometry);
  if (triangles < 1 || triangles > syncTriangles) return null;
  geometry.boundsTree = new MeshBVH(geometry, { indirect: true, targetLeafSize: 10 });
  return geometry.boundsTree as MeshBVH;
}

const probes = new WeakMap<BufferGeometry, Float32Array>();

/**
 * Surface points with their normals, spread evenly by area so collision detail does not depend
 * on tessellation. Coarse meshes also get their corners and edges, which are what touches first.
 */
function probesOf(geometry: BufferGeometry) {
  const cached = probes.get(geometry);
  if (cached) return cached;
  const count = triangleCount(geometry);
  const stride = Math.max(1, Math.ceil(count / sampledTriangles));
  const faces = Math.ceil(count / stride);
  const areas = new Float64Array(faces);
  const triangle = new Triangle();
  let area = 0;
  for (let i = 0; i < faces; i++) {
    area += readFace(geometry, i * stride, triangle).getArea() || 0;
    areas[i] = area;
  }
  const values: number[] = [];
  const point = new Vector3(),
    normal = new Vector3();
  if (area > 0) {
    let face = 0;
    for (let i = 0; i < probeTarget; i++) {
      const position = ((i + 0.5) / probeTarget) * area;
      while (areas[face] < position) face++;
      readFace(geometry, face * stride, triangle).getNormal(normal);
      const u = Math.sqrt(((i + 1) * 0.7548776662466927) % 1),
        v = ((i + 1) * 0.5698402909980532) % 1;
      point
        .copy(triangle.a)
        .multiplyScalar(1 - u)
        .addScaledVector(triangle.b, u * (1 - v))
        .addScaledVector(triangle.c, u * v);
      values.push(point.x, point.y, point.z, normal.x, normal.y, normal.z);
    }
    if (count <= detailedTriangles) {
      let length = 0;
      for (let i = 0; i < count; i++) {
        readFace(geometry, i, triangle);
        length +=
          triangle.a.distanceTo(triangle.b) +
          triangle.b.distanceTo(triangle.c) +
          triangle.c.distanceTo(triangle.a);
      }
      const spacing = Math.max(Math.sqrt(area / probeTarget), length / (probeTarget * 2));
      const seen = new Set<string>();
      const cell = spacing / 4;
      for (let i = 0; i < count; i++) {
        readFace(geometry, i, triangle).getNormal(normal);
        if (normal.lengthSq() === 0) continue;
        const corners = [triangle.a, triangle.b, triangle.c];
        for (let edge = 0; edge < 3; edge++) {
          const from = corners[edge],
            to = corners[(edge + 1) % 3];
          const steps = Math.max(1, Math.ceil(from.distanceTo(to) / spacing));
          for (let step = 0; step < steps; step++) {
            point.copy(from).lerp(to, step / steps);
            const key = `${Math.round(point.x / cell)},${Math.round(point.y / cell)},${Math.round(point.z / cell)}`;
            if (seen.has(key)) continue;
            seen.add(key);
            values.push(point.x, point.y, point.z, normal.x, normal.y, normal.z);
          }
        }
      }
    }
  }
  const result = new Float32Array(values);
  probes.set(geometry, result);
  return result;
}

interface Body {
  part: Part;
  tree: MeshBVH;
  matrix: Matrix4;
  inverse: Matrix4;
  normalMatrix: Matrix3;
  box: Box3;
  minScale: number;
  maxScale: number;
}

function bodyOf(part: Part): Body | null {
  if (!part.visible) return null;
  const tree = treeOf(part.geometry);
  if (!tree) return null;
  if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
  const matrix = partMatrix(part);
  return {
    part,
    tree,
    matrix,
    inverse: matrix.clone().invert(),
    normalMatrix: new Matrix3().getNormalMatrix(matrix),
    box: part.geometry.boundingBox!.clone().applyMatrix4(matrix),
    minScale: Math.max(1e-6, Math.min(...part.scale.map(Math.abs))),
    maxScale: Math.max(1e-6, ...part.scale.map(Math.abs)),
  };
}

const bodiesOf = (parts: Part[]) => parts.map(bodyOf).filter((body): body is Body => !!body);

/** One face the contact could rest against, as a plane the moving part must stay in front of. */
interface Plane {
  /** Unit direction that moves the moving part clear of this face. */
  normal: Vector3;
  /** Signed gap to the plane in mm, negative behind it. */
  gap: number;
  /** 1 when this face and the sampled surface face each other squarely. */
  facing: number;
}

interface Contact {
  mover: string;
  obstacle: string;
  /** On the moving part, in world space. */
  point: Vector3;
  /** Signed gap in mm, negative when the parts overlap. */
  distance: number;
  /** The surface sample that found this contact. It stays put when its part does. */
  probe: Vector3;
  planes: Plane[];
  limit: number;
  /** Where the sample met the other part, in that part's own space. */
  onto: Body;
  at: Vector3;
  face: number;
  /** The planes belong to the moving part, so they move with it. */
  moving: boolean;
  widened: boolean;
}

interface Zone {
  mover: string;
  obstacle: string;
  center: Vector3;
  radius: number;
}

const closest = { point: new Vector3(), distance: 0, faceIndex: 0 };
const face = new Triangle();
const faceNormal = new Vector3();
const bary = new Vector3();
const offset = new Vector3();
const nearby = new Vector3();
const edge = new Line3();
const ray = new Ray();
const around: Vector3[] = [];

/**
 * Collects the faces meeting at a surface point into `around`, with their angle-weighted normal,
 * which stays correct on edges and corners. Returns false on the rim of an open mesh.
 */
function facesAround(tree: MeshBVH, at: Vector3, epsilon: number, normal: Vector3) {
  const spokes: Vector3[] = [];
  normal.set(0, 0, 0);
  around.length = 0;
  tree.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(at) <= epsilon,
    intersectsTriangle: (triangle) => {
      triangle.getNormal(faceNormal);
      if (faceNormal.lengthSq() === 0) return false;
      triangle.closestPointToPoint(at, nearby);
      if (nearby.distanceTo(at) > epsilon) return false;
      if (!around.some((other) => other.dot(faceNormal) > 0.9999)) around.push(faceNormal.clone());
      const corners = [triangle.a, triangle.b, triangle.c];
      const corner = corners.findIndex((vertex) => vertex.distanceTo(at) <= epsilon);
      if (corner >= 0) {
        const a = corners[(corner + 1) % 3].clone().sub(corners[corner]).normalize(),
          b = corners[(corner + 2) % 3].clone().sub(corners[corner]).normalize();
        normal.addScaledVector(faceNormal, a.angleTo(b));
        spokes.push(a, b);
        return false;
      }
      for (let i = 0; i < 3; i++) {
        edge.set(corners[i], corners[(i + 1) % 3]);
        edge.closestPointToPoint(at, true, nearby);
        if (nearby.distanceTo(at) > epsilon) continue;
        normal.addScaledVector(faceNormal, Math.PI);
        spokes.push(edge.start.clone().sub(at).normalize(), edge.end.clone().sub(at).normalize());
        return false;
      }
      normal.addScaledVector(faceNormal, Math.PI * 2);
      return false;
    },
  });
  // Around a closed surface, every edge leaving the point is shared by two triangles.
  const matched = spokes.map(() => false);
  for (let i = 0; i < spokes.length; i++) {
    if (matched[i]) continue;
    const other = spokes.findIndex(
      (spoke, j) => j > i && !matched[j] && spoke.dot(spokes[i]) > 0.99995,
    );
    if (other < 0) return false;
    matched[i] = matched[other] = true;
  }
  return normal.lengthSq() > 0;
}

/** Counts surface crossings along a ray, which also holds for parts made of overlapping shells. */
function enclosed(tree: MeshBVH, origin: Vector3, direction: Vector3) {
  ray.origin.copy(origin);
  ray.direction.copy(direction);
  let winding = 0;
  for (const hit of tree.raycast(ray, DoubleSide))
    winding += Math.sign(hit.face!.normal.dot(direction));
  return winding > 0;
}

/**
 * How clear each sample was when last measured, in the other part's own space. A sample cannot
 * come closer than the distance it has moved since, so most of a part is skipped while only the
 * region near a contact is measured again.
 */
interface Memo {
  at: Float32Array;
  gap: Float32Array;
}
const memos = new Map<string, Memo>();
const memoLimit = 96;

function memoFor(from: Body, onto: Body, samples: number) {
  const key = `${from.part.id}\n${onto.part.id}\n${from.part.geometry.uuid}\n${onto.part.geometry.uuid}`;
  let memo = memos.get(key);
  memos.delete(key);
  if (!memo || memo.gap.length !== samples)
    memo = { at: new Float32Array(samples * 3), gap: new Float32Array(samples) };
  memos.set(key, memo);
  if (memos.size > memoLimit) memos.delete(memos.keys().next().value!);
  return memo;
}

const axes = [
  new Vector3(1, 0, 0),
  new Vector3(-1, 0, 0),
  new Vector3(0, 1, 0),
  new Vector3(0, -1, 0),
  new Vector3(0, 0, 1),
  new Vector3(0, 0, -1),
];

interface Exit {
  point: Vector3;
  normal: Vector3;
  face: number;
}

/**
 * For a point deep inside a mesh, the ways out along its own surface normal and the six axes,
 * nearest first. Finding the true nearest surface from that deep costs far more on a dense scan.
 * Returns nothing for a point that is outside, which never sees the inside of a face first.
 */
function exitsFrom(tree: MeshBVH, origin: Vector3, behind: Vector3) {
  const exits: (Exit & { distance: number })[] = [];
  ray.origin.copy(origin);
  for (let i = 0; i < 7; i++) {
    ray.direction.copy(i ? axes[i - 1] : behind);
    const hit = tree.raycastFirst(ray, DoubleSide);
    if (hit && hit.face!.normal.dot(ray.direction) > 0)
      exits.push({
        point: hit.point.clone(),
        normal: hit.face!.normal.clone(),
        face: hit.faceIndex!,
        distance: hit.distance,
      });
    else if (i < 2) return null;
  }
  const first = exits[0];
  exits.sort((a, b) => a.distance - b.distance);
  return { nearest: exits[0], behind: first };
}

const local = new Vector3();
const world = new Vector3();
const surface = new Vector3();
const own = new Vector3();
const pseudo = new Vector3();
const inward = new Vector3();
const back = new Vector3();

/**
 * Measures each surface sample of one part against the surface of another. A sample at an edge
 * or inside the other part can rest against several faces, and all of them are reported: which
 * one holds depends on where the sample is heading.
 */
function probe(
  from: Body,
  onto: Body,
  band: number,
  coarse: boolean,
  visit: (
    sample: Vector3,
    surface: Vector3,
    distance: number,
    planes: Plane[],
    at: Vector3,
    face: number,
  ) => void,
) {
  const points = probesOf(from.part.geometry);
  const geometry = onto.part.geometry;
  // Each search of a dense scan is slow, so a gesture samples it more sparsely until it settles.
  const triangles = triangleCount(geometry);
  const stride = 6 * (!coarse || triangles < 40_000 ? 1 : triangles < 200_000 ? 2 : 3);
  const box = geometry.boundingBox!;
  const reach = band / onto.minScale;
  const wide = box.clone().expandByScalar(reach);
  const toLocal = onto.inverse.clone().multiply(from.matrix);
  const epsilon = Math.max(1e-9, box.getSize(offset).length() * 1e-7);
  const memo = memoFor(from, onto, points.length / 6);
  for (let i = 0; i < points.length; i += stride) {
    const k = i / 6;
    local.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(toLocal);
    // A sample stays outside for as long as it has moved less than its last known clearance.
    const known = memo.gap[k];
    const outside =
      known > 0 &&
      Math.hypot(
        local.x - memo.at[k * 3],
        local.y - memo.at[k * 3 + 1],
        local.z - memo.at[k * 3 + 2],
      ) < known;
    local.toArray(memo.at, k * 3);
    if (!wide.containsPoint(local)) {
      memo.gap[k] = Math.max(reach, box.distanceToPoint(local));
      continue;
    }
    // Searching a dense mesh costs more the farther the surface is, so look only as far as needed.
    // The search prunes by distance but can still return a farther triangle from a near box.
    const found = onto.tree.closestPointToPoint(local, closest, 0, reach);
    const hit = found && found.distance <= reach ? found : null;
    world.set(points[i], points[i + 1], points[i + 2]).applyMatrix4(from.matrix);
    own
      .set(points[i + 3], points[i + 4], points[i + 5])
      .applyMatrix3(from.normalMatrix)
      .normalize();
    back
      .set(points[i + 3], points[i + 4], points[i + 5])
      .transformDirection(toLocal)
      .negate();
    if (!hit) {
      memo.gap[k] = reach;
      if (outside || !box.containsPoint(local)) continue;
      const exits = exitsFrom(onto.tree, local, back);
      if (!exits) continue;
      // Deep inside. Leave by the nearest way out, or by the way this surface came in.
      memo.gap[k] = 0;
      const planes: Plane[] = [];
      for (const exit of [exits.nearest, exits.behind]) {
        const normal = exit.normal.clone().applyMatrix3(onto.normalMatrix).normalize();
        const gap = offset.copy(exit.point).applyMatrix4(onto.matrix).sub(world).dot(normal);
        if (gap > 0 && !planes.some((plane) => plane.normal.dot(normal) > 0.9999))
          planes.push({ normal, gap: -gap, facing: -normal.dot(own) });
      }
      if (!planes.length) continue;
      surface.copy(exits.nearest.point).applyMatrix4(onto.matrix);
      visit(world, surface, planes[0].gap, planes, exits.nearest.point, exits.nearest.face);
      continue;
    }
    memo.gap[k] = 0;
    surface.copy(hit.point).applyMatrix4(onto.matrix);
    const distance = world.distanceTo(surface);
    readFace(geometry, hit.faceIndex, face).getNormal(faceNormal);
    offset.copy(local).sub(hit.point);
    let side = offset.dot(faceNormal);
    face.getBarycoord(hit.point, bary);
    around.length = 0;
    if (faceNormal.lengthSq() === 0 || Math.min(bary.x, bary.y, bary.z) < 1e-5) {
      if (!facesAround(onto.tree, hit.point, epsilon, pseudo)) continue;
      side = offset.dot(pseudo);
    } else around.push(faceNormal.clone());
    let inside = side < 0;
    if (inside && !enclosed(onto.tree, local, inward.copy(offset).normalize())) {
      // Behind an open sheet. A surface that came through from the front still faces forward;
      // anything else is resting against the back, which blocks it like the front does.
      if (pseudo.copy(around[0]).applyMatrix3(onto.normalMatrix).normalize().dot(own) > -0.3) {
        inside = false;
        for (const normal of around) normal.negate();
      }
    }
    if (!inside) memo.gap[k] = hit.distance;
    const planes: Plane[] = around.map((normal) => {
      normal.applyMatrix3(onto.normalMatrix).normalize();
      return { normal, gap: offset.copy(world).sub(surface).dot(normal), facing: -normal.dot(own) };
    });
    if (inside) {
      // The face straight behind the sample is where its own surface came in, which is the way
      // back out even when a nearer face lies off to the side.
      ray.origin.copy(local);
      ray.direction.copy(back);
      const behind = onto.tree.raycastFirst(ray, DoubleSide);
      if (behind && behind.face!.normal.dot(back) > 0) {
        const normal = behind.face!.normal.clone().applyMatrix3(onto.normalMatrix).normalize();
        const gap = offset.copy(world).sub(behind.point.applyMatrix4(onto.matrix)).dot(normal);
        if (gap < 0 && !planes.some((plane) => plane.normal.dot(normal) > 0.9999))
          planes.push({ normal, gap, facing: -normal.dot(own) });
      }
    }
    visit(world, surface, inside ? -distance : distance, planes, hit.point, hit.faceIndex);
  }
}

const signature = (body: Body) =>
  `${body.part.id}:${body.part.geometry.uuid}:${body.matrix.elements.join(',')}`;
let recent: { key: string; contacts: Contact[] } | null = null;

/**
 * Every place the moving parts come within `band` of the others. A gesture ends each step by
 * measuring where it stopped, which is where the next step starts, so that result is kept.
 */
function collide(movers: Body[], obstacles: Body[], band: number, coarse = false) {
  const key = [band, coarse, ...movers.map(signature), '', ...obstacles.map(signature)].join('\n');
  if (recent?.key === key) return recent.contacts;
  const contacts: Contact[] = [];
  for (const mover of movers)
    for (const obstacle of obstacles) {
      if (!mover.box.clone().expandByScalar(band).intersectsBox(obstacle.box)) continue;
      const add = (
        moving: boolean,
        sample: Vector3,
        point: Vector3,
        distance: number,
        planes: Plane[],
        at: Vector3,
        face: number,
      ) => {
        if (moving) for (const plane of planes) plane.normal.negate();
        contacts.push({
          mover: mover.part.id,
          obstacle: obstacle.part.id,
          point: point.clone(),
          distance,
          probe: sample.clone(),
          planes,
          limit: 0,
          onto: moving ? mover : obstacle,
          at: at.clone(),
          face,
          moving,
          widened: false,
        });
      };
      probe(mover, obstacle, band, coarse, (sample, _, distance, planes, at, face) =>
        add(false, sample, sample, distance, planes, at, face),
      );
      probe(obstacle, mover, band, coarse, (sample, point, distance, planes, at, face) =>
        add(true, sample, point, distance, planes, at, face),
      );
    }
  recent = { key, contacts };
  return contacts;
}

const middle = new Vector3();
const center = new Vector3();

/**
 * Adds the faces just around a contact that bend away from it. Near such an edge a sample that
 * sits within the allowance of one face can still travel freely along the next one.
 */
function widen(contact: Contact, radius: number) {
  if (contact.widened) return false;
  contact.widened = true;
  const { onto, at } = contact;
  const reach = radius / onto.minScale;
  const first = readFace(onto.part.geometry, contact.face, face).getNormal(new Vector3());
  if (first.lengthSq() === 0) return false;
  face.getMidpoint(center);
  const lift = Math.max(1e-9, reach * 1e-4);
  let added = false;
  onto.tree.shapecast({
    intersectsBounds: (box) => box.distanceToPoint(at) <= reach,
    intersectsTriangle: (triangle) => {
      if (contact.planes.length >= 8) return true;
      triangle.getNormal(faceNormal);
      if (faceNormal.lengthSq() === 0) return false;
      triangle.closestPointToPoint(at, nearby);
      if (nearby.distanceTo(at) > reach) return false;
      triangle.getMidpoint(middle);
      if (
        middle.sub(at).dot(first) > -lift ||
        offset.copy(center).sub(nearby).dot(faceNormal) > -lift
      )
        return false;
      const normal = faceNormal.clone().applyMatrix3(onto.normalMatrix).normalize();
      const gap = offset.copy(contact.probe).sub(nearby.applyMatrix4(onto.matrix)).dot(normal);
      if (contact.moving) normal.negate();
      if (contact.planes.some((plane) => plane.normal.dot(normal) > 0.999)) return false;
      contact.planes.push({ normal, gap, facing: 0 });
      added = true;
      return false;
    },
  });
  return added;
}

/**
 * The smallest step that satisfies every `row · x >= bound`, by Hildreth's method. Bounds that
 * contradict each other, as in a fit tighter than the allowance, get the step that splits the
 * difference instead.
 */
function smallestStep(rows: { row: number[]; bound: number }[], size: number) {
  const x = Array<number>(size).fill(0);
  if (!rows.some(({ bound }) => bound > 0)) return x;
  const weights = new Float64Array(rows.length);
  const norms = rows.map(({ row }) => row.reduce((sum, value) => sum + value * value, 0));
  const shortfall = (i: number) => {
    let gap = rows[i].bound;
    for (let k = 0; k < size; k++) gap -= rows[i].row[k] * x[k];
    return gap;
  };
  for (let sweep = 0; sweep < 120; sweep++) {
    let change = 0;
    for (let i = 0; i < rows.length; i++) {
      if (norms[i] < 1e-12) continue;
      const step = Math.max(-weights[i], shortfall(i) / norms[i]);
      if (!step) continue;
      weights[i] += step;
      for (let k = 0; k < size; k++) x[k] += step * rows[i].row[k];
      change = Math.max(change, Math.abs(step) * Math.sqrt(norms[i]));
    }
    if (change < 1e-7) break;
  }
  if (!rows.some((_, i) => shortfall(i) > 1e-4)) return x;
  x.fill(0);
  for (let round = 0; round < 24; round++) {
    const normal = Matrix.eye(size, size).mul(1e-6);
    const right = Matrix.zeros(size, 1);
    let active = 0;
    for (let i = 0; i < rows.length; i++) {
      const gap = shortfall(i);
      if (gap <= 0) continue;
      active++;
      for (let r = 0; r < size; r++) {
        right.set(r, 0, right.get(r, 0) + rows[i].row[r] * gap);
        for (let c = 0; c < size; c++)
          normal.set(r, c, normal.get(r, c) + rows[i].row[r] * rows[i].row[c]);
      }
    }
    if (!active) break;
    const step = solve(normal, right).to1DArray();
    if (!step.every(Number.isFinite) || Math.hypot(...step) < 1e-7) break;
    for (let k = 0; k < size; k++) x[k] += step[k];
  }
  return x;
}

const samePose = (a: Part, b: Part) =>
  a === b ||
  [...a.position, ...a.quaternion, ...a.scale].every(
    (value, i) => Math.abs(value - [...b.position, ...b.quaternion, ...b.scale][i]) < 1e-9,
  );

/** The farthest any point of a part of this size moves between two poses. */
function travel(from: Part[], to: Part[], radius: number) {
  let distance = 0;
  from.forEach((part, i) => {
    const other = to[i];
    const turn =
      2 * Math.acos(Math.min(1, Math.abs(quat(part.quaternion).dot(quat(other.quaternion)))));
    const stretch = Math.max(...part.scale.map((value, k) => Math.abs(value - other.scale[k])));
    distance = Math.max(
      distance,
      vec(part.position).distanceTo(vec(other.position)) + (turn + stretch) * radius,
    );
  });
  return distance;
}

const blend = (from: Part, to: Part, amount: number): Part => ({
  ...to,
  position: vec(from.position).lerp(vec(to.position), amount).toArray(),
  quaternion: quat(from.quaternion).slerp(quat(to.quaternion), amount).toArray(),
  scale: vec(from.scale).lerp(vec(to.scale), amount).toArray(),
});

function unionBox(bodies: Body[]) {
  const box = new Box3();
  for (const body of bodies) box.union(body.box);
  return box;
}

function deepest(contacts: Contact[]) {
  let depth = 0;
  for (const contact of contacts) depth = Math.max(depth, -contact.distance);
  return depth;
}

const pairKey = (contact: { mover: string; obstacle: string }) =>
  `${contact.mover}\n${contact.obstacle}`;

/**
 * Places parts as near to the requested poses as other visible parts allow. The moved parts may
 * sink into their neighbors by `overlap`, and no farther. Joints, locks, and plane constraints
 * applied by `place` stay authoritative, so they can hold an overlap this cannot remove.
 */
export function placeClear(options: {
  parts: Part[];
  joints: Joint[];
  ids: string[];
  target: Part[];
  place: (poses: Part[]) => Part[];
  overlap: number;
  mode: ClipMode;
  /** Let the correction turn the parts as well as shift them. */
  rotate?: boolean;
  /** Milliseconds a gesture may spend here before settling for the progress made so far. */
  budget?: number;
  /** The gesture has ended, so take the time to finish it at full detail. */
  settle?: boolean;
}): { parts: Part[]; report: ClipReport | null } {
  const { parts, ids, place, mode } = options;
  const started = performance.now();
  const overlap = Math.max(0, options.overlap);
  const open = place(options.target);
  const before = new Map(parts.map((part) => [part.id, part]));
  const moverIds = new Set(
    open.filter((part) => !samePose(part, before.get(part.id) ?? part)).map((part) => part.id),
  );
  const moversIn = (list: Part[]) => bodiesOf(list.filter((part) => moverIds.has(part.id)));
  const obstacles = bodiesOf(parts.filter((part) => !moverIds.has(part.id)));
  const atTarget = moversIn(open);
  if (!atTarget.length || !obstacles.length) return { parts: open, report: null };

  const posesOf = (list: Part[]) => ids.map((id) => list.find((part) => part.id === id)!);
  const target = posesOf(open);
  const radius = Math.max(1, unionBox(atTarget).getSize(new Vector3()).length() / 2);
  const slop = Math.max(0.002, overlap * 0.05);
  const gesture = mode === 'drag';
  const coarse = gesture && !options.settle;
  const bandMin = Math.max(0.5, overlap * 2);
  const bandMax = Math.max(1.5, Math.min(6, radius * 0.3));
  // A gesture takes short steps, because a search costs more the farther it has to look.
  const bandDrag = Math.max(0.5, Math.min(1.2, radius * 0.1)) + overlap;

  const swept = unionBox(atTarget);
  if (gesture) swept.union(unionBox(moversIn(parts)));
  swept.expandByScalar(bandMin);
  if (!obstacles.some((obstacle) => obstacle.box.intersectsBox(swept)))
    return { parts: open, report: null };

  const zones: Zone[] = [];
  const limits = new Map<string, number>();
  const joined = options.joints.filter(
    (joint) =>
      isJointConnected(joint) &&
      moverIds.has(joint.childId) !== moverIds.has(joint.parentId) &&
      before.has(joint.childId) &&
      before.has(joint.parentId),
  );
  const exempt = (contact: Contact) =>
    zones.some(
      (zone) =>
        zone.mover === contact.mover &&
        zone.obstacle === contact.obstacle &&
        contact.probe.distanceTo(zone.center) <= zone.radius,
    );
  /** Reads what already overlaps where the parts start, which a move may keep but not deepen. */
  const allow = (baseline: Contact[]) => {
    // Jointed parts meet at their anchors by design, so that contact does not count against them.
    for (const joint of joined) {
      const mover = moverIds.has(joint.childId) ? joint.childId : joint.parentId;
      const obstacle = mover === joint.childId ? joint.parentId : joint.childId;
      const center = vec(joint.parentAnchor).applyMatrix4(partMatrix(before.get(joint.parentId)!));
      let reach = 0;
      for (const contact of baseline)
        if (
          contact.mover === mover &&
          contact.obstacle === obstacle &&
          -contact.distance > overlap + slop
        )
          reach = Math.max(reach, contact.probe.distanceTo(center));
      if (reach) zones.push({ mover, obstacle, center, radius: reach + 1e-6 });
    }
    if (mode === 'fit') return;
    for (const contact of baseline) {
      if (-contact.distance <= overlap + slop || exempt(contact)) continue;
      const key = pairKey(contact);
      limits.set(key, Math.max(limits.get(key) ?? 0, -contact.distance));
    }
  };
  if (!gesture && (mode === 'adjust' || joined.length))
    allow(collide(moversIn(parts), obstacles, bandMin));

  const size = options.rotate ? 6 : 3;
  const budget = gesture ? (options.settle ? 32 : 8) : 40;
  let placed = gesture ? parts : open;
  let state = posesOf(placed);
  type Step = { placed: Part[]; contacts: Contact[]; excess: number };
  let clear: Step | null = null;
  let best: Step | null = null;
  let last: Step | null = null;
  let stride = 1;
  for (let iteration = 0; ; iteration++) {
    const remaining = travel(state, target, radius);
    const movers = moversIn(placed);
    const band = gesture
      ? Math.min(bandDrag * stride, Math.max(bandDrag, remaining * 1.2 + overlap))
      : Math.max(bandMin, Math.min(bandMax, remaining * 1.2 + overlap));
    const measured = collide(movers, obstacles, band, coarse);
    // With nothing in reach the parts are in open space, where longer strides are safe.
    stride = measured.length ? 1 : Math.min(16, stride * 2);
    if (gesture && !iteration) allow(measured);
    const contacts = zones.length ? measured.filter((contact) => !exempt(contact)) : measured;
    let excess = 0;
    for (const contact of contacts) {
      contact.limit = limits.get(pairKey(contact)) ?? overlap;
      excess = Math.max(excess, -contact.distance - contact.limit);
    }
    last = { placed, contacts, excess };
    if (excess <= slop) clear = last;
    if (!best || excess < best.excess) best = last;
    if ((excess <= slop && remaining < 1e-7) || iteration >= budget) break;

    const reach = Math.max(band * 0.9, Math.min(excess * 1.05, bandMax));
    // Get clear first, then close in on the request.
    const amount = excess > slop ? 0 : remaining > reach ? reach / remaining : 1;
    const blended =
      remaining < 1e-9 || !amount ? state : state.map((pose, i) => blend(pose, target[i], amount));
    const shift = partMatrix(blended[0]).multiply(partMatrix(state[0]).invert());
    const pivot = unionBox(movers).getCenter(new Vector3()).applyMatrix4(shift);
    const candidates = contacts.map((contact) => {
      const point = contact.point.clone().applyMatrix4(shift);
      return { contact, drift: point.clone().sub(contact.point), arm: point.sub(pivot) };
    });
    const step = Array<number>(size).fill(0);
    const move = new Vector3(),
      spin = new Vector3();
    let chosen: number[] = [];
    const pick = () =>
      candidates.map(({ contact, drift, arm }) => {
        if (contact.planes.length < 2) return 0;
        const travelled = drift.clone().add(move).add(spin.clone().cross(arm));
        // A sample past the allowance leaves the way its own surface came in.
        const bias = -contact.distance - contact.limit > slop ? 0.3 * (0.05 - contact.distance) : 0;
        let best = 0,
          score = -Infinity;
        contact.planes.forEach((plane, k) => {
          const value = plane.gap + plane.normal.dot(travelled) + bias * plane.facing;
          if (value > score) {
            score = value;
            best = k;
          }
        });
        return best;
      });
    const rowsFor = (picks: number[]) => {
      const all = candidates
        .map(({ contact, drift, arm }, i) => {
          const plane = contact.planes[picks[i]];
          return {
            contact,
            row: options.rotate
              ? [
                  ...plane.normal.toArray(),
                  ...arm.clone().cross(plane.normal).divideScalar(radius).toArray(),
                ]
              : plane.normal.toArray(),
            bound: -contact.limit - plane.gap - plane.normal.dot(drift),
            normal: plane.normal,
          };
        })
        .filter((candidate) => candidate.bound > -reach * 1.5)
        .sort((a, b) => b.bound - a.bound);
      // Thousands of samples can share one flat contact, so keep the tightest few in each area.
      const cell = radius / 4;
      const used = new Map<string, number>();
      return all
        .filter(({ contact: { point }, normal }) => {
          const key = `${Math.round(point.x / cell)},${Math.round(point.y / cell)},${Math.round(point.z / cell)},${Math.round(normal.x)},${Math.round(normal.y)},${Math.round(normal.z)}`;
          const count = used.get(key) ?? 0;
          used.set(key, count + 1);
          return count < 3;
        })
        .slice(0, 240);
    };
    const take = (rows: ReturnType<typeof rowsFor>) => {
      const solved = smallestStep(rows, size);
      const length = Math.hypot(...solved);
      for (let k = 0; k < size; k++) step[k] = solved[k] * (length > reach ? reach / length : 1);
      move.set(step[0], step[1], step[2]);
      if (options.rotate) spin.set(step[3], step[4], step[5]).divideScalar(radius);
    };
    let rows = rowsFor(pick());
    for (let pass = 0; pass < 8; pass++) {
      let wider = false;
      for (const { contact, bound } of rows)
        if (bound > 0 && widen(contact, overlap * 1.5 + 0.02)) wider = true;
      if (!wider) break;
      rows = rowsFor(pick());
    }
    // An edge is passed on one side or the other, and which side depends on the step itself. So
    // settle the contacts that have only one side first, then let the rest follow that step.
    take(rows.filter(({ contact }) => contact.planes.length === 1));
    for (let round = 0; round < 4; round++) {
      const picks = pick();
      if (round && picks.every((value, i) => value === chosen[i])) break;
      chosen = picks;
      take(rowsFor(picks));
    }
    let next = blended;
    if (Math.hypot(...step) > 1e-12) {
      const turn = new Quaternion();
      const angle = spin.length();
      if (angle > 1e-12) turn.setFromAxisAngle(spin.clone().divideScalar(angle), angle);
      next = blended.map((pose) => ({
        ...pose,
        position: vec(pose.position)
          .sub(pivot)
          .applyQuaternion(turn)
          .add(pivot)
          .add(move)
          .toArray(),
        quaternion: turn.clone().multiply(quat(pose.quaternion)).normalize().toArray(),
      }));
    }
    let nextPlaced: Part[];
    try {
      nextPlaced = place(next);
    } catch {
      break;
    }
    const nextState = posesOf(nextPlaced);
    if (travel(state, nextState, radius) < (gesture ? 1e-3 : 1e-5)) break;
    if (options.budget && iteration && performance.now() - started > options.budget) {
      placed = nextPlaced;
      state = nextState;
      iteration = budget - 1;
      continue;
    }
    placed = nextPlaced;
    state = nextState;
  }

  // A typed move that a joint or constraint keeps from stepping clear goes as far as it can
  // from where the part is, the way a drag would.
  if (mode === 'adjust' && last!.excess > slop && !clear)
    return placeClear({ ...options, mode: 'drag', settle: true, budget: undefined });
  // A gesture never ends deeper than it started. A fit reports the overlap it could not remove.
  const result = last!.excess <= slop ? last! : (clear ?? (gesture ? null : best!));
  if (!result) return { parts, report: { depth: 0, moved: 0, blockers: [], unresolved: false } };
  const moved = travel(posesOf(result.placed), target, radius);
  const unresolved = result.excess > slop;
  const margin = Math.max(0.01, slop * 2);
  const blockers =
    moved > 1e-6 || unresolved
      ? [
          ...new Set(
            result.contacts
              .filter((contact) => contact.distance + contact.limit <= margin)
              .map((contact) => contact.obstacle),
          ),
        ]
      : [];
  return {
    parts: moved < 1e-9 ? open : result.placed,
    report: {
      depth: deepest(result.contacts),
      moved: moved < 1e-9 ? 0 : moved,
      blockers,
      unresolved,
    },
  };
}

/** The deepest overlap between these parts and every other visible part, in mm. */
export function clippingDepth(parts: Part[], ids: string[]) {
  const movers = bodiesOf(parts.filter((part) => ids.includes(part.id)));
  const obstacles = bodiesOf(parts.filter((part) => !ids.includes(part.id)));
  return deepest(collide(movers, obstacles, 0.25));
}

/** A short account of what avoiding clipping did, for a status message. Empty when nothing. */
export function clipNote(report: ClipReport | null | undefined, parts: Part[]) {
  if (!report || (!report.unresolved && report.moved < 0.001)) return '';
  const names = report.blockers
    .map((id) => parts.find((part) => part.id === id)?.name ?? id)
    .slice(0, 3)
    .join(', ');
  return report.unresolved
    ? `still overlaps ${names || 'another part'} by ${report.depth.toFixed(2)} mm`
    : `moved ${report.moved.toFixed(2)} mm to clear ${names || 'other parts'}`;
}
