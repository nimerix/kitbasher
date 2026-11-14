import { Matrix4, Quaternion, Vector3 } from 'three';
import { partMatrix, quat, rigidAlignment, vec } from './geometry';
import type { Part } from './types';

export const pinTolerance = 1e-6;
export type PinPair = { source: Vector3; target: Vector3 };

export function pinGaps(part: Part) {
  const matrix = partMatrix(part);
  return (part.pins ?? []).map((pin) =>
    vec(pin.point).applyMatrix4(matrix).distanceTo(vec(pin.target)),
  );
}

export function hardPinsSatisfied(part: Part) {
  const gaps = pinGaps(part);
  return (part.pins ?? []).every((pin, i) => pin.kind !== 'hard' || gaps[i] <= pinTolerance);
}

/** Exponential strength makes the whole priority range useful; zero releases a soft pin. */
export const pinWeight = (priority: number) => (priority <= 0 ? 0 : 10 ** (priority / 25 - 1));

/** Rigid correction of a requested assembly pose. No mesh edits or scale decomposition. */
export function pinCorrection(
  driver: Part,
  parts: Part[],
  fixed: PinPair[] = [],
  soft = true,
): Matrix4 {
  const hard = [...fixed];
  const source: Vector3[] = [],
    target: Vector3[] = [],
    weights: number[] = [];
  const add = (a: Vector3, b: Vector3, weight: number) => {
    source.push(a);
    target.push(b);
    weights.push(weight);
  };
  // Six virtual handles represent the user's requested pose. Their total translation
  // weight is one, and their radius gives rotation a model-size-relative resistance.
  if (!driver.geometry.boundingSphere) driver.geometry.computeBoundingSphere();
  const sphere = driver.geometry.boundingSphere!;
  const center = sphere.center.clone().applyMatrix4(partMatrix(driver));
  const radius = Math.max(sphere.radius * Math.max(...driver.scale.map(Math.abs)), 0.01);
  for (let axis = 0; axis < 3; axis++)
    for (const sign of [-1, 1]) {
      const point = center.clone().add(new Vector3().setComponent(axis, sign * radius));
      add(point, point.clone(), 1 / 6);
    }
  for (const part of parts) {
    const matrix = partMatrix(part);
    for (const pin of part.pins ?? []) {
      const a = vec(pin.point).applyMatrix4(matrix),
        b = vec(pin.target);
      if (pin.kind === 'hard') hard.push({ source: a, target: b });
      else if (soft && pin.priority > 0) add(a, b, pinWeight(pin.priority));
    }
  }
  if (!hard.length) return rigidAlignment(source, target, true, { weights }).matrix;
  const origin = hard[0];
  const other = hard.reduce(
    (best, pair) =>
      pair.source.distanceToSquared(origin.source) > best.source.distanceToSquared(origin.source)
        ? pair
        : best,
    origin,
  );
  let matrix: Matrix4;
  if (other.source.distanceTo(origin.source) <= pinTolerance) {
    // One point removes translation, but leaves all rotation degrees of freedom.
    matrix = rigidAlignment(source, target, true, {
      weights,
      centers: [origin.source, origin.target],
    }).matrix;
  } else {
    const from = other.source.clone().sub(origin.source).normalize();
    const to = other.target.clone().sub(origin.target).normalize();
    const noncollinear = hard.some(
      ({ source: point }) => point.clone().sub(origin.source).cross(from).length() > pinTolerance,
    );
    let rotation: Quaternion;
    if (noncollinear) {
      // Three noncollinear points determine the entire rigid pose.
      rotation = new Quaternion().setFromRotationMatrix(
        rigidAlignment(
          hard.map((p) => p.source),
          hard.map((p) => p.target),
          true,
        ).matrix,
      );
    } else {
      const align = new Quaternion().setFromUnitVectors(from, to);
      let cosine = 0,
        sine = 0;
      for (let i = 0; i < source.length; i++) {
        const a = source[i].clone().sub(origin.source).applyQuaternion(align);
        const b = target[i].clone().sub(origin.target);
        a.addScaledVector(to, -a.dot(to));
        b.addScaledVector(to, -b.dot(to));
        cosine += weights[i] * a.dot(b);
        sine += weights[i] * to.dot(a.clone().cross(b));
      }
      // Two points leave exactly one free twist around their shared axis.
      rotation = new Quaternion().setFromAxisAngle(to, Math.atan2(sine, cosine)).multiply(align);
    }
    matrix = new Matrix4().makeRotationFromQuaternion(rotation);
    matrix.setPosition(origin.target.clone().sub(origin.source.clone().applyQuaternion(rotation)));
  }
  if (
    hard.some(
      (pair) => pair.source.clone().applyMatrix4(matrix).distanceTo(pair.target) > pinTolerance,
    )
  )
    throw new Error(
      'These hard pins cannot stay fixed with this transform. Release a pin before changing the shape or scale.',
    );
  return matrix;
}

export function applyPinCorrection(part: Part, delta: Matrix4): Part {
  return {
    ...part,
    position: vec(part.position).applyMatrix4(delta).toArray(),
    quaternion: new Quaternion()
      .setFromRotationMatrix(delta)
      .multiply(quat(part.quaternion))
      .normalize()
      .toArray(),
  };
}
