import type { BufferGeometry } from 'three';
import { useEditor } from '../src/core/store';
import { matchesSculptTarget, type SculptTarget } from '../src/core/sculpt-session';
import {
  applyPatch,
  composePatches,
  diffScenes,
  mergeScenes,
  reconcile,
  summarizePatch,
} from '../src/core/sync';
import type { ScenePatch } from '../src/core/sync';
import { buffersOf, historyBudgetBytes, historyLimit } from '../src/core/history-budget';
import type { SceneDocument } from '../src/core/types';
import {
  archiveGeometry,
  archiveScene,
  rememberSculptGeometry,
  restoreGeometry,
  restoreScene,
  type HistoryScene,
  type HistoryGeometry,
} from '../src/core/sculpt-history';

function mapPatchGeometry(
  patch: ScenePatch,
  map: (g: HistoryGeometry) => HistoryGeometry,
): ScenePatch {
  return patch.map((change) => {
    if (change.kind !== 'parts') return change;
    const mapped = (entity: typeof change.before) => {
      if (!entity) return entity;
      const geometry = map(entity.geometry as HistoryGeometry);
      return geometry === entity.geometry ? entity : { ...entity, geometry };
    };
    const before = mapped(change.before);
    const after = mapped(change.after);
    return before === change.before && after === change.after
      ? change
      : { ...change, before, after };
  });
}

export const agent = 'agent';

/** A change that cannot be combined with the current scene. Nothing was applied. */
export class EditConflict extends Error {}

export interface Edit {
  /** The version the editor's change was made on. */
  base: number;
  epoch: number;
  scene: SceneDocument;
  /** False continues the author's previous undo step, as a drag does. */
  checkpoint: boolean;
  /** Starts the scene over, as opening a file does. */
  replace?: boolean;
  replacementId?: string;
  sculpt?: SculptTarget;
}

interface Logged {
  author: string;
  summary: ReturnType<typeof summarizePatch>;
  replaced: boolean;
}

// Enough for a tab that falls behind during a large upload.
const keepVersions = 200;
const keepUploadsMs = 10 * 60 * 1000;

const changesGeometry = (patch: ScenePatch) =>
  patch.some(
    (change) => change.kind === 'parts' && change.after?.geometry !== change.before?.geometry,
  );

/**
 * The one scene that the agent and every browser tab edit. Each change gets a version, so an edit
 * made on an older version can be combined with what happened since. Each author has their own
 * undo history, which reverts only their changes.
 */
export class SharedDocument {
  version = 0;
  /** Counts scene replacements. Edits made before one no longer apply. */
  epoch = 0;
  /** Identifies the browser edit that started this epoch, if any. */
  replacementId?: string;
  private readonly versions = new Map<number, HistoryScene>();
  private readonly log = new Map<number, Logged>();
  private readonly histories = new Map<string, { undo: ScenePatch[]; redo: ScenePatch[] }>();
  private readonly meshes = new Map<string, HistoryGeometry>();
  private readonly uploads = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

  constructor(private readonly budget = historyBudgetBytes) {}

  get scene() {
    return useEditor.getState().scene;
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Starts over from a scene that nobody can undo, such as a file just opened. */
  replace(scene: SceneDocument, author = agent, saved = true, replacementId?: string) {
    useEditor.getState().setScene(scene);
    if (!saved) useEditor.setState({ savedRevision: -1 });
    this.epoch++;
    this.replacementId = replacementId;
    this.versions.clear();
    this.log.clear();
    this.histories.clear();
    this.publish(author, [], true);
  }

  /** Records what changed since `before`, which the store has already applied, as one step. */
  commit(author: string, before: SceneDocument, amend = false) {
    const patch = diffScenes(before, this.scene);
    if (!patch.length) return false;
    this.record(author, patch, amend);
    this.publish(author, patch);
    return true;
  }

  apply(author: string, edit: Edit) {
    if (edit.replace && edit.replacementId && this.replacementId === edit.replacementId)
      return this.version;
    if ((!edit.replace || edit.replacementId) && edit.epoch !== this.epoch)
      throw new EditConflict('The scene was replaced while this change was being made.');
    if (edit.replace) {
      this.replace(edit.scene, author, false, edit.replacementId);
      return this.version;
    }
    const version = this.versions.get(edit.base);
    if (!version)
      throw new EditConflict('This change was made on a version of the scene that is too old.');
    const current = this.scene;
    if (edit.sculpt) {
      const target = edit.sculpt;
      const part = current.parts.find((part) => part.id === target.partId);
      const carved = edit.scene.parts.find((part) => part.id === target.partId);
      if (part && carved && carved.geometry === part.geometry) return this.version;
      if (!part || !carved || !matchesSculptTarget(part, target))
        throw new EditConflict(
          'The sculpt target changed before the stroke reached the shared scene.',
        );
      rememberSculptGeometry(part.geometry, carved.geometry);
      const next = {
        ...current,
        parts: current.parts.map((candidate) =>
          candidate === part ? { ...part, geometry: carved.geometry } : candidate,
        ),
      };
      useEditor.setState((state) => ({ scene: next, revision: state.revision + 1 }));
      this.commit(author, current);
      return this.version;
    }
    const base = edit.base === this.version ? current : restoreScene(version);
    let next = mergeScenes(base, edit.scene, current, 'ours');
    if (base !== current)
      try {
        next = reconcile(next);
      } catch (error) {
        throw new EditConflict((error as Error).message);
      }
    const patch = diffScenes(current, next);
    if (!patch.length) return this.version;
    useEditor.setState((state) => ({ scene: next, revision: state.revision + 1 }));
    this.record(author, patch, !edit.checkpoint);
    this.publish(author, patch);
    return this.version;
  }

  /** Reverts the author's last step, leaving anything others have changed since. */
  undo(author: string) {
    return this.step(author, 'undo');
  }

  redo(author: string) {
    return this.step(author, 'redo');
  }

  counts(author: string) {
    const history = this.histories.get(author);
    return { undo: history?.undo.length ?? 0, redo: history?.redo.length ?? 0 };
  }

  historyCounts() {
    return Object.fromEntries(
      [...this.histories].map(([author, history]) => [
        author,
        [history.undo.length, history.redo.length],
      ]),
    );
  }

  /** What others changed after a version, for telling an author whose view may be out of date. */
  changesSince(version: number, author: string) {
    const parts = {
      added: new Set<string>(),
      changed: new Set<string>(),
      removed: new Set<string>(),
    };
    const joints = new Set<string>(),
      constraints = new Set<string>();
    let renamed = false,
      replaced = false;
    for (const [at, entry] of this.log) {
      if (at <= version || entry.author === author) continue;
      if (entry.replaced) {
        replaced = true;
        continue;
      }
      const { summary } = entry;
      summary.partsAdded.forEach((id) => parts.added.add(id));
      summary.partsChanged.forEach((id) => parts.changed.add(id));
      summary.partsRemoved.forEach((id) => parts.removed.add(id));
      summary.joints.forEach((id) => joints.add(id));
      summary.constraints.forEach((id) => constraints.add(id));
      renamed ||= summary.renamed;
    }
    const present = new Set(this.scene.parts.map((part) => part.id));
    const list = (ids: Set<string>, keep = (id: string) => present.has(id)) =>
      [...ids].filter(keep);
    const result = {
      ...(replaced ? { scene_replaced: true } : {}),
      ...(renamed ? { scene_renamed: true } : {}),
      parts_added: list(parts.added),
      parts_changed: list(parts.changed, (id) => present.has(id) && !parts.added.has(id)),
      parts_removed: list(parts.removed, (id) => !present.has(id)),
      joints: [...joints],
      plane_constraints: [...constraints],
    };
    const entries = Object.entries(result).filter(([, value]) =>
      Array.isArray(value) ? value.length > 0 : value,
    );
    return entries.length ? Object.fromEntries(entries) : null;
  }

  addMesh(key: string, geometry: BufferGeometry) {
    this.meshes.set(key, geometry);
    this.uploads.set(key, Date.now());
  }

  mesh(key: string) {
    const geometry = this.meshes.get(key);
    return geometry && restoreGeometry(geometry);
  }

  private step(author: string, direction: 'undo' | 'redo') {
    const history = this.histories.get(author);
    const stack = direction === 'undo' ? history?.undo : history?.redo;
    const patch = stack?.at(-1);
    if (!history || !stack || !patch) return null;
    const current = this.scene;
    const { scene, changed } = applyPatch(
      current,
      mapPatchGeometry(patch, restoreGeometry),
      direction,
    );
    const next = changed ? reconcile(scene) : current;
    stack.pop();
    (direction === 'undo' ? history.redo : history.undo).push(patch);
    const applied = diffScenes(current, next);
    if (applied.length) {
      useEditor.setState((state) => ({ scene: next, revision: state.revision + 1 }));
      this.publish(author, applied);
    } else this.publish(author, []);
    return { changed: applied.length > 0, version: this.version };
  }

  private record(author: string, patch: ScenePatch, amend: boolean) {
    let history = this.histories.get(author);
    if (!history) this.histories.set(author, (history = { undo: [], redo: [] }));
    patch = mapPatchGeometry(patch, archiveGeometry);
    const last = history.undo.at(-1);
    if (amend && last && !history.redo.length)
      history.undo[history.undo.length - 1] = composePatches(last, patch);
    else {
      history.undo.push(patch);
      if (history.undo.length > historyLimit) history.undo.shift();
    }
    history.redo = [];
  }

  private publish(author: string, patch: ScenePatch, replaced = false) {
    this.version++;
    this.versions.set(this.version, archiveScene(this.scene));
    this.log.set(this.version, { author, summary: summarizePatch(patch), replaced });
    this.versions.delete(this.version - keepVersions);
    this.log.delete(this.version - keepVersions);
    for (const part of this.scene.parts) {
      const { geometry } = part;
      this.meshes.set(geometry.uuid, archiveGeometry(geometry));
      this.uploads.delete(geometry.uuid);
    }
    if (changesGeometry(patch)) this.trimMemory();
    if (this.version % 50 === 0) this.prune();
    for (const listener of this.listeners) listener();
  }

  /**
   * Reserve the mesh budget for undo and redo before retaining older scene versions.
   * Change summaries, each author’s newest undo step, and the current version stay.
   */
  private trimMemory() {
    const kept = buffersOf(this.scene.parts.map((part) => part.geometry));
    const counts = new Map<ArrayBufferLike, number>();
    const references = new Map<HistoryGeometry, number>();
    let total = 0;
    const hold = (geometries: HistoryGeometry[], by: 1 | -1) => {
      for (const geometry of geometries) {
        const previous = references.get(geometry) ?? 0;
        references.set(geometry, previous + by);
        if (previous !== 0 && previous + by !== 0) continue;
        for (const buffer of buffersOf([geometry])) {
          if (kept.has(buffer)) continue;
          const count = (counts.get(buffer) ?? 0) + by;
          counts.set(buffer, count);
          if (by === 1 && count === 1) total += buffer.byteLength;
          if (by === -1 && count === 0) total -= buffer.byteLength;
        }
      }
    };
    const ofScene = (scene: HistoryScene) => scene.parts.map((part) => part.geometry);
    const ofPatch = (patch: ScenePatch) =>
      patch.flatMap((change) =>
        change.kind === 'parts'
          ? [change.before, change.after].flatMap((entity) =>
              entity ? [entity.geometry as HistoryGeometry] : [],
            )
          : [],
      );
    hold(ofScene(this.versions.get(this.version)!), 1);
    const histories = [...this.histories.values()];
    for (const history of histories)
      for (const patch of [...history.undo, ...history.redo]) hold(ofPatch(patch), 1);
    let trimmed = total > this.budget;

    const drop = () => {
      const undo = histories.find((history) => history.undo.length > 1);
      if (undo) return (hold(ofPatch(undo.undo.shift()!), -1), true);
      const redo = histories.find((history) => history.redo.length);
      if (redo) return (hold(ofPatch(redo.redo.shift()!), -1), true);
      return false;
    };
    while (total > this.budget && drop());
    // Version snapshots often own exactly the same buffers as undo. Spend any
    // remaining budget on the newest versions needed by late-arriving edits.
    for (const [version, scene] of [...this.versions].reverse()) {
      if (version === this.version) continue;
      if (total <= this.budget) hold(ofScene(scene), 1);
      if (total > this.budget) {
        this.versions.delete(version);
        trimmed = true;
      }
    }
    if (trimmed) this.prune();
  }

  /** Keeps every mesh that a version or an undo step can still bring back. */
  private prune() {
    const used = new Set<string>();
    const scenes = [...this.versions.values()];
    for (const scene of scenes) for (const part of scene.parts) used.add(part.geometry.uuid);
    const patches = [...this.histories.values()].flatMap((history) => [
      ...history.undo,
      ...history.redo,
    ]);
    for (const patch of patches)
      for (const change of patch)
        for (const entity of [change.before, change.after])
          if (change.kind === 'parts' && entity) used.add((entity.geometry as BufferGeometry).uuid);
    const recent = Date.now() - keepUploadsMs;
    for (const [key, time] of this.uploads) if (time > recent) used.add(key);
    for (const key of this.meshes.keys())
      if (!used.has(key)) {
        this.meshes.delete(key);
        this.uploads.delete(key);
      }
  }
}

/** The editor store is one per process, and so is the document built on it. */
export const sharedDocument = new SharedDocument();
