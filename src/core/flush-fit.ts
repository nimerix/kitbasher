import { Matrix, solve } from 'ml-matrix';
import { Quaternion, Vector3 } from 'three';
import { isJointConnected, transformAssembly } from './constraints';
import { quat, vec } from './geometry';
import { solvePlaneConstraints } from './plane-constraints';
import { fitPatchPlane, worldPlane } from './planes';
import { completedSurfacePairs } from './surfaces';
import type { AssemblyOperation, Part, SceneDocument } from './types';

export function solveFlushAlignment(scene: SceneDocument, operation: AssemblyOperation) {
  const source = scene.parts.find((part) => part.id === operation.sourceId);
  if (!source || source.locked) throw new Error('Choose an unlocked moving part.');
  const complete = completedSurfacePairs(operation.surfacePairs);
  if (!complete.length || complete.length !== operation.surfacePairs.length)
    throw new Error('Paint across both sides of every seam, or remove incomplete regions.');
  const regions = complete.map((pair, index) => {
    const target = scene.parts.find((part) => part.id === pair.target!.partId);
    if (!target || target.id === source.id || pair.source!.partId !== source.id)
      throw new Error('Each seam needs the moving part and a different stationary part.');
    const moving = fitPatchPlane(source, pair.source!);
    const fixed = fitPatchPlane(target, pair.target!);
    const targetPlane = worldPlane(target, fixed.plane);
    if (worldPlane(source, moving.plane).normal.dot(targetPlane.normal) < 0)
      throw new Error('Paint the outward surfaces across a seam, not opposing contact faces.');
    return {
      index: index + 1,
      targetId: target.id,
      movingPlane: moving.plane,
      targetPlane,
      length: Math.max(0.5, Math.sqrt(Math.min(moving.area, fixed.area))),
    };
  });
  const centers = regions.map((region) => worldPlane(source, region.movingPlane).point);
  const pivot = centers
    .reduce((sum, center) => sum.add(center), new Vector3())
    .divideScalar(centers.length);
  const length = Math.max(
    1,
    ...regions.map((region) => region.length),
    ...centers.map((center) => center.distanceTo(pivot)),
  );
  const movable = new Set([source.id]);
  const queue = [source.id];
  const joints = scene.joints.filter(isJointConnected);
  while (queue.length) {
    const parentId = queue.shift()!;
    for (const joint of joints)
      if (joint.parentId === parentId && !movable.has(joint.childId)) {
        movable.add(joint.childId);
        queue.push(joint.childId);
      }
  }
  const fixedIds = scene.parts
    .filter(
      (part) => !movable.has(part.id) || regions.some((region) => region.targetId === part.id),
    )
    .map((part) => part.id);
  const place = (parameters: number[]) => {
    const rotationVector = new Vector3(
      ...(parameters.slice(3) as [number, number, number]),
    ).divideScalar(length);
    const angle = rotationVector.length();
    const rotation = angle
      ? new Quaternion().setFromAxisAngle(rotationVector.divideScalar(angle), angle)
      : new Quaternion();
    const requested: Part = {
      ...source,
      position: vec(source.position)
        .sub(pivot)
        .applyQuaternion(rotation)
        .add(pivot)
        .add(new Vector3(...(parameters.slice(0, 3) as [number, number, number])))
        .toArray(),
      quaternion: rotation.multiply(quat(source.quaternion)).normalize().toArray(),
    };
    const parts = solvePlaneConstraints(
      scene,
      transformAssembly(scene.parts, scene.joints, source.id, requested, {
        stationaryIds: fixedIds,
      }),
      fixedIds,
    );
    return { parts, placed: parts.find((part) => part.id === source.id)! };
  };
  const residuals = (parameters: number[]) => {
    const { parts, placed } = place(parameters);
    const values = regions.flatMap((region) => {
      const moving = worldPlane(placed, region.movingPlane);
      return [
        moving.point.sub(region.targetPlane.point).dot(region.targetPlane.normal),
        ...moving.normal.sub(region.targetPlane.normal).multiplyScalar(region.length).toArray(),
      ];
    });
    const regularization = 0.001 * Math.sqrt(regions.length);
    values.push(...parameters.map((value) => value * regularization));
    return { parts, placed, values, score: values.reduce((sum, value) => sum + value * value, 0) };
  };
  let parameters = Array<number>(6).fill(0);
  let best = residuals(parameters);
  for (let iteration = 0; iteration < 40; iteration++) {
    const step = Math.max(1e-5, length * 1e-5);
    const jacobian = Matrix.zeros(best.values.length, 6);
    for (let column = 0; column < 6; column++) {
      const shifted = [...parameters];
      shifted[column] += step;
      let next;
      try {
        next = residuals(shifted);
      } catch {
        continue;
      }
      next.values.forEach((value, row) =>
        jacobian.set(row, column, (value - best.values[row]) / step),
      );
    }
    const delta = solve(
      jacobian,
      Matrix.columnVector(best.values.map((value) => -value)),
      true,
    ).to1DArray();
    if (!delta.every(Number.isFinite))
      throw new Error('This seam fit is unstable. Paint wider, flatter regions.');
    if (Math.hypot(...delta) < 1e-7) break;
    const limit = Math.min(1, (length * 0.1) / Math.max(1e-12, Math.hypot(...delta)));
    let improved = false;
    for (let attempt = 0; attempt < 10; attempt++) {
      const candidate = parameters.map(
        (value, index) => value + delta[index] * limit * 0.5 ** attempt,
      );
      if (Math.hypot(...candidate.slice(3)) / length > Math.PI / 6) continue;
      let next;
      try {
        next = residuals(candidate);
      } catch {
        continue;
      }
      if (next.score < best.score - 1e-14) {
        parameters = candidate;
        best = next;
        improved = true;
        break;
      }
    }
    if (!improved) break;
  }
  const regionErrors = regions.map((region) => {
    const moving = worldPlane(best.placed, region.movingPlane);
    return {
      region: region.index,
      distance: Math.abs(moving.point.sub(region.targetPlane.point).dot(region.targetPlane.normal)),
      angle: (moving.normal.angleTo(region.targetPlane.normal) * 180) / Math.PI,
    };
  });
  return {
    parts: best.parts,
    rms: Math.sqrt(
      regionErrors.reduce((sum, region) => sum + region.distance ** 2, 0) / regionErrors.length,
    ),
    angleError: Math.max(...regionErrors.map((region) => region.angle)),
    regionErrors,
    constrained: regionErrors.some((region) => region.distance > 0.05 || region.angle > 1),
    anchored: scene.joints.some((joint) => joint.childId === source.id && isJointConnected(joint)),
    addedConstraints: [],
  };
}
