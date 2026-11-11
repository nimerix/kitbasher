import type { BufferGeometry } from 'three';
import { uid } from './geometry';
import { appendGeometry, parseSceneDocument, readGeometry, validateLayout } from './scene-file';
import { liveHost, useEditor, useSharedHistory } from './store';
import { useXR } from './xr-session';
import { keepUnchanged, mergeScenes, sharedScene } from './sync';
import type { GeometryLayout, SceneDocument } from './types';

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
  const requests: ('undo' | 'redo')[] = [];
  /** The last scene the server sent. Unsent changes here are relative to it. */
  let confirmed: { version: number; epoch: number; scene: SceneDocument } | null = null;
  let latest: Message | null = null;
  let receiving = false;
  let pumping = false;
  let sending = false;
  let applyingRemote = false;
  let connected = false;
  let closed = false;
  let viewMoved = false;
  let dirty = false;
  let checkpoint = false;
  let replace = false;
  /** The version that holds this tab's last request. Nothing more is sent until it arrives. */
  let awaited = 0;

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

  const unsubscribe = useEditor.subscribe((state, previous) => {
    if (applyingRemote || state.scene === previous.scene || !confirmed) return;
    dirty = true;
    if (state.sceneEpoch !== previous.sceneEpoch) replace = true;
    // An action that adds an undo step here starts a new one on the server; a drag extends it.
    if (replace || state.past !== previous.past) checkpoint = true;
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
    const local = useEditor.getState().scene;
    const first = !confirmed;
    let next = scene;
    // This tab is about to replace the scene, so it keeps its own.
    if (replace) next = local;
    // Changes made on a scene that has since been replaced no longer apply.
    else if (first || message.epoch !== confirmed!.epoch) dirty = false;
    else if (dirty || sending) next = mergeScenes(confirmed!.scene, local, scene, 'ours');
    confirmed = { version: message.version, epoch: message.epoch, scene };
    const [undo, redo] = message.history[client] ?? [0, 0];
    useEditor.setState({ liveStatus: 'connected', sharedHistory: { undo, redo } });
    const before = new Set(local.parts.map((part) => part.id));
    show(next);
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
    dirty = false;
    replace = false;
    checkpoint = true;
    if (confirmed) show(confirmed.scene);
    notify(
      `Your last change was undone because it could not be combined with ${other}'s.${reason ? ` ${reason}` : ''}`,
    );
  };

  const lost = () => {
    if (closed) return;
    connected = false;
    useSharedHistory(null);
    // While the agent is away, undo here covers only changes made in the meantime.
    useEditor.setState({ liveStatus: 'disconnected', sharedHistory: null, past: [], future: [] });
  };

  const sendEdit = async () => {
    const scene = useEditor.getState().scene;
    const base = confirmed!;
    const flags = { checkpoint, replace };
    dirty = checkpoint = replace = false;
    sending = true;
    try {
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
        ...flags,
        scene: sharedScene(scene),
      });
      if (response.ok) awaited = ((await response.json()) as { version: number }).version;
      else refused(await errorOf(response));
    } catch (error) {
      if (error instanceof Refusal) refused(error.message);
      else {
        // Kept for when the agent can be reached again.
        dirty = true;
        checkpoint ||= flags.checkpoint;
        replace ||= flags.replace;
        lost();
      }
    } finally {
      sending = false;
    }
  };

  const sendHistory = async (direction: 'undo' | 'redo') => {
    sending = true;
    try {
      const response = await post(`live/${direction}`, { client });
      if (!response.ok) {
        notify((await errorOf(response)) ?? `This could not be ${direction}ne.`);
        return;
      }
      const result = (await response.json()) as {
        version: number;
        changed: boolean;
        empty?: boolean;
      };
      awaited = result.version;
      if (!result.changed && !result.empty)
        notify(
          `Nothing to ${direction}: ${other} has since changed everything that step touched.`,
          'info',
        );
    } catch {
      lost();
    } finally {
      sending = false;
    }
  };

  const pump = async () => {
    if (pumping) return;
    pumping = true;
    try {
      while (!closed && connected && confirmed && awaited <= confirmed.version) {
        if (dirty) await sendEdit();
        else if (requests.length) await sendHistory(requests.shift()!);
        else break;
      }
    } finally {
      pumping = false;
    }
  };

  const history = {
    undo: () => {
      requests.push('undo');
      void pump();
    },
    redo: () => {
      requests.push('redo');
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
    useSharedHistory(null);
    window.removeEventListener('pointerdown', markViewMoved, { capture: true });
    window.removeEventListener('wheel', markViewMoved, { capture: true });
  };
}
