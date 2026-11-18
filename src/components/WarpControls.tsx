import { useEffect, useMemo, useRef } from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { clipLimits } from '../core/clipping';
import { fittedSizeRange, partSize } from '../core/geometry';
import {
  useEditor,
  warpChanges,
  warpDistributeCounts,
  warpPointRadius,
  warpWholePart,
  type WarpSession,
} from '../core/store';
import type { Part } from '../core/types';
import { warpDensityNodes } from '../core/warp-grid';
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { TransformAdjustments } from './TransformAdjustments';
import { LogRangeInput, NumericInput, RadioGroup, Section } from './ui';

type PointSettings = { radius?: number; falloff?: number };

/**
 * Sends a slider's changes to the selected points at most once a frame, and its release as one
 * step. A range input fires a native change when it is let go, by pointer or by key.
 */
function usePointSettingsGesture() {
  const pending = useRef<PointSettings | null>(null),
    frame = useRef(0),
    container = useRef<HTMLDivElement>(null);
  const end = useMemo(() => {
    const finish = () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
      window.removeEventListener('pointerup', finish);
      const patch = pending.current;
      pending.current = null;
      if (patch) useEditor.getState().setWarpPointSettings(patch, 'end');
    };
    return finish;
  }, []);
  useEffect(() => {
    const element = container.current!;
    element.addEventListener('change', end);
    return () => {
      element.removeEventListener('change', end);
      end();
    };
  }, [end]);
  const drag = (patch: PointSettings) => {
    if (!pending.current) window.addEventListener('pointerup', end);
    pending.current = { ...pending.current, ...patch };
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      if (pending.current) useEditor.getState().setWarpPointSettings(pending.current, 'drag');
    });
  };
  return { container, drag, end };
}

/** Radius, falloff and Distribute points, for the selected points or for new ones. */
function PointSettingsControls({ warp, part }: { warp: WarpSession; part: Part | undefined }) {
  const { container, drag, end } = usePointSettingsGesture();
  const selected = warp.points.filter((point) => warp.selectedPoints.includes(point.id));
  const shown = selected[0];
  const radius = shown ? shown.radius : warpPointRadius(warp, part);
  const falloff = shown ? shown.falloff : warp.pointFalloff;
  const { max } = fittedSizeRange(part ? partSize(part) : 40);
  const coarse = selected.some(
    (point) => point.radius > 0 && point.reach && !point.reach.effective,
  );
  const commit = (patch: PointSettings) => useEditor.getState().setWarpPointSettings(patch, 'end');
  const gesture = { onKeyUp: end, onBlur: end };
  return (
    <div className="warp-point-settings" ref={container}>
      <label className="warp-point-setting" {...gesture}>
        <span>Radius</span>
        <LogRangeInput
          label="Point radius slider"
          value={radius}
          min={0.1}
          max={max}
          zero
          onChange={(value) => drag({ radius: value })}
        />
        <NumericInput
          label="Point radius"
          value={radius}
          min={0}
          max={100}
          step={0.1}
          onCommit={(value) => commit({ radius: value })}
        />
        <small>mm</small>
      </label>
      <label className="warp-point-setting" {...gesture}>
        <span>Falloff</span>
        <input
          type="range"
          aria-label="Point falloff slider"
          min={0}
          max={100}
          step={1}
          value={Math.round(falloff * 100)}
          onChange={(event) => drag({ falloff: Number(event.target.value) / 100 })}
        />
        <NumericInput
          label="Point falloff"
          value={Math.round(falloff * 100)}
          min={0}
          max={100}
          onCommit={(value) => commit({ falloff: value / 100 })}
        />
        <small>%</small>
      </label>
      <p className="anchor-help">
        {selected.length
          ? radius > 0
            ? `Moves the surface within ${Number(radius.toPrecision(3))} mm of the selected ${selected.length === 1 ? 'point' : 'points'}. New points use the same settings.`
            : `The selected ${selected.length === 1 ? 'point moves' : 'points move'} the surface at the point only.`
          : 'New points use this radius and falloff.'}
        {coarse
          ? ' This grid is too coarse for that radius here. A finer grid lets it take effect.'
          : ''}
      </p>
      <div className="warp-distribute-row">
        <button
          className="button secondary"
          onClick={() => useEditor.getState().distributeWarpPoints()}
        >
          Distribute points
        </button>
        <select
          aria-label="Points to distribute"
          value={warp.distributeCount}
          onChange={(event) =>
            useEditor.getState().setWarpOptions({ distributeCount: Number(event.target.value) })
          }
        >
          {warpDistributeCounts.map((count) => (
            <option key={count} value={count}>
              {count}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}

/** Ends the session without a notice and leaves the tool. */
function cancel() {
  const state = useEditor.getState();
  state.cancelWarp();
  state.setTool('select');
}

export function WarpControls() {
  const warp = useEditor((s) => s.warp);
  const part = useEditor((s) =>
    s.warp ? s.scene.parts.find((p) => p.id === s.warp!.partId) : undefined,
  );
  if (!warp)
    return (
      <Section title="Warp">
        <p className="anchor-help">
          Bend a scanned surface to close the gap to a neighbouring part. Select one visible,
          unlocked part to start.
        </p>
        <button
          className="button primary full-width"
          onClick={() => useEditor.getState().startWarp()}
        >
          Start warp
        </button>
      </Section>
    );
  if (warp.stage === 'region') {
    const painted = warp.region === 'painted';
    return (
      <div className="warp-controls">
        <Section title="Region">
          <p className="anchor-help">
            Warping <strong>{part?.name}</strong>.{' '}
            {painted
              ? 'Paint the area to bend. Its edge stays where it is.'
              : 'Every surface of the part can bend.'}
          </p>
          <RadioGroup
            label="Warp region"
            className="display-segmented warp-region"
            value={warp.region}
            options={[
              { id: 'painted', label: 'Painted' },
              { id: 'whole', label: 'Whole part' },
            ]}
            onChange={(mode) => useEditor.getState().setWarpRegion(mode)}
          />
          {painted ? (
            <>
              <SurfaceBrushControls />
              <p className="anchor-help" role="status">
                {warp.faces.length
                  ? `${warp.faces.length.toLocaleString()} triangles painted.`
                  : 'Nothing painted yet, so the grid covers the whole part.'}
              </p>
            </>
          ) : null}
          {warpWholePart(warp) && warp.firstLay ? (
            <div className="warp-auto-points">
              <label className="transform-scale-option">
                <input
                  type="checkbox"
                  checked={warp.autoPoints}
                  onChange={(event) =>
                    useEditor.getState().setWarpOptions({ autoPoints: event.target.checked })
                  }
                />
                Place points automatically
              </label>
              <select
                aria-label="Points to place automatically"
                value={warp.distributeCount}
                disabled={!warp.autoPoints}
                onChange={(event) =>
                  useEditor
                    .getState()
                    .setWarpOptions({ distributeCount: Number(event.target.value) })
                }
              >
                {warpDistributeCounts.map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </div>
          ) : null}
        </Section>
        <div className="warp-actions">
          <button className="button secondary" onClick={cancel}>
            Cancel
          </button>
          <button
            className="button primary"
            onClick={() => void useEditor.getState().layWarpGrid()}
          >
            Lay grid
          </button>
        </div>
      </div>
    );
  }
  const building = warp.stage === 'building';
  const { seam } = warp;
  const folds = warp.folds.length;
  const selected = warp.selectedPoints.length;
  return (
    <div className="warp-controls">
      <Section title="Grid">
        <label className="warp-density">
          <span>Density</span>
          <input
            type="range"
            aria-label="Grid density"
            min={0}
            max={warpDensityNodes.length - 1}
            step={1}
            value={warp.density}
            onChange={(event) =>
              void useEditor.getState().setWarpDensity(Number(event.target.value))
            }
          />
        </label>
        <div className="warp-density-scale" aria-hidden="true">
          <span>Coarse</span>
          <span>Fine</span>
        </div>
        <p className="anchor-help">Coarser grids bend broadly. Finer grids bend locally.</p>
        {building ? (
          <p className="warp-building" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
            Laying the grid…
          </p>
        ) : null}
        <button
          className="button secondary full-width"
          onClick={() => useEditor.getState().setWarpRegion(warp.region)}
        >
          Edit region
        </button>
      </Section>
      {building ? null : (
        <Section title="Control points">
          <p className="anchor-help">
            {warp.points.length
              ? `${warp.points.length} ${warp.points.length === 1 ? 'point' : 'points'}, ${selected} selected. Shift+click a point to add it to the selection. Delete removes the selected points.`
              : 'Click the surface to add a control point. A point holds the surface where it is until you move it.'}
          </p>
          <PointSettingsControls warp={warp} part={part} />
          <TransformAdjustments />
        </Section>
      )}
      <Section title="Neighbour">
        <label className="transform-scale-option">
          <input
            type="checkbox"
            checked={warp.snap}
            onChange={(event) =>
              useEditor.getState().setWarpOptions({ snap: event.target.checked })
            }
          />
          Snap to neighbour
        </label>
        <div className="warp-gap-row">
          <button
            className="button secondary"
            disabled={building}
            onClick={() => useEditor.getState().closeWarpGap()}
          >
            Close gap
          </button>
          <label>
            <span>Overlap</span>
            <NumericInput
              label="Overlap"
              value={warp.overlap}
              min={clipLimits.min}
              max={clipLimits.max}
              step={clipLimits.step}
              onCommit={(overlap) => useEditor.getState().setWarpOptions({ overlap })}
            />
            <small>mm</small>
          </label>
        </div>
        {seam ? (
          <div className="warp-readout" role="status">
            <span>Gap to neighbour</span>
            <strong className={seam.largestGap <= 0 ? 'closed' : ''}>
              {seam.largestGap <= 0 ? 'Closed' : `${seam.largestGap.toFixed(2)} mm`}
            </strong>
          </div>
        ) : null}
      </Section>
      {folds ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {folds} folded {folds === 1 ? 'triangle' : 'triangles'}. Apply is still allowed.
        </p>
      ) : null}
      <div className="warp-actions">
        <button className="button secondary" onClick={cancel}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={building || !warpChanges(warp)}
          title={warpChanges(warp) ? undefined : 'Move a control point or close the gap first.'}
          onClick={() => useEditor.getState().applyWarp()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
