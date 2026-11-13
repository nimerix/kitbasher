import { Quaternion, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import { quat, radians, vec } from './geometry';
import type { Part } from './types';

export type TransformAxis = 0 | 1 | 2 | null;
export type FreeTransformMode = 'translate' | 'rotate';
export type TransformPatch = { id: string; patch: Partial<Part> };

/** Pointer motion in a frozen camera frame, independent of scene constraints and history. */
export class FreeTransformMotion {
  private offset = new Vector2();
  private rotation = new Quaternion();
  private right: Vector3;
  private down: Vector3;
  private pixelX: Vector3;
  private pixelY: Vector3;
  private angularGain: number;

  constructor(camera: Camera, pivot: Vector3, width: number, height: number) {
    camera.updateMatrixWorld();
    const depth = pivot.clone().project(camera).z;
    const center = new Vector3(0, 0, depth).unproject(camera);
    this.pixelX = new Vector3(2 / width, 0, depth).unproject(camera).sub(center);
    this.pixelY = new Vector3(0, -2 / height, depth).unproject(camera).sub(center);
    this.right = this.pixelX.clone().normalize();
    this.down = this.pixelY.clone().normalize();
    this.angularGain = Math.PI / Math.max(200, Math.min(width, height));
  }

  move(dx: number, dy: number, fine: boolean) {
    const gain = fine ? 0.1 : 1;
    this.offset.add(new Vector2(dx, dy).multiplyScalar(gain));
    const yaw = new Quaternion().setFromAxisAngle(this.down, -dx * gain * this.angularGain);
    const pitch = new Quaternion().setFromAxisAngle(this.right, dy * gain * this.angularGain);
    this.rotation.premultiply(yaw.multiply(pitch)).normalize();
  }

  patches(
    parts: Part[],
    pivot: Vector3,
    orientation: Quaternion,
    mode: FreeTransformMode,
    axis: TransformAxis,
    snap: number | null,
  ): TransformPatch[] {
    const position = new Vector3();
    const rotation = new Quaternion();
    const direction =
      axis === null ? null : new Vector3().setComponent(axis, 1).applyQuaternion(orientation);
    const quantize = (value: number, step: number | null) =>
      step && step > 0 ? Math.round(value / step) * step : value;
    if (mode === 'translate') {
      position
        .copy(this.pixelX)
        .multiplyScalar(this.offset.x)
        .addScaledVector(this.pixelY, this.offset.y);
      if (direction) {
        const x = direction.dot(this.right),
          y = direction.dot(this.down);
        const projected = x * x + y * y;
        // An axis facing the camera has no screen projection. Vertical motion still reaches it.
        const amount =
          projected > 0.01
            ? position.dot(direction) / projected
            : -this.offset.y * this.pixelY.length();
        position.copy(direction).multiplyScalar(quantize(amount, snap));
      } else if (snap) {
        position.applyQuaternion(orientation.clone().invert());
        position.set(
          quantize(position.x, snap),
          quantize(position.y, snap),
          quantize(position.z, snap),
        );
        position.applyQuaternion(orientation);
      }
    } else if (direction) {
      rotation.setFromAxisAngle(
        direction,
        quantize((this.offset.x - this.offset.y) * this.angularGain, snap ? radians(snap) : null),
      );
    } else {
      rotation.copy(this.rotation);
      if (snap) {
        // Snap the trackball's total angle without changing its axis.
        const w = Math.max(-1, Math.min(1, rotation.w));
        const angle = 2 * Math.acos(w);
        const rotationAxis = new Vector3(rotation.x, rotation.y, rotation.z);
        if (rotationAxis.lengthSq() > 1e-16)
          rotation.setFromAxisAngle(rotationAxis.normalize(), quantize(angle, radians(snap)));
      }
    }
    return parts.map((part) => ({
      id: part.id,
      patch:
        mode === 'translate'
          ? { position: vec(part.position).add(position).toArray() }
          : {
              position: vec(part.position)
                .sub(pivot)
                .applyQuaternion(rotation)
                .add(pivot)
                .toArray(),
              quaternion: rotation.clone().multiply(quat(part.quaternion)).normalize().toArray(),
            },
    }));
  }
}
