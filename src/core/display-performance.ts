import { create } from 'zustand';
import type { BufferGeometry, Intersection, Mesh, Raycaster } from 'three';
import { triangleCount } from './geometry';
import { processMeshInWorker } from './mesh-job';
import type { Part } from './types';
import { cancelTask, completeTask, failTask, startTask } from './activity';
import { backgroundWork, meshWorkBytes } from './work-queue';

export type DisplayDetail = 'auto' | 'full' | 'fast';
const key = 'kitbasher.display-detail';
function readDetail(): DisplayDetail {
  try {
    const value = localStorage.getItem(key);
    return value === 'full' || value === 'fast' ? value : 'auto';
  } catch {
    return 'auto';
  }
}

export const useDisplayPerformance = create<{ detail: DisplayDetail; moving: boolean }>(() => ({
  detail: readDetail(),
  moving: false,
}));
export function setDisplayDetail(detail: DisplayDetail) {
  useDisplayPerformance.setState({ detail });
  try {
    localStorage.setItem(key, detail);
  } catch {
    /* Session setting still works. */
  }
}
let idle: ReturnType<typeof setTimeout> | undefined;
export function markInteraction() {
  if (!useDisplayPerformance.getState().moving) useDisplayPerformance.setState({ moving: true });
  clearTimeout(idle);
  idle = setTimeout(() => useDisplayPerformance.setState({ moving: false }), 180);
}

export const proxyThreshold = 100_000;
export const proxyTarget = 50_000;
const headsetTriangleBudget = 300_000;
const proxyLevels = [50_000, 25_000, 12_500, 6_250] as const;

/** A shared budget prevents each scan in a VR assembly from consuming the whole frame. */
export function displayTarget(parts: Part[], headset: boolean) {
  if (!headset) return proxyTarget;
  let dense = 0,
    original = 0;
  for (const part of parts) {
    if (!part.visible) continue;
    const count = triangleCount(part.geometry);
    if (count >= proxyThreshold) dense++;
    else original += count;
  }
  const allowance = (headsetTriangleBudget - original) / Math.max(1, dense);
  return proxyLevels.find((target) => target <= allowance) ?? proxyLevels[proxyLevels.length - 1];
}

/** Bounded background workers; duplicates and undo share the source's proxy. */
const proxies = new WeakMap<BufferGeometry, Map<number, Promise<BufferGeometry | null>>>();
export function displayProxy(
  source: BufferGeometry,
  target = proxyTarget,
): Promise<BufferGeometry | null> {
  if (triangleCount(source) < proxyThreshold) return Promise.resolve(null);
  let levels = proxies.get(source);
  if (!levels) proxies.set(source, (levels = new Map()));
  const cached = levels.get(target);
  if (cached) return cached;
  const controller = new AbortController();
  const taskId = startTask({
    title: 'Optimize viewport mesh',
    detail: `${triangleCount(source).toLocaleString()} triangles · waiting for another mesh`,
    status: 'queued',
    progress: null,
    notify: false,
    cancel: () => controller.abort(),
  });
  controller.signal.addEventListener(
    'abort',
    () => cancelTask(taskId, 'Viewport optimization cancelled.'),
    { once: true },
  );
  let proxy: BufferGeometry | null = null;
  const dispose = () => {
    controller.abort();
    proxy?.dispose();
    source.removeEventListener('dispose', dispose);
    proxies.delete(source);
  };
  source.addEventListener('dispose', dispose);
  const task = backgroundWork
    .run(
      meshWorkBytes(source),
      async () => {
        if (controller.signal.aborted) return null;
        try {
          const result = await processMeshInWorker(
            source,
            {
              mode: 'decimate',
              ratio: target / triangleCount(source),
              error: 0.002,
              lockBorder: true,
            },
            controller.signal,
            { taskId },
          );
          if (
            controller.signal.aborted ||
            triangleCount(result.geometry) >= triangleCount(source) * 0.9
          ) {
            result.geometry.dispose();
            if (!controller.signal.aborted)
              completeTask(
                taskId,
                'Original mesh retained: reduction was below the useful threshold.',
              );
            return null;
          }
          proxy = result.geometry;
          completeTask(
            taskId,
            `Viewport mesh ready · ${triangleCount(proxy).toLocaleString()} triangles`,
          );
          return proxy;
        } catch (error) {
          if (controller.signal.aborted) cancelTask(taskId, 'Viewport optimization cancelled.');
          else
            failTask(
              taskId,
              `${error instanceof Error ? error.message : String(error)} The original mesh remains available.`,
            );
          return null;
        } // A failed display optimization always leaves the original drawable.
      },
      controller.signal,
    )
    .catch((error) => {
      if (controller.signal.aborted) return null;
      throw error;
    });
  levels.set(target, task);
  const releaseCancelled = () => {
    if (levels.get(target) === task) levels.delete(target);
    source.removeEventListener('dispose', dispose);
  };
  // A later Full → Fast switch or hide/show can retry an explicitly cancelled job.
  // Waiting for its queue turn would leave a cancelled entry cached behind a slow mesh.
  controller.signal.addEventListener('abort', releaseCancelled, { once: true });
  void task.then(() => {
    if (!controller.signal.aborted)
      controller.signal.removeEventListener('abort', releaseCancelled);
  });
  return task;
}

/** Draw a proxy, but return original triangle ids, points and normals for every editing tool. */
export function sourceRaycast(source: BufferGeometry, raycast: Mesh['raycast']): Mesh['raycast'] {
  return function (this: Mesh, raycaster: Raycaster, hits: Intersection[]) {
    const displayed = this.geometry;
    this.geometry = source;
    try {
      raycast.call(this, raycaster, hits);
    } finally {
      this.geometry = displayed;
    }
  };
}

export function shouldDrawProxy(
  detail: DisplayDetail,
  moving: boolean,
  headset: boolean,
  precision: boolean,
) {
  return !precision && detail !== 'full' && (detail === 'fast' || moving || headset);
}
