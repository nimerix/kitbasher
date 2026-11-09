import {
  MathUtils,
  OrthographicCamera,
  PerspectiveCamera,
  Quaternion,
  Spherical,
  Vector3,
} from 'three';
import { partPivot, sceneBounds, vec } from './geometry';
import type { Part, Vec3 } from './types';

export type CameraDirection = 'left' | 'right' | 'up' | 'down';
export type NavigationMode = 'orbit' | 'pan';
export interface CameraStep {
  mode: NavigationMode;
  direction: CameraDirection;
}

/** From the view's target toward its camera, with Y up. */
export const viewDirections = {
  front: [0, 0, 1],
  back: [0, 0, -1],
  right: [1, 0, 0],
  left: [-1, 0, 0],
  top: [0, 1, 0.001],
  bottom: [0, -1, 0.001],
  iso: [1, 0.65, 1.3],
} as const;
export type ViewName = keyof typeof viewDirections;

const orbitPreferenceKey = 'kitbasher.orbit-selection';

export function readOrbitPreference() {
  try {
    return localStorage.getItem(orbitPreferenceKey) !== 'false';
  } catch {
    return true;
  }
}

export function saveOrbitPreference(enabled: boolean) {
  try {
    localStorage.setItem(orbitPreferenceKey, String(enabled));
  } catch {
    // Navigation still works when browser storage is unavailable.
  }
}

export interface ExplodeFrame {
  center: Vector3;
  /** Displacement in mm at 100%, so the slider suits any assembly size. */
  reach: number;
}

export function explodeFrame(parts: Part[]): ExplodeFrame {
  const bounds = sceneBounds(parts.map((part) => ({ ...part, visible: true })));
  return {
    center: bounds.getCenter(new Vector3()),
    reach: bounds.getSize(new Vector3()).length() * 0.25,
  };
}

export function displayedPosition(part: Part, explode: number, frame?: ExplodeFrame): Vec3 {
  if (!explode || !frame) return part.position;
  const direction = partPivot({ ...part, pivot: undefined }).sub(frame.center);
  if (direction.length() < frame.reach * 0.1) direction.set(0, 0, 1);
  return vec(part.position)
    .addScaledVector(direction.normalize(), (explode / 100) * frame.reach)
    .toArray();
}

export function selectionOrbitCenter(parts: Part[], selected: string[], explode = 0) {
  const selection = new Set(selected);
  const visible = parts.filter((part) => part.visible && selection.has(part.id));
  if (!visible.length) return null;
  const frame = explode ? explodeFrame(parts) : undefined;
  const primary = visible.find((part) => part.id === selected[0]);
  if (primary?.pivot)
    return partPivot({ ...primary, position: displayedPosition(primary, explode, frame) });
  return sceneBounds(
    visible.map((part) => ({ ...part, position: displayedPosition(part, explode, frame) })),
  ).getCenter(new Vector3());
}

function visibleHeight(camera: PerspectiveCamera | OrthographicCamera, target: Vector3) {
  return camera instanceof OrthographicCamera
    ? (camera.top - camera.bottom) / camera.zoom
    : 2 * camera.position.distanceTo(target) * Math.tan(MathUtils.degToRad(camera.fov / 2));
}

/** Carry a view between projections, keeping its direction, pivot, and apparent size. */
export function transferView(
  from: PerspectiveCamera | OrthographicCamera,
  to: PerspectiveCamera | OrthographicCamera,
  fromTarget: Vector3,
  toTarget: Vector3,
) {
  const height = visibleHeight(from, fromTarget);
  const direction = from.position.clone().sub(fromTarget).normalize();
  toTarget.copy(fromTarget);
  to.up.copy(from.up);
  if (to instanceof OrthographicCamera) {
    to.position.copy(from.position);
    to.zoom = (to.top - to.bottom) / height;
  } else {
    to.position
      .copy(fromTarget)
      .addScaledVector(direction, height / (2 * Math.tan(MathUtils.degToRad(to.fov / 2))));
  }
  to.updateProjectionMatrix();
  to.lookAt(fromTarget);
  to.updateMatrixWorld();
}

/** Recenter without changing the view direction, orbit distance, or orthographic zoom. */
export function setOrbitCenter(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  center: Vector3,
) {
  camera.position.add(center.clone().sub(target));
  target.copy(center);
  camera.lookAt(target);
  camera.updateMatrixWorld();
}

/** Carry the panned view around a separate pivot without changing its screen position. */
export function rotateOrbitOffset(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  pivot: Vector3,
  previousRotation: Quaternion,
) {
  const rotation = camera.quaternion.clone().multiply(previousRotation.clone().invert());
  const offset = target.clone().sub(pivot);
  const correction = offset.clone().applyQuaternion(rotation).sub(offset);
  camera.position.add(correction);
  target.add(correction);
  camera.updateMatrixWorld();
}

export function stepCamera(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  step: CameraStep,
  pivot = target,
) {
  const horizontal = step.direction === 'left' ? -1 : step.direction === 'right' ? 1 : 0;
  const vertical = step.direction === 'up' ? 1 : step.direction === 'down' ? -1 : 0;
  if (step.mode === 'orbit') {
    const previousRotation = camera.quaternion.clone();
    const up = new Quaternion().setFromUnitVectors(camera.up, new Vector3(0, 1, 0));
    const offset = camera.position.clone().sub(target).applyQuaternion(up);
    const spherical = new Spherical().setFromVector3(offset);
    spherical.theta += (horizontal * Math.PI) / 12;
    spherical.phi = MathUtils.clamp(
      spherical.phi - (vertical * Math.PI) / 12,
      0.01,
      Math.PI - 0.01,
    );
    offset.setFromSpherical(spherical).applyQuaternion(up.invert());
    camera.position.copy(target).add(offset);
    camera.lookAt(target);
    rotateOrbitOffset(camera, target, pivot, previousRotation);
  } else {
    // A tenth of the visible height gives comparable steps at every zoom level.
    const height = visibleHeight(camera, target);
    camera.updateMatrixWorld();
    const delta = new Vector3()
      .setFromMatrixColumn(camera.matrixWorld, 0)
      .multiplyScalar(horizontal);
    delta.addScaledVector(new Vector3().setFromMatrixColumn(camera.matrixWorld, 1), vertical);
    delta.multiplyScalar(height * 0.1);
    camera.position.add(delta);
    target.add(delta);
  }
  camera.updateMatrixWorld();
}
