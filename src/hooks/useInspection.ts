import { useEffect, useMemo, useState } from 'react';
import { partMatrix } from '../core/geometry';
import { useEditor } from '../core/store';
import type { InspectionMesh, InspectionResult } from '../core/inspection-types';

export function useInspection() {
  const parts = useEditor((state) => state.scene.parts);
  const selected = useEditor((state) => state.selected);
  const isolated = useEditor((state) => state.isolated);
  const settings = useEditor((state) => state.view.inspection);
  const [retryId, setRetryId] = useState(0);
  const selectionKey = settings.scope === 'selected' ? selected.join('\0') : '';
  const request = useMemo(
    () => ({
      // An isolated view compares what it shows, not parts that are out of sight.
      parts: parts.filter(
        (part) =>
          part.visible &&
          (!isolated || isolated.includes(part.id)) &&
          (settings.scope === 'all' || selected.includes(part.id)),
      ),
      distance: settings.distance,
      enabled: settings.enabled,
      retryId,
    }),
    [parts, selectionKey, isolated, settings.scope, settings.distance, settings.enabled, retryId],
  );
  const [completed, setCompleted] = useState<{
    request: typeof request;
    result?: InspectionResult;
    error?: string;
  } | null>(null);
  useEffect(() => {
    if (!request.enabled || request.parts.length < 2) return;
    let worker: Worker | null = null;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let cancelled = false;
    const finish = (response: { result?: InspectionResult; error?: string }) => {
      clearTimeout(timeout);
      worker?.terminate();
      if (!cancelled) setCompleted({ request, ...response });
    };
    // Coalesce live dragging and threshold edits. Source buffers remain owned by the editor.
    const debounce = setTimeout(() => {
      try {
        worker = new Worker(new URL('../core/inspection.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event) => finish(event.data);
        worker.onerror = (event) =>
          finish({ error: event.message || 'The inspection worker stopped.' });
        timeout = setTimeout(
          () =>
            finish({
              error:
                'Inspection exceeded 60 seconds. Select fewer parts or simplify dense scans, then try again.',
            }),
          60000,
        );
        const meshes: InspectionMesh[] = request.parts.map((part) => {
          const position = part.geometry.getAttribute('position');
          const positions = new Float32Array(position.count * 3);
          for (let i = 0; i < position.count; i++) {
            positions[i * 3] = position.getX(i);
            positions[i * 3 + 1] = position.getY(i);
            positions[i * 3 + 2] = position.getZ(i);
          }
          const indices = part.geometry.index
            ? new Uint32Array(part.geometry.index.array)
            : undefined;
          return {
            id: part.id,
            name: part.name,
            positions,
            indices,
            matrix: partMatrix(part).toArray(),
          };
        });
        const transfer: ArrayBuffer[] = [];
        meshes.forEach((mesh) => {
          transfer.push(mesh.positions.buffer as ArrayBuffer);
          if (mesh.indices) transfer.push(mesh.indices.buffer as ArrayBuffer);
        });
        worker.postMessage({ meshes, distance: request.distance }, transfer);
      } catch (error) {
        finish({ error: (error as Error).message });
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearTimeout(timeout);
      worker?.terminate();
    };
  }, [request]);
  const current = completed?.request === request ? completed : null;
  return {
    settings,
    count: request.parts.length,
    status: !request.enabled
      ? 'off'
      : request.parts.length < 2
        ? 'empty'
        : current?.error
          ? 'error'
          : current?.result
            ? 'ready'
            : 'working',
    result: current?.result ?? null,
    error: current?.error,
    retry: () => setRetryId((id) => id + 1),
  } as const;
}

export type InspectionState = ReturnType<typeof useInspection>;
