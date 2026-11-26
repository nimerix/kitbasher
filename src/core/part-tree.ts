import { uid } from './geometry';
import type { Part, PartGroup, SceneDocument } from './types';

type GroupedScene = Pick<SceneDocument, 'parts' | 'groups'>;

/** The scene's groups that have parts. A part's `groupId` that names no group is ignored. */
export function liveGroups(scene: GroupedScene): PartGroup[] {
  const used = new Set(scene.parts.flatMap((part) => (part.groupId ? [part.groupId] : [])));
  return (scene.groups ?? []).filter((group) => used.has(group.id));
}

/** The group a part belongs to. */
export function groupOf(scene: GroupedScene, part: Part | undefined) {
  return part?.groupId ? scene.groups?.find((group) => group.id === part.groupId) : undefined;
}

/** These parts and every other part of their groups, the given ones first. */
export function withGroups(scene: GroupedScene, ids: string[]) {
  const chosen = new Set(ids);
  const groups = new Set(
    scene.parts.flatMap((part) => {
      const group = chosen.has(part.id) ? groupOf(scene, part) : undefined;
      return group ? [group.id] : [];
    }),
  );
  const others = scene.parts.filter(
    (part) => !chosen.has(part.id) && part.groupId && groups.has(part.groupId),
  );
  return [...ids, ...others.map((part) => part.id)];
}

const ungrouped = (part: Part): Part => {
  const { groupId: _, ...rest } = part;
  return rest;
};

/** Keeps only the groups that still have parts, and leaves `groups` out once none do. */
function withGroupList<T extends GroupedScene>(scene: T, groups: PartGroup[]): T {
  const { groups: _, ...rest } = scene;
  const live = liveGroups({ parts: scene.parts, groups });
  return (live.length ? { ...rest, groups: live } : rest) as T;
}

/** "Group 1", or the next number no group uses. */
export function nextGroupName(scene: GroupedScene) {
  const names = new Set(liveGroups(scene).map((group) => group.name));
  let index = 1;
  while (names.has(`Group ${index}`)) index++;
  return `Group ${index}`;
}

/** Whether grouping these parts would change anything: two or more, not already one group. */
export function canGroup(scene: GroupedScene, ids: string[]) {
  const chosen = new Set(ids);
  const parts = scene.parts.filter((part) => chosen.has(part.id));
  if (parts.length < 2) return false;
  const group = groupOf(scene, parts[0]);
  return !(
    group && scene.parts.every((part) => (part.groupId === group.id) === chosen.has(part.id))
  );
}

/** Whether any of these parts is in a group. */
export function canUngroup(scene: GroupedScene, ids: string[]) {
  const chosen = new Set(ids);
  return scene.parts.some((part) => chosen.has(part.id) && !!groupOf(scene, part));
}

/** Puts these parts in a new group, taking them out of any group they were in. */
export function groupParts<T extends GroupedScene>(scene: T, ids: string[], name?: string) {
  if (!canGroup(scene, ids)) return null;
  const chosen = new Set(ids);
  const group: PartGroup = { id: uid(), name: name ?? nextGroupName(scene) };
  const parts = scene.parts.map((part) =>
    chosen.has(part.id) ? { ...part, groupId: group.id } : part,
  );
  return { scene: withGroupList({ ...scene, parts }, [...(scene.groups ?? []), group]), group };
}

/** Ends every group these parts are in, leaving all of its parts ungrouped. */
export function ungroupParts<T extends GroupedScene>(scene: T, ids: string[]) {
  if (!canUngroup(scene, ids)) return null;
  const chosen = new Set(ids);
  const ended = new Set(
    scene.parts.flatMap((part) => (chosen.has(part.id) && part.groupId ? [part.groupId] : [])),
  );
  const parts = scene.parts.map((part) =>
    part.groupId && ended.has(part.groupId) ? ungrouped(part) : part,
  );
  return withGroupList({ ...scene, parts }, scene.groups ?? []);
}

/** Renames a group. A blank name, or the same one, changes nothing. */
export function renameGroup<T extends GroupedScene>(scene: T, id: string, name: string) {
  const trimmed = name.trim();
  const group = scene.groups?.find((candidate) => candidate.id === id);
  if (!group || !trimmed || trimmed === group.name) return null;
  return {
    ...scene,
    groups: scene.groups!.map((candidate) =>
      candidate.id === id ? { ...candidate, name: trimmed } : candidate,
    ),
  };
}

export type PartTreeEntry =
  | { kind: 'part'; part: Part }
  /** `parts` is the whole group; `shown` is the part of it a search leaves listed. */
  | { kind: 'group'; group: PartGroup; parts: Part[]; shown: Part[] };

/**
 * What the Parts list shows, in scene order. A group sits where its first part is, with its parts
 * under it. A search lists the parts whose names match, and every part of a group whose name does.
 */
export function partTree(scene: GroupedScene, query = ''): PartTreeEntry[] {
  const search = query.toLowerCase();
  const matches = (name: string) => name.toLowerCase().includes(search);
  const groups = new Map(liveGroups(scene).map((group) => [group.id, group]));
  const members = new Map<string, Part[]>();
  for (const part of scene.parts)
    if (part.groupId && groups.has(part.groupId))
      members.set(part.groupId, [...(members.get(part.groupId) ?? []), part]);
  const entries: PartTreeEntry[] = [];
  const placed = new Set<string>();
  for (const part of scene.parts) {
    const group = part.groupId ? groups.get(part.groupId) : undefined;
    if (!group) {
      if (matches(part.name)) entries.push({ kind: 'part', part });
      continue;
    }
    if (placed.has(group.id)) continue;
    placed.add(group.id);
    const parts = members.get(group.id)!;
    const shown = matches(group.name) ? parts : parts.filter((member) => matches(member.name));
    if (shown.length) entries.push({ kind: 'group', group, parts, shown });
  }
  return entries;
}

/** The listed parts in the order they appear, for ranges. Parts of a closed group count. */
export const treeOrder = (entries: PartTreeEntry[]) =>
  entries.flatMap((entry) =>
    entry.kind === 'part' ? [entry.part.id] : entry.shown.map((part) => part.id),
  );

/**
 * The parts between an anchor and a target in a list's order, inclusive, for Shift+click. The
 * anchor comes first, so it stays the primary part. Without an anchor in the list, the target
 * alone is chosen. A target of several parts, such as a group, is reached to its far end.
 */
export function selectionRange(
  order: string[],
  anchor: string | null | undefined,
  target: string[],
) {
  const at = target.map((id) => order.indexOf(id)).filter((index) => index >= 0);
  const from = anchor ? order.indexOf(anchor) : -1;
  if (!at.length || from < 0) return target;
  const low = Math.min(from, ...at),
    high = Math.max(from, ...at);
  const range = order.slice(low, high + 1);
  if (from === high) return range.reverse();
  return [order[from], ...range.filter((id) => id !== order[from])];
}
