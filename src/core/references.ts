import { PlaneGeometry } from 'three';
import type { Part, SceneDocument } from './types';

export const referencePlanes: Part[] = [
  {
    id: 'plane-xz',
    name: 'Ground · XZ',
    geometry: new PlaneGeometry(180, 180).rotateX(-Math.PI / 2),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#a1bba5',
    locked: true,
    visible: true,
    source: 'Reference plane',
  },
  {
    id: 'plane-xy',
    name: 'Front · XY',
    geometry: new PlaneGeometry(180, 180).translate(0, 90, 0),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#9eafc4',
    locked: true,
    visible: true,
    source: 'Reference plane',
  },
  {
    id: 'plane-yz',
    name: 'Side · YZ',
    geometry: new PlaneGeometry(180, 180).rotateY(Math.PI / 2).translate(0, 90, 0),
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    color: '#c69d9b',
    locked: true,
    visible: true,
    source: 'Reference plane',
  },
];

export const resolvePart = (scene: SceneDocument, id: string | null) =>
  scene.parts.find((p) => p.id === id) ?? referencePlanes.find((p) => p.id === id);
