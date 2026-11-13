import { useEffect, useMemo, useRef, useState } from 'react';
import { partMatrix } from '../core/geometry';
import { useEditor } from '../core/store';
import { cancelTask, completeTask, failTask, startTask, updateTask } from '../core/activity';
import type {
  InspectionMesh,
  InspectionProgress,
  InspectionResponse,
  InspectionResult,
} from '../core/inspection-types';

export function useInspection() {
  const parts = useEditor((state) => state.scene.parts);
  const selected = useEditor((state) => state.selected);
  const isolated = useEditor((state) => state.isolated);
  const settings = useEditor((state) => state.view.inspection);
  const [retryId, setRetryId] = useState(0);
  const cancelCurrent = useRef<(() => void) | null>(null);
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
    cancelled?: boolean;
  } | null>(null);
  const [progress, setProgress] = useState<{
    request: typeof request;
    value: InspectionProgress;
  } | null>(null);
  useEffect(() => {
    if (!request.enabled || request.parts.length < 2) return;
    let worker: Worker | null = null;
    let taskId: string | null = null;
    let active = true;
    const report = (value: InspectionProgress) => {
      if (!active) return;
      setProgress({ request, value });
      if (taskId) updateTask(taskId, { detail: value.detail, progress: value.fraction });
    };
    const finish = (response: { result?: InspectionResult; error?: string }) => {
      if (!active) return;
      if (!response.result && !response.error)
        response = { error: 'The inspection worker returned an unreadable result.' };
      active = false;
      worker?.terminate();
      if (taskId) {
        if (response.error) failTask(taskId, response.error);
        else if (response.result) {
          const result = response.result;
          const overlapCount = result.pairs.filter(
            (pair) => pair.volume !== null && pair.volume > 0,
          ).length;
          completeTask(
            taskId,
            `${result.checkedPairs} ${result.checkedPairs === 1 ? 'pair' : 'pairs'} checked · ${overlapCount} overlapping${result.warnings.length ? ' · Partial analysis: see inspection notes' : ''}`,
          );
        }
      }
      setCompleted({ request, ...response });
    };
    const cancel = () => {
      if (!active) return;
      active = false;
      clearTimeout(debounce);
      worker?.terminate();
      if (taskId) cancelTask(taskId, 'Inspection cancelled');
      setCompleted({ request, cancelled: true });
    };
    cancelCurrent.current = cancel;
    // Coalesce live dragging and threshold edits. Source buffers remain owned by the editor.
    const debounce = setTimeout(async () => {
      taskId = startTask({
        title: 'Interference inspection',
        detail: `Preparing ${request.parts.length} parts`,
        progress: null,
        cancel,
      });
      try {
        worker = new Worker(new URL('../core/inspection.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.onmessage = (event: MessageEvent<InspectionResponse>) => {
          if (!active) return;
          const data = event.data;
          if (data && 'progress' in data) report(data.progress);
          else if (data && ('result' in data || 'error' in data)) finish(data);
          else finish({ error: 'The inspection worker returned an unreadable result.' });
        };
        worker.onerror = (event) =>
          finish({ error: event.message || 'The inspection worker stopped.' });
        worker.onmessageerror = () =>
          finish({ error: 'The inspection worker returned an unreadable result.' });
        const meshes: InspectionMesh[] = [];
        for (let partIndex = 0; partIndex < request.parts.length; partIndex++) {
          if (!active) return;
          const part = request.parts[partIndex];
          report({
            stage: 'preparing',
            detail: `Copying part ${partIndex + 1} of ${request.parts.length}: ${part.name}`,
            fraction: partIndex / request.parts.length,
          });
          // Let the progress UI paint and cancellation run between source copies.
          await new Promise<void>((resolve) => setTimeout(resolve, 0));
          if (!active) return;
          const position = part.geometry.getAttribute('position');
          const positions = new Float32Array(position.count * 3);
          for (let start = 0; start < position.count; start += 65536) {
            const end = Math.min(position.count, start + 65536);
            for (let i = start; i < end; i++) {
              positions[i * 3] = position.getX(i);
              positions[i * 3 + 1] = position.getY(i);
              positions[i * 3 + 2] = position.getZ(i);
            }
            report({
              stage: 'preparing',
              detail: `Copying part ${partIndex + 1} of ${request.parts.length}: ${part.name}`,
              fraction: (partIndex + end / position.count) / request.parts.length,
            });
            if (end < position.count) {
              await new Promise<void>((resolve) => setTimeout(resolve, 0));
              if (!active) return;
            }
          }
          const indices = part.geometry.index
            ? new Uint32Array(part.geometry.index.array)
            : undefined;
          meshes.push({
            id: part.id,
            name: part.name,
            positions,
            indices,
            matrix: partMatrix(part).toArray(),
          });
        }
        if (!active) return;
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
      const wasActive = active;
      active = false;
      clearTimeout(debounce);
      worker?.terminate();
      if (wasActive && taskId)
        cancelTask(taskId, 'Inspection stopped because the view or parts changed');
      if (cancelCurrent.current === cancel) cancelCurrent.current = null;
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
        : current?.cancelled
          ? 'cancelled'
          : current?.error
            ? 'error'
            : current?.result
              ? 'ready'
              : 'working',
    result: current?.result ?? null,
    error: current?.error,
    progress: progress?.request === request ? progress.value : null,
    cancel: () => cancelCurrent.current?.(),
    retry: () => setRetryId((id) => id + 1),
  } as const;
}

export type InspectionState = ReturnType<typeof useInspection>;
