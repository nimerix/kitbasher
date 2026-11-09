import type { BufferGeometry } from 'three';
import { useEditor } from '../src/core/store';
import {
  applyPatch,
  composePatches,
  diffScenes,
  mergeScenes,
  reconcile,
  summarizePatch,
} from '../src/core/sync';
import type { ScenePatch } from '../src/core/sync';
import type { SceneDocument } from '../src/core/types';

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
}

interface Logged {
  author: string;
  patch: ScenePatch;
  replaced: boolean;
}

// Enough for a tab that falls behind during a large upload.
const keepVersions = 200;
const keepSteps = 40;
const keepUploadsMs = 10 * 60 * 1000;

/**
 * The one scene that the agent and every browser tab edit. Each change gets a version, so an edit
 * made on an older version can be combined with what happened since. Each author has their own
 * undo history, which reverts only their changes.
 */
export class SharedDocument {
  version = 0;
  /** Counts scene replacements. Edits made before one no longer apply. */
  epoch = 0;
  private readonly versions = new Map<number, SceneDocument>();
  private readonly log = new Map<number, Logged>();
  private readonly histories = new Map<string, { undo: ScenePatch[]; redo: ScenePatch[] }>();
  private readonly meshes = new Map<string, BufferGeometry>();
  private readonly uploads = new Map<string, number>();
  private readonly listeners = new Set<() => void>();

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
  replace(scene: SceneDocument, author = agent, saved = true) {
    useEditor.getState().setScene(scene);
    if (!saved) useEditor.setState({ savedRevision: -1 });
    this.epoch++;
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
    if (edit.replace) {
      this.replace(edit.scene, author, false);
      return this.version;
    }
    if (edit.epoch !== this.epoch)
      throw new EditConflict('The scene was replaced while this change was being made.');
    const base = this.versions.get(edit.base);
    if (!base)
      throw new EditConflict('This change was made on a version of the scene that is too old.');
    const current = this.scene;
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
      const summary = summarizePatch(entry.patch);
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
    return this.meshes.get(key);
  }

  private step(author: string, direction: 'undo' | 'redo') {
    const history = this.histories.get(author);
    const stack = direction === 'undo' ? history?.undo : history?.redo;
    const patch = stack?.at(-1);
    if (!history || !stack || !patch) return null;
    const current = this.scene;
    const { scene, changed } = applyPatch(current, patch, direction);
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
    const last = history.undo.at(-1);
    if (amend && last && !history.redo.length)
      history.undo[history.undo.length - 1] = composePatches(last, patch);
    else {
      history.undo.push(patch);
      if (history.undo.length > keepSteps) history.undo.shift();
    }
    history.redo = [];
  }

  private publish(author: string, patch: ScenePatch, replaced = false) {
    this.version++;
    this.versions.set(this.version, this.scene);
    this.log.set(this.version, { author, patch, replaced });
    this.versions.delete(this.version - keepVersions);
    this.log.delete(this.version - keepVersions);
    for (const part of this.scene.parts) this.meshes.set(part.geometry.uuid, part.geometry);
    if (this.version % 50 === 0) this.prune();
    for (const listener of this.listeners) listener();
  }

  /** Keeps every mesh that a version or an undo step can still bring back. */
  private prune() {
    const used = new Set<string>();
    const scenes = [...this.versions.values()];
    for (const scene of scenes) for (const part of scene.parts) used.add(part.geometry.uuid);
    for (const history of this.histories.values())
      for (const patch of [...history.undo, ...history.redo])
        for (const change of patch)
          for (const entity of [change.before, change.after])
            if (change.kind === 'parts' && entity)
              used.add((entity.geometry as BufferGeometry).uuid);
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
