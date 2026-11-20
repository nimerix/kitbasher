import { useEffect, useRef, useState, type ReactNode } from 'react';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { isTaskActive, useActivity } from '../core/activity';
import { fittedSizeRange, partSize } from '../core/geometry';
import type { EdgeEnd, EdgeSolve } from '../core/refine-edge';
import type { RegionSolve, RegionShape, Treatment } from '../core/refine-region';
import {
  refineBrushRadius,
  refineEdited,
  refineSolved,
  useEditor,
  type RefineFeature,
  type RefineSession,
} from '../core/store';
import {
  autoStart,
  endLabels,
  endOption,
  featureCounts,
  fittedLabel,
  foldWarning,
  skippedWarning,
} from './refine-panel';
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { LogRangeInput, NumericInput, RadioGroup, Section, Switch } from './ui';

const editor = () => useEditor.getState();

const isSlider = (target: EventTarget | null) =>
  target instanceof HTMLInputElement && target.type === 'range';

/**
 * A slider with a number field. A percent setting holds 0 to 1 and shows 0 to 100; a setting with
 * `range` is in mm on a logarithmic slider. Unless `live`, a drag shows its value and sets it once,
 * when let go or changed by key, since each set may solve again.
 */
function SliderSetting({
  label,
  value,
  range,
  live = false,
  onSet,
}: {
  label: string;
  value: number;
  range?: { min: number; max: number };
  live?: boolean;
  onSet: (value: number) => void;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const pending = useRef<number | null>(null);
  const set = useRef(onSet);
  set.current = onSet;
  const row = useRef<HTMLLabelElement>(null);
  useEffect(() => {
    const element = row.current!;
    // A range input fires a native change when it is let go, by pointer or by key.
    const commit = (event: Event) => {
      if (!isSlider(event.target)) return;
      const next = pending.current;
      pending.current = null;
      setDraft(null);
      if (next !== null) set.current(next);
    };
    element.addEventListener('change', commit);
    element.addEventListener('focusout', commit);
    return () => {
      element.removeEventListener('change', commit);
      element.removeEventListener('focusout', commit);
    };
  }, []);
  const change = (next: number) => {
    if (live) return onSet(next);
    pending.current = next;
    setDraft(next);
  };
  const shown = draft ?? value;
  return (
    <label className="warp-point-setting" ref={row}>
      <span>{label}</span>
      {range ? (
        <LogRangeInput
          label={`${label} slider`}
          value={shown}
          min={range.min}
          max={range.max}
          onChange={change}
        />
      ) : (
        <input
          type="range"
          aria-label={`${label} slider`}
          min={0}
          max={100}
          step={1}
          value={Math.round(shown * 100)}
          onChange={(event) => change(Number(event.target.value) / 100)}
        />
      )}
      <NumericInput
        label={label}
        value={range ? shown : Math.round(shown * 100)}
        min={range ? range.min : 0}
        max={range ? range.max : 100}
        step={range ? 0.01 : 1}
        onCommit={(next) => onSet(range ? next : next / 100)}
      />
      <small>{range ? 'mm' : '%'}</small>
    </label>
  );
}

/** A switch that hands a setting to the solver (null), and the setting itself once it is off. */
function AutoSetting({
  label,
  value,
  start,
  onSet,
  children,
}: {
  label: string;
  value: number | null;
  /** Where the setting starts when Auto is turned off. */
  start: () => number;
  onSet: (value: number | null) => void;
  children: (value: number) => ReactNode;
}) {
  return (
    <>
      <div className="appearance-row">
        <span>Automatic {label.toLowerCase()}</span>
        <Switch
          label={`Choose ${label.toLowerCase()} automatically`}
          checked={value === null}
          onChange={(auto) => onSet(auto ? null : Number(start().toPrecision(3)))}
        />
      </div>
      {value === null ? null : children(value)}
    </>
  );
}

/** A number field in mm on one row. */
function MillimetreField({
  label,
  value,
  onSet,
}: {
  label: string;
  value: number;
  onSet: (value: number) => void;
}) {
  return (
    <label className="brush-radius">
      <span>{label}</span>
      <NumericInput label={label} value={value} min={0} max={100} step={0.01} onCommit={onSet} />
      <small>mm</small>
    </label>
  );
}

/** A labelled choice of a few options. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { id: T; label: string }[];
  onChange: (value: T) => void;
}) {
  return (
    <div className="refine-choice">
      <span>{label}</span>
      <RadioGroup
        label={label}
        className={`display-segmented ${options.length === 2 ? 'refine-pair' : ''}`}
        value={value}
        options={options}
        onChange={onChange}
      />
    </div>
  );
}

/** The one selected pending feature of a type, whose settings the panel shows. */
function selectedOf<T extends 'edge' | 'region'>(refine: RefineSession, type: T) {
  if (refine.selected.length !== 1) return null;
  const feature = refine.features.find((f) => f.id === refine.selected[0]);
  return feature?.state === 'pending' && feature.feature.type === type
    ? (feature as RefineFeature & { feature: { type: T } })
    : null;
}

/** Dismiss and Accept for the selected pending features. */
function FeatureActions({ refine }: { refine: RefineSession }) {
  const pending = refine.features.some(
    (f) => f.state === 'pending' && refine.selected.includes(f.id),
  );
  return (
    <div className="warp-gap-row">
      <button
        className="button secondary"
        disabled={!pending}
        onClick={() => editor().dismissRefine()}
      >
        Dismiss
      </button>
      <button
        className="button primary"
        disabled={!pending}
        onClick={() => editor().acceptRefine()}
      >
        Accept
      </button>
    </div>
  );
}

const endChoices = ['auto', 'taper', 'hold'] as const;

function EdgeControls({ refine }: { refine: RefineSession }) {
  const selected = selectedOf(refine, 'edge');
  const input = selected?.feature.input;
  const width = input ? input.width : refine.edge.width;
  const strength = input ? input.strength : refine.edge.strength;
  const ends = input ? (input.ends ?? [null, null]) : refine.edge.ends;
  const solve = selected ? (refineSolved(refine, selected) as EdgeSolve | null) : null;
  const setEnd = (index: 0 | 1, choice: (typeof endChoices)[number]) => {
    const next: [EdgeEnd | null, EdgeEnd | null] = [ends[0], ends[1]];
    next[index] = choice === 'auto' ? null : choice;
    editor().setRefineEdge({ ends: next });
  };
  return (
    <>
      <Choice
        label="Guide"
        value={refine.edge.kind}
        options={[
          { id: 'line', label: 'Line' },
          { id: 'arc', label: 'Arc' },
          { id: 'spline', label: 'Spline' },
        ]}
        onChange={(kind) => editor().setRefineEdge({ kind })}
      />
      <AutoSetting
        label="Width"
        value={width}
        start={() => autoStart('width', refine.model!, solve?.width)}
        onSet={(width) => editor().setRefineEdge({ width })}
      >
        {(width) => (
          <SliderSetting
            label="Width"
            value={width}
            range={{ min: 0.1, max: 5 }}
            onSet={(width) => editor().setRefineEdge({ width })}
          />
        )}
      </AutoSetting>
      <SliderSetting
        label="Strength"
        value={strength}
        live
        onSet={(strength) => editor().setRefineEdge({ strength })}
      />
      <p className="anchor-help">
        How loosely the edge follows the guide's line, arc or spline, from no change to fully on it.
      </p>
      <Choice
        label="Joints"
        value={refine.edge.joint}
        options={[
          { id: 'sharp', label: 'Sharp' },
          { id: 'smooth', label: 'Smooth' },
        ]}
        onChange={(joint) => editor().setRefineEdge({ joint })}
      />
      {input?.closed ? null : (
        <div className="refine-choice">
          <span>Ends</span>
          <div className="refine-ends">
            {(['Start', 'End'] as const).map((label, index) => (
              <label key={label}>
                <span>{label}</span>
                <select
                  aria-label={`${label} of the guide`}
                  value={ends[index] ?? 'auto'}
                  onChange={(event) =>
                    setEnd(index as 0 | 1, event.target.value as (typeof endChoices)[number])
                  }
                >
                  {endChoices.map((choice) => (
                    <option key={choice} value={choice}>
                      {choice === 'auto' ? endOption(solve?.ends[index]) : endLabels[choice]}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
        </div>
      )}
      <FeatureActions refine={refine} />
    </>
  );
}

const shapes: { id: RegionShape; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'cone', label: 'Cone' },
  { id: 'sphere', label: 'Sphere' },
  { id: 'sweep', label: 'Sweep' },
];

/** Paint brush controls and how much is painted. */
function PaintControls({ refine }: { refine: RefineSession }) {
  const part = useEditor((s) => s.scene.parts.find((p) => p.id === refine.partId));
  const fitted = part
    ? {
        radius: refineBrushRadius,
        range: fittedSizeRange(partSize(part)),
        set: editor().setRefineBrushRadius,
      }
    : undefined;
  return (
    <>
      <SurfaceBrushControls fitted={fitted} />
      <p className="anchor-help" role="status">
        {refine.triangles.length
          ? `${refine.triangles.length.toLocaleString()} ${refine.triangles.length === 1 ? 'triangle' : 'triangles'} painted.`
          : 'Nothing painted yet.'}
      </p>
    </>
  );
}

function RegionControls({ refine }: { refine: RefineSession }) {
  const selected = selectedOf(refine, 'region');
  const region = selected ? selected.feature.input : refine.region;
  const solve = selected ? (refineSolved(refine, selected) as RegionSolve | null) : null;
  const model = refine.model!;
  const set = editor().setRefineRegion;
  const fitted = region.shape === 'auto' ? fittedLabel(solve?.fitted ?? null) : null;
  return (
    <>
      <PaintControls refine={refine} />
      <button
        className="button secondary full-width refine-spaced"
        disabled={!refine.triangles.length}
        onClick={() => editor().makeRefineRegion()}
      >
        Make region
      </button>
      <Choice<Treatment>
        label="Treatment"
        value={region.treatment}
        options={[
          { id: 'smooth', label: 'Smooth' },
          { id: 'flatten', label: 'Flatten' },
          { id: 'shape', label: 'Shape' },
        ]}
        onChange={(treatment) => set({ treatment })}
      />
      {region.treatment === 'shape' ? (
        <>
          <label className="brush-radius">
            <span>Shape</span>
            <select
              aria-label="Shape"
              value={region.shape}
              onChange={(event) => set({ shape: event.target.value as RegionShape })}
            >
              {shapes.map(({ id, label }) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          </label>
          {fitted ? (
            <p className="anchor-help" role="status">
              {fitted}
            </p>
          ) : null}
        </>
      ) : null}
      <SliderSetting
        label="Strength"
        value={region.strength}
        onSet={(strength) => set({ strength })}
      />
      <div className="appearance-row">
        <span>Keep detail</span>
        <Switch
          label="Keep detail"
          checked={region.keepDetail}
          onChange={(keepDetail) => set({ keepDetail })}
        />
      </div>
      {region.keepDetail ? (
        <AutoSetting
          label="Offset"
          value={region.detail}
          start={() => autoStart('detail', model)}
          onSet={(detail) => set({ detail })}
        >
          {(detail) => (
            <MillimetreField label="Offset" value={detail} onSet={(detail) => set({ detail })} />
          )}
        </AutoSetting>
      ) : null}
      {region.keepDetail ? (
        <p className="anchor-help">
          How far a feature must deviate from the surface, raised or recessed, to be preserved.
        </p>
      ) : null}
      <AutoSetting
        label="Blend"
        value={region.blend}
        start={() => autoStart('blend', model)}
        onSet={(blend) => set({ blend })}
      >
        {(blend) => (
          <MillimetreField label="Blend" value={blend} onSet={(blend) => set({ blend })} />
        )}
      </AutoSetting>
      {region.treatment === 'smooth' ? (
        <>
          <AutoSetting
            label="Reach"
            value={region.scale ?? null}
            start={() => Math.min(5, autoStart('scale', model))}
            onSet={(scale) => set({ scale })}
          >
            {(scale) => (
              <SliderSetting
                label="Reach"
                value={scale}
                range={{ min: 0.3, max: 5 }}
                onSet={(scale) => set({ scale })}
              />
            )}
          </AutoSetting>
          <p className="anchor-help">The longest ripple Smooth removes.</p>
        </>
      ) : null}
      <FeatureActions refine={refine} />
    </>
  );
}

function BrushControls({ refine }: { refine: RefineSession }) {
  const part = useEditor((s) => s.scene.parts.find((p) => p.id === refine.partId));
  const radius = useEditor(refineBrushRadius);
  const range = fittedSizeRange(part ? partSize(part) : 0);
  const setRadius = (value: number) => editor().setRefineBrushRadius(value);
  return (
    <>
      <Choice
        label="Brush"
        value={refine.brush.kind}
        options={[
          { id: 'crease', label: 'Crease' },
          { id: 'flatten', label: 'Flatten' },
          { id: 'smooth', label: 'Smooth' },
        ]}
        onChange={(kind) => editor().setRefineBrush({ kind })}
      />
      <label className="brush-radius">
        <span>Brush radius</span>
        <NumericInput
          label="Brush radius"
          value={radius}
          min={0.05}
          max={100}
          step={0.1}
          onCommit={setRadius}
        />
        <small>mm</small>
      </label>
      <LogRangeInput
        className="brush-radius-slider"
        label="Brush radius slider"
        value={radius}
        min={range.min}
        max={range.max}
        onChange={setRadius}
      />
      <SliderSetting
        label="Strength"
        value={refine.brush.strength}
        live
        onSet={(strength) => editor().setRefineBrush({ strength })}
      />
    </>
  );
}

const detectTitle = 'Finding edges and surfaces';

function DetectControls({ refine }: { refine: RefineSession }) {
  const { detect } = refine;
  const task = useActivity((s) =>
    s.tasks.find((task) => task.title === detectTitle && isTaskActive(task)),
  );
  const pending = refine.features.filter((f) => f.state === 'pending');
  return (
    <>
      <Choice
        label="Look in"
        value={detect.where}
        options={[
          { id: 'part', label: 'Whole part' },
          { id: 'painted', label: 'Painted area' },
        ]}
        onChange={(where) => editor().setRefineDetect({ where })}
      />
      {detect.where === 'painted' ? <PaintControls refine={refine} /> : null}
      <SliderSetting
        label="Sensitivity"
        value={detect.sensitivity}
        live
        onSet={(sensitivity) => editor().setRefineDetect({ sensitivity })}
      />
      <label className="brush-radius">
        <span>Minimum length</span>
        <NumericInput
          label="Minimum length"
          value={detect.minLength}
          min={0}
          max={100}
          step={0.1}
          onCommit={(minLength) => editor().setRefineDetect({ minLength })}
        />
        <small>mm</small>
      </label>
      {detect.running ? (
        <>
          <div className="job-inline-progress" role="status">
            <p>
              {detectTitle}
              {task?.progress != null ? ` · ${Math.round(task.progress * 100)}%` : ''}
            </p>
            <progress aria-label="Detection progress" max={1} value={task?.progress ?? undefined} />
          </div>
          <button
            className="button secondary full-width refine-spaced"
            onClick={() => editor().cancelRefineDetect()}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          className="button primary full-width refine-spaced"
          disabled={detect.where === 'painted' && !refine.triangles.length}
          onClick={() => void editor().detectRefine()}
        >
          Find edges and surfaces
        </button>
      )}
      {pending.length ? (
        <>
          <button
            className="button secondary full-width refine-spaced"
            onClick={() => editor().selectRefine(pending.map((f) => f.id))}
          >
            Select all proposed
          </button>
          <div className="warp-gap-row">
            <button
              className="button secondary"
              disabled={!refine.selected.length}
              onClick={() => editor().dismissRefine()}
            >
              Dismiss selected
            </button>
            <button
              className="button primary"
              disabled={!refine.selected.length}
              onClick={() => editor().acceptRefine()}
            >
              Accept selected
            </button>
          </div>
        </>
      ) : null}
    </>
  );
}

/** Ends the session without a notice and leaves the tool. */
function cancel() {
  const state = editor();
  state.cancelRefine();
  state.setTool('select');
}

const modeTitles = { edge: 'Edge', region: 'Region', brush: 'Brush', detect: 'Detect' } as const;

export function RefineControls() {
  const refine = useEditor((s) => s.refine);
  const name = useEditor((s) =>
    s.refine ? s.scene.parts.find((p) => p.id === s.refine!.partId)?.name : undefined,
  );
  if (!refine)
    return (
      <Section title="Refine">
        <p className="anchor-help">
          Restore sharp edges and clean surfaces on a scanned part. Select one visible, unlocked
          part to start.
        </p>
        <button className="button primary full-width" onClick={() => editor().startRefine()}>
          Start refine
        </button>
      </Section>
    );
  const building = refine.stage === 'building';
  const folds = refine.folds.length;
  const skipped = refine.skipped.length;
  return (
    <div className="warp-controls refine-controls">
      <Section title="Mode">
        <p className="anchor-help">
          Refining <strong>{name}</strong>.
        </p>
        {building ? (
          <p className="warp-building" role="status">
            <LoaderCircle size={13} className="spin" aria-hidden="true" />
            Preparing the surface…
          </p>
        ) : (
          <RadioGroup
            label="Refine mode"
            className="display-segmented refine-modes"
            value={refine.mode}
            options={[
              { id: 'edge', label: 'Edge' },
              { id: 'region', label: 'Region' },
              { id: 'brush', label: 'Brush' },
              { id: 'detect', label: 'Detect' },
            ]}
            onChange={(mode) => editor().setRefineMode(mode)}
          />
        )}
      </Section>
      {building ? null : (
        <Section title={modeTitles[refine.mode]}>
          {refine.mode === 'edge' ? (
            <EdgeControls refine={refine} />
          ) : refine.mode === 'region' ? (
            <RegionControls refine={refine} />
          ) : refine.mode === 'brush' ? (
            <BrushControls refine={refine} />
          ) : (
            <DetectControls refine={refine} />
          )}
        </Section>
      )}
      <p className="anchor-help refine-counts" role="status">
        {featureCounts(refine.features)}
      </p>
      {folds ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {foldWarning(folds)}
        </p>
      ) : null}
      {skipped ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {skippedWarning(skipped)}
        </p>
      ) : null}
      <div className="warp-actions">
        <button className="button secondary" onClick={cancel}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={building || !refineEdited(refine)}
          title={refineEdited(refine) ? undefined : 'Accept a feature or make a stroke first.'}
          onClick={() => editor().applyRefine()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
