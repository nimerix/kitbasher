import './shims';
import { createWriteStream, existsSync, openAsBlob } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { ReadableStream as NodeReadableStream } from 'node:stream/web';
import { DoubleSide, Euler, Matrix3, Matrix4, Quaternion, Ray, Vector3 } from 'three';
import { fitAnchors, anchorGaps } from '../src/core/anchor-fit';
import { solveAlignment } from '../src/core/alignment';
import { evaluateBoolean } from '../src/core/boolean';
import type { ClipReport } from '../src/core/clipping';
import type { BooleanOperation } from '../src/core/boolean';
import { captureComponents, instantiateComponents } from '../src/core/clipboard';
import { anchorError, isJointConnected } from '../src/core/constraints';
import {
  export3mf,
  exportBlenderPackage,
  exportGlb,
  exportStl,
  importModels,
} from '../src/core/files';
import {
  bakedPartGeometry,
  binaryGeometry,
  combineParts,
  deserializeGeometry,
  partMatrix,
  partPivot,
  poseAtPivot,
  quat,
  radians,
  rotationDegrees,
  transformFromMatrix,
  triangleCount,
  vec,
  worldNormal,
  worldPoint,
} from '../src/core/geometry';
import { inspectMeshes } from '../src/core/inspection';
import { assertClosed, mergedPart } from '../src/core/merge';
import {
  planeConstraintResidual,
  solvePlaneConstraints,
  validatePlaneConstraints,
} from '../src/core/plane-constraints';
import { referencePlanes, resolvePart } from '../src/core/references';
import { createSample } from '../src/core/sample';
import { readSceneFile, sceneFileBlob, sceneSubset } from '../src/core/scene-file';
import { useEditor } from '../src/core/store';
import { facesUnderBrush, maxPaintTriangles } from '../src/core/surfaces';
import type {
  AssemblyOperation,
  AxisLocks,
  FitAnchor,
  Part,
  PlaneConstraint,
  PlaneConstraintKind,
  Quat,
  SceneDocument,
  SurfacePair,
  SurfacePatch,
  SurfacePoint,
  Vec3,
} from '../src/core/types';
import { agent, sharedDocument } from './document';
import { closestSurface, ensureBvh, unionBounds, worldBounds } from './measure';
import { buildPartGeometry, parseColor } from './shapes';
import type { ShapeSpec } from './shapes';

export const faces = ['+x', '-x', '+y', '-y', '+z', '-z', 'center'] as const;
export type Face = (typeof faces)[number];

export interface PointRef {
  face?: Face;
  local?: number[];
  world?: number[];
  normal?: number[];
}

export interface PartSpec {
  id?: string;
  name: string;
  shapes: ShapeSpec[];
  position?: number[];
  rotation?: number[];
  scale?: number[];
  color?: string;
  locked?: boolean;
  visible?: boolean;
}

export interface PartUpdate {
  id: string;
  name?: string;
  color?: string;
  visible?: boolean;
  locked?: boolean;
  pivot?: number[] | null;
  position?: number[];
  translate?: number[];
  rotation?: number[];
  quaternion?: number[];
  rotate_by?: { axis: number[]; degrees: number; about?: number[] };
  scale?: number[];
}

export interface Placement {
  id: string;
  target?: string;
  side?: Exclude<Face, 'center'>;
  gap?: number;
  align?: Partial<Record<'x' | 'y' | 'z', 'center' | 'min' | 'max' | 'keep'>>;
  offset?: number[];
}

export interface DuplicateSpec {
  ids: string[];
  count?: number;
  translate?: number[];
  rotate?: { axis: number[]; degrees: number; about?: number[] };
  mirror?: { axis: 'x' | 'y' | 'z'; at?: number };
  names?: string[];
}

export interface PatchSpec {
  part?: string;
  point: number[];
  radius: number;
  plane_angle?: number;
  plane_distance?: number;
}

const editor = () => useEditor.getState();
const blankScene = (name = 'Untitled assembly'): SceneDocument => ({
  name,
  parts: [],
  joints: [],
  constraints: [],
});

const round = (value: number) => Math.round(value * 1e4) / 1e4 || 0;
const rounded = (values: ArrayLike<number>) => Array.from(values, round);

export const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'part';

const reservedIds = new Set(referencePlanes.map((plane) => plane.id));

function uniqueId(wanted: string, taken: Iterable<string>) {
  const used = new Set([...taken, ...reservedIds]);
  if (!used.has(wanted)) return wanted;
  for (let index = 2; ; index++) {
    const candidate = `${wanted}-${index}`;
    if (!used.has(candidate)) return candidate;
  }
}

function tuple3(value: number[] | undefined, label: string): Vec3 {
  if (!value || value.length !== 3 || !value.every(Number.isFinite))
    throw new Error(`${label} must be [x, y, z].`);
  return value as Vec3;
}

const checkedScale = (scale: number[]) => {
  const value = tuple3(scale, 'scale');
  // Scene files reject a collapsed part, so it could never be reopened.
  if (value.some((n) => Math.abs(n) < 1e-6)) throw new Error('scale values must not be zero.');
  return value;
};

export function requirePart(id: string): Part {
  const parts = editor().scene.parts;
  const exact = parts.find((part) => part.id === id);
  if (exact) return exact;
  const named = parts.filter((part) => part.name === id);
  if (named.length === 1) return named[0];
  const known = parts.map((part) => part.id);
  throw new Error(
    `There is no part "${id}".${known.length ? ` Parts: ${known.slice(0, 40).join(', ')}${known.length > 40 ? ', …' : ''}.` : ' The scene is empty.'}`,
  );
}

/** Alignment targets can also be the world reference planes. */
const requireTarget = (id: string) => resolvePart(editor().scene, id) ?? requirePart(id);

function requireUnlocked(id: string) {
  const part = requirePart(id);
  if (part.locked) throw new Error(`"${part.id}" is locked. Unlock it with update_parts first.`);
  return part;
}

export function describePart(part: Part) {
  const bounds = worldBounds(part);
  const rotation = rotationDegrees(part);
  return {
    id: part.id,
    name: part.name,
    position: rounded(part.position),
    ...(rotation.some((value) => Math.abs(value) > 1e-6) ? { rotation: rounded(rotation) } : {}),
    ...(part.scale.some((value) => value !== 1) ? { scale: rounded(part.scale) } : {}),
    bounds: { min: rounded(bounds.min.toArray()), max: rounded(bounds.max.toArray()) },
    size: rounded(bounds.max.clone().sub(bounds.min).toArray()),
    triangles: triangleCount(part.geometry),
    ...(part.color !== '#ffffff' ? { color: part.color } : {}),
    ...(part.locked ? { locked: true } : {}),
    ...(!part.visible ? { visible: false } : {}),
    ...(part.pivot ? { pivot: rounded(part.pivot) } : {}),
    ...(part.anchors?.length
      ? { anchors: part.anchors.length, anchor_gaps: rounded(anchorGaps(part)) }
      : {}),
  };
}

function setScene(scene: SceneDocument) {
  useEditor.setState((state) => ({ scene, revision: state.revision + 1 }));
}

/**
 * Runs one tool call as one undo step that either fully applies or changes nothing. Store actions
 * report failures as notifications for the UI, so they are turned back into errors here.
 */
function transaction<T>(run: () => T): T {
  const { scene, revision, tool, operation, selected } = editor();
  useEditor.setState({ toast: null });
  try {
    const result = run();
    const after = editor();
    if (after.toast?.kind === 'error') throw new Error(after.toast.message);
    useEditor.setState({ toast: null });
    // Nothing is shared until the whole call has worked.
    sharedDocument.commit(agent, scene);
    return result;
  } catch (error) {
    const scratch = editor();
    useEditor.setState({
      scene,
      revision: scratch.scene === scene ? revision : scratch.revision + 1,
      tool,
      operation,
      selected,
      toast: null,
    });
    throw error;
  }
}

/** A store action that declines work leaves the scene alone and explains why in a notification. */
function required(run: () => void) {
  const before = editor().scene;
  useEditor.setState({ toast: null });
  run();
  const { scene, toast } = editor();
  if (toast?.kind === 'error' || (scene === before && toast)) throw new Error(toast.message);
}

function throwIfFailed() {
  const { toast } = editor();
  if (toast?.kind === 'error') throw new Error(toast.message);
}

export function surfacePoint(part: Part, ref: PointRef, label = 'point'): SurfacePoint {
  const given = [ref.face, ref.local, ref.world].filter((value) => value !== undefined);
  if (given.length !== 1) throw new Error(`${label} needs exactly one of face, local, or world.`);
  const toLocalNormal = (normal: Vector3) =>
    normal.applyMatrix3(new Matrix3().getNormalMatrix(partMatrix(part)).invert()).normalize();
  if (ref.face) {
    if (!part.geometry.boundingBox) part.geometry.computeBoundingBox();
    const box = part.geometry.boundingBox!;
    const point = box.getCenter(new Vector3());
    const normal = new Vector3(0, 1, 0);
    if (ref.face !== 'center') {
      const axis = ref.face[1] as 'x' | 'y' | 'z';
      const positive = ref.face[0] === '+';
      point[axis] = positive ? box.max[axis] : box.min[axis];
      normal.set(0, 0, 0)[axis] = positive ? 1 : -1;
    }
    return { partId: part.id, point: point.toArray(), normal: normal.toArray() };
  }
  const local = ref.local
    ? tuple3(ref.local, `${label}.local`)
    : vec(tuple3(ref.world, `${label}.world`))
        .applyMatrix4(partMatrix(part).invert())
        .toArray();
  const normal = ref.normal
    ? ref.local
      ? vec(tuple3(ref.normal, `${label}.normal`)).normalize()
      : toLocalNormal(vec(tuple3(ref.normal, `${label}.normal`)).normalize())
    : vec(closestSurface(part, local).normal as Vec3).normalize();
  if (normal.lengthSq() === 0 || !Number.isFinite(normal.x))
    throw new Error(`${label}.normal must not be zero.`);
  return { partId: part.id, point: [...local] as Vec3, normal: normal.toArray() };
}

function requestedPose(part: Part, update: PartUpdate): Partial<Part> {
  const scene = editor().scene;
  const anchor = scene.joints.find(
    (j) => j.childId === part.id && isJointConnected(j),
  )?.childAnchor;
  const patch: Partial<Part> = {};
  let next = part;
  const orientation: Pick<Partial<Part>, 'quaternion' | 'scale'> = {};
  if (update.rotation && update.quaternion)
    throw new Error('Set rotation or quaternion, not both.');
  if (update.position && update.translate) throw new Error('Set position or translate, not both.');
  if (update.rotation)
    orientation.quaternion = new Quaternion()
      .setFromEuler(new Euler(...(tuple3(update.rotation, 'rotation').map(radians) as Vec3)))
      .toArray();
  if (update.quaternion) {
    if (update.quaternion.length !== 4 || !update.quaternion.every(Number.isFinite))
      throw new Error('quaternion must be [x, y, z, w].');
    orientation.quaternion = new Quaternion(...(update.quaternion as Quat)).normalize().toArray();
  }
  if (update.scale) orientation.scale = checkedScale(update.scale);
  if (orientation.quaternion || orientation.scale) {
    next = poseAtPivot(part, orientation, anchor);
    Object.assign(patch, orientation, { position: next.position });
  }
  if (update.rotate_by) {
    const { axis, degrees, about } = update.rotate_by;
    const direction = vec(tuple3(axis, 'rotate_by.axis'));
    if (direction.lengthSq() === 0) throw new Error('rotate_by.axis must not be zero.');
    const rotation = new Quaternion().setFromAxisAngle(direction.normalize(), radians(degrees));
    const pivot = about ? vec(tuple3(about, 'rotate_by.about')) : partPivot(next, anchor);
    patch.position = vec(next.position).sub(pivot).applyQuaternion(rotation).add(pivot).toArray();
    patch.quaternion = rotation.clone().multiply(quat(next.quaternion)).normalize().toArray();
    next = { ...next, ...patch };
  }
  if (update.position) patch.position = [...tuple3(update.position, 'position')];
  if (update.translate)
    patch.position = vec(next.position)
      .add(vec(tuple3(update.translate, 'translate')))
      .toArray();
  return patch;
}

/** What staying clear of other parts did to a placement, when it did anything. */
function clipResult(report: ClipReport | null | undefined) {
  if (!report || (!report.unresolved && report.moved < 0.001)) return {};
  return {
    clip: {
      moved_mm: round(report.moved),
      overlap_mm: round(report.depth),
      blocked_by: report.blockers,
      ...(report.unresolved ? { unresolved: true } : {}),
    },
  };
}

function moveResult(before: Part, requested: Partial<Part>) {
  const after = requirePart(before.id);
  const { toast } = editor();
  const achieved = (['position', 'quaternion', 'scale'] as const).every((key) => {
    const wanted = requested[key];
    return !wanted || wanted.every((value, i) => Math.abs(value - after[key][i]) < 1e-6);
  });
  return {
    ...describePart(after),
    ...(achieved ? {} : { constrained: true }),
    ...(toast?.kind === 'info' ? { note: toast.message } : {}),
  };
}

function withFriendlyIds(parts: Part[], names?: string[]) {
  const taken = new Set(editor().scene.parts.map((part) => part.id));
  return parts.map((part, i) => {
    const name = names?.[i] ?? part.name;
    const id = uniqueId(slug(name), taken);
    taken.add(id);
    return { ...part, id, name };
  });
}

const statusOf = (pair: { volume: number | null; distance: number }) =>
  pair.volume && pair.volume > 0 ? 'overlap' : pair.distance < 1e-3 ? 'touching' : 'near';

export class Session {
  private file: string | null = null;
  /** A scene someone opens in the live view replaces the one this file held. */
  private fileEpoch = 0;

  constructor() {
    sharedDocument.replace(blankScene());
  }

  get path() {
    return this.fileEpoch === sharedDocument.epoch ? this.file : null;
  }

  private setPath(file: string | null) {
    this.file = file;
    this.fileEpoch = sharedDocument.epoch;
  }

  private assertDiscardable(discard = false) {
    const { revision, savedRevision, scene } = editor();
    if (!discard && revision !== savedRevision && scene.parts.length)
      throw new Error(
        `"${scene.name}" has unsaved changes. Call save_scene first, or pass discard_unsaved: true.`,
      );
  }

  newScene(name?: string, sample = false, discard = false) {
    this.assertDiscardable(discard);
    const scene = sample ? createSample() : blankScene(name);
    if (name) scene.name = name;
    sharedDocument.replace(scene);
    this.setPath(null);
    return this.summary();
  }

  async openScene(path: string, discard = false) {
    this.assertDiscardable(discard);
    const file = resolve(path);
    if (!['.kitbash', '.json'].includes(extname(file).toLowerCase()))
      throw new Error('Scene files end in .kitbash.');
    if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    sharedDocument.replace(await readSceneFile(await openAsBlob(file)));
    this.setPath(file);
    return this.summary();
  }

  async saveScene(path?: string, overwrite = false) {
    const wanted = path ?? this.path;
    if (!wanted) throw new Error('This scene has no file yet. Pass a path ending in .kitbash.');
    const file = resolve(extname(wanted) ? wanted : `${wanted}.kitbash`);
    if (extname(file).toLowerCase() !== '.kitbash')
      throw new Error('Scene files end in .kitbash. Use export_scene for other formats.');
    if (file !== this.path && existsSync(file) && !overwrite)
      throw new Error(`${file} already exists. Pass overwrite: true to replace it.`);
    const { scene, revision } = editor();
    const bytes = await writeAtomically(file, await sceneFileBlob(scene));
    this.setPath(file);
    editor().markSaved(revision);
    return { path: file, bytes, parts: scene.parts.length };
  }

  async exportScene(path: string, ids?: string[], overwrite = false) {
    const file = resolve(path);
    const extension = extname(file).toLowerCase();
    if (!['.glb', '.stl', '.3mf', '.zip'].includes(extension))
      throw new Error('Export to a path ending in .glb, .stl, .3mf, or .zip (a Blender package).');
    if (existsSync(file) && !overwrite)
      throw new Error(`${file} already exists. Pass overwrite: true to replace it.`);
    const scene = editor().scene;
    const parts = ids ? ids.map(requirePart) : scene.parts;
    if (!parts.length) throw new Error('There are no parts to export.');
    const document = sceneSubset(scene, parts);
    const data: ArrayBuffer | Uint8Array =
      extension === '.glb'
        ? await exportGlb(document, parts)
        : extension === '.stl'
          ? exportStl(parts)
          : extension === '.3mf'
            ? export3mf(document, parts)
            : await exportBlenderPackage(document, parts);
    const body = new Blob([data as BlobPart]);
    return {
      path: file,
      bytes: await writeAtomically(file, body),
      parts: parts.length,
      triangles: parts.reduce((total, part) => total + triangleCount(part.geometry), 0),
    };
  }

  summary(ids?: string[], offset = 0, limit = 200) {
    const { scene, revision, savedRevision } = editor();
    const history = sharedDocument.counts(agent);
    const selected = ids ? ids.map(requirePart) : scene.parts;
    const page = selected.slice(offset, offset + limit);
    const bounds = selected.length ? unionBounds(selected) : null;
    return {
      name: scene.name,
      path: this.path,
      units: 'mm',
      unsaved: revision !== savedRevision,
      avoid_clipping: this.clipping(),
      can_undo: history.undo,
      can_redo: history.redo,
      part_count: scene.parts.length,
      triangles: scene.parts.reduce((total, part) => total + triangleCount(part.geometry), 0),
      ...(bounds
        ? {
            bounds: { min: rounded(bounds.min.toArray()), max: rounded(bounds.max.toArray()) },
            size: rounded(bounds.max.clone().sub(bounds.min).toArray()),
          }
        : {}),
      parts: page.map(describePart),
      ...(selected.length > offset + limit ? { next_offset: offset + limit } : {}),
      joints: scene.joints.map((joint) => ({
        id: joint.id,
        name: joint.name,
        parent: joint.parentId,
        child: joint.childId,
        rotation_locks: joint.rotationLocks,
        keep_connected: joint.keepConnected,
        anchor_gap: round(anchorError(scene.parts, joint)),
      })),
      plane_constraints: (scene.constraints ?? []).map((constraint) => {
        const residual = planeConstraintResidual(scene.parts, constraint);
        return {
          id: constraint.id,
          name: constraint.name,
          kind: constraint.kind,
          source: constraint.sourceId,
          target: constraint.targetId,
          offset: constraint.offset,
          angle: constraint.angle,
          opposed: constraint.opposed,
          enabled: constraint.enabled,
          residual_mm: round(residual.distance),
          residual_degrees: round((residual.angle * 180) / Math.PI),
        };
      }),
    };
  }

  clipping() {
    const { enabled, overlap } = editor().view.clip;
    return { enabled, max_overlap_mm: overlap };
  }

  setClipping(enabled?: boolean, overlap?: number) {
    const current = editor().view.clip;
    if (overlap !== undefined && (!Number.isFinite(overlap) || overlap < 0 || overlap > 5))
      throw new Error('max_overlap_mm must be from 0 to 5.');
    editor().setView({
      clip: { enabled: enabled ?? current.enabled, overlap: overlap ?? current.overlap },
    });
    return this.clipping();
  }

  addParts(specs: PartSpec[]) {
    return transaction(() => {
      const taken = new Set(editor().scene.parts.map((part) => part.id));
      const parts = specs.map((spec) => {
        if (!spec.name?.trim()) throw new Error('Every part needs a name.');
        let built;
        try {
          built = buildPartGeometry(spec.shapes, spec.color);
        } catch (error) {
          throw new Error(`Part "${spec.name}": ${(error as Error).message}`);
        }
        // An id the caller chose stays exactly as written, since later calls will use it.
        const id = spec.id?.trim() || uniqueId(slug(spec.name), taken);
        if (taken.has(id) || reservedIds.has(id))
          throw new Error(`The part id "${id}" is already in use.`);
        taken.add(id);
        const part: Part = {
          id,
          name: spec.name.trim(),
          geometry: built.geometry,
          position: spec.position ? [...tuple3(spec.position, 'position')] : [0, 0, 0],
          quaternion: spec.rotation
            ? new Quaternion()
                .setFromEuler(
                  new Euler(...(tuple3(spec.rotation, 'rotation').map(radians) as Vec3)),
                )
                .toArray()
            : [0, 0, 0, 1],
          scale: spec.scale ? [...checkedScale(spec.scale)] : [1, 1, 1],
          color: built.color,
          visible: spec.visible ?? true,
          locked: spec.locked ?? false,
          source: 'MCP',
        };
        return part;
      });
      editor().addParts(parts);
      return { added: parts.map(describePart), part_count: editor().scene.parts.length };
    });
  }

  async importModel(path: string, options: { units?: string; up?: string; center?: boolean }) {
    const file = resolve(path);
    if (!existsSync(file)) throw new Error(`${file} does not exist.`);
    const blob = await openAsBlob(file);
    const imported = await importModels([new File([blob], basename(file))], {
      units: (options.units ?? 'auto') as 'auto',
      up: (options.up ?? 'auto') as 'auto',
      center: options.center ?? false,
    });
    return transaction(() => {
      const parts = withFriendlyIds(imported);
      editor().addParts(parts);
      return { added: parts.map(describePart), part_count: editor().scene.parts.length };
    });
  }

  updateParts(updates: PartUpdate[]) {
    return transaction(() => {
      const results = updates.map((update) => {
        const part = requirePart(update.id);
        const patch: Partial<Part> = {};
        if (update.name !== undefined) {
          if (!update.name.trim()) throw new Error('A part name cannot be empty.');
          patch.name = update.name.trim();
        }
        if (update.color !== undefined) patch.color = parseColor(update.color);
        if (update.visible !== undefined) patch.visible = update.visible;
        if (update.pivot !== undefined)
          patch.pivot = update.pivot === null ? undefined : [...tuple3(update.pivot, 'pivot')];
        if (update.locked === false) patch.locked = false;
        if (Object.keys(patch).length) editor().patchParts([part.id], patch, false);
        const moved =
          update.position ||
          update.translate ||
          update.rotation ||
          update.quaternion ||
          update.rotate_by ||
          update.scale;
        let result = describePart(requirePart(part.id)) as ReturnType<typeof moveResult>;
        if (moved) {
          const current = requireUnlocked(part.id);
          const requested = requestedPose(current, update);
          editor().transform(current.id, requested, false);
          throwIfFailed();
          result = moveResult(current, requested);
        }
        if (update.locked === true) {
          editor().patchParts([part.id], { locked: true }, false);
          result = { ...result, locked: true };
        }
        return result;
      });
      return { updated: results };
    });
  }

  placeParts(placements: Placement[]) {
    return transaction(() => {
      const results = placements.map((placement) => {
        const part = requireUnlocked(placement.id);
        const bounds = worldBounds(part);
        const ground = !placement.target || placement.target === 'ground';
        const target = ground ? null : worldBounds(requirePart(placement.target!));
        const delta = new Vector3();
        const side = placement.side;
        const axes = ['x', 'y', 'z'] as const;
        const sideAxis = side ? (side[1] as 'x' | 'y' | 'z') : ground ? 'y' : null;
        for (const axis of axes) {
          const setting = placement.align?.[axis];
          if (axis === sideAxis) {
            const above = (side ?? '+y')[0] === '+';
            const gap = placement.gap ?? 0;
            const surface = target ? (above ? target.max[axis] : target.min[axis]) : 0;
            delta[axis] = above
              ? surface + gap - bounds.min[axis]
              : surface - gap - bounds.max[axis];
            continue;
          }
          const mode = setting ?? (ground ? 'keep' : 'center');
          if (mode === 'keep') continue;
          const reference = target ?? { min: new Vector3(), max: new Vector3() };
          if (mode === 'min') delta[axis] = reference.min[axis] - bounds.min[axis];
          else if (mode === 'max') delta[axis] = reference.max[axis] - bounds.max[axis];
          else
            delta[axis] =
              (reference.min[axis] + reference.max[axis]) / 2 -
              (bounds.min[axis] + bounds.max[axis]) / 2;
        }
        if (placement.offset) delta.add(vec(tuple3(placement.offset, 'offset')));
        const requested = { position: vec(part.position).add(delta).toArray() };
        editor().transform(part.id, requested, false);
        throwIfFailed();
        return moveResult(part, requested);
      });
      return { placed: results };
    });
  }

  duplicateParts(spec: DuplicateSpec) {
    return transaction(() => {
      if (!spec.ids.length) throw new Error('List at least one part to duplicate.');
      const count = spec.count ?? 1;
      if (!Number.isInteger(count) || count < 1 || count > 512)
        throw new Error('count must be a whole number from 1 to 512.');
      if (spec.mirror && count !== 1) throw new Error('mirror makes one copy, so omit count.');
      const sources = spec.ids.map(requirePart).map((part) => part.id);
      const step = new Matrix4();
      if (spec.translate)
        step.premultiply(new Matrix4().makeTranslation(vec(tuple3(spec.translate, 'translate'))));
      if (spec.rotate) {
        const about = vec(tuple3(spec.rotate.about ?? [0, 0, 0], 'rotate.about'));
        const axis = vec(tuple3(spec.rotate.axis, 'rotate.axis'));
        if (axis.lengthSq() === 0) throw new Error('rotate.axis must not be zero.');
        step
          .premultiply(new Matrix4().makeTranslation(about.clone().negate()))
          .premultiply(
            new Matrix4().makeRotationAxis(axis.normalize(), radians(spec.rotate.degrees)),
          )
          .premultiply(new Matrix4().makeTranslation(about));
      }
      if (spec.mirror) {
        const index = { x: 0, y: 1, z: 2 }[spec.mirror.axis];
        const at = spec.mirror.at ?? 0;
        const elements = [1, 1, 1];
        elements[index] = -1;
        const shift = [0, 0, 0];
        shift[index] = at * 2;
        step
          .premultiply(new Matrix4().makeScale(...(elements as Vec3)))
          .premultiply(new Matrix4().makeTranslation(...(shift as Vec3)));
      }
      const added: Part[] = [];
      const taken = new Set(editor().scene.parts.map((part) => part.id));
      let transform = new Matrix4();
      for (let copy = 0; copy < count; copy++) {
        transform = step.clone().multiply(transform);
        const scene = editor().scene;
        const clipboard = { ...captureComponents(scene, sources), nextOffset: 0 };
        const copies = instantiateComponents(clipboard, [...scene.parts, ...added]);
        const ids = new Map<string, string>();
        const parts = copies.parts.map((part, i) => {
          const name = spec.names?.[added.length + i] ?? part.name;
          const id = uniqueId(slug(name), taken);
          taken.add(id);
          ids.set(part.id, id);
          const moved = transformFromMatrix(part, transform.clone().multiply(partMatrix(part)));
          return {
            ...moved,
            id,
            name,
            anchors: part.anchors?.map((anchor) => ({
              ...anchor,
              target: vec(anchor.target).applyMatrix4(transform).toArray(),
            })),
          };
        });
        const placed = new Map(parts.map((part) => [part.id, part]));
        const joints = copies.joints.map((joint) => {
          const parentId = ids.get(joint.parentId)!,
            childId = ids.get(joint.childId)!;
          return {
            ...joint,
            parentId,
            childId,
            restRotation: quat(placed.get(parentId)!.quaternion)
              .invert()
              .multiply(quat(placed.get(childId)!.quaternion))
              .toArray(),
          };
        });
        const constraints = copies.constraints.map((constraint) => ({
          ...constraint,
          sourceId: ids.get(constraint.sourceId)!,
          targetId: ids.get(constraint.targetId)!,
        }));
        setScene({
          ...scene,
          parts: [...scene.parts, ...parts],
          joints: [...scene.joints, ...joints],
          constraints: [...(scene.constraints ?? []), ...constraints],
        });
        added.push(...parts);
      }
      return { added: added.map(describePart), part_count: editor().scene.parts.length };
    });
  }

  deleteParts(ids: string[]) {
    return transaction(() => {
      const parts = ids.map(requireUnlocked);
      const before = editor().scene;
      useEditor.setState({ selected: parts.map((part) => part.id) });
      editor().deleteSelected();
      const after = editor().scene;
      return {
        deleted: parts.map((part) => part.id),
        removed_joints: before.joints.length - after.joints.length,
        removed_plane_constraints:
          (before.constraints?.length ?? 0) - (after.constraints?.length ?? 0),
        part_count: after.parts.length,
      };
    });
  }

  mergeParts(
    ids: string[],
    mode: 'combine' | BooleanOperation,
    name?: string,
    keepOriginals = false,
  ) {
    return transaction(() => {
      if (ids.length < 2) throw new Error('List at least two parts to merge.');
      const parts = ids.map(keepOriginals ? requirePart : requireUnlocked);
      let geometry;
      if (mode === 'combine') geometry = combineParts(parts);
      else {
        parts.forEach(assertClosed);
        const total = parts.reduce((sum, part) => sum + triangleCount(part.geometry), 0);
        // Booleans run on the server's only thread, so the limit stays well inside a tool timeout.
        if (total > maxBooleanTriangles)
          throw new Error(
            `A Boolean through MCP is limited to ${maxBooleanTriangles.toLocaleString('en-US')} triangles in total. These parts have ${total.toLocaleString('en-US')}.`,
          );
        const meshes = parts.map((part) => {
          const baked = bakedPartGeometry(part);
          return binaryGeometry(baked);
        });
        geometry = deserializeGeometry(evaluateBoolean(meshes, mode));
      }
      const label = {
        combine: 'Combined',
        union: 'Boolean union',
        subtract: 'Boolean subtraction',
        intersect: 'Boolean intersection',
      }[mode];
      const merged = mergedPart(
        geometry,
        name ?? `${parts[0].name} ${mode}`,
        `${label} · ${parts.length} parts`,
      );
      const [result] = withFriendlyIds([merged]);
      const before = editor().scene;
      if (keepOriginals) editor().addParts([result]);
      else
        editor().replaceWithMerged(
          result,
          parts.map((part) => part.id),
        );
      const after = editor().scene;
      return {
        part: describePart(requirePart(result.id)),
        removed: keepOriginals ? [] : parts.map((part) => part.id),
        removed_joints: before.joints.length - after.joints.length,
        removed_plane_constraints:
          (before.constraints?.length ?? 0) - (after.constraints?.length ?? 0),
      };
    });
  }

  alignParts(args: {
    source: string;
    target: string;
    method: 'point' | 'point_to_plane' | 'plane' | 'points';
    pairs: { source: PointRef; target: PointRef }[];
    offset?: number;
    opposed?: boolean;
  }) {
    return transaction(() => {
      const source = requireUnlocked(args.source);
      const target = requireTarget(args.target);
      if (!args.pairs.length) throw new Error('List at least one source and target point pair.');
      const mode = {
        point: 'point',
        point_to_plane: 'point-plane',
        plane: 'plane',
        points: 'multi',
      }[args.method] as AssemblyOperation['mode'];
      if (mode !== 'multi' && args.pairs.length !== 1)
        throw new Error(`The ${args.method} method uses exactly one pair.`);
      const operation: AssemblyOperation = {
        ...editor().operation,
        mode,
        sourceId: source.id,
        targetId: target.id,
        pairs: args.pairs.map((pair, i) => ({
          source: surfacePoint(source, pair.source, `pairs[${i}].source`),
          target: surfacePoint(target, pair.target, `pairs[${i}].target`),
        })),
        offset: args.offset ?? 0,
        flipNormal: args.opposed ?? true,
        pending: null,
      };
      return this.applyOperation(operation, source.id);
    });
  }

  fitSurfaces(args: {
    source: string;
    target?: string;
    method: 'contact' | 'flush' | PlaneConstraintKind;
    pairs: { source: PatchSpec; target: PatchSpec }[];
    offset?: number;
    angle?: number;
    opposed?: boolean;
    keep_constraint?: boolean;
  }) {
    return transaction(() => {
      const source = requireUnlocked(args.source);
      if (!args.pairs.length) throw new Error('List at least one pair of surface patches.');
      // A retained constraint takes its id from the pair, so pair ids must stay unused.
      const existing = (editor().scene.constraints ?? []).map((c) => c.id.replace(/^plane-/, ''));
      const surfacePairs: SurfacePair[] = args.pairs.map((pair, i) => {
        const targetId = pair.target.part ?? args.target;
        if (!targetId) throw new Error(`pairs[${i}].target needs a part.`);
        return {
          id: uniqueId(`${source.id}-${i + 1}`, existing),
          source: patchUnder(source, pair.source, `pairs[${i}].source`),
          target: patchUnder(requirePart(targetId), pair.target, `pairs[${i}].target`),
        };
      });
      const targetId = args.target ?? surfacePairs[0].target!.partId;
      const operation: AssemblyOperation = {
        ...editor().operation,
        mode: 'surface',
        sourceId: source.id,
        targetId,
        surfacePairs,
        activeSurface: null,
        surfaceMethod: args.method,
        offset: args.offset ?? 0,
        planeAngle: args.angle ?? 0,
        flipNormal: args.opposed ?? args.method !== 'flush',
        retainConstraint: args.keep_constraint ?? false,
        pending: null,
        pairs: [],
      };
      return {
        ...this.applyOperation(operation, source.id),
        patch_triangles: surfacePairs.map((pair) => [
          pair.source!.faces.length,
          pair.target!.faces.length,
        ]),
      };
    });
  }

  private applyOperation(operation: AssemblyOperation, sourceId: string) {
    const scene = editor().scene;
    const solved = solveAlignment(scene, operation, editor().view.clip) as ReturnType<
      typeof solveAlignment
    > & {
      angleError?: number;
      addedConstraints?: PlaneConstraint[];
    };
    const added = solved.addedConstraints ?? [];
    setScene({
      ...scene,
      parts: solved.parts,
      ...(added.length ? { constraints: [...(scene.constraints ?? []), ...added] } : {}),
    });
    return {
      part: describePart(requirePart(sourceId)),
      rms_mm: round(solved.rms),
      ...(solved.angleError !== undefined ? { angle_error_degrees: round(solved.angleError) } : {}),
      ...(solved.constrained ? { constrained: true } : {}),
      ...(solved.anchored ? { anchored_by_joint: true } : {}),
      ...(added.length ? { plane_constraints_added: added.map((c) => c.id) } : {}),
      ...clipResult(solved.clip),
    };
  }

  fitAnchors(partId: string, anchors: { point: PointRef; target: number[] }[]) {
    return transaction(() => {
      const part = requireUnlocked(partId);
      const fit: FitAnchor[] = anchors.map((anchor, i) => ({
        id: `anchor-${i + 1}`,
        point: surfacePoint(part, anchor.point, `anchors[${i}].point`).point,
        target: [...tuple3(anchor.target, `anchors[${i}].target`)],
      }));
      const scene = editor().scene;
      const { clip } = editor().view;
      let report: ClipReport | null = null;
      setScene({
        ...scene,
        parts: fitAnchors(
          scene,
          part.id,
          fit,
          clip.enabled
            ? { overlap: clip.overlap, mode: 'fit', report: (value) => (report = value) }
            : undefined,
        ),
      });
      const placed = requirePart(part.id);
      return {
        part: describePart(placed),
        gaps_mm: rounded(anchorGaps(placed)),
        ...clipResult(report),
      };
    });
  }

  createJoint(args: {
    child: string;
    parent: string;
    child_anchor: PointRef;
    parent_anchor: PointRef;
    rotation_locks?: boolean[];
    keep_connected?: boolean;
    name?: string;
  }) {
    return transaction(() => {
      const child = requireUnlocked(args.child);
      const parent = requirePart(args.parent);
      const locks = args.rotation_locks ?? [true, false, true];
      if (locks.length !== 3) throw new Error('rotation_locks must be [x, y, z] booleans.');
      useEditor.setState({
        tool: 'joint',
        operation: {
          ...editor().operation,
          mode: 'point',
          sourceId: child.id,
          targetId: parent.id,
          pending: null,
          pairs: [
            {
              source: surfacePoint(child, args.child_anchor, 'child_anchor'),
              target: surfacePoint(parent, args.parent_anchor, 'parent_anchor'),
            },
          ],
          rotationLocks: locks as AxisLocks,
          keepConnected: args.keep_connected ?? true,
        },
      });
      required(() => editor().createJoint());
      const scene = editor().scene;
      const created = scene.joints.at(-1)!;
      const name = args.name?.trim() || created.name;
      const id = uniqueId(
        slug(name),
        scene.joints.map((joint) => joint.id),
      );
      setScene({
        ...scene,
        joints: scene.joints.map((joint) => (joint === created ? { ...joint, id, name } : joint)),
      });
      return {
        joint: { id, name, parent: parent.id, child: child.id },
        part: describePart(requirePart(child.id)),
      };
    });
  }

  updateJoint(
    id: string,
    patch: { name?: string; rotation_locks?: boolean[]; keep_connected?: boolean },
  ) {
    return transaction(() => {
      if (!editor().scene.joints.some((joint) => joint.id === id))
        throw new Error(`There is no joint "${id}".`);
      if (patch.rotation_locks && patch.rotation_locks.length !== 3)
        throw new Error('rotation_locks must be [x, y, z] booleans.');
      required(() =>
        editor().updateJoint(id, {
          ...(patch.name !== undefined ? { name: patch.name } : {}),
          ...(patch.rotation_locks ? { rotationLocks: patch.rotation_locks as AxisLocks } : {}),
          ...(patch.keep_connected !== undefined ? { keepConnected: patch.keep_connected } : {}),
        }),
      );
      return { joint: id, updated: true };
    });
  }

  createPlaneConstraint(args: {
    source: string;
    target: string;
    kind: PlaneConstraintKind;
    source_plane: PointRef;
    target_plane: PointRef;
    angle?: number;
    offset?: number;
    opposed?: boolean;
    name?: string;
  }) {
    return transaction(() => {
      const source = requireUnlocked(args.source);
      const target = requirePart(args.target);
      const sourcePlane = surfacePoint(source, args.source_plane, 'source_plane');
      const targetPlane = surfacePoint(target, args.target_plane, 'target_plane');
      const scene = editor().scene;
      const name = args.name?.trim() || `${source.name} ${args.kind}`;
      const constraint: PlaneConstraint = {
        id: uniqueId(
          slug(name),
          (scene.constraints ?? []).map((c) => c.id),
        ),
        name,
        sourceId: source.id,
        targetId: target.id,
        sourcePlane: { point: sourcePlane.point, normal: sourcePlane.normal },
        targetPlane: { point: targetPlane.point, normal: targetPlane.normal },
        kind: args.kind,
        angle: args.angle ?? 0,
        offset: args.offset ?? 0,
        opposed: args.opposed ?? true,
        enabled: true,
      };
      const next = { ...scene, constraints: [...(scene.constraints ?? []), constraint] };
      validatePlaneConstraints(next);
      const parts = solvePlaneConstraints(next, next.parts, [target.id]);
      setScene({ ...next, parts });
      const residual = planeConstraintResidual(parts, constraint);
      return {
        constraint: constraint.id,
        part: describePart(requirePart(source.id)),
        residual_mm: round(residual.distance),
        residual_degrees: round((residual.angle * 180) / Math.PI),
      };
    });
  }

  updatePlaneConstraint(
    id: string,
    patch: {
      name?: string;
      angle?: number;
      offset?: number;
      opposed?: boolean;
      enabled?: boolean;
      kind?: PlaneConstraintKind;
    },
  ) {
    return transaction(() => {
      if (!editor().scene.constraints?.some((c) => c.id === id))
        throw new Error(`There is no plane constraint "${id}".`);
      required(() => editor().updateConstraint(id, patch));
      return { constraint: id, updated: true };
    });
  }

  removeRelationships(jointIds: string[] = [], constraintIds: string[] = []) {
    return transaction(() => {
      for (const id of jointIds) {
        if (!editor().scene.joints.some((joint) => joint.id === id))
          throw new Error(`There is no joint "${id}".`);
        editor().removeJoint(id);
      }
      for (const id of constraintIds) {
        if (!editor().scene.constraints?.some((c) => c.id === id))
          throw new Error(`There is no plane constraint "${id}".`);
        editor().removeConstraint(id);
      }
      return { removed_joints: jointIds, removed_plane_constraints: constraintIds };
    });
  }

  undo() {
    return this.historyStep('undo');
  }

  redo() {
    return this.historyStep('redo');
  }

  /** Steps through this agent's own changes only. Edits made in the live view are kept. */
  private historyStep(direction: 'undo' | 'redo') {
    const result = sharedDocument[direction](agent);
    if (!result) throw new Error(`There is nothing to ${direction}.`);
    const { undo, redo } = sharedDocument.counts(agent);
    return {
      ...(result.changed
        ? {}
        : {
            changed: false,
            note: `Nothing was ${direction === 'undo' ? 'reverted' : 'restored'}: the user has since changed everything that step touched.`,
          }),
      can_undo: undo,
      can_redo: redo,
      parts: editor().scene.parts.map((part) => part.id),
    };
  }

  raycast(origin: number[], direction: number[], ids?: string[], all = false) {
    const dir = vec(tuple3(direction, 'direction'));
    if (dir.lengthSq() === 0) throw new Error('direction must not be zero.');
    const ray = new Ray(vec(tuple3(origin, 'origin')), dir.normalize());
    const parts = ids ? ids.map(requirePart) : editor().scene.parts.filter((part) => part.visible);
    const hits = parts.flatMap((part) => {
      const matrix = partMatrix(part);
      const local = ray.clone().applyMatrix4(matrix.clone().invert());
      return ensureBvh(part.geometry)
        .raycast(local, DoubleSide)
        .map((hit) => {
          const surface: SurfacePoint = {
            partId: part.id,
            point: hit.point.toArray(),
            normal: hit.face!.normal.toArray(),
          };
          const world = worldPoint(part, surface);
          return {
            part: part.id,
            name: part.name,
            world: rounded(world.toArray()),
            local: rounded(surface.point),
            normal: rounded(worldNormal(part, surface).toArray()),
            distance: round(world.distanceTo(ray.origin)),
          };
        });
    });
    hits.sort((a, b) => a.distance - b.distance);
    // A ray through an edge between triangles hits each of them at the same point.
    const distinct = hits.filter(
      (hit, i) =>
        !hits
          .slice(0, i)
          .some(
            (other) => other.part === hit.part && Math.abs(other.distance - hit.distance) < 1e-6,
          ),
    );
    return { hits: all ? distinct.slice(0, 100) : distinct.slice(0, 1) };
  }

  inspect(ids: string[] | undefined, distance: number) {
    const parts = ids ? ids.map(requirePart) : editor().scene.parts.filter((part) => part.visible);
    if (parts.length < 2) throw new Error('Inspection compares at least two parts.');
    const result = inspectMeshes({
      meshes: parts.map((part) => ({
        id: part.id,
        name: part.name,
        positions: binaryGeometry(part.geometry).positions,
        indices: part.geometry.index ? new Uint32Array(part.geometry.index.array) : undefined,
        matrix: partMatrix(part).toArray(),
      })),
      distance,
      surfaces: false,
    });
    const connected = new Set(result.pairs.flatMap((pair) => [pair.a, pair.b]));
    return {
      distance_mm: distance,
      checked_pairs: result.checkedPairs,
      solid_pairs: result.solidPairs,
      pairs: result.pairs.map((pair) => ({
        a: pair.a,
        b: pair.b,
        status: statusOf(pair),
        overlap_mm3: pair.volume === null ? null : round(pair.volume),
        gap_mm: round(pair.distance),
        // Touching meshes end the search before it records any points.
        ...(pair.distance > 0 ? { closest_points: pair.points.map(rounded) } : {}),
      })),
      // Parts near nothing else are often an assembly mistake.
      isolated: parts.filter((part) => !connected.has(part.id)).map((part) => part.id),
      warnings: result.warnings,
    };
  }

  renderableParts(ids?: string[]) {
    return ids ? ids.map(requirePart) : editor().scene.parts.filter((part) => part.visible);
  }
}

const maxBooleanTriangles = 2_000_000;

function patchUnder(part: Part, spec: PatchSpec, label: string): SurfacePatch {
  if (triangleCount(part.geometry) > maxPaintTriangles)
    throw new Error(`${part.name} has too many triangles to select a surface patch.`);
  const local = vec(tuple3(spec.point, `${label}.point`))
    .applyMatrix4(partMatrix(part).invert())
    .toArray();
  const nearest = closestSurface(part, local);
  const seed: SurfacePoint & { face: number } = {
    partId: part.id,
    point: nearest.point as Vec3,
    normal: nearest.normal as Vec3,
    face: nearest.face,
  };
  ensureBvh(part.geometry);
  const patchFaces = facesUnderBrush(part, seed, spec.radius, nearest.face, {
    plane:
      spec.plane_angle !== undefined || spec.plane_distance !== undefined
        ? { enabled: true, angle: spec.plane_angle ?? 20, distance: spec.plane_distance ?? 0.5 }
        : undefined,
  });
  if (!patchFaces.length)
    throw new Error(
      `${label}: no surface of "${part.id}" lies within ${spec.radius} mm of that point.`,
    );
  return { partId: part.id, faces: patchFaces, seed };
}

async function writeAtomically(file: string, data: Blob) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    await pipeline(
      Readable.fromWeb(data.stream() as NodeReadableStream),
      createWriteStream(temporary),
    );
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return data.size;
}
