import type { BufferGeometry } from 'three';
import { same } from './sync';
import type { Part, Quat, SculptBrush, SculptureSettings, Vec3 } from './types';

export interface SculptTarget {
  partId: string;
  source: string;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
}

export function matchesSculptTarget(part: Part | undefined, target: SculptTarget) {
  return (
    part?.visible &&
    !part.locked &&
    part.id === target.partId &&
    part.geometry.uuid === target.source &&
    same(part.position, target.position) &&
    same(part.quaternion, target.quaternion) &&
    same(part.scale, target.scale)
  );
}

export interface SculptStrokeCommit {
  partId: string;
  source: BufferGeometry;
  epoch: number;
  revision?: number;
  position: Vec3;
  quaternion: Quat;
  scale: Vec3;
  geometry: BufferGeometry | null;
  mask: Float32Array | null;
}

interface SculptSnapshot {
  geometry: string;
  mask: Float32Array | null;
}

export interface SculptStep {
  before: SculptSnapshot;
  after: SculptSnapshot;
}

export interface SculptSession {
  partId: string;
  settings: SculptureSettings;
  byBrush: Partial<Record<SculptBrush, SculptureSettings>>;
  defaultRadius: number;
  mask: Float32Array | null;
  revision: number;
  past: SculptStep[];
  future: SculptStep[];
  pending: { id: number; direction: 'undo' | 'redo'; step: SculptStep } | null;
}

export function sculptDefaults(
  brush: SculptBrush,
  radius: number,
  maskVisible = true,
): SculptureSettings {
  return {
    brush,
    radius,
    strength: 0.35,
    detail: 0.5,
    minEdge: 0.05,
    falloff: 'soft',
    symmetry: false,
    spacing: 0.2,
    stabilization: 0,
    pressureStrength: true,
    pressureRadius: false,
    pressureCurve: 1,
    aspect: 1,
    rotation: 0,
    tilt: false,
    twist: false,
    pinch: 0.5,
    maskVisible,
  };
}

export const maskHistoryBytes = 64 * 1024 * 1024;
export const sculptHistoryBytes = 256 * 1024 * 1024;

/** Count unique allocations because consecutive strokes can share unchanged weights. */
export function appendSculptStep(past: SculptStep[], step: SculptStep) {
  const kept = [...past, step].slice(-40);
  const seen = new Set([step.after.mask?.buffer]);
  let bytes = 0;
  for (let i = kept.length - 1; i >= 0; i--) {
    for (const { mask } of [kept[i].before, kept[i].after]) {
      if (mask && !seen.has(mask.buffer)) {
        seen.add(mask.buffer);
        bytes += mask.buffer.byteLength;
      }
    }
    if (bytes > maskHistoryBytes) return kept.slice(i + 1);
  }
  return kept;
}

export function stepSculptSession(
  session: SculptSession,
  direction: 'undo' | 'redo',
  step: SculptStep,
): SculptSession {
  const undo = direction === 'undo';
  return {
    ...session,
    revision: session.revision + 1,
    mask: (undo ? step.before : step.after).mask,
    pending: null,
    past: undo ? session.past.slice(0, -1) : [...session.past, step],
    future: undo ? [step, ...session.future] : session.future.slice(1),
  };
}
