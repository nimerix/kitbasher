import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { clipLimits } from '../core/clipping';
import { fittedSizeRange, partSize } from '../core/geometry';
import { useEditor, warpBrushRadius, warpChanges } from '../core/store';
import { warpDensityNodes } from '../core/warp-grid';
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { TransformAdjustments } from './TransformAdjustments';
import { NumericInput, RadioGroup, Section } from './ui';

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
    const brush = part
      ? {
          radius: warpBrushRadius,
          range: fittedSizeRange(partSize(part)),
          set: useEditor.getState().setWarpBrushRadius,
        }
      : undefined;
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
              <SurfaceBrushControls fitted={brush} />
              <p className="anchor-help" role="status">
                {warp.faces.length
                  ? `${warp.faces.length.toLocaleString()} triangles painted.`
                  : 'Nothing painted yet, so the grid covers the whole part.'}
              </p>
            </>
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
