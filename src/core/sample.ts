import {
  BufferAttribute,
  BufferGeometry,
  Color,
  CylinderGeometry,
  Euler,
  Matrix4,
  Quaternion,
  SphereGeometry,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import type { Joint, Part, SceneDocument, Vec3 } from './types';

const ivory = '#c7c3b6',
  dark = '#41474a',
  graphite = '#2b3033',
  orange = '#ce8050',
  steel = '#787f7c';

function piece(
  geometry: BufferGeometry,
  color: string,
  position: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
) {
  const quaternion = new Quaternion().setFromEuler(new Euler(...rotation));
  geometry.applyMatrix4(
    new Matrix4().compose(new Vector3(...position), quaternion, new Vector3(1, 1, 1)),
  );
  const nonIndexed = geometry.index ? geometry.toNonIndexed() : geometry;
  const rgb = new Color(color),
    colors = new Float32Array(nonIndexed.getAttribute('position').count * 3);
  for (let i = 0; i < colors.length; i += 3) {
    colors[i] = rgb.r;
    colors[i + 1] = rgb.g;
    colors[i + 2] = rgb.b;
  }
  nonIndexed.setAttribute('color', new BufferAttribute(colors, 3));
  nonIndexed.deleteAttribute('uv');
  if (nonIndexed !== geometry) geometry.dispose();
  return nonIndexed;
}

const box = (
  x: number,
  y: number,
  z: number,
  color: string,
  pos: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
) => piece(new RoundedBoxGeometry(x, y, z, 2, Math.min(x, y, z) * 0.12), color, pos, rotation);
const cylinder = (
  top: number,
  bottom: number,
  height: number,
  color: string,
  pos: Vec3 = [0, 0, 0],
  rotation: Vec3 = [0, 0, 0],
) => piece(new CylinderGeometry(top, bottom, height, 24), color, pos, rotation);
const ball = (radius: number, color: string, pos: Vec3 = [0, 0, 0]) =>
  piece(new SphereGeometry(radius, 20, 14), color, pos);

function part(
  id: string,
  name: string,
  position: Vec3,
  pieces: BufferGeometry[],
  locked = false,
): Part {
  const geometry = mergeGeometries(pieces)!;
  geometry.computeBoundingSphere();
  pieces.forEach((p) => p.dispose());
  return {
    id,
    name,
    position,
    geometry,
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#ffffff',
    visible: true,
    locked,
    source: 'Scout assembly · sample',
  };
}

export function createSample(): SceneDocument {
  const parts: Part[] = [];
  parts.push(
    part(
      'base',
      'Display base',
      [0, 0, 0],
      [
        cylinder(32, 33, 3, graphite, [0, 1.5, 0]),
        cylinder(30.8, 31.5, 1.1, steel, [0, 3.5, 0]),
        cylinder(30.5, 30.5, 0.65, '#565b56', [0, 4.1, 0]),
        ...Array.from({ length: 8 }, (_, i) =>
          box(
            0.6,
            0.4,
            5,
            '#899085',
            [Math.sin((i * Math.PI) / 4) * 25, 4.55, Math.cos((i * Math.PI) / 4) * 25],
            [0, (i * Math.PI) / 4, 0],
          ),
        ),
      ],
      true,
    ),
  );
  for (const [side, sign] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    parts.push(
      part(
        `boot-${side}`,
        `${side === 'L' ? 'Left' : 'Right'} foot`,
        [sign * 10.5, 10, 2],
        [
          box(14, 7, 21, dark, [0, -1, 1]),
          box(13, 5, 17, ivory, [0, 2, 2]),
          box(12, 2, 8, steel, [0, -3.5, 7]),
          box(10, 0.5, 10, orange, [0, 4.6, 3]),
          ...[-4, 0, 4].map((x) => box(0.6, 3, 0.5, graphite, [x, 0, 11.6])),
        ],
      ),
    );
    parts.push(
      part(
        `shin-${side}`,
        `${side === 'L' ? 'Left' : 'Right'} lower leg`,
        [sign * 10.5, 27, 0],
        [
          box(7, 22, 7, dark),
          box(10, 16, 7.5, ivory, [0, 1, 2]),
          box(6, 9, 1.2, orange, [0, 2, 6]),
          cylinder(4, 4, 11, steel, [0, 10, 0], [0, 0, Math.PI / 2]),
          cylinder(2.6, 2.6, 11.4, dark, [0, 10, 0], [0, 0, Math.PI / 2]),
          cylinder(1.5, 1.5, 19, steel, [sign * 4, -1, -3]),
        ],
      ),
    );
    parts.push(
      part(
        `thigh-${side}`,
        `${side === 'L' ? 'Left' : 'Right'} upper leg`,
        [sign * 10.5, 46, 0],
        [
          box(8, 15, 8, dark),
          box(11, 12, 10, ivory, [sign * 0.8, 0, 0]),
          box(6, 6, 1.1, steel, [0, 1, 5.7]),
          cylinder(4, 4, 4, graphite, [0, 8, 0]),
        ],
      ),
    );
  }
  parts.push(
    part(
      'pelvis',
      'Hip assembly',
      [0, 56, 0],
      [
        box(23, 10, 14, dark),
        box(14, 10, 3, ivory, [0, 0, 7]),
        box(8, 5, 1, orange, [0, 1, 9]),
        cylinder(6, 6, 7, steel, [0, 8, 0]),
      ],
    ),
  );
  parts.push(
    part(
      'torso',
      'Torso shell',
      [0, 76, 0],
      [
        box(31, 25, 20, ivory),
        box(25, 16, 3, orange, [0, 2, 10.2]),
        box(28, 5, 4, dark, [0, -10.5, 9]),
        box(13, 3, 1.5, graphite, [0, 6, 12]),
        box(10, 2, 0.7, steel, [0, 0, 12]),
        ...[-10, 10].map((x) => cylinder(1, 1, 1, steel, [x, 7.2, 12], [Math.PI / 2, 0, 0])),
        ...[-8, -4, 0, 4, 8].map((x) => box(1, 2, 0.8, graphite, [x, -10, 11.5])),
      ],
    ),
  );
  parts.push(
    part(
      'backpack',
      'Power pack',
      [0, 77, -14],
      [
        box(21, 22, 8, dark),
        box(14, 16, 3, steel, [0, 1, -5]),
        ...[-5, 0, 5].map((x) => box(1.5, 12, 1, graphite, [x, 0, -7])),
        cylinder(3, 3, 16, orange, [12, 0, 0]),
      ],
    ),
  );
  parts.push(
    part(
      'head',
      'Optics & head',
      [0, 98, 0.5],
      [
        cylinder(4.2, 4.2, 5, dark, [0, -8, 0]),
        box(18, 15, 16, ivory),
        box(16, 6, 2.2, graphite, [0, 1, 8]),
        cylinder(3.5, 3.5, 2, steel, [3, 1, 10], [Math.PI / 2, 0, 0]),
        cylinder(2.6, 2.6, 2.3, '#a4c5bc', [3, 1, 10.8], [Math.PI / 2, 0, 0]),
        box(4.5, 1.3, 1, orange, [-4.5, 1, 9.5]),
        box(8, 2, 2, dark, [0, -5, 8]),
        cylinder(0.8, 0.8, 14, steel, [-7, 13, 0]),
        ball(1.4, orange, [-7, 20, 0]),
      ],
    ),
  );
  for (const [side, sign] of [
    ['L', -1],
    ['R', 1],
  ] as const) {
    parts.push(
      part(
        `shoulder-${side}`,
        `${side === 'L' ? 'Left' : 'Right'} shoulder`,
        [sign * 22, 82, 0],
        [
          ball(6, dark),
          box(10, 13, 17, orange, [sign * 1, 2, 0]),
          box(5, 4, 18, ivory, [sign * 1, 8, 0]),
          cylinder(4, 4, 2, steel, [sign * 7, 0, 0], [0, 0, Math.PI / 2]),
          cylinder(2, 2, 2.3, graphite, [sign * 7.5, 0, 0], [0, 0, Math.PI / 2]),
        ],
      ),
    );
    parts.push(
      part(
        `arm-${side}`,
        `${side === 'L' ? 'Left' : 'Right'} arm`,
        [sign * 25, 65, 1],
        [
          box(6, 17, 6, dark),
          cylinder(4, 4, 9, steel, [0, -6, 0], [0, 0, Math.PI / 2]),
          box(10, 14, 11, ivory, [sign, -15, 1]),
          box(6, 8, 1, orange, [sign, -14, 7]),
          cylinder(2.8, 2.8, 5, graphite, [sign, -24, 1]),
          box(8, 6, 9, dark, [sign, -28, 2]),
          box(2, 6, 4, steel, [sign * 5, -28, 3]),
        ],
      ),
    );
  }
  // The demo begins with two real constraints; other connections can be added.
  const joints: Joint[] = [
    {
      id: 'joint-neck',
      name: 'Neck pivot',
      parentId: 'torso',
      childId: 'head',
      parentAnchor: [0, 14.5, 0.5],
      childAnchor: [0, -7.5, 0],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, false, true],
      keepConnected: true,
    },
    {
      id: 'joint-pack',
      name: 'Power pack mount',
      parentId: 'torso',
      childId: 'backpack',
      parentAnchor: [0, 1, -10],
      childAnchor: [0, 0, 4],
      restRotation: [0, 0, 0, 1],
      rotationLocks: [true, true, true],
      keepConnected: true,
    },
  ];
  return { name: 'Scout · MK.04', parts, joints };
}
