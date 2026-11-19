import {
  useEffect,
  useMemo,
  useRef,
  type FocusEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { clipLimits } from '../core/clipping';
import { fittedSizeRange, partSize } from '../core/geometry';
import {
  useEditor,
  warpBrushRadius,
  warpChanges,
  warpDistributeCounts,
  warpPinDrift,
  warpPointRadius,
  warpShortfall,
  warpShortfallShown,
  warpWholePart,
  type WarpSession,
} from '../core/store';
import type { Part } from '../core/types';
import { warpDensityNodes } from '../core/warp-grid';
import { fadeWidth, handleGuides } from '../core/warp-handles';
import { featherWarning } from '../core/warp-model';
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { TransformAdjustments } from './TransformAdjustments';
import { LogRangeInput, NumericInput, RadioGroup, Section } from './ui';

type PointSettings = { radius?: number; falloff?: number };
type Slider = 'radius' | 'falloff';

/**
 * A slider gesture on the selected points' settings. It belongs to the slider it began on and,
 * for a drag, to its pointer. Changes reach the points at most once a frame, and the gesture ends
 * exactly once, as one step: on release, the slider's own change, pointer cancel, lost capture
 * or window blur. Blur from any other control ends nothing.
 */
function usePointSettingsGesture() {
  const current = useRef<{
    slider: Slider;
    pointer: number | null;
    patch: PointSettings | null;
    frame: number;
  } | null>(null);
  const gesture = useMemo(() => {
    const release = (event: PointerEvent) => {
      const owner = current.current;
      if (owner && (owner.pointer === null || owner.pointer === event.pointerId)) end();
    };
    const blur = () => end();
    const end = (slider?: Slider) => {
      const owner = current.current;
      if (!owner || (slider && owner.slider !== slider)) return;
      current.current = null;
      cancelAnimationFrame(owner.frame);
      window.removeEventListener('pointerup', release);
      window.removeEventListener('pointercancel', release);
      window.removeEventListener('blur', blur);
      if (owner.patch) useEditor.getState().setWarpPointSettings(owner.patch, 'end');
    };
    const begin = (slider: Slider, pointer: number | null) => {
      end();
      current.current = { slider, pointer, patch: null, frame: 0 };
      window.addEventListener('pointerup', release);
      window.addEventListener('pointercancel', release);
      window.addEventListener('blur', blur);
    };
    const change = (slider: Slider, patch: PointSettings) => {
      if (current.current?.slider !== slider) begin(slider, null);
      const owner = current.current!;
      owner.patch = { ...owner.patch, ...patch };
      if (owner.frame) return;
      owner.frame = requestAnimationFrame(() => {
        owner.frame = 0;
        if (current.current === owner && owner.patch)
          useEditor.getState().setWarpPointSettings(owner.patch, 'drag');
      });
    };
    return { begin, change, end };
  }, []);
  useEffect(() => () => gesture.end(), [gesture]);
  return gesture;
}

const isSlider = (target: EventTarget) =>
  target instanceof HTMLInputElement && target.type === 'range';

/** Radius, falloff and Distribute points, for the selected points or for new ones. */
function PointSettingsControls({ warp, part }: { warp: WarpSession; part: Part | undefined }) {
  const gesture = usePointSettingsGesture();
  const selected = warp.points.filter((point) => warp.selectedPoints.includes(point.id));
  const shown = selected[0];
  const radius = shown ? shown.radius : warpPointRadius(warp, part);
  const falloff = shown ? shown.falloff : warp.pointFalloff;
  const { max } = fittedSizeRange(part ? partSize(part) : 40);
  const coarse = selected.some((point) => point.radius > 0 && !handleGuides(point));
  const fade = shown && handleGuides(shown) ? fadeWidth(shown) : null;
  const shortfall = warpShortfall(warp);
  const drift = warpPinDrift(warp);
  const commit = (patch: PointSettings) => useEditor.getState().setWarpPointSettings(patch, 'end');
  const owned = (slider: Slider) => ({
    'data-slider': slider,
    onPointerDown: (event: ReactPointerEvent) => {
      if (isSlider(event.target)) gesture.begin(slider, event.pointerId);
    },
    onBlur: (event: FocusEvent) => {
      if (isSlider(event.target)) gesture.end(slider);
    },
    onLostPointerCapture: (event: ReactPointerEvent) => {
      if (isSlider(event.target)) gesture.end(slider);
    },
  });
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = container.current!;
    // A range input fires a native change when it is let go, by pointer or by key.
    const changed = (event: Event) => {
      const slider = (event.target as Element)
        .closest('[data-slider]')
        ?.getAttribute('data-slider');
      if (slider && isSlider(event.target!)) gesture.end(slider as Slider);
    };
    element.addEventListener('change', changed);
    return () => element.removeEventListener('change', changed);
  }, [gesture]);
  return (
    <div className="warp-point-settings" ref={container}>
      <label className="warp-point-setting" {...owned('radius')}>
        <span>Radius</span>
        <LogRangeInput
          label="Point radius slider"
          value={radius}
          min={0.1}
          max={max}
          zero
          onChange={(value) => gesture.change('radius', { radius: value })}
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
      <label className="warp-point-setting" {...owned('falloff')}>
        <span>Falloff</span>
        <input
          type="range"
          aria-label="Point falloff slider"
          min={0}
          max={100}
          step={1}
          value={Math.round(falloff * 100)}
          onChange={(event) =>
            gesture.change('falloff', { falloff: Number(event.target.value) / 100 })
          }
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
            ? `Moves the surface within ${Number(radius.toPrecision(3))} mm of the selected ${selected.length === 1 ? 'point' : 'points'}${fade !== null ? `, fading over the outer ${Number(fade.toPrecision(2))} mm` : ''}. New points use the same settings.`
            : `The selected ${selected.length === 1 ? 'point moves' : 'points move'} the surface at the point only.`
          : warp.pointRadius === null
            ? 'New points use this falloff, and reach a few grid spacings where you click until you set a radius.'
            : 'New points use this radius and falloff.'}
        {coarse
          ? ' This grid is too coarse for that radius here. A finer grid lets it take effect.'
          : ''}
      </p>
      {shortfall > warpShortfallShown ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          The surface stops {shortfall.toFixed(2)} mm short of the{' '}
          {selected.length === 1 ? "point's target" : "selected points' targets"}. A point on the
          same spot or the fixed edge holds it back.
        </p>
      ) : null}
      {drift > warpShortfallShown ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          The surface has moved {drift.toFixed(2)} mm from where the{' '}
          {selected.length === 1 ? 'selected point holds' : 'selected points hold'} it. A moved
          point beside it pulls it away.
        </p>
      ) : null}
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

/** Feathered edge for a painted region: a switch, and a width once it is on. */
function FeatherEdge({ part }: { part: Part | undefined }) {
  const feather = useEditor((s) => s.warpFeather);
  const brushRadius = useEditor(warpBrushRadius);
  const width = feather.width ?? brushRadius;
  const range = fittedSizeRange(part ? partSize(part) : 0);
  const setWidth = (value: number) => useEditor.getState().setWarpFeather({ width: value });
  return (
    <>
      <div className="appearance-row">
        <span>Feather edge</span>
        <button
          role="switch"
          aria-label="Feather the painted edge"
          aria-checked={feather.enabled}
          className={`toggle ${feather.enabled ? 'on' : ''}`}
          onClick={() => useEditor.getState().setWarpFeather({ enabled: !feather.enabled })}
        >
          <span />
        </button>
      </div>
      {feather.enabled ? (
        <>
          <label className="brush-radius">
            <span>Feather width</span>
            <NumericInput
              label="Feather width"
              value={width}
              min={0}
              max={100}
              step={0.1}
              onCommit={setWidth}
            />
            <small>mm</small>
          </label>
          <LogRangeInput
            className="brush-radius-slider"
            label="Feather width slider"
            value={width}
            min={range.min}
            max={range.max}
            onChange={setWidth}
          />
        </>
      ) : null}
    </>
  );
}

export function WarpControls() {
  const warp = useEditor((s) => s.warp);
  const part = useEditor((s) =>
    s.warp ? s.scene.parts.find((p) => p.id === s.warp!.partId) : undefined,
  );
  const feathered = useEditor((s) => s.warpFeather.enabled);
  const featherNote = featherWarning(warp?.model?.feather);
  const featherWidth = warp?.model?.feather?.width;
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
            {!painted
              ? 'Every surface of the part can bend.'
              : feathered
                ? 'Paint the area to bend. Its edge blends into the surface around it.'
                : 'Paint the area to bend. Its edge stays where it is.'}
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
              <FeatherEdge part={part} />
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
        {featherNote === 'unanchored' ? (
          <p className="warp-warning" role="status">
            <TriangleAlert size={13} aria-hidden="true" />
            The {featherWidth} mm feather would leave part of the area with nothing fixed to hold
            it, so the painted edge stays fixed. Edit the region to narrow the feather or paint
            less.
          </p>
        ) : null}
        {featherNote === 'coarse' ? (
          <p className="warp-warning" role="status">
            <TriangleAlert size={13} aria-hidden="true" />
            The mesh beside the paint is too coarse for a {featherWidth} mm feather, so the painted
            edge stays fixed. Edit the region to widen it.
          </p>
        ) : null}
        {featherNote === 'anchored' ? (
          <p className="warp-warning" role="status">
            <TriangleAlert size={13} aria-hidden="true" />
            The {featherWidth} mm feather reaches all the way around, so the area farthest from the
            paint stays fixed to hold the part in place. Edit the region to narrow the feather or
            paint less.
          </p>
        ) : null}
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
      {warp.settling && !building ? (
        <p className="warp-building warp-settling" role="status">
          <LoaderCircle size={13} className="spin" aria-hidden="true" />
          {warp.applying
            ? 'Applying once the surface settles…'
            : 'The surface is still settling. Apply waits for it.'}
        </p>
      ) : null}
      <div className="warp-actions">
        <button className="button secondary" onClick={cancel}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={building || !!warp.applying || !warpChanges(warp)}
          aria-busy={warp.applying || undefined}
          title={warpChanges(warp) ? undefined : 'Move a control point or close the gap first.'}
          onClick={() => useEditor.getState().applyWarp()}
        >
          {warp.applying ? (
            <>
              <LoaderCircle size={13} className="spin" aria-hidden="true" />
              Applying…
            </>
          ) : (
            'Apply'
          )}
        </button>
      </div>
    </div>
  );
}
