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

export function displayedPosition(part: Part, explode: number): Vec3 {
  if (!explode) return part.position;
  const direction = vec(part.position).sub(new Vector3(0, 55, 0));
  if (direction.length() < 10) direction.set(0, 0, 15);
  return vec(part.position)
    .add(direction.normalize().multiplyScalar(explode * 0.45))
    .toArray();
}

export function selectionOrbitCenter(parts: Part[], selected: string[], explode = 0) {
  const selection = new Set(selected);
  const visible = parts.filter((part) => part.visible && selection.has(part.id));
  if (!visible.length) return null;
  const primary = visible.find((part) => part.id === selected[0]);
  if (primary?.pivot)
    return partPivot({ ...primary, position: displayedPosition(primary, explode) });
  return sceneBounds(
    visible.map((part) => ({ ...part, position: displayedPosition(part, explode) })),
  ).getCenter(new Vector3());
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

export function stepCamera(
  camera: PerspectiveCamera | OrthographicCamera,
  target: Vector3,
  step: CameraStep,
) {
  const horizontal = step.direction === 'left' ? -1 : step.direction === 'right' ? 1 : 0;
  const vertical = step.direction === 'up' ? 1 : step.direction === 'down' ? -1 : 0;
  if (step.mode === 'orbit') {
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
  } else {
    // A tenth of the visible height gives comparable steps at every zoom level.
    const height =
      camera instanceof OrthographicCamera
        ? (camera.top - camera.bottom) / camera.zoom
        : 2 * camera.position.distanceTo(target) * Math.tan(MathUtils.degToRad(camera.fov / 2));
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
