import {
  BoxGeometry,
  BufferAttribute,
  BufferGeometry,
  CatmullRomCurve3,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Matrix4,
  Path,
  Quaternion,
  Shape,
  ShapeUtils,
  SphereGeometry,
  TorusGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
} from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries, toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';
import { deserializeGeometry, radians } from '../src/core/geometry';
import type { Vec3 } from '../src/core/types';

export const defaultPartColor = '#c5c2b8';
export const shapeTypes = [
  'box',
  'cylinder',
  'cone',
  'sphere',
  'capsule',
  'torus',
  'lathe',
  'extrude',
  'tube',
  'loft',
  'mesh',
] as const;

type Point2 = [number, number];

export interface LoftSection {
  y: number;
  radius?: number;
  size?: Point2;
  outline?: Point2[];
  center?: Point2;
}

export interface ShapeSpec {
  type: (typeof shapeTypes)[number];
  size?: number[];
  corner_radius?: number;
  radius?: number;
  radius_top?: number;
  radius_bottom?: number;
  height?: number;
  tube?: number;
  segments?: number;
  profile?: number[][];
  outline?: number[][];
  holes?: number[][][];
  depth?: number;
  bevel?: number;
  path?: number[][];
  closed?: boolean;
  sections?: LoftSection[];
  positions?: number[];
  indices?: number[];
  colors?: number[];
  position?: number[];
  rotation?: number[];
  scale?: number[];
  color?: string;
  smooth_angle?: number;
}

function fail(shape: ShapeSpec, message: string): never {
  throw new Error(`${shape.type}: ${message}`);
}

function positive(shape: ShapeSpec, field: keyof ShapeSpec, value = shape[field]): number {
  if (typeof value !== 'number' || !(value > 0))
    fail(shape, `${String(field)} must be a positive number of millimeters.`);
  return value as number;
}

function segmentsOf(shape: ShapeSpec, fallback: number, minimum = 3) {
  const segments = shape.segments ?? fallback;
  if (!Number.isInteger(segments) || segments < minimum || segments > 512)
    fail(shape, `segments must be a whole number from ${minimum} to 512.`);
  return segments;
}

function signedVolume(geometry: BufferGeometry) {
  const position = geometry.getAttribute('position');
  const a = new Vector3(),
    b = new Vector3(),
    c = new Vector3();
  let volume = 0;
  for (let i = 0, count = geometry.index?.count ?? position.count; i < count; i += 3) {
    a.fromBufferAttribute(position, geometry.index?.getX(i) ?? i);
    b.fromBufferAttribute(position, geometry.index?.getX(i + 1) ?? i + 1);
    c.fromBufferAttribute(position, geometry.index?.getX(i + 2) ?? i + 2);
    volume += a.dot(b.cross(c));
  }
  return volume / 6;
}

function reverseWinding(geometry: BufferGeometry) {
  for (const attribute of Object.values(geometry.attributes))
    for (let i = 0; i < attribute.count; i += 3)
      for (let component = 0; component < attribute.itemSize; component++) {
        const held = attribute.getComponent(i + 1, component);
        attribute.setComponent(i + 1, component, attribute.getComponent(i + 2, component));
        attribute.setComponent(i + 2, component, held);
      }
}

/** Generated surfaces face outward whichever way round the caller described them. */
function creased(geometry: BufferGeometry, shape: ShapeSpec) {
  const plain = geometry.index ? geometry.toNonIndexed() : geometry;
  if (signedVolume(plain) < 0) reverseWinding(plain);
  return toCreasedNormals(plain, radians(shape.smooth_angle ?? 35));
}

function indexedMesh(vertices: number[], indices: number[]) {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(new Float32Array(vertices), 3));
  geometry.setIndex(indices);
  return geometry;
}

function points2(shape: ShapeSpec, field: string, values: unknown, minimum = 3): Point2[] {
  if (
    !Array.isArray(values) ||
    !values.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite))
  )
    fail(shape, `${field} must be a list of [a, b] coordinates.`);
  const points = (values as Point2[]).filter((point, i, all) => {
    const previous = all[i === 0 ? all.length - 1 : i - 1];
    return i === 0 && all.length === 1
      ? true
      : point[0] !== previous[0] || point[1] !== previous[1];
  });
  if (points.length < minimum) fail(shape, `${field} needs at least ${minimum} distinct points.`);
  return points;
}

/** Revolves [radius, y] points around Y, closing either end at the axis to make a solid. */
function revolve(shape: ShapeSpec, profile: Point2[], segments: number) {
  const points = [...profile];
  if (points[0][0] > 0) points.unshift([0, points[0][1]]);
  if (points.at(-1)![0] > 0) points.push([0, points.at(-1)![1]]);
  if (points.some(([radius]) => radius < 0)) fail(shape, 'profile radii cannot be negative.');
  if (points.every(([radius]) => radius === 0)) fail(shape, 'profile needs a point off the axis.');
  const vertices: number[] = [],
    indices: number[] = [];
  const rings = points.map(([radius, y]) => {
    const start = vertices.length / 3;
    if (radius === 0) {
      vertices.push(0, y, 0);
      return { start, pole: true };
    }
    for (let i = 0; i < segments; i++) {
      const angle = (i / segments) * Math.PI * 2;
      vertices.push(radius * Math.cos(angle), y, radius * Math.sin(angle));
    }
    return { start, pole: false };
  });
  for (let r = 0; r + 1 < rings.length; r++) {
    const a = rings[r],
      b = rings[r + 1];
    if (a.pole && b.pole) continue;
    for (let i = 0; i < segments; i++) {
      const next = (i + 1) % segments;
      if (a.pole) indices.push(a.start, b.start + next, b.start + i);
      else if (b.pole) indices.push(a.start + i, a.start + next, b.start);
      else
        indices.push(
          a.start + i,
          a.start + next,
          b.start + next,
          a.start + i,
          b.start + next,
          b.start + i,
        );
    }
  }
  return creased(indexedMesh(vertices, indices), shape);
}

function capsule(shape: ShapeSpec) {
  const radius = positive(shape, 'radius');
  const height = positive(shape, 'height');
  if (height < radius * 2) fail(shape, 'height is the overall length, at least twice the radius.');
  const segments = segmentsOf(shape, 32);
  const steps = Math.max(4, Math.round(segments / 4));
  const profile: Point2[] = [[0, -height / 2]];
  for (let i = 1; i <= steps; i++) {
    const angle = (i / steps) * (Math.PI / 2);
    profile.push([radius * Math.sin(angle), -height / 2 + radius - radius * Math.cos(angle)]);
  }
  for (let i = steps; i >= 1; i--) {
    const angle = (i / steps) * (Math.PI / 2);
    profile.push([radius * Math.sin(angle), height / 2 - radius + radius * Math.cos(angle)]);
  }
  profile.push([0, height / 2]);
  // A capsule has no sharp edges, whatever its facet angle.
  return revolve({ ...shape, smooth_angle: shape.smooth_angle ?? 60 }, profile, segments);
}

function extrude(shape: ShapeSpec) {
  const outline = points2(shape, 'outline', shape.outline);
  const depth = positive(shape, 'depth');
  const bevel = shape.bevel ?? 0;
  if (bevel < 0 || bevel * 2 >= depth) fail(shape, 'bevel must be less than half of depth.');
  const solid = new Shape(outline.map(([x, y]) => new Vector2(x, y)));
  for (const hole of shape.holes ?? [])
    solid.holes.push(new Path(points2(shape, 'holes', hole).map(([x, y]) => new Vector2(x, y))));
  const geometry = new ExtrudeGeometry(solid, {
    depth: depth - bevel * 2,
    steps: 1,
    curveSegments: 1,
    bevelEnabled: bevel > 0,
    bevelSize: bevel,
    bevelThickness: bevel,
    bevelOffset: -bevel,
    bevelSegments: 2,
  });
  geometry.translate(0, 0, -(depth - bevel * 2) / 2);
  return creased(geometry, shape);
}

function tube(shape: ShapeSpec) {
  const path = shape.path;
  if (
    !Array.isArray(path) ||
    path.length < 2 ||
    !path.every((p) => Array.isArray(p) && p.length === 3 && p.every(Number.isFinite))
  )
    fail(shape, 'path must list at least two [x, y, z] points.');
  const radius = positive(shape, 'radius');
  const closed = shape.closed === true;
  const radial = segmentsOf(shape, 16);
  const curve = new CatmullRomCurve3(
    path!.map((p) => new Vector3(...(p as Vec3))),
    closed,
    'centripetal',
  );
  const steps = Math.min(1024, Math.max(16, (path!.length - (closed ? 0 : 1)) * 12));
  const geometry = new TubeGeometry(curve, steps, radius, radial, closed);
  const vertices = Array.from(geometry.getAttribute('position').array);
  const indices = Array.from(geometry.index!.array);
  if (!closed) {
    const ring = radial + 1;
    const cap = (center: Vector3, first: number, reverse: boolean) => {
      const pole = vertices.length / 3;
      vertices.push(center.x, center.y, center.z);
      for (let i = 0; i < radial; i++) {
        const a = first + i,
          b = first + i + 1;
        if (reverse) indices.push(pole, b, a);
        else indices.push(pole, a, b);
      }
    };
    cap(curve.getPointAt(0), 0, false);
    cap(curve.getPointAt(1), steps * ring, true);
  }
  return creased(indexedMesh(vertices, indices), {
    ...shape,
    smooth_angle: shape.smooth_angle ?? 60,
  });
}

function outlineArea(points: Point2[]) {
  let area = 0;
  for (let i = 0; i < points.length; i++) {
    const [ax, ay] = points[i],
      [bx, by] = points[(i + 1) % points.length];
    area += ax * by - bx * ay;
  }
  return area / 2;
}

function resample(points: Point2[], count: number): Point2[] {
  const closed = [...points, points[0]];
  const lengths = [0];
  for (let i = 1; i < closed.length; i++)
    lengths.push(
      lengths[i - 1] + Math.hypot(closed[i][0] - closed[i - 1][0], closed[i][1] - closed[i - 1][1]),
    );
  const total = lengths.at(-1)!;
  const result: Point2[] = [];
  let edge = 0;
  for (let i = 0; i < count; i++) {
    const distance = (i / count) * total;
    while (edge < closed.length - 2 && lengths[edge + 1] <= distance) edge++;
    const span = lengths[edge + 1] - lengths[edge] || 1;
    const t = (distance - lengths[edge]) / span;
    result.push([
      closed[edge][0] + (closed[edge + 1][0] - closed[edge][0]) * t,
      closed[edge][1] + (closed[edge + 1][1] - closed[edge][1]) * t,
    ]);
  }
  return result;
}

const centered = (ring: Point2[]) => {
  const cx = ring.reduce((sum, p) => sum + p[0], 0) / ring.length;
  const cz = ring.reduce((sum, p) => sum + p[1], 0) / ring.length;
  return ring.map(([x, z]): Point2 => [x - cx, z - cz]);
};

/** Starts a ring at the rotation closest to the previous one, so a loft does not twist. */
function untwisted(ring: Point2[], previous: Point2[]) {
  const a = centered(previous),
    b = centered(ring);
  let start = 0,
    best = Infinity;
  for (let offset = 0; offset < b.length; offset++) {
    let distance = 0;
    for (let i = 0; i < b.length; i++) {
      const [x, z] = b[(i + offset) % b.length];
      distance += (x - a[i][0]) ** 2 + (z - a[i][1]) ** 2;
    }
    if (distance < best - 1e-9) {
      best = distance;
      start = offset;
    }
  }
  return [...ring.slice(start), ...ring.slice(0, start)];
}

function rectangle([width, depth]: Point2, count: number): Point2[] {
  const x = width / 2,
    z = depth / 2,
    side = count / 4;
  const corners: Point2[] = [
    [x, z],
    [-x, z],
    [-x, -z],
    [x, -z],
  ];
  const result: Point2[] = [];
  for (let i = 0; i < side / 2; i++) result.push([x, (z * i) / (side / 2)]);
  corners.forEach(([ax, az], i) => {
    const [bx, bz] = corners[(i + 1) % 4];
    const steps = i === 3 ? side / 2 : side;
    for (let s = 0; s < steps; s++)
      result.push([ax + ((bx - ax) * s) / side, az + ((bz - az) * s) / side]);
  });
  return result;
}

function loft(shape: ShapeSpec) {
  const sections = shape.sections;
  if (!Array.isArray(sections) || sections.length < 2)
    fail(shape, 'sections must list at least two cross sections.');
  const outlines = sections!.map((section) => {
    if (!section.outline) return null;
    const points = points2(shape, 'outline', section.outline);
    // Every ring runs the same way round, whichever way it was written.
    return outlineArea(points) < 0 ? [...points].reverse() : points;
  });
  const hasRectangle = sections!.some((section) => section.size);
  const allOutlines = outlines.every(Boolean);
  const sameCount = allOutlines && outlines.every((o) => o!.length === outlines[0]!.length);
  let count = sameCount && !shape.segments ? outlines[0]!.length : segmentsOf(shape, 48);
  // A rectangle keeps its corners only if sampled points land on them.
  if (hasRectangle) count = Math.ceil(count / 8) * 8;
  const vertices: number[] = [],
    indices: number[] = [];
  let previous: Point2[] | null = null;
  const rings = sections!.map((section, s) => {
    if (!Number.isFinite(section.y)) fail(shape, 'every section needs a y position.');
    const defined = [section.radius, section.size, section.outline].filter(
      (value) => value !== undefined,
    );
    if (defined.length !== 1) fail(shape, 'each section needs one of radius, size, or outline.');
    let ring: Point2[];
    if (section.radius !== undefined) {
      const radius = positive(shape, 'radius', section.radius);
      ring = Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2;
        return [radius * Math.cos(angle), radius * Math.sin(angle)] as Point2;
      });
    } else if (section.size) {
      if (section.size.length !== 2 || !section.size.every((value) => value > 0))
        fail(shape, 'section size must be [x, z] with positive values.');
      ring = rectangle(section.size, count);
    } else ring = outlines[s]!.length === count ? outlines[s]! : resample(outlines[s]!, count);
    if (previous) ring = untwisted(ring, previous);
    previous = ring;
    const [cx, cz] = section.center ?? [0, 0];
    ring = ring.map(([x, z]) => [x + cx, z + cz]);
    const start = vertices.length / 3;
    for (const [x, z] of ring) vertices.push(x, section.y, z);
    return { ring, start };
  });
  for (let r = 0; r + 1 < rings.length; r++) {
    const a = rings[r].start,
      b = rings[r + 1].start;
    for (let i = 0; i < count; i++) {
      const next = (i + 1) % count;
      indices.push(a + i, a + next, b + next, a + i, b + next, b + i);
    }
  }
  // Caps reuse the ring vertices, so they stay welded to the sides.
  [rings[0], rings.at(-1)!].forEach(({ ring, start }, end) => {
    const contour = ring.map(([x, z]) => new Vector2(x, z));
    for (const [a, b, c] of ShapeUtils.triangulateShape(contour, [])) {
      const area = outlineArea([ring[a], ring[b], ring[c]]);
      const sameDirection = area > 0 === (end === 1);
      indices.push(start + a, start + (sameDirection ? b : c), start + (sameDirection ? c : b));
    }
  });
  return creased(indexedMesh(vertices, indices), shape);
}

function rawMesh(shape: ShapeSpec) {
  if (!Array.isArray(shape.positions)) fail(shape, 'positions must be a flat x, y, z list.');
  const geometry = deserializeGeometry({
    positions: shape.positions!,
    indices: shape.indices,
    colors: shape.colors,
  });
  return toCreasedNormals(
    geometry.index ? geometry.toNonIndexed() : geometry,
    radians(shape.smooth_angle ?? 35),
  );
}

function buildSurface(shape: ShapeSpec): BufferGeometry {
  switch (shape.type) {
    case 'box': {
      const size = shape.size;
      if (!Array.isArray(size) || size.length !== 3 || !size.every((value) => value > 0))
        fail(shape, 'size must be [x, y, z] with positive millimeters.');
      const [x, y, z] = size as Vec3;
      const corner = shape.corner_radius ?? 0;
      if (corner < 0 || corner * 2 >= Math.min(x, y, z))
        fail(shape, 'corner_radius must be less than half of the smallest side.');
      return corner > 0
        ? new RoundedBoxGeometry(x, y, z, segmentsOf(shape, 3, 1), corner)
        : new BoxGeometry(x, y, z);
    }
    case 'cylinder': {
      const top = shape.radius_top ?? shape.radius;
      const bottom = shape.radius_bottom ?? shape.radius;
      if (typeof top !== 'number' || typeof bottom !== 'number' || top < 0 || bottom < 0)
        fail(shape, 'set radius, or radius_top and radius_bottom.');
      if (!top && !bottom) fail(shape, 'at least one end needs a positive radius.');
      return new CylinderGeometry(top, bottom, positive(shape, 'height'), segmentsOf(shape, 32));
    }
    case 'cone':
      return new CylinderGeometry(
        0,
        positive(shape, 'radius'),
        positive(shape, 'height'),
        segmentsOf(shape, 32),
      );
    case 'sphere': {
      const segments = segmentsOf(shape, 32);
      return new SphereGeometry(
        positive(shape, 'radius'),
        segments,
        // An even count puts a ring on the equator, so the bounds reach the full radius.
        Math.max(2, Math.round(segments * 0.35) * 2),
      );
    }
    case 'capsule':
      return capsule(shape);
    case 'torus': {
      const segments = segmentsOf(shape, 48);
      return new TorusGeometry(
        positive(shape, 'radius'),
        positive(shape, 'tube'),
        Math.max(3, Math.round(segments / 3)),
        segments,
      ).rotateX(Math.PI / 2);
    }
    case 'lathe':
      return revolve(shape, points2(shape, 'profile', shape.profile, 2), segmentsOf(shape, 48));
    case 'extrude':
      return extrude(shape);
    case 'tube':
      return tube(shape);
    case 'loft':
      return loft(shape);
    case 'mesh':
      return rawMesh(shape);
    default:
      throw new Error(`Unknown shape type. Use one of: ${shapeTypes.join(', ')}.`);
  }
}

export function parseColor(value: string) {
  const text = value.trim().toLowerCase();
  if (/^#[\da-f]{6}$/.test(text)) return text;
  if (/^#[\da-f]{3}$/.test(text)) return `#${[...text.slice(1)].map((c) => c + c).join('')}`;
  const named = (Color.NAMES as Record<string, number>)[text];
  if (named === undefined)
    throw new Error(`"${value}" is not a #rrggbb color or a CSS color name.`);
  return `#${named.toString(16).padStart(6, '0')}`;
}

function paint(geometry: BufferGeometry, hex: string) {
  const color = new Color(hex);
  const count = geometry.getAttribute('position').count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = color.r;
    colors[i * 3 + 1] = color.g;
    colors[i * 3 + 2] = color.b;
  }
  geometry.setAttribute('color', new BufferAttribute(colors, 3));
}

/** Builds one shape in its part's local space: non-indexed, with normals and no extras. */
export function buildShape(shape: ShapeSpec) {
  const surface = buildSurface(shape);
  const geometry = surface.index ? surface.toNonIndexed() : surface;
  for (const name of Object.keys(geometry.attributes))
    if (!['position', 'normal', 'color'].includes(name)) geometry.deleteAttribute(name);
  if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
  const scale = shape.scale ?? [1, 1, 1];
  if (scale.length !== 3 || scale.some((value) => Math.abs(value) < 1e-6))
    fail(shape, 'scale must be three non-zero numbers.');
  const matrix = new Matrix4().compose(
    new Vector3(...((shape.position ?? [0, 0, 0]) as Vec3)),
    new Quaternion().setFromEuler(
      new Euler(...((shape.rotation ?? [0, 0, 0]).map(radians) as Vec3)),
    ),
    new Vector3(...(scale as Vec3)),
  );
  geometry.applyMatrix4(matrix);
  if (matrix.determinant() < 0) reverseWinding(geometry);
  geometry.clearGroups();
  return geometry;
}

/**
 * Merges a part's shapes into one mesh. A part whose shapes all share a color uses the part
 * color. Mixed colors are stored per vertex, under a white part color so they are not tinted.
 */
export function buildPartGeometry(shapes: ShapeSpec[], partColor?: string) {
  if (!shapes.length) throw new Error('A part needs at least one shape.');
  const color = parseColor(partColor ?? defaultPartColor);
  const colored = shapes.some((shape) => shape.color || shape.colors);
  const pieces = shapes.map((shape) => {
    const geometry = buildShape(shape);
    if (colored && !geometry.getAttribute('color'))
      paint(geometry, shape.color ? parseColor(shape.color) : color);
    return geometry;
  });
  const geometry = pieces.length === 1 ? pieces[0] : mergeGeometries(pieces);
  if (!geometry) throw new Error('These shapes could not be combined into one mesh.');
  geometry.computeBoundingBox();
  geometry.computeBoundingSphere();
  return { geometry, color: colored ? '#ffffff' : color };
}
