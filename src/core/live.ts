import type { BufferGeometry } from 'three';
import { uid } from './geometry';
import { geometryBytes } from './history-budget';
import { appendGeometry, parseSceneDocument, readGeometry, validateLayout } from './scene-file';
import {
  committedScene,
  liveHost,
  restoreSculptAfterRefusal,
  stopSharedSculptHistory,
  useEditor,
  useSharedHistory,
  useSharedSculptQueueGuard,
} from './store';
import { useXR } from './xr-session';
import { matchesSculptTarget, sculptHistoryBytes, type SculptTarget } from './sculpt-session';
import { keepUnchanged, mergeScenes, sharedScene } from './sync';
import type { GeometryLayout, SceneDocument } from './types';

interface OrdinaryEdit {
  before: SceneDocument;
  scene: SceneDocument;
  checkpoint: boolean;
  replace: boolean;
}

interface SculptEdit {
  sculpt: SculptTarget;
  geometry: BufferGeometry;
}

type QueuedEdit = OrdinaryEdit | SculptEdit;

interface HistoryRequest {
  direction: 'undo' | 'redo';
  sculpt: number | null;
}

function applyQueuedEdit(scene: SceneDocument, edit: QueuedEdit): SceneDocument {
  if (!('sculpt' in edit))
    return edit.replace ? edit.scene : mergeScenes(edit.before, edit.scene, scene);
  const { sculpt, geometry } = edit;
  return {
    ...scene,
    parts: scene.parts.map((part) =>
      part.id === sculpt.partId && part.geometry.uuid === sculpt.source
        ? { ...part, geometry }
        : part,
    ),
  };
}

interface Message {
  version: number;
  epoch: number;
  scene: unknown;
  geometries: Record<string, GeometryLayout>;
  history: Record<string, [number, number]>;
}

// The other side of the scene: an agent's server, or a session with no agent in it.
const host = liveHost === 'people' ? 'The session' : 'The agent';
const other = liveHost === 'people' ? 'someone else' : 'the agent';

/** The server turned a request down. Retrying it would not help. */
class Refusal extends Error {}

const clientKey = 'kitbasher.live-client';

/** One id per tab, kept across reloads, so undo still finds this tab's own changes. */
function tabId() {
  try {
    const stored = sessionStorage.getItem(clientKey);
    if (stored) return stored;
    const id = uid();
    sessionStorage.setItem(clientKey, id);
    return id;
  } catch {
    return uid();
  }
}

const post = (path: string, body: unknown) =>
  fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

const errorOf = async (response: Response) =>
  ((await response.json().catch(() => ({}))) as { error?: string }).error;

/**
 * Edits the scene an MCP server holds, alongside the agent and any other tabs. Changes made here
 * show at once and are sent in the background; the server combines them with everyone else's.
 * Camera, selection, and tools stay in this tab. Meshes cross once each, by key.
 */
export function joinLiveSession() {
  const client = tabId();
  const source = new EventSource('live/events');
  const meshes = new Map<string, BufferGeometry>();
  /** Mesh keys the server already holds. */
  const known = new Set<string>();
  const edits: QueuedEdit[] = [];
  const requests: HistoryRequest[] = [];
  /** The last scene the server sent. Unsent changes here are relative to it. */
  let confirmed: { version: number; epoch: number; scene: SceneDocument } | null = null;
  let latest: Message | null = null;
  let receiving = false;
  let pumping = false;
  let applyingRemote = false;
  let connected = false;
  let closed = false;
  let viewMoved = false;
  let dirtyEdit: OrdinaryEdit | null = null;
  let activeEdit: QueuedEdit | null = null;
  let activeSculptObserved = false;
  /** The version that holds this tab's last request. Nothing more is sent until it arrives. */
  let awaited = 0;
  let awaitedHistory: { version: number; sculpt: number | null } | null = null;

  const notify = (message: string, kind: 'error' | 'info' = 'error') =>
    useEditor.getState().notify(message, kind);

  const show = (scene: SceneDocument) => {
    applyingRemote = true;
    try {
      useEditor.getState().receiveScene(keepUnchanged(useEditor.getState().scene, scene));
    } finally {
      applyingRemote = false;
    }
  };

  const unsentEdits = () => (dirtyEdit ? [...edits, dirtyEdit] : edits);

  useSharedSculptQueueGuard((geometry) => {
    if (!connected) return false;
    const queued = [activeEdit, ...edits].flatMap((edit) =>
      edit && 'sculpt' in edit ? [edit.geometry] : [],
    );
    return queued.length < 40 && geometryBytes([...queued, geometry]) <= sculptHistoryBytes;
  });

  const unsubscribe = useEditor.subscribe((state, previous) => {
    const before = committedScene(previous);
    const scene = committedScene(state);
    if (applyingRemote || scene === before || !confirmed) return;
    const sculpt = state.sculpt;
    const step = sculpt?.past.at(-1);
    const target = sculpt && before.parts.find((part) => part.id === sculpt.partId);
    const changed = sculpt && scene.parts.find((part) => part.id === sculpt.partId);
    if (
      sculpt &&
      sculpt.revision !== previous.sculpt?.revision &&
      step &&
      target &&
      changed &&
      target.geometry !== changed.geometry &&
      step.before.geometry === target.geometry.uuid &&
      step.after.geometry === changed.geometry.uuid
    ) {
      // Keep each geometry stroke as a separate shared undo step, even during an upload.
      if (dirtyEdit) edits.push(dirtyEdit);
      dirtyEdit = null;
      edits.push({
        geometry: changed.geometry,
        sculpt: {
          partId: target.id,
          source: target.geometry.uuid,
          position: target.position,
          quaternion: target.quaternion,
          scale: target.scale,
        },
      });
    } else {
      const replace = state.sceneEpoch !== previous.sceneEpoch;
      if (replace) {
        edits.length = 0;
        dirtyEdit = null;
      }
      // Accumulate only ordinary edits, each relative to what this action actually changed.
      // In particular, an optimistic sculpt mesh in both scenes must not enter this batch.
      dirtyEdit = {
        before: dirtyEdit?.before ?? before,
        scene:
          dirtyEdit && dirtyEdit.scene !== before
            ? mergeScenes(before, scene, dirtyEdit.scene)
            : scene,
        checkpoint: replace || !!dirtyEdit?.checkpoint || state.past !== previous.past,
        replace: replace || !!dirtyEdit?.replace,
      };
    }
    void pump();
  });

  const load = async (message: Message) => {
    for (const [key, layout] of Object.entries(message.geometries)) {
      if (meshes.has(key)) continue;
      const response = await fetch(`live/geometry/${encodeURIComponent(key)}`);
      // The scene has already moved on from this mesh, and a newer message is on its way.
      if (response.status === 404) return false;
      if (!response.ok) throw new Error(`${host} did not send a mesh.`);
      const body = await response.blob();
      validateLayout(layout, 0, body.size);
      const geometry = await readGeometry(body, layout);
      geometry.uuid = key;
      meshes.set(key, geometry);
    }
    return true;
  };

  const apply = (message: Message) => {
    const scene = parseSceneDocument(message.scene, 2, (key) => {
      const geometry = meshes.get(key as string);
      if (!geometry) throw new Error(`${host} sent a part without its mesh.`);
      return geometry;
    });
    for (const key of Object.keys(message.geometries)) known.add(key);
    const local = committedScene(useEditor.getState());
    const first = !confirmed;
    const replaced = !!confirmed && message.epoch !== confirmed.epoch;
    const unsent = unsentEdits();
    if (activeEdit && 'sculpt' in activeEdit) {
      const { sculpt, geometry } = activeEdit;
      if (
        scene.parts.some(
          (part) => part.id === sculpt.partId && part.geometry.uuid === geometry.uuid,
        )
      )
        activeSculptObserved = true;
    }
    const replacing = unsent.some((edit) => !('sculpt' in edit) && edit.replace);
    let next = scene;
    // Changes built on a replaced scene no longer apply, unless we will replace it ourselves.
    if (!replacing && (first || replaced)) {
      dirtyEdit = null;
      edits.length = 0;
      if (replaced && useEditor.getState().sculpt) useEditor.getState().setTool('select');
    } else {
      const pending = activeEdit && !activeSculptObserved ? [activeEdit, ...unsent] : unsent;
      next = pending.reduce(applyQueuedEdit, scene);
    }
    confirmed = { version: message.version, epoch: message.epoch, scene };
    const [undo, redo] = message.history[client] ?? [0, 0];
    useEditor.setState({ liveStatus: 'connected', sharedHistory: { undo, redo } });
    const before = new Set(local.parts.map((part) => part.id));
    show(next);
    if (awaitedHistory && message.version >= awaitedHistory.version) {
      stopSharedSculptHistory(true, awaitedHistory.sculpt);
      awaitedHistory = null;
    }
    if (!replacing && (first || replaced)) useEditor.getState().settleWarp(true);
    const shown = useEditor.getState().scene;
    if (first) useEditor.getState().markSaved(useEditor.getState().revision);
    // Keep a growing model in view, until the person watching takes over the camera.
    const fresh = !shown.parts.some((part) => before.has(part.id));
    const grew = shown.parts.length > before.size;
    if (shown.parts.length && (fresh || (grew && !viewMoved)))
      useEditor.getState().focus(undefined, true);
    const used = new Set(shown.parts.map((part) => part.geometry.uuid));
    for (const key of meshes.keys())
      if (!used.has(key) && !(key in message.geometries)) meshes.delete(key);
  };

  const receive = async () => {
    if (receiving) return;
    receiving = true;
    try {
      while (latest && !closed) {
        const message = latest;
        latest = null;
        if ((await load(message)) && !closed) apply(message);
      }
    } catch (error) {
      notify(`The shared scene stopped updating. ${(error as Error).message}`);
    } finally {
      receiving = false;
    }
    void pump();
  };

  const upload = async (key: string, geometry: BufferGeometry) => {
    const body: BlobPart[] = [];
    const { layout } = appendGeometry(geometry, body, 0);
    const response = await fetch(`live/geometry/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'X-Kitbasher-Layout': JSON.stringify(layout) },
      body: new Blob(body),
    });
    if (!response.ok)
      throw new Refusal((await errorOf(response)) ?? `${host} could not take a mesh.`);
  };

  /** The server's scene stands. Later changes here were built on the refused one, so they go too. */
  const refused = (reason?: string) => {
    edits.length = 0;
    dirtyEdit = null;
    if (confirmed) {
      const { sculpt } = useEditor.getState();
      show(confirmed.scene);
      restoreSculptAfterRefusal(confirmed.scene, sculpt);
    }
    notify(
      `Your last change was undone because it could not be combined with ${other}'s.${reason ? ` ${reason}` : ''}`,
    );
    useEditor.getState().settleWarp(false);
  };

  const lost = () => {
    if (closed) return;
    connected = false;
    awaitedHistory = null;
    useSharedHistory(null);
    stopSharedSculptHistory();
    // While the agent is away, undo here covers only changes made in the meantime.
    useEditor.setState({ liveStatus: 'disconnected', sharedHistory: null, past: [], future: [] });
  };

  const sendEdit = async (edit: QueuedEdit) => {
    // Keep the submitted draft separate from any warp applied while this edit is in flight.
    const base = confirmed!;
    const sculpt = 'sculpt' in edit ? edit.sculpt : undefined;
    const checkpoint = 'sculpt' in edit || edit.checkpoint;
    const replace = !('sculpt' in edit) && edit.replace;
    activeEdit = edit;
    activeSculptObserved = false;
    if (!sculpt) useEditor.getState().submitWarp();
    try {
      if ('sculpt' in edit) {
        const target = base.scene.parts.find((part) => part.id === edit.sculpt.partId);
        // A request can succeed even when the connection drops before its response arrives.
        if (target?.geometry.uuid === edit.geometry.uuid) return;
        if (!matchesSculptTarget(target, edit.sculpt))
          throw new Refusal(
            'The sculpt target changed before the stroke reached the shared scene.',
          );
      }
      const scene = applyQueuedEdit(base.scene, edit);
      for (const { geometry } of scene.parts) {
        const key = geometry.uuid;
        if (known.has(key)) continue;
        await upload(key, geometry);
        known.add(key);
        meshes.set(key, geometry);
      }
      const response = await post('live/edit', {
        client,
        base: base.version,
        epoch: base.epoch,
        checkpoint,
        replace,
        sculpt,
        scene: sharedScene(scene),
      });
      if (response.ok) {
        awaited = ((await response.json()) as { version: number }).version;
        if (!sculpt) useEditor.getState().settleWarp(true, true);
        else if (!closed && confirmed && confirmed.version >= awaited) {
          // The stream can skip the accepted mesh or show it before the HTTP response arrives.
          show(unsentEdits().reduce(applyQueuedEdit, confirmed.scene));
        }
      } else refused(await errorOf(response));
    } catch (error) {
      if (error instanceof Refusal) refused(error.message);
      else {
        // Kept for when the agent can be reached again.
        edits.unshift(edit);
        if (!sculpt) useEditor.getState().retryWarp();
        lost();
      }
    } finally {
      activeEdit = null;
    }
  };

  const sendHistory = async ({ direction, sculpt }: HistoryRequest) => {
    try {
      const response = await post(`live/${direction}`, { client });
      if (!response.ok) {
        stopSharedSculptHistory(false, sculpt);
        notify((await errorOf(response)) ?? `This could not be ${direction}ne.`);
        return;
      }
      const result = (await response.json()) as {
        version: number;
        changed: boolean;
        empty?: boolean;
      };
      awaited = result.version;
      if (sculpt && result.changed && awaited > confirmed!.version)
        awaitedHistory = { version: awaited, sculpt };
      else stopSharedSculptHistory(result.changed, sculpt);
      if (!result.changed && !result.empty)
        notify(
          `Nothing to ${direction}: ${other} has since changed everything that step touched.`,
          'info',
        );
    } catch {
      lost();
    }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && connected && confirmed && awaited <= confirmed.version) {
        const edit = edits.shift() ?? dirtyEdit;
        if (edit) {
          if (edit === dirtyEdit) dirtyEdit = null;
          await sendEdit(edit);
        } else if (requests.length) await sendHistory(requests.shift()!);
        else break;
      }
    } finally {
      pumping = false;
    }
  };

  const history = {
    undo: () => {
      requests.push({
        direction: 'undo',
        sculpt: useEditor.getState().sculpt?.pending?.id ?? null,
      });
      void pump();
    },
    redo: () => {
      requests.push({
        direction: 'redo',
        sculpt: useEditor.getState().sculpt?.pending?.id ?? null,
      });
      void pump();
    },
  };

  const markViewMoved = () => {
    viewMoved = true;
  };
  window.addEventListener('pointerdown', markViewMoved, { capture: true, once: true });
  window.addEventListener('wheel', markViewMoved, { capture: true, once: true, passive: true });

  source.addEventListener('scene', (event) => {
    latest = JSON.parse((event as MessageEvent<string>).data);
    if (!connected) {
      connected = true;
      useSharedHistory(history);
    }
    void receive();
  });
  // Sent only to tabs on the computer that holds the scene: how another device joins it.
  source.addEventListener('share', (event) =>
    useXR.setState({ sharing: JSON.parse((event as MessageEvent<string>).data) }),
  );
  // EventSource keeps retrying, so a server that is only briefly unreachable reconnects by itself.
  source.onerror = lost;
  useEditor.setState({ liveStatus: 'connecting' });

  return () => {
    closed = true;
    source.close();
    unsubscribe();
    useSharedSculptQueueGuard(null);
    useSharedHistory(null);
    stopSharedSculptHistory();
    useEditor.setState({ liveStatus: null });
    window.removeEventListener('pointerdown', markViewMoved, { capture: true });
    window.removeEventListener('wheel', markViewMoved, { capture: true });
  };
}
