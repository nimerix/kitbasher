import { useEffect, useRef, useState } from 'react';
import type { BufferGeometry } from 'three';
import { triangleCount } from '../core/geometry';
import { processMeshInWorker } from '../core/mesh-job';
import { useActivity } from '../core/activity';
import { useEditor } from '../core/store';
import { Modal, RadioGroup } from './ui';

export function MeshProcessingDialog() {
  const [input] = useState(() => {
    const state = useEditor.getState();
    return {
      part: state.scene.parts.find((p) => p.id === state.selected[0]),
      epoch: state.sceneEpoch,
    };
  });
  const [mode, setMode] = useState<'decimate' | 'remesh'>('decimate');
  const [percent, setPercent] = useState(25);
  const [errorLimit, setErrorLimit] = useState(0.1);
  const [resolution, setResolution] = useState(64);
  const [lockBorder, setLockBorder] = useState(true);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [busy, setBusy] = useState(false);
  const [taskId, setTaskId] = useState<string | null>(null);
  const task = useActivity((state) => state.tasks.find((item) => item.id === taskId));
  const [error, setError] = useState('');
  const [result, setResult] = useState<{ geometry: BufferGeometry; error: number | null } | null>(
    null,
  );
  const pending = useRef<AbortController | null>(null);
  const owned = useRef<BufferGeometry | null>(null);
  useEffect(
    () => () => {
      pending.current?.abort();
      owned.current?.dispose();
    },
    [],
  );
  const { part } = input;
  const scene = useEditor((s) => s.scene);
  const linked =
    part &&
    (!!part.anchors?.length ||
      scene.joints.some((j) => j.parentId === part.id || j.childId === part.id) ||
      scene.constraints?.some((c) => c.sourceId === part.id || c.targetId === part.id));
  const close = () => useEditor.getState().setModal(null);
  const clearResult = () => {
    owned.current?.dispose();
    owned.current = null;
    setResult(null);
    setError('');
  };
  const prepare = async () => {
    if (!part) return;
    clearResult();
    const controller = new AbortController();
    pending.current = controller;
    setBusy(true);
    try {
      const processed = await processMeshInWorker(
        part.geometry,
        mode === 'decimate'
          ? { mode, ratio: percent / 100, error: errorLimit / 100, lockBorder }
          : { mode, resolution },
        controller.signal,
        {
          title: `${mode === 'decimate' ? 'Reduce mesh' : 'Remesh surface'} · ${part.name}`,
          onTask: setTaskId,
        },
      );
      if (controller.signal.aborted) {
        processed.geometry.dispose();
        return;
      }
      owned.current = processed.geometry;
      setResult(processed);
    } catch (error) {
      if (!controller.signal.aborted && (error as Error).name !== 'AbortError')
        setError((error as Error).message);
    } finally {
      if (!controller.signal.aborted) setBusy(false);
    }
  };
  const apply = () => {
    if (!part || !result) return;
    const copy = keepOriginal || !!linked;
    const state = useEditor.getState();
    if (
      !state.applyProcessedMesh(
        part.id,
        part.geometry,
        result.geometry,
        copy,
        input.epoch,
        mode === 'decimate' ? 'Decimated' : 'Remeshed',
      )
    ) {
      setError('The source part changed or is locked. Close this dialog and select it again.');
      return;
    }
    owned.current = null;
    close();
    state.notify(
      `${mode === 'decimate' ? 'Decimated' : 'Remeshed'} mesh applied. Undo restores the original.`,
    );
  };
  if (!part)
    return (
      <Modal title="Mesh reduction" onClose={close}>
        <p>Select one part first.</p>
      </Modal>
    );
  const valid =
    mode === 'decimate'
      ? percent > 0 && percent <= 100 && errorLimit >= 0 && errorLimit <= 100
      : Number.isInteger(resolution) && resolution >= 24 && resolution <= 128;
  return (
    <Modal
      title="Decimate or remesh"
      subtitle={`${part.name} · ${triangleCount(part.geometry).toLocaleString()} triangles`}
      onClose={close}
    >
      <fieldset className="mesh-processing-options" disabled={busy}>
        <RadioGroup
          label="Mesh operation"
          value={mode}
          className="display-segmented"
          options={[
            { id: 'decimate', label: 'Decimate' },
            { id: 'remesh', label: 'Voxel remesh' },
          ]}
          onChange={(value) => {
            clearResult();
            setMode(value);
          }}
        />
        <p className="export-note">
          {mode === 'decimate'
            ? 'Reduce triangles with an error limit. Borders and fine features may prevent reaching the target.'
            : 'Rebuild a closed mesh on a voxel grid. This changes mating surfaces, can remove thin details, and removes vertex colors. Material tint is retained.'}
        </p>
        {mode === 'decimate' ? (
          <>
            <label className="field-label">
              <span>Triangles to keep (%)</span>
              <input
                aria-label="Triangles to keep (%)"
                type="number"
                min="1"
                max="100"
                step="1"
                value={percent}
                onChange={(e) => {
                  clearResult();
                  setPercent(Number(e.target.value));
                }}
              />
            </label>
            <label className="field-label">
              <span>Approximate error limit (% of mesh size)</span>
              <input
                aria-label="Approximate error limit"
                type="number"
                min="0"
                max="100"
                step="0.05"
                value={errorLimit}
                onChange={(e) => {
                  clearResult();
                  setErrorLimit(Number(e.target.value));
                }}
              />
            </label>
            <label className="mesh-check">
              <input
                type="checkbox"
                checked={lockBorder}
                onChange={(e) => {
                  clearResult();
                  setLockBorder(e.target.checked);
                }}
              />
              Preserve open borders
            </label>
          </>
        ) : (
          <label className="field-label">
            <span>Voxel resolution (24–128)</span>
            <input
              aria-label="Voxel resolution"
              type="number"
              min="24"
              max="128"
              step="8"
              value={resolution}
              onChange={(e) => {
                clearResult();
                setResolution(Number(e.target.value));
              }}
            />
            <small>Higher resolution retains smaller features and takes more memory.</small>
          </label>
        )}
        <label className="mesh-check">
          <input
            type="checkbox"
            checked={keepOriginal || !!linked}
            disabled={!!linked}
            onChange={(e) => setKeepOriginal(e.target.checked)}
          />
          Keep original as a hidden part
        </label>
        <p className="export-note">
          {keepOriginal || linked
            ? 'Creates an independent part at the same position. The hidden original retains its geometry and assembly links; show it again from the parts list. Exports of all parts include hidden originals.'
            : 'Replaces this part’s geometry. Undo restores it; save a scene copy to retain it beyond undo history.'}
        </p>
        {linked ? (
          <p className="export-note">
            Parts with anchors, joints or constraints are processed as independent copies.
          </p>
        ) : null}
      </fieldset>
      {busy && task ? (
        <div className="job-inline-progress" role="status">
          <p>{task.detail}</p>
          <progress
            aria-label="Mesh processing progress"
            max={1}
            value={task.progress ?? undefined}
          />
        </div>
      ) : null}
      {result ? (
        <p role="status" className="export-note">
          Ready: {triangleCount(result.geometry).toLocaleString()} triangles
          {result.error === null
            ? ''
            : ` · estimated error ${(result.error * 100).toPrecision(3)}% of mesh size`}
          . Review the result in the viewport after applying; Undo restores the previous scene.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="form-error">
          {error}
        </p>
      ) : null}
      <div className="modal-footer">
        <button className="button secondary" onClick={close}>
          {busy ? 'Cancel processing' : 'Cancel'}
        </button>
        {result ? (
          <button className="button primary" onClick={apply}>
            {keepOriginal || linked ? 'Add processed copy' : 'Replace mesh'}
          </button>
        ) : (
          <button
            className="button primary"
            disabled={busy || !valid || part.locked}
            onClick={prepare}
          >
            {busy ? 'Processing mesh…' : 'Prepare mesh'}
          </button>
        )}
      </div>
    </Modal>
  );
}
