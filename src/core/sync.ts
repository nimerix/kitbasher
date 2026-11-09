import { constrainPart, isJointConnected, validateJoint } from './constraints';
import { partMatrix } from './geometry';
import { solvePlaneConstraints, validatePlaneConstraints } from './plane-constraints';
import { sceneMetadata } from './scene-file';
import type { Joint, Part, PlaneConstraint, SceneDocument } from './types';

// Rules for one scene edited from several places at once: an agent's MCP server and the browser
// tabs that share it. Changes combine field by field, so edits to different parts, or to different
// properties of one part, never overwrite each other.

/** A scene as it travels between the agent's server and its tabs, with meshes named by key. */
export const sharedScene = (scene: SceneDocument) => ({
  ...sceneMetadata(scene),
  parts: scene.parts.map((part) => ({ ...part, geometry: part.geometry.uuid })),
});
export type SharedScene = ReturnType<typeof sharedScene>;

type Kind = 'parts' | 'joints' | 'constraints' | 'name';
type Entity = { id: string } & Record<string, unknown>;
type Lists = Record<Kind, Entity[]>;
const kinds: Kind[] = ['parts', 'joints', 'constraints', 'name'];

/** Fields that only make sense together, such as a pose, change as one. */
const fieldGroups: Record<Kind, string[][]> = {
  parts: [
    ['position', 'quaternion', 'scale'],
    ['pivot'],
    ['anchors'],
    ['name'],
    ['color'],
    ['visible'],
    ['locked'],
    ['geometry', 'source'],
  ],
  joints: [
    ['parentId', 'childId', 'parentAnchor', 'childAnchor'],
    ['restRotation', 'rotationLocks'],
    ['keepConnected'],
    ['name'],
  ],
  constraints: [
    ['sourceId', 'targetId', 'sourcePlane', 'targetPlane'],
    ['kind', 'angle', 'offset', 'opposed'],
    ['enabled'],
    ['name'],
  ],
  name: [['name']],
};

const isPlain = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;

/** Value equality for scene data. Meshes compare by identity, since each key has one mesh. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, i) => same(value, b[i]))
    );
  if (!isPlain(a) || !isPlain(b)) return false;
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)]))
    if (!same(a[key], b[key])) return false;
  return true;
}

const lists = (scene: SceneDocument): Lists => ({
  parts: scene.parts as unknown as Entity[],
  joints: scene.joints as unknown as Entity[],
  constraints: (scene.constraints ?? []) as unknown as Entity[],
  name: [{ id: 'scene', name: scene.name }],
});

/** Relationships to a part that is gone would make the scene invalid, so they go with it. */
function fromLists(source: Lists): SceneDocument {
  const parts = source.parts as unknown as Part[];
  const ids = new Set(parts.map((part) => part.id));
  return {
    name: String(source.name[0]?.name ?? 'Untitled assembly'),
    parts,
    joints: (source.joints as unknown as Joint[]).filter(
      (joint) => ids.has(joint.parentId) && ids.has(joint.childId),
    ),
    constraints: (source.constraints as unknown as PlaneConstraint[]).filter(
      (constraint) => ids.has(constraint.sourceId) && ids.has(constraint.targetId),
    ),
  };
}

const changedGroups = (kind: Kind, a: Entity, b: Entity) =>
  fieldGroups[kind].flatMap((keys, group) =>
    keys.some((key) => !same(a[key], b[key])) ? [group] : [],
  );

function mergeList(
  kind: Kind,
  base: Entity[],
  ours: Entity[],
  theirs: Entity[],
  prefer: 'ours' | 'theirs',
) {
  const index = (list: Entity[]) => new Map(list.map((entity) => [entity.id, entity]));
  const [b, o, t] = [base, ours, theirs].map(index);
  const merged = (id: string) => {
    const was = b.get(id),
      mine = o.get(id),
      other = t.get(id);
    if (mine === was || same(mine, was)) return other;
    if (other === was || same(other, was)) return mine;
    // Both sides changed it, and one created or removed it.
    if (!mine || !other || !was) return prefer === 'ours' ? mine : other;
    let result = other;
    for (const group of changedGroups(kind, was, mine)) {
      const keys = fieldGroups[kind][group];
      const otherChanged = keys.some((key) => !same(other[key], was[key]));
      if (otherChanged && prefer === 'theirs') continue;
      result = { ...result };
      for (const key of keys) result[key] = mine[key];
    }
    return result;
  };
  const ids = [...new Set([...theirs.map((e) => e.id), ...ours.map((e) => e.id)])];
  return ids.map(merged).filter((entity): entity is Entity => !!entity);
}

/**
 * Combines two edits of the same base scene. Where both changed the same group of fields, the
 * preferred side wins. Unchanged entities keep theirs's objects, so their identity is stable.
 */
export function mergeScenes(
  base: SceneDocument,
  ours: SceneDocument,
  theirs: SceneDocument,
  prefer: 'ours' | 'theirs' = 'ours',
): SceneDocument {
  const [b, o, t] = [base, ours, theirs].map(lists);
  const merged = {} as Lists;
  for (const kind of kinds) merged[kind] = mergeList(kind, b[kind], o[kind], t[kind], prefer);
  return fromLists(merged);
}

/** One entity's part in a change: the field groups that changed, or its creation or removal. */
export interface EntityChange {
  kind: Kind;
  id: string;
  /** Its position in the list it was removed from or added to. */
  index: number;
  before?: Entity;
  after?: Entity;
  groups: number[];
}
export type ScenePatch = EntityChange[];

export function diffScenes(before: SceneDocument, after: SceneDocument): ScenePatch {
  const changes: ScenePatch = [];
  const a = lists(before),
    b = lists(after);
  for (const kind of kinds) {
    const next = new Map(b[kind].map((entity) => [entity.id, entity]));
    const previous = new Set<string>();
    a[kind].forEach((entity, index) => {
      previous.add(entity.id);
      const now = next.get(entity.id);
      if (!now) changes.push({ kind, id: entity.id, index, before: entity, groups: [] });
      else if (now !== entity && !same(now, entity)) {
        const groups = changedGroups(kind, entity, now);
        if (groups.length)
          changes.push({ kind, id: entity.id, index, before: entity, after: now, groups });
      }
    });
    b[kind].forEach((entity, index) => {
      if (!previous.has(entity.id))
        changes.push({ kind, id: entity.id, index, after: entity, groups: [] });
    });
  }
  return changes;
}

/**
 * Joins two consecutive changes by one author into a single undo step. The earliest value of each
 * field is kept as the one to restore, and the latest value as the one the author left.
 */
export function composePatches(first: ScenePatch, second: ScenePatch): ScenePatch {
  const result = new Map(first.map((change) => [`${change.kind}:${change.id}`, change]));
  for (const next of second) {
    const key = `${next.kind}:${next.id}`;
    const previous = result.get(key);
    if (!previous) {
      result.set(key, next);
      continue;
    }
    if (!previous.before && !next.after) result.delete(key);
    else if (!previous.before) result.set(key, { ...previous, after: next.after });
    else if (!previous.after) {
      const after = next.after!;
      result.set(key, {
        ...previous,
        after,
        groups: changedGroups(next.kind, previous.before, after),
      });
    } else {
      const keysOf = (groups: number[]) => groups.flatMap((group) => fieldGroups[next.kind][group]);
      const before = { ...next.before! };
      for (const field of keysOf(previous.groups)) before[field] = previous.before[field];
      if (!next.after) {
        result.set(key, { ...previous, before, after: undefined, groups: [] });
        continue;
      }
      const after = { ...next.after };
      for (const field of keysOf(previous.groups.filter((group) => !next.groups.includes(group))))
        after[field] = previous.after[field];
      const groups = [...new Set([...previous.groups, ...next.groups])].sort((x, y) => x - y);
      result.set(key, { ...previous, before, after, groups });
    }
  }
  return [...result.values()];
}

/**
 * Reverts a change, or applies it again, to the scene as it is now. A field someone else has
 * changed since keeps their value. A creation is undone even if others have edited it since.
 */
export function applyPatch(scene: SceneDocument, patch: ScenePatch, direction: 'undo' | 'redo') {
  const current = lists(scene);
  for (const kind of kinds) current[kind] = [...current[kind]];
  let changed = false;
  const ordered = [...patch].sort((a, b) => a.index - b.index);
  for (const change of ordered) {
    const from = direction === 'undo' ? change.after : change.before;
    const to = direction === 'undo' ? change.before : change.after;
    const list = current[change.kind];
    const index = list.findIndex((entity) => entity.id === change.id);
    if (!from) {
      if (index < 0 && to) {
        list.splice(Math.min(change.index, list.length), 0, to);
        changed = true;
      }
      continue;
    }
    if (index < 0) continue;
    if (!to) {
      list.splice(index, 1);
      changed = true;
      continue;
    }
    let entity = list[index];
    for (const group of change.groups) {
      const keys = fieldGroups[change.kind][group];
      if (!keys.every((key) => same(entity[key], from[key]))) continue;
      if (keys.every((key) => same(entity[key], to[key]))) continue;
      entity = { ...entity };
      for (const key of keys) entity[key] = to[key];
      changed = true;
    }
    list[index] = entity;
  }
  return { scene: fromLists(current), changed };
}

/** Which parts and relationships a change touched, for telling others about it. */
export function summarizePatch(patch: ScenePatch) {
  const ids = (kind: Kind, test: (change: EntityChange) => boolean) =>
    patch.filter((change) => change.kind === kind && test(change)).map((change) => change.id);
  return {
    partsAdded: ids('parts', (change) => !change.before),
    partsChanged: ids('parts', (change) => !!change.before && !!change.after),
    partsRemoved: ids('parts', (change) => !change.after),
    joints: ids('joints', () => true),
    constraints: ids('constraints', () => true),
    renamed: patch.some((change) => change.kind === 'name'),
  };
}

function sameTransform(a: Part, b: Part) {
  const x = partMatrix(a).elements,
    y = partMatrix(b).elements;
  return x.every((value, i) => Math.abs(value - y[i]) < 1e-6);
}

/**
 * Makes a combined scene valid again. Two edits can each keep a joint connected yet, combined,
 * leave a child away from its moved parent: each such child is seated again, parents first,
 * and plane constraints are solved. Throws if the relationships themselves conflict.
 */
export function reconcile(scene: SceneDocument): SceneDocument {
  const checked: Joint[] = [];
  for (const joint of scene.joints) {
    validateJoint(checked, joint.parentId, joint.childId);
    checked.push(joint);
  }
  validatePlaneConstraints(scene);
  const parts = new Map(scene.parts.map((part) => [part.id, part]));
  const connected = scene.joints.filter(isJointConnected);
  const parentJoint = new Map(connected.map((joint) => [joint.childId, joint]));
  const depth = (id: string) => {
    let levels = 0;
    for (let joint = parentJoint.get(id); joint; joint = parentJoint.get(joint.parentId)) levels++;
    return levels;
  };
  for (const joint of [...connected].sort((a, b) => depth(a.childId) - depth(b.childId))) {
    const child = parts.get(joint.childId)!;
    if (child.locked) continue;
    const seated = constrainPart(child, parts.get(joint.parentId)!, joint);
    if (!sameTransform(child, seated)) parts.set(child.id, seated);
  }
  const placed = scene.parts.map((part) => parts.get(part.id)!);
  return { ...scene, parts: solvePlaneConstraints({ ...scene, parts: placed }, placed) };
}

/** Reuses objects that did not change, so a view only redraws what did. */
export function keepUnchanged(previous: SceneDocument, next: SceneDocument): SceneDocument {
  let reused = true;
  const reuse = <T extends { id: string }>(old: T[], fresh: T[]) => {
    const byId = new Map(old.map((entity) => [entity.id, entity]));
    const result = fresh.map((entity) => {
      const existing = byId.get(entity.id);
      if (existing && same(existing, entity)) return existing;
      reused = false;
      return entity;
    });
    if (old.length !== fresh.length || result.some((entity, i) => entity !== old[i]))
      reused = false;
    return result;
  };
  const scene = {
    ...next,
    parts: reuse(previous.parts, next.parts),
    joints: reuse(previous.joints, next.joints),
    constraints: reuse(previous.constraints ?? [], next.constraints ?? []),
  };
  return reused && previous.name === next.name ? previous : scene;
}
