import { describe, expect, it } from 'vitest';
import { Box3, Matrix4, Quaternion, Vector3 } from 'three';
import {
  dragRig,
  facing,
  frameRig,
  heldPose,
  levelRig,
  magnification,
  magnificationLimits,
  pinchRig,
  rescaleRig,
  sanitizeXRSettings,
  scaleLabel,
  toRoom,
  toScene,
  turnRig,
  WorldGesture,
} from '../../src/core/xr';
import type { Rig } from '../../src/core/xr';

const up = new Vector3(0, 1, 0);
const close = (a: Vector3, b: Vector3, digits = 6) => {
  expect(a.x).toBeCloseTo(b.x, digits);
  expect(a.y).toBeCloseTo(b.y, digits);
  expect(a.z).toBeCloseTo(b.z, digits);
};
const head = (position: Vector3, yaw = 0, pitch = 0) =>
  new Matrix4().compose(
    position,
    new Quaternion()
      .setFromAxisAngle(up, yaw)
      .multiply(new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), pitch)),
    new Vector3(1, 1, 1),
  );
// Turned, tilted, and off-center, so nothing passes by being the identity.
const rig = (): Rig => ({
  position: new Vector3(40, -300, 120),
  quaternion: new Quaternion().setFromAxisAngle(new Vector3(1, 2, 0.5).normalize(), 0.7),
  scale: 250,
});
const model = new Box3(new Vector3(-40, 0, -30), new Vector3(40, 120, 30));

describe('the room in the scene', () => {
  it('maps points both ways', () => {
    const point = new Vector3(0.3, 1.2, -0.5);
    close(toRoom(rig(), toScene(rig(), point)), point);
    expect(magnification(rig())).toBe(4);
  });

  it('frames the model ahead of the viewer, upright, seen from its front', () => {
    const eyes = new Vector3(1, 1.5, 2);
    for (const yaw of [0, 1.1, Math.PI, -2.4]) {
      const framed = frameRig(head(eyes, yaw, -0.4), model);
      const center = toRoom(framed, model.getCenter(new Vector3()));
      const { forward } = facing(head(eyes, yaw));
      close(center, eyes.clone().addScaledVector(forward, 0.55).setY(1.25));
      // The diagonal of the model spans 0.4 m.
      expect(model.getSize(new Vector3()).length() / framed.scale).toBeCloseTo(0.4, 6);
      // Up stays up, and the viewer looks along the scene's -Z, at the model's front.
      close(up.clone().applyQuaternion(framed.quaternion), up);
      close(forward.clone().applyQuaternion(framed.quaternion), new Vector3(0, 0, -1));
    }
  });

  it('frames from a level direction even when the viewer looks straight down', () => {
    const framed = frameRig(head(new Vector3(0, 1.6, 0), 0.5, -Math.PI / 2), model);
    close(up.clone().applyQuaternion(framed.quaternion), up);
    expect(Number.isFinite(framed.position.length())).toBe(true);
  });

  it('keeps a huge or tiny model within the magnification limits', () => {
    const size = (extent: number) =>
      frameRig(head(new Vector3()), new Box3(new Vector3(), new Vector3(extent, extent, extent)));
    expect(magnification(size(1e6))).toBe(magnificationLimits.min);
    expect(magnification(size(1e-3))).toBe(magnificationLimits.max);
  });
});

describe('moving the world by hand', () => {
  it('one hand carries the point it holds, without turning or resizing', () => {
    const start = rig();
    const from = new Vector3(0.2, 1.1, -0.4),
      to = new Vector3(-0.1, 1.4, -0.2);
    const moved = dragRig(start, from, to);
    close(toScene(moved, to), toScene(start, from));
    expect(moved.scale).toBe(start.scale);
    expect(moved.quaternion.angleTo(start.quaternion)).toBeCloseTo(0, 9);
  });

  it('two hands keep hold of both points when free to tilt', () => {
    const start = rig();
    const from: [Vector3, Vector3] = [new Vector3(-0.2, 1.1, -0.4), new Vector3(0.2, 1.2, -0.3)];
    const to: [Vector3, Vector3] = [new Vector3(-0.35, 1.3, -0.5), new Vector3(0.3, 0.9, -0.1)];
    const moved = pinchRig(start, from, to, false);
    close(toScene(moved, to[0]), toScene(start, from[0]), 4);
    close(toScene(moved, to[1]), toScene(start, from[1]), 4);
    expect(magnification(moved) / magnification(start)).toBeCloseTo(
      to[0].distanceTo(to[1]) / from[0].distanceTo(from[1]),
      9,
    );
  });

  it('two hands kept level turn the world about the vertical and hold its middle', () => {
    const start = { ...rig(), quaternion: new Quaternion().setFromAxisAngle(up, 0.4) };
    const from: [Vector3, Vector3] = [new Vector3(-0.2, 1.1, -0.4), new Vector3(0.2, 1.2, -0.3)];
    const to: [Vector3, Vector3] = [new Vector3(-0.35, 1.3, -0.5), new Vector3(0.3, 0.9, -0.1)];
    const moved = pinchRig(start, from, to, true);
    close(up.clone().applyQuaternion(moved.quaternion), up);
    const middle = (pair: [Vector3, Vector3]) => pair[0].clone().add(pair[1]).multiplyScalar(0.5);
    close(toScene(moved, middle(to)), toScene(start, middle(from)), 4);
    // Seen from above, the line between the hands turned the world by as much as it turned.
    const heading = (pair: [Vector3, Vector3]) =>
      Math.atan2(pair[1].x - pair[0].x, pair[1].z - pair[0].z);
    const turned = new Quaternion().setFromAxisAngle(up, heading(to) - heading(from));
    expect(
      moved.quaternion.angleTo(start.quaternion.clone().multiply(turned.invert())),
    ).toBeCloseTo(0, 6);
  });

  it('ignores hands too close together to give a direction or a size', () => {
    const start = rig();
    const at = new Vector3(0, 1, 0);
    const moved = pinchRig(start, [at, at.clone()], [at, new Vector3(0.3, 1, 0)], false);
    expect(moved.scale).toBe(start.scale);
    expect(moved.quaternion.angleTo(start.quaternion)).toBeCloseTo(0, 9);
  });

  it('ignores invalid pinch poses instead of corrupting the view transform', () => {
    const start = rig(),
      a = new Vector3(-0.1, 1, 0),
      b = new Vector3(0.1, 1, 0);
    for (const invalid of [NaN, Infinity, -Infinity, 1e308]) {
      const moved = pinchRig(start, [a, b], [a, new Vector3(invalid, 1, 0)], true);
      close(moved.position, start.position);
      expect(moved.scale).toBe(start.scale);
      expect(moved.quaternion.angleTo(start.quaternion)).toBeCloseTo(0, 9);
    }
  });

  it('stops resizing at the limits', () => {
    const a = new Vector3(-0.01, 1, 0),
      b = new Vector3(0.01, 1, 0);
    const wide: [Vector3, Vector3] = [new Vector3(-5, 1, 0), new Vector3(5, 1, 0)];
    expect(magnification(pinchRig(rig(), [a, b], wide, true))).toBe(magnificationLimits.max);
    expect(magnification(pinchRig(rig(), wide, [a, b], true))).toBe(magnificationLimits.min);
  });

  it('resizes about a point that stays where it is', () => {
    const start = rig();
    const center = new Vector3(5, 60, -10);
    const life = rescaleRig(start, center, 1);
    expect(magnification(life)).toBe(1);
    close(toRoom(life, center), toRoom(start, center));
    expect(life.quaternion.angleTo(start.quaternion)).toBeCloseTo(0, 9);
  });

  it('stands a tilted world upright without turning it away', () => {
    const start = rig();
    const center = new Vector3(5, 60, -10);
    const level = levelRig(start, center);
    close(up.clone().applyQuaternion(level.quaternion), up);
    close(toRoom(level, center), toRoom(start, center));
    // A world that was only turned about the vertical is left as it was.
    const turned = { ...rig(), quaternion: new Quaternion().setFromAxisAngle(up, 1.3) };
    expect(levelRig(turned, center).quaternion.angleTo(turned.quaternion)).toBeCloseTo(0, 9);
  });
});

describe('stable world gestures', () => {
  const pair = (span: number, center = new Vector3(0, 1.2, -0.3)): [Vector3, Vector3] => [
    center.clone().add(new Vector3(-span / 2, 0, 0)),
    center.clone().add(new Vector3(span / 2, 0, 0)),
  ];
  const unchanged = (actual: Rig, expected: Rig) => {
    close(actual.position, expected.position, 8);
    expect(actual.scale).toBeCloseTo(expected.scale, 8);
    expect(actual.quaternion.angleTo(expected.quaternion)).toBeLessThan(1e-7);
  };

  it('keeps one-hand dragging one-to-one even with precision enabled', () => {
    const start = rig(),
      from = new Vector3(0.2, 1.1, -0.3);
    const gesture = new WorldGesture(start, [from], true, true);
    const to = from.clone().add(new Vector3(0.03, -0.02, 0.04));
    unchanged(gesture.update([to], true, true), dragRig(start, from, to));
  });

  it('holds both scene points through incremental unconstrained movement', () => {
    const start = rig(),
      from = pair(0.3);
    const gesture = new WorldGesture(start, from, false);
    const points = from.map((point) => toScene(start, point));
    for (const next of [
      [new Vector3(-0.2, 1.25, -0.3), new Vector3(0.2, 1.1, -0.25)],
      [new Vector3(-0.1, 1.3, -0.4), new Vector3(0.3, 1.2, -0.2)],
    ]) {
      const current = gesture.update(next, false);
      next.forEach((point, index) => close(toScene(current, point), points[index], 6));
    }
  });

  it('pauses close-hand scale and resumes from the new baseline without a jump', () => {
    const start = rig(),
      gesture = new WorldGesture(start, pair(0.2), true);
    const approaching = gesture.update(pair(0.04), true);
    expect(magnification(approaching)).toBeCloseTo(magnification(start) * 0.2);
    for (const span of [0.029, 0.01, 0, 0.035, 0.049, 0.051])
      unchanged(gesture.update(pair(span), true), approaching);
    expect(magnification(gesture.update(pair(0.102), true))).toBeCloseTo(
      magnification(approaching) * 2,
    );
  });

  it('starts with close hands without disabling zoom for the rest of the gesture', () => {
    const start = rig(),
      gesture = new WorldGesture(start, pair(0.01), true);
    unchanged(gesture.update(pair(0.06), true), start);
    expect(magnification(gesture.update(pair(0.12), true))).toBeCloseTo(magnification(start) * 2);
  });

  it('does not flip the world when hands cross between samples', () => {
    const start = rig(),
      gesture = new WorldGesture(start, pair(0.2), true);
    unchanged(gesture.update(pair(-0.2), true), start);
    unchanged(gesture.update(pair(-0.21), true), start);
    expect(magnification(gesture.update(pair(-0.42), true))).toBeCloseTo(magnification(start) * 2);
  });

  it('pauses yaw independently when a tall hand span becomes nearly vertical', () => {
    const start = { ...rig(), quaternion: new Quaternion() };
    const center = new Vector3(0, 1.2, -0.3);
    const tiltedPair = (x: number, z: number) => {
      const half = new Vector3(x, 0.3, z).multiplyScalar(0.5);
      return [center.clone().sub(half), center.clone().add(half)];
    };
    const gesture = new WorldGesture(start, tiltedPair(0.2, 0), true);
    const turned = gesture.update(tiltedPair(0.03, 0.04), true);
    for (const [x, z] of [
      [0.005, 0.005],
      [-0.005, -0.005],
      [-0.04, -0.04],
    ]) {
      const next = gesture.update(tiltedPair(x, z), true);
      expect(next.quaternion.angleTo(turned.quaternion)).toBeLessThan(1e-7);
    }
  });

  it('rebases count changes, missing poses, and precision toggles without moving the view', () => {
    const start = rig(),
      hands = pair(0.2);
    const gesture = new WorldGesture(start, [hands[0]], true);
    unchanged(gesture.update(hands, true), start);
    const enlarged = gesture.update(pair(0.4), true);
    unchanged(gesture.update([new Vector3(0.4, 1.2, -0.3)], true), enlarged);
    unchanged(gesture.update([new Vector3(NaN, 0, 0)], true), enlarged);
    unchanged(gesture.update([new Vector3(5, 6, 7)], true), enlarged);
    unchanged(gesture.update(pair(0.2), true, true), enlarged);
    expect(magnification(gesture.update(pair(0.4), true, true))).toBeCloseTo(
      magnification(enlarged) * Math.pow(2, 0.1),
    );
  });

  it('reverses immediately away from a magnification limit', () => {
    const start = { ...rig(), scale: 1000 / 190 };
    const gesture = new WorldGesture(start, pair(0.2), true);
    expect(magnification(gesture.update(pair(0.4), true))).toBe(magnificationLimits.max);
    expect(magnification(gesture.update(pair(0.3), true))).toBeCloseTo(150);
  });

  it('takes the short yaw through the angle branch cut in precision mode', () => {
    const start = { ...rig(), quaternion: new Quaternion() };
    const atAngle = (degrees: number) => {
      const angle = (degrees * Math.PI) / 180;
      const span = new Vector3(Math.sin(angle), 0, Math.cos(angle)).multiplyScalar(0.1);
      return [span.clone().negate(), span];
    };
    const gesture = new WorldGesture(start, atAngle(179), true, true);
    const next = gesture.update(atAngle(-179), true, true);
    expect(next.quaternion.angleTo(start.quaternion)).toBeCloseTo((0.2 * Math.PI) / 180, 8);
  });

  it('turns around a fixed pivot in room coordinates and ignores non-finite requests', () => {
    const start = rig(),
      pivot = new Vector3(12, 45, -18),
      point = new Vector3(42, 80, 22);
    const angle = Math.PI / 6,
      roomPivot = toRoom(start, pivot);
    const rotated = turnRig(start, pivot, angle);
    close(toRoom(rotated, pivot), roomPivot);
    const expected = toRoom(start, point).sub(roomPivot).applyAxisAngle(up, angle).add(roomPivot);
    close(toRoom(rotated, point), expected);
    expect(rotated.scale).toBe(start.scale);
    unchanged(turnRig(start, pivot, NaN), start);
    unchanged(rescaleRig(start, pivot, Infinity), start);
    unchanged(rescaleRig(start, new Vector3(NaN, 0, 0), 2), start);
  });
});

describe('holding a part', () => {
  const part = {
    position: [10, 20, 30] as [number, number, number],
    quaternion: new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), 0.3).toArray() as [
      number,
      number,
      number,
      number,
    ],
  };
  const grab = {
    position: new Vector3(100, 50, 200),
    quaternion: new Quaternion().setFromAxisAngle(up, 0.2),
    pivot: new Vector3(12, 24, 31),
  };

  it('leaves it alone until the hand moves', () => {
    const held = heldPose(part, grab, grab);
    held.position.forEach((value, i) => expect(value).toBeCloseTo(part.position[i], 9));
    held.quaternion.forEach((value, i) => expect(value).toBeCloseTo(part.quaternion[i], 9));
  });

  it('moves it exactly as far as the hand, however far away it is held', () => {
    const hand = { ...grab, position: grab.position.clone().add(new Vector3(3, -2, 5)) };
    const held = heldPose(part, grab, hand);
    expect(held.position).toEqual([13, 18, 35]);
    held.quaternion.forEach((value, i) => expect(value).toBeCloseTo(part.quaternion[i], 9));
  });

  it('turns it with the wrist about the point it was taken by', () => {
    const twist = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), Math.PI / 2);
    const hand = { ...grab, quaternion: twist.clone().multiply(grab.quaternion) };
    const held = heldPose(part, grab, hand);
    // The part's origin swings a quarter turn around the pivot.
    const expected = new Vector3(...part.position)
      .sub(grab.pivot)
      .applyQuaternion(twist)
      .add(grab.pivot);
    close(new Vector3(...held.position), expected);
    expect(
      new Quaternion(...held.quaternion).angleTo(
        twist.clone().multiply(new Quaternion(...part.quaternion)),
      ),
    ).toBeCloseTo(0, 6);
  });
});

describe('labels and settings', () => {
  it('writes magnification briefly', () => {
    expect(scaleLabel(1)).toBe('1×');
    expect(scaleLabel(2.639)).toBe('2.64×');
    expect(scaleLabel(0.25)).toBe('0.25×');
    expect(scaleLabel(12.34)).toBe('12.3×');
    expect(scaleLabel(150.4)).toBe('150×');
  });

  it('falls back to the defaults for settings it cannot read', () => {
    expect(sanitizeXRSettings(null)).toEqual({ level: true, mode: 'ar' });
    expect(sanitizeXRSettings({ level: false, mode: 'vr' })).toEqual({ level: false, mode: 'vr' });
    expect(sanitizeXRSettings({ level: 'yes', mode: 'hologram' })).toEqual({
      level: true,
      mode: 'ar',
    });
  });
});
