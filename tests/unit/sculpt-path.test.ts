import { expect, it } from 'vitest';
import { SculptPath, type SculptSample } from '../../src/core/sculpt-path';

const pen = (clientX: number, clientY = 0, pressure = 1): SculptSample => ({
  clientX,
  clientY,
  pressure,
  pointerType: 'pen',
  tiltX: 0,
  tiltY: 0,
  twist: 0,
  shiftKey: false,
  altKey: false,
});

it('lazily covers a fast sweep at the configured spacing and keeps its endpoint', () => {
  const path = new SculptPath(pen(0, 0, 0.1), () => 2, 0);
  path.push(pen(475, 0, 1), true);
  expect(path.next()).toEqual(pen(0, 0, 0.1));
  let previous = 0;
  let count = 0;
  for (let sample = path.next(); sample; sample = path.next()) {
    expect(sample.clientX - previous).toBeLessThanOrEqual(2.00001);
    previous = sample.clientX;
    count++;
  }
  expect(count).toBe(238);
  expect(previous).toBe(475);
  expect(path.pending).toBe(false);
});

it('carries spacing around the actual input path and accepts another move after draining', () => {
  const path = new SculptPath(pen(0), () => 4, 0);
  path.push(pen(3));
  path.push(pen(3, 3));
  expect(path.next()).toEqual(pen(0));
  expect(path.next()).toEqual(pen(3, 1));
  expect(path.next()).toBeUndefined();
  path.push(pen(6, 3), true);
  expect(path.next()).toEqual(pen(5, 3));
  expect(path.next()).toEqual(pen(6, 3));
  expect(path.next()).toBeUndefined();
});
