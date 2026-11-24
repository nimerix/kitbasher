import type { BufferGeometry } from 'three';
import { PackedArray, packArray } from './sculpt-history';
import { historyLimit } from './history-budget';
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

type MaskSnapshot = PackedArray<Float32Array> | null;
const maskSnapshots = new WeakMap<Float32Array, PackedArray<Float32Array>>();

export function archiveMask(
  mask: Float32Array | null,
  previous?: Float32Array | null,
): MaskSnapshot {
  if (!mask) return null;
  const known = maskSnapshots.get(mask);
  if (known) return known;
  let packed = packArray(
    mask,
    previous ?? undefined,
    previous ? maskSnapshots.get(previous) : undefined,
  );
  if (
    packed.slices.length &&
    packed.slices.reduce(
      (bytes, slice) => bytes + slice.bytes.byteLength,
      packed.base.buffer.byteLength,
    ) > maskHistoryBytes
  )
    packed = packArray(mask);
  maskSnapshots.set(mask, packed);
  return packed;
}

export function restoreMask(snapshot: MaskSnapshot) {
  if (!snapshot) return null;
  const mask = snapshot.restore();
  maskSnapshots.set(mask, snapshot);
  return mask;
}

interface SculptSnapshot {
  geometry: string;
  mask: MaskSnapshot;
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
export function appendSculptStep(
  past: SculptStep[],
  step: SculptStep,
  current: Float32Array | null,
) {
  const kept = [...past, step].slice(-historyLimit);
  const seen = new Set<ArrayBufferLike>();
  const masks = new Set<MaskSnapshot>();
  if (current) seen.add(current.buffer);
  let bytes = 0;
  const count = (buffer: ArrayBufferLike) => {
    if (seen.has(buffer)) return;
    seen.add(buffer);
    bytes += buffer.byteLength;
  };
  for (let i = kept.length - 1; i >= 0; i--) {
    for (const { mask } of [kept[i].before, kept[i].after]) {
      if (!mask || masks.has(mask)) continue;
      masks.add(mask);
      count(mask.base.buffer);
      for (const slice of mask.slices) count(slice.bytes.buffer);
    }
    if (bytes <= maskHistoryBytes) continue;
    if (i < kept.length - 1) return kept.slice(i + 1);
    // The latest mask already lives in the session. Keeping it directly frees
    // its patches when the preceding mask needs the entire undo budget.
    if (current) {
      const full = packArray(current);
      maskSnapshots.set(current, full);
      return [{ ...step, after: { ...step.after, mask: full } }];
    }
    return [step];
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
    mask: restoreMask((undo ? step.before : step.after).mask),
    pending: null,
    past: undo ? session.past.slice(0, -1) : [...session.past, step],
    future: undo ? [step, ...session.future] : session.future.slice(1),
  };
}
