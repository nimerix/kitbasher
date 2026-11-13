import { Matrix4, Plane, Quaternion, Raycaster, Vector2, Vector3 } from 'three';
import type { Camera } from 'three';
import { partMatrix, quat, radians, transformFromMatrix, vec } from './geometry';
import { FreeTransformMotion } from './free-transform';
import type { TransformPatch } from './free-transform';
import type { Part } from './types';

export interface TransformHandle {
  mode: 'translate' | 'rotate' | 'scale';
  axis: 0 | 1 | 2 | null;
  /** The normal axis of a planar move handle. */
  plane?: 0 | 1 | 2;
}

/** A frozen drag frame: model updates never move the coordinate system under the pointer. */
export class CombinedTransformDrag {
  private camera: Camera;
  private pointer: Vector2;
  private motion: FreeTransformMotion;
  private raycaster = new Raycaster();
  private plane: Plane | null = null;
  private previousPoint: Vector3 | null = null;
  private translation = new Vector3();
  private angle = 0;
  private worldAxis: Vector3 | null;

  constructor(
    private parts: Part[],
    private pivot: Vector3,
    private orientation: Quaternion,
    readonly handle: TransformHandle,
    camera: Camera,
    private width: number,
    private height: number,
    pointer: Vector2,
    private handleWorldSize: number,
  ) {
    this.camera = camera.clone();
    this.camera.updateMatrixWorld();
    this.pointer = pointer.clone();
    this.motion = new FreeTransformMotion(this.camera, pivot, width, height);
    this.worldAxis =
      handle.axis === null
        ? null
        : new Vector3().setComponent(handle.axis, 1).applyQuaternion(orientation);
    const normal =
      handle.plane !== undefined
        ? new Vector3().setComponent(handle.plane, 1).applyQuaternion(orientation)
        : handle.mode === 'rotate'
          ? this.worldAxis
          : null;
    if (normal) {
      this.plane = new Plane().setFromNormalAndCoplanarPoint(normal, pivot);
      this.previousPoint = this.pointOnPlane(pointer);
    }
  }

  private pointOnPlane(pointer: Vector2) {
    if (!this.plane) return null;
    this.raycaster.setFromCamera(
      new Vector2((pointer.x / this.width) * 2 - 1, 1 - (pointer.y / this.height) * 2),
      this.camera,
    );
    return this.raycaster.ray.intersectPlane(this.plane, new Vector3());
  }

  update(
    pointer: Vector2,
    fine: boolean,
    snap: { move: number; rotate: number; scale: number } | null,
  ): TransformPatch[] {
    this.motion.move(pointer.x - this.pointer.x, pointer.y - this.pointer.y, fine);
    this.pointer.copy(pointer);
    const gain = fine ? 0.1 : 1;
    if (this.plane) {
      const point = this.pointOnPlane(pointer);
      if (point && this.previousPoint) {
        if (this.handle.mode === 'rotate') {
          const before = this.previousPoint.clone().sub(this.pivot).normalize();
          const after = point.clone().sub(this.pivot).normalize();
          this.angle +=
            Math.atan2(this.worldAxis!.dot(before.clone().cross(after)), before.dot(after)) * gain;
        } else this.translation.add(point.clone().sub(this.previousPoint).multiplyScalar(gain));
      }
      this.previousPoint = point;
    }
    const quantize = (value: number, step?: number) =>
      step ? Math.round(value / step) * step : value;
    if (this.handle.mode === 'translate') {
      if (!this.plane)
        return this.motion.patches(
          this.parts,
          this.pivot,
          this.orientation,
          'translate',
          this.handle.axis,
          snap?.move ?? null,
        );
      const offset = this.translation.clone().applyQuaternion(this.orientation.clone().invert());
      offset.set(
        quantize(offset.x, snap?.move),
        quantize(offset.y, snap?.move),
        quantize(offset.z, snap?.move),
      );
      offset.setComponent(this.handle.plane!, 0).applyQuaternion(this.orientation);
      return this.parts.map((part) => ({
        id: part.id,
        patch: { position: vec(part.position).add(offset).toArray() },
      }));
    }
    if (this.handle.mode === 'rotate') {
      const rotation = new Quaternion().setFromAxisAngle(
        this.worldAxis!,
        quantize(this.angle, snap ? radians(snap.rotate) : undefined),
      );
      return this.parts.map((part) => ({
        id: part.id,
        patch: {
          position: vec(part.position)
            .sub(this.pivot)
            .applyQuaternion(rotation)
            .add(this.pivot)
            .toArray(),
          quaternion: rotation.clone().multiply(quat(part.quaternion)).normalize().toArray(),
        },
      }));
    }
    const moved = this.motion.patches(
      this.parts,
      this.pivot,
      this.orientation,
      'translate',
      this.handle.axis,
      null,
    )[0].patch.position!;
    const offset = vec(moved).sub(vec(this.parts[0].position));
    const amount = this.worldAxis
      ? offset.dot(this.worldAxis)
      : offset.dot(new Vector3(-1, -1, 0).applyQuaternion(this.camera.quaternion).normalize());
    const factor = Math.max(
      0.001,
      quantize(Math.exp(Math.max(-7, Math.min(7, amount / this.handleWorldSize))), snap?.scale),
    );
    const scale =
      this.handle.axis === null
        ? new Vector3(factor, factor, factor)
        : new Vector3(1, 1, 1).setComponent(this.handle.axis, factor);
    const frame = new Matrix4().compose(this.pivot, this.orientation, new Vector3(1, 1, 1));
    const delta = frame
      .clone()
      .multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z))
      .multiply(frame.clone().invert());
    return this.parts.map((part) => {
      const pose = transformFromMatrix(part, delta.clone().multiply(partMatrix(part)));
      return {
        id: part.id,
        patch: { position: pose.position, quaternion: pose.quaternion, scale: pose.scale },
      };
    });
  }
}
