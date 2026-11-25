import type { CleanInput, CleanResult } from './refine-clean';
import type { DetectOptions, RefineProposal } from './refine-detect';
import {
  type RefineModel,
  type RefineModelInput,
  type RefineRequest,
  buffersOf,
  packRefineModel,
  runRefineRequest,
  unpackClean,
  unpackProposals,
  unpackRefineModel,
} from './refine-model';

const cancelled = () => new DOMException('Refine cancelled', 'AbortError');

/** Builds in a worker when available, in-thread otherwise. Transfers the input arrays. */
export function buildRefineModelJob(
  input: RefineModelInput,
  signal: AbortSignal,
): Promise<RefineModel> {
  return run({ type: 'build', input }, signal, () => {}, unpackRefineModel);
}

/** Detects on copies of the model's arrays and keeps the edge proposals solveEdge can solve. */
export function detectRefineJob(
  model: RefineModel,
  options: DetectOptions,
  signal: AbortSignal,
  report: (fraction: number) => void,
): Promise<RefineProposal[]> {
  if (signal.aborted) return Promise.reject(cancelled());
  const triangles = options.triangles?.slice() ?? null;
  const request: RefineRequest = {
    type: 'detect',
    model: packRefineModel(model),
    options: { ...options, triangles },
  };
  return run(request, signal, report, unpackProposals);
}

/** Cleans copies of the model's arrays and returns the vertices that moved, with their positions. */
export function cleanRefineJob(
  model: RefineModel,
  input: CleanInput,
  signal: AbortSignal,
  report: (fraction: number) => void,
): Promise<CleanResult> {
  if (signal.aborted) return Promise.reject(cancelled());
  const request: RefineRequest = {
    type: 'clean',
    model: packRefineModel(model),
    input: { ...input, triangles: input.triangles?.slice() ?? null },
  };
  return run(request, signal, report, unpackClean);
}

function run<T>(
  request: RefineRequest,
  signal: AbortSignal,
  report: (fraction: number) => void,
  unpack: (result: unknown) => T,
): Promise<T> {
  if (signal.aborted) return Promise.reject(cancelled());
  const transfer = buffersOf(request);
  // Without a worker the request and result still pass through structured clone, as they would.
  if (typeof Worker === 'undefined')
    return Promise.resolve().then(() => {
      try {
        if (signal.aborted) throw cancelled();
        const received = structuredClone(request, { transfer });
        const result = runRefineRequest(received, report, signal);
        if (signal.aborted) throw cancelled();
        return unpack(structuredClone(result, { transfer: buffersOf(result) }));
      } catch (error) {
        throw signal.aborted ? cancelled() : error;
      }
    });

  return new Promise<T>((resolve, reject) => {
    let worker: Worker | undefined;
    let settled = false;
    const finish = (error: unknown, result?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', cancel);
      worker?.terminate();
      if (error) reject(error);
      else
        try {
          resolve(unpack(result));
        } catch (unreadable) {
          reject(unreadable);
        }
    };
    const cancel = () => finish(cancelled());
    signal.addEventListener('abort', cancel, { once: true });
    try {
      worker = new Worker(new URL('./refine.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') {
          if (settled) return;
          try {
            report(data.fraction);
          } catch (error) {
            finish(error);
          }
        } else if (data.error) finish(new Error(data.error));
        else finish(undefined, data.result);
      };
      worker.onerror = (event) => finish(new Error(event.message || 'The Refine worker stopped.'));
      worker.onmessageerror = () =>
        finish(new Error('The Refine worker returned an unreadable result.'));
      worker.postMessage(request, transfer);
    } catch (error) {
      finish(error);
    }
  });
}
