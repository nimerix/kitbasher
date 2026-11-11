import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import type { Quat, Vec3 } from './types';

/**
 * Where the room sits in the scene. The headset reports poses in meters and the scene is in
 * millimeters, so a scene point is `position + scale · rotate(room point)`.
 */
export interface Rig {
  position: Vector3;
  quaternion: Quaternion;
  /** Scene millimeters per room meter. */
  scale: number;
}

export interface HandPose {
  position: Vector3;
  quaternion: Quaternion;
}

/** How many times larger than life the scene looks. */
export const magnificationLimits = { min: 0.02, max: 200 } as const;

const up = new Vector3(0, 1, 0);
// A new view shows the whole model this wide, this far ahead, and this far below the eyes.
const framedSize = 0.4;
const framedReach = 0.55;
const framedDrop = 0.25;
// Hands closer together than this give no usable direction or distance.
const minimumSpan = 0.01;

const clampMagnification = (value: number) =>
  Math.max(magnificationLimits.min, Math.min(magnificationLimits.max, value));

export const magnification = (rig: Rig) => 1000 / rig.scale;

export const cloneRig = (rig: Rig): Rig => ({
  position: rig.position.clone(),
  quaternion: rig.quaternion.clone(),
  scale: rig.scale,
});

export const rigMatrix = (rig: Rig, target = new Matrix4()) =>
  target.compose(rig.position, rig.quaternion, new Vector3(rig.scale, rig.scale, rig.scale));

export const toScene = (rig: Rig, room: Vector3) =>
  room.clone().multiplyScalar(rig.scale).applyQuaternion(rig.quaternion).add(rig.position);

export const toRoom = (rig: Rig, scene: Vector3) =>
  scene
    .clone()
    .sub(rig.position)
    .applyQuaternion(rig.quaternion.clone().invert())
    .divideScalar(rig.scale);

/** The rig with this rotation and scale that puts a scene point at a room point. */
function anchored(scene: Vector3, room: Vector3, quaternion: Quaternion, scale: number): Rig {
  return {
    quaternion,
    scale,
    position: scene.clone().sub(room.clone().multiplyScalar(scale).applyQuaternion(quaternion)),
  };
}

/** Where the head is and the level direction it faces. */
export function facing(head: Matrix4) {
  const position = new Vector3().setFromMatrixPosition(head);
  const forward = new Vector3(0, 0, -1).transformDirection(head).setY(0);
  // Looking straight down or up, the top of the head points the way the body faces.
  if (forward.lengthSq() < 1e-4) forward.set(0, 1, 0).transformDirection(head).setY(0);
  if (forward.lengthSq() < 1e-4) forward.set(0, 0, -1);
  return { position, forward: forward.normalize() };
}

/**
 * Sets the whole model in front of the viewer at a comfortable size, upright, with the viewer
 * looking at its front.
 */
export function frameRig(head: Matrix4, bounds: Box3): Rig {
  const { position, forward } = facing(head);
  const center = bounds.getCenter(new Vector3());
  const radius = Math.max(bounds.getSize(new Vector3()).length() / 2, 1);
  const scale = 1000 / clampMagnification((framedSize * 1000) / (radius * 2));
  const room = position.clone().addScaledVector(forward, framedReach);
  room.y -= framedDrop;
  // The front of a model faces +Z, so the viewer looks along -Z.
  const heading = Math.atan2(-forward.x, -forward.z);
  return anchored(center, room, new Quaternion().setFromAxisAngle(up, -heading), scale);
}

/** One hand drags the scene: the point it took hold of stays in it. */
export function dragRig(start: Rig, from: Vector3, to: Vector3): Rig {
  return {
    ...cloneRig(start),
    position: start.position
      .clone()
      .add(from.clone().sub(to).multiplyScalar(start.scale).applyQuaternion(start.quaternion)),
  };
}

/**
 * Two hands stretch, turn, and carry the scene: the points they took hold of stay in them.
 * Level keeps the scene upright, so the hands only turn it like a turntable.
 */
export function pinchRig(
  start: Rig,
  from: [Vector3, Vector3],
  to: [Vector3, Vector3],
  level: boolean,
): Rig {
  const before = from[1].clone().sub(from[0]),
    after = to[1].clone().sub(to[0]);
  const stretch =
    before.length() < minimumSpan || after.length() < minimumSpan
      ? 1
      : after.length() / before.length();
  const wanted = clampMagnification(magnification(start) * stretch);
  const scale = 1000 / wanted;
  const turn = new Quaternion();
  if (level) {
    before.setY(0);
    after.setY(0);
  }
  if (before.length() >= minimumSpan && after.length() >= minimumSpan) {
    if (level)
      turn.setFromAxisAngle(up, Math.atan2(after.x, after.z) - Math.atan2(before.x, before.z));
    else turn.setFromUnitVectors(before.normalize(), after.normalize());
  }
  const middle = from[0].clone().add(from[1]).multiplyScalar(0.5);
  const quaternion = start.quaternion.clone().multiply(turn.invert());
  return anchored(
    toScene(start, middle),
    to[0].clone().add(to[1]).multiplyScalar(0.5),
    quaternion,
    scale,
  );
}

/** Changes the magnification around a scene point, which stays where it is in the room. */
export function rescaleRig(rig: Rig, center: Vector3, wanted: number): Rig {
  return anchored(
    center,
    toRoom(rig, center),
    rig.quaternion.clone(),
    1000 / clampMagnification(wanted),
  );
}

/** Stands a tilted scene upright around a scene point, keeping the way it faces. */
export function levelRig(rig: Rig, center: Vector3): Rig {
  const { y, w } = rig.quaternion;
  const length = Math.hypot(y, w);
  const quaternion =
    length < 1e-6 ? new Quaternion() : new Quaternion(0, y / length, 0, w / length);
  return anchored(center, toRoom(rig, center), quaternion, rig.scale);
}

/**
 * Where a held part goes. It turns with the hand around the point it was taken by, and that
 * point travels as far as the hand has, so a part held at a distance moves no faster than the
 * hand does.
 */
export function heldPose(
  part: { position: Vec3; quaternion: Quat },
  grab: HandPose & { pivot: Vector3 },
  hand: HandPose,
): { position: Vec3; quaternion: Quat } {
  const turn = hand.quaternion.clone().multiply(grab.quaternion.clone().invert());
  const pivot = grab.pivot.clone().add(hand.position).sub(grab.position);
  return {
    position: new Vector3(...part.position)
      .sub(grab.pivot)
      .applyQuaternion(turn)
      .add(pivot)
      .toArray(),
    quaternion: turn
      .multiply(new Quaternion(...part.quaternion))
      .normalize()
      .toArray(),
  };
}

export function scaleLabel(value: number) {
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${Number(value.toFixed(digits))}×`;
}

export type XRMode = 'vr' | 'ar';

export interface XRSettings {
  /** Keep the scene upright while two hands turn it. */
  level: boolean;
  /** The kind of session entered last. */
  mode: XRMode;
}

export const defaultXRSettings: XRSettings = { level: true, mode: 'ar' };

const storageKey = 'kitbasher.headset';

export function sanitizeXRSettings(value: unknown): XRSettings {
  const source = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return {
    level: typeof source.level === 'boolean' ? source.level : defaultXRSettings.level,
    mode: source.mode === 'vr' || source.mode === 'ar' ? source.mode : defaultXRSettings.mode,
  };
}

export function readXRSettings(): XRSettings {
  try {
    const saved = localStorage.getItem(storageKey);
    return saved ? sanitizeXRSettings(JSON.parse(saved)) : defaultXRSettings;
  } catch {
    return defaultXRSettings;
  }
}

export function saveXRSettings(settings: XRSettings) {
  try {
    localStorage.setItem(storageKey, JSON.stringify(settings));
  } catch {
    // The setting still applies for this session when browser storage is unavailable.
  }
}
