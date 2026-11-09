import type { BufferGeometry } from 'three';
import { parseSceneDocument, readGeometry, validateLayout } from './scene-file';
import { useEditor } from './store';
import type { GeometryLayout } from './types';

interface LiveMessage {
  sequence: number;
  scene: unknown;
  geometries: Record<string, GeometryLayout>;
}

/**
 * Mirrors the scene an MCP server is building. Its parts and relationships arrive on every change.
 * Meshes never change, so each one is fetched once, as autosave stores each one once.
 */
export function followLiveScene() {
  const source = new EventSource('live/events');
  const meshes = new Map<string, BufferGeometry>();
  let latest: LiveMessage | null = null;
  let applying = false;
  let closed = false;
  let viewMoved = false;

  const markViewMoved = () => {
    viewMoved = true;
  };
  window.addEventListener('pointerdown', markViewMoved, { capture: true, once: true });
  window.addEventListener('wheel', markViewMoved, { capture: true, once: true, passive: true });

  const apply = async (message: LiveMessage) => {
    for (const [key, layout] of Object.entries(message.geometries)) {
      if (meshes.has(key)) continue;
      const response = await fetch(`live/geometry/${key}`);
      // The agent has already moved on from this mesh, and a newer message is on its way.
      if (response.status === 404) return;
      if (!response.ok) throw new Error('The agent did not send a mesh.');
      const body = await response.blob();
      validateLayout(layout, 0, body.size);
      const geometry = await readGeometry(body, layout);
      geometry.uuid = key;
      meshes.set(key, geometry);
    }
    if (closed) return;
    for (const key of meshes.keys()) if (!(key in message.geometries)) meshes.delete(key);
    const scene = parseSceneDocument(message.scene, 2, (reference) => {
      const geometry = meshes.get(reference as string);
      if (!geometry) throw new Error('The agent sent a part without its mesh.');
      return geometry;
    });
    const editor = useEditor.getState();
    const previous = new Set(editor.scene.parts.map((part) => part.id));
    const replaced = !scene.parts.some((part) => previous.has(part.id));
    const grew = scene.parts.length > previous.size;
    editor.followScene(scene);
    // Keep a growing model in view, until the person watching takes over the camera.
    if (scene.parts.length && (replaced || (grew && !viewMoved)))
      useEditor.getState().focus(undefined, true);
  };

  const drain = async () => {
    if (applying) return;
    applying = true;
    try {
      while (latest && !closed) {
        const message = latest;
        latest = null;
        await apply(message);
      }
    } catch (error) {
      useEditor
        .getState()
        .notify(`The live view stopped updating. ${(error as Error).message}`, 'error');
    } finally {
      applying = false;
    }
  };

  source.addEventListener('scene', (event) => {
    latest = JSON.parse((event as MessageEvent<string>).data);
    useEditor.setState({ liveStatus: 'connected' });
    void drain();
  });
  source.onopen = () => useEditor.setState({ liveStatus: 'connected' });
  // EventSource keeps retrying, so a restarted server on the same address reconnects by itself.
  source.onerror = () => useEditor.setState({ liveStatus: 'disconnected' });
  useEditor.setState({ liveStatus: 'connecting' });

  return () => {
    closed = true;
    source.close();
    window.removeEventListener('pointerdown', markViewMoved, { capture: true });
    window.removeEventListener('wheel', markViewMoved, { capture: true });
  };
}
