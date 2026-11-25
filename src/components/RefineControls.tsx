import { useId, useMemo, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { isTaskActive, useActivity } from '../core/activity';
import type { EdgeInput, EdgePosition, EdgeSolve } from '../core/refine-edge';
import type { RegionInput, RegionSolve, RegionShape, Treatment } from '../core/refine-region';
import {
  cleanTitle,
  refineDraftLimit,
  refineFailure,
  refinePickingPrompt,
  refineEdited,
  refinePointRemovable,
  refineSolved,
  useEditor,
  type RefineFeature,
  type RefineSession,
} from '../core/store';
import {
  autoRule,
  cleanDepthMax,
  cleanSizeRange,
  draftSkippedHint,
  endLabels,
  endOption,
  extendsGuide,
  featureCounts,
  fittedLabel,
  foldWarning,
  manualStart,
  manualStarts,
  piecesWarning,
  refineTargets,
  shared,
  skippedWarning,
  targetKey,
  withEnd,
} from './refine-panel';
import { BrushSettings } from './BrushSettings';
import { useSliderEdit } from '../hooks/useSliderEdit';
import { LogRangeInput, NumericInput, RadioGroup, Section } from './ui';

const editor = () => useEditor.getState();

/** What the panel shows of the session: everything but the painted triangles. */
const panelView = (refine: RefineSession | null) =>
  refine && {
    failure: refineFailure(refine),
    partId: refine.partId,
    stage: refine.stage,
    model: refine.model,
    // A new draft means new solves to show, such as a fitted shape or an Auto end.
    draft: refine.draft,
    mode: refine.mode,
    features: refine.features,
    selected: refine.selected,
    chosenPoint: refine.chosenPoint,
    planes: refine.planes,
    picking: refine.picking,
    edge: refine.edge,
    region: refine.region,
    brush: refine.brush,
    detect: refine.detect,
    clean: refine.clean,
    folds: refine.folds.length,
    skipped: refine.skipped.length,
    edited: refineEdited(refine),
  };
type PanelView = NonNullable<ReturnType<typeof panelView>>;

/** The key of what the panel's settings write to now. */
function currentTarget() {
  const { refine } = editor();
  return refine ? targetKey(refine.mode, refineTargets(refine)) : '';
}

/** Whether a setting rendered for `target` may still write: the panel still edits that target. */
const ownedBy = (target: string) => () => currentTarget() === target;

/**
 * A slider with a number field. A percent setting holds 0 to `most` (1 unless set) and shows it as
 * a percentage; a setting with `range` is in mm on a logarithmic slider. Unless `live`, a drag sets its value once on release;
 * a live one gives `begin` to put the value back on Escape.
 */
function SliderSetting({
  label,
  value,
  mixed = false,
  range,
  most = 1,
  live = false,
  begin,
  owned,
  onSet,
}: {
  label: string;
  value: number;
  mixed?: boolean;
  range?: { min: number; max: number };
  most?: number;
  live?: boolean;
  begin?: () => () => void;
  owned: () => boolean;
  onSet: (value: number) => void;
}) {
  const slider = useSliderEdit({
    owned,
    onSet,
    live,
    begin,
    mixed,
    least: range ? range.min : 0,
  });
  const shown = slider.draft ?? value;
  const { hidden } = slider;
  return (
    <label
      className="warp-point-setting"
      ref={slider.row}
      onPointerDown={slider.onPointerDown}
      onKeyDown={slider.onKeyDown}
    >
      <span>{label}</span>
      {range ? (
        <LogRangeInput
          label={`${label} slider`}
          value={shown}
          min={range.min}
          max={range.max}
          mixed={hidden}
          onChange={slider.change}
        />
      ) : (
        <input
          type="range"
          className={hidden ? 'mixed' : undefined}
          aria-label={`${label} slider`}
          aria-valuetext={hidden ? 'Mixed' : undefined}
          min={0}
          max={Math.round(most * 100)}
          step={1}
          value={hidden ? 0 : Math.round(shown * 100)}
          onChange={(event) => slider.change(Number(event.target.value) / 100)}
        />
      )}
      <NumericInput
        label={label}
        value={range ? shown : Math.round(shown * 100)}
        mixed={hidden}
        min={range ? range.min : 0}
        max={range ? range.max : Math.round(most * 100)}
        step={range ? 0.01 : 1}
        onCommit={(next) => owned() && onSet(range ? next : next / 100)}
      />
      <small>{range ? 'mm' : '%'}</small>
    </label>
  );
}

const fieldRange = { min: 0, max: 100 };

/** A switch on its own row, marked Mixed when the targets disagree; a click sets them all. */
function SwitchRow({
  title,
  label,
  checked,
  mixed,
  onChange,
}: {
  title: string;
  label: string;
  checked: boolean;
  mixed: boolean;
  onChange: (checked: boolean) => void;
}) {
  const mixedId = useId();
  // The ui Switch's markup. A switch has no mixed state, so a mixed one is a tri-state checkbox
  // (aria-checked="mixed") with the same look, also described by the visible Mixed.
  const on = checked && !mixed;
  return (
    <div className="appearance-row">
      <span>{title}</span>
      <span className="refine-switch">
        {mixed ? <small id={mixedId}>Mixed</small> : null}
        <button
          type="button"
          role={mixed ? 'checkbox' : 'switch'}
          aria-label={label}
          aria-checked={mixed ? 'mixed' : on}
          aria-describedby={mixed ? mixedId : undefined}
          className={`toggle ${on ? 'on' : ''}`}
          onClick={() => onChange(!on)}
        >
          <span />
        </button>
      </span>
    </div>
  );
}

/**
 * A switch that hands a setting to the solver (null), and the setting itself once it is off. It
 * is on when every target is automatic. Turning it off runs `seed`, which writes each target's
 * start and says whether any was held to the control's range; the hint stays until a manual edit.
 */
function AutoSetting({
  label,
  values,
  seed,
  onSet,
  children,
}: {
  label: string;
  values: readonly (number | null)[];
  seed: () => boolean;
  onSet: (value: number | null) => void;
  children: (value: number, mixed: boolean, set: (value: number) => void) => ReactNode;
}) {
  const [adjusted, setAdjusted] = useState(false);
  const auto = values.every((v) => v === null);
  const value = values.find((v) => v !== null) ?? 0;
  const mixed = values.some((v) => v !== values[0]);
  const set = (value: number) => {
    setAdjusted(false);
    onSet(value);
  };
  return (
    <>
      <SwitchRow
        title={`Automatic ${label.toLowerCase()}`}
        label={`Choose ${label.toLowerCase()} automatically`}
        checked={auto}
        mixed={!auto && values.includes(null)}
        onChange={(on) => {
          setAdjusted(false);
          if (on) onSet(null);
          else setAdjusted(seed());
        }}
      />
      {auto ? null : children(value, mixed, set)}
      {!auto && adjusted ? (
        <p className="anchor-help" role="status">
          Adjusted to the nearest allowed value.
        </p>
      ) : null}
    </>
  );
}

/** A number field in mm on one row. */
function MillimetreField({
  label,
  value,
  mixed,
  owned,
  onSet,
}: {
  label: string;
  value: number;
  mixed: boolean;
  owned: () => boolean;
  onSet: (value: number) => void;
}) {
  return (
    <label className="brush-radius">
      <span>{label}</span>
      <NumericInput
        label={label}
        value={value}
        mixed={mixed}
        min={fieldRange.min}
        max={fieldRange.max}
        step={0.01}
        onCommit={(next) => owned() && onSet(next)}
      />
      <small>mm</small>
    </label>
  );
}

/** A number field in degrees on one row. */
function DegreeField({
  label,
  value,
  mixed,
  owned,
  onSet,
}: {
  label: string;
  value: number;
  mixed: boolean;
  owned: () => boolean;
  onSet: (value: number) => void;
}) {
  return (
    <label className="brush-radius">
      <span>{label}</span>
      <NumericInput
        label={label}
        value={value}
        mixed={mixed}
        min={angleRange.min}
        max={angleRange.max}
        step={1}
        onCommit={(next) => owned() && onSet(next)}
      />
      <small>°</small>
    </label>
  );
}

/** A labelled choice of a few options; none is chosen when the targets differ. */
function Choice<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
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

/** Says that the preview is off while more features are selected than it shows. */
function PreviewOffHint() {
  const skipped = useEditor((s) => !!s.refine?.draftSkipped);
  return skipped ? (
    <p className="anchor-help" role="status">
      {draftSkippedHint(refineDraftLimit)}
    </p>
  ) : null;
}

/** Dismiss and Accept for the mode's selected pending features. */
function FeatureActions({ targets }: { targets: RefineFeature[] }) {
  const ids = targets.map((f) => f.id);
  const waiting = useEditor((s) => !!(s.refine?.draftStatus || s.refine?.draggingHandle));
  return (
    <div className="warp-gap-row">
      <button
        className="button secondary"
        disabled={!ids.length}
        onClick={() => editor().dismissRefine(ids)}
      >
        Dismiss
      </button>
      <button
        className="button primary"
        disabled={!ids.length || waiting}
        onClick={() => editor().acceptRefine()}
      >
        Accept
      </button>
    </div>
  );
}

/** A setting of the targets, or of the next feature when there are none. */
function settingOf<I, T>(inputs: readonly I[], pick: (input: I) => T, fallback: T) {
  return inputs.length ? shared(inputs.map(pick), fallback) : { value: fallback, mixed: false };
}

const endChoices = ['auto', 'taper', 'hold'] as const;

interface ModeProps {
  view: PanelView;
  targets: RefineFeature[];
  owned: () => boolean;
}

function EdgeControls({ view, targets, owned }: ModeProps) {
  const inputs = targets.map((f) => f.feature.input as EdgeInput);
  const widths = inputs.length ? inputs.map((i) => i.width) : [view.edge.width];
  const strength = settingOf(inputs, (i) => i.strength, view.edge.strength);
  const ends = ([0, 1] as const).map((k) =>
    settingOf(inputs, (i) => i.ends?.[k] ?? null, view.edge.ends[k]),
  );
  const closed = inputs.length > 0 && inputs.every((i) => i.closed);
  const position = settingOf(inputs, (i) => i.position ?? 'along', view.edge.position);
  const fits = inputs.length ? inputs.map((i) => i.fit ?? null) : [view.edge.fit];
  const path = settingOf(inputs, (i) => !!i.path, view.edge.path);
  const walls = inputs.length ? inputs.map((i) => i.wallAngle ?? null) : [view.edge.wallAngle];
  const planed = inputs.filter((i) => i.plane);
  const usePlane = settingOf(planed, (i) => i.usePlane !== false, view.edge.usePlane);
  const solveOf = (f: RefineFeature) => refineSolved(editor().refine!, f) as EdgeSolve | null;
  const solve = targets.length === 1 ? solveOf(targets[0]) : null;
  // Each target keeps its own other end.
  const setEnd = (index: 0 | 1, choice: (typeof endChoices)[number]) => {
    const end = choice === 'auto' ? null : choice;
    if (!targets.length)
      return editor().setRefineEdge({ ends: withEnd(view.edge.ends, index, end) });
    const each = Object.fromEntries(
      targets.map((f, i) => [f.id, { ends: withEnd(inputs[i].ends, index, end) }]),
    );
    editor().setRefineEdge({}, each);
  };
  const seedWidths = () => {
    const rule = autoRule('width', view.model!);
    if (!targets.length) {
      const start = manualStart(rule, widthRange);
      editor().setRefineEdge({ width: start.value });
      return start.adjusted;
    }
    const { each, adjusted } = manualStarts(
      targets.map((f) => ({ id: f.id, start: solveOf(f)?.width ?? rule })),
      widthRange,
    );
    editor().setRefineEdge(
      {},
      Object.fromEntries(Object.entries(each).map(([id, width]) => [id, { width }])),
    );
    return adjusted;
  };
  // A live Strength edit puts back each target's own value on Escape.
  const beginStrength = () => {
    if (!targets.length) {
      // Straight back into the default: the setter would write to whatever is selected by then.
      const saved = view.edge.strength;
      return () => editor().restoreRefineDefaults({ edge: { strength: saved } });
    }
    // Each target as it was, edited mark included, so a cancelled edit leaves no trace.
    const ids = new Set(targets.map((f) => f.id));
    const saved = editor()
      .refine!.features.filter((f) => ids.has(f.id))
      .map(({ id, feature, edited }) => ({ id, feature, edited }));
    return () => editor().restoreRefineFeatures(saved);
  };
  const planeIds = inputs.length
    ? shared(
        inputs.map((i) => i.plane?.id ?? 'none'),
        'none',
      )
    : { value: view.edge.plane ?? 'none', mixed: false };
  const choosePlane = (choice: string) => {
    if (choice === 'points' || choice === 'face')
      return editor().startRefinePicking({
        kind: 'plane',
        from: choice,
        points: [],
        lock: targets.length === 1 ? targets[0].id : null,
      });
    editor().setRefinePlane(choice === 'none' ? null : choice);
  };
  return (
    <>
      <Picking view={view} />
      <div className="refine-choice">
        <span>Plane</span>
        <select
          aria-label="Plane"
          value={planeIds.mixed ? 'mixed' : planeIds.value}
          onChange={(event) => choosePlane(event.target.value)}
        >
          {planeIds.mixed ? (
            <option value="mixed" disabled>
              Mixed
            </option>
          ) : null}
          <option value="none">None</option>
          {view.planes.map((plane) => (
            <option key={plane.id} value={plane.id}>
              {plane.name}
            </option>
          ))}
          <option value="points">New plane from 3 points</option>
          <option value="face">New plane from a face</option>
        </select>
      </div>
      <Choice
        label="Guide"
        value={view.edge.kind}
        options={[
          { id: 'line', label: 'Line' },
          { id: 'arc', label: 'Arc' },
          { id: 'spline', label: 'Spline' },
        ]}
        onChange={(kind) => editor().setRefineEdge({ kind })}
      />
      <AutoSetting
        label="Width"
        values={widths}
        seed={seedWidths}
        onSet={(width) => editor().setRefineEdge({ width })}
      >
        {(width, mixed, set) => (
          <SliderSetting
            label="Width"
            value={width}
            mixed={mixed}
            range={widthRange}
            owned={owned}
            onSet={set}
          />
        )}
      </AutoSetting>
      <SliderSetting
        label="Strength"
        value={strength.value}
        mixed={strength.mixed}
        live
        begin={beginStrength}
        owned={owned}
        onSet={(strength) => editor().setRefineEdge({ strength })}
      />
      <p className="anchor-help">
        How loosely the edge follows the guide's line, arc or spline, from no change to fully on it.
      </p>
      <Choice
        label="Position"
        value={position.mixed ? null : position.value}
        options={positionChoices}
        onChange={(position) => editor().setRefineEdge({ position })}
      />
      <p className="anchor-help">Where the guide lies on the rounded edge of the scan.</p>
      <AutoSetting
        label="Fit"
        values={fits}
        seed={() => {
          editor().setRefineEdge({ fit: 0 });
          return false;
        }}
        onSet={(fit) => editor().setRefineEdge({ fit })}
      >
        {(fit, mixed, set) => (
          <MillimetreField label="Fit" value={fit} mixed={mixed} owned={owned} onSet={set} />
        )}
      </AutoSetting>
      <p className="anchor-help">
        How far the edge may move off the guide to fit the scan. Automatic reaches as far as the
        rounding.
      </p>
      <SwitchRow
        title="Use guide path"
        label="Use guide path"
        checked={path.value}
        mixed={path.mixed}
        onChange={(path) => editor().setRefineEdge({ path })}
      />
      {planed.length ? (
        <SwitchRow
          title="Use guide plane"
          label="Use guide plane"
          checked={usePlane.value}
          mixed={usePlane.mixed}
          onChange={(usePlane) => editor().setRefineEdge({ usePlane })}
        />
      ) : null}
      <AutoSetting
        label="Wall angle"
        values={walls}
        seed={() => {
          editor().setRefineEdge({ wallAngle: 90 });
          return false;
        }}
        onSet={(wallAngle) => editor().setRefineEdge({ wallAngle })}
      >
        {(angle, mixed, set) => (
          <DegreeField label="Wall angle" value={angle} mixed={mixed} owned={owned} onSet={set} />
        )}
      </AutoSetting>
      <Choice
        label="Joints"
        value={view.edge.joint}
        options={[
          { id: 'sharp', label: 'Sharp' },
          { id: 'smooth', label: 'Smooth' },
        ]}
        onChange={(joint) => editor().setRefineEdge({ joint })}
      />
      {extendsGuide(view) ? (
        <p className="anchor-help" role="status">
          Applies to the next segment.
        </p>
      ) : null}
      {closed ? null : (
        <div className="refine-choice">
          <span>Ends</span>
          <div className="refine-ends">
            {(['Start', 'End'] as const).map((label, index) => (
              <label key={label}>
                <span>{label}</span>
                <select
                  aria-label={`${label} of the guide`}
                  value={ends[index].mixed ? 'mixed' : (ends[index].value ?? 'auto')}
                  onChange={(event) =>
                    setEnd(index as 0 | 1, event.target.value as (typeof endChoices)[number])
                  }
                >
                  {ends[index].mixed ? (
                    <option value="mixed" disabled>
                      Mixed
                    </option>
                  ) : null}
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
      <RemovePoint view={view} />
      <FeatureActions targets={targets} />
    </>
  );
}

/** What the session waits for while it waits for picks, with a way out. */
function Picking({ view }: Pick<ModeProps, 'view'>) {
  const picking = view.picking;
  if (!picking) return null;
  return (
    <div className="refine-picking">
      <p className="anchor-help" role="status">
        {refinePickingPrompt(picking)}
      </p>
      <button
        type="button"
        className="button secondary full-width"
        onClick={() => editor().cancelRefinePicking()}
      >
        Cancel
      </button>
    </div>
  );
}

/** Removes the chosen guide point, when the guide stays complete without it. */
function RemovePoint({ view }: Pick<ModeProps, 'view'>) {
  return (
    <button
      type="button"
      className="button secondary full-width"
      disabled={!refinePointRemovable(view)}
      onClick={() => editor().removeChosenRefinePoint()}
    >
      Remove point
    </button>
  );
}

const widthRange = { min: 0.1, max: 5 };
const angleRange = { min: 10, max: 170 };
const positionChoices: { id: EdgePosition; label: string }[] = [
  { id: 'corner', label: 'Corner' },
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'along', label: 'Along' },
];
const reachRange = { min: 0.3, max: 5 };

const shapes: { id: RegionShape; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'cone', label: 'Cone' },
  { id: 'sphere', label: 'Sphere' },
  { id: 'sweep', label: 'Sweep' },
];

/** Paint and Erase, the brush radius, and how much is painted. Session undo takes paint back. */
function PaintControls() {
  const painted = useEditor((s) => s.refine?.triangles.length ?? 0);
  return (
    <>
      <BrushSettings />
      <p className="anchor-help" role="status">
        {painted
          ? `${painted.toLocaleString()} ${painted === 1 ? 'triangle' : 'triangles'} painted.`
          : 'Nothing painted yet.'}
      </p>
    </>
  );
}

function RegionControls({ view, targets, owned }: ModeProps) {
  const painted = useEditor((s) => (s.refine?.triangles.length ?? 0) > 0);
  const inputs = targets.map((f) => f.feature.input as RegionInput);
  const defaults = view.region;
  const treatment = settingOf(inputs, (i) => i.treatment, defaults.treatment);
  const shape = settingOf(inputs, (i) => i.shape, defaults.shape);
  const strength = settingOf(inputs, (i) => i.strength, defaults.strength);
  const keepDetail = settingOf(inputs, (i) => i.keepDetail, defaults.keepDetail);
  const values = (pick: (input: Omit<RegionInput, 'triangles'>) => number | null) =>
    inputs.length ? inputs.map(pick) : [pick(defaults)];
  const solve =
    targets.length === 1
      ? (refineSolved(editor().refine!, targets[0]) as RegionSolve | null)
      : null;
  const model = view.model!;
  const set = (options: Partial<RefineSession['region']>) => editor().setRefineRegion(options);
  // Each selected region starts from what its own solve used; the model's rule stands in without one.
  const seed =
    (setting: 'detail' | 'blend' | 'scale', range: { min: number; max: number }) => () => {
      const rule = autoRule(setting, model);
      if (!targets.length) {
        const start = manualStart(rule, range);
        set({ [setting]: start.value });
        return start.adjusted;
      }
      const { each, adjusted } = manualStarts(
        targets.map((f) => {
          const used = (refineSolved(editor().refine!, f) as RegionSolve | null)?.resolved;
          return { id: f.id, start: used?.find((patch) => patch)?.[setting] ?? rule };
        }),
        range,
      );
      editor().setRefineRegion(
        {},
        Object.fromEntries(Object.entries(each).map(([id, value]) => [id, { [setting]: value }])),
      );
      return adjusted;
    };
  const smooth = !treatment.mixed && treatment.value === 'smooth';
  const fitted = !shape.mixed && shape.value === 'auto' ? fittedLabel(solve?.fitted ?? null) : null;
  return (
    <>
      <PaintControls />
      <button
        className="button secondary full-width refine-spaced"
        disabled={!painted}
        onClick={() => editor().makeRefineRegion()}
      >
        Make region
      </button>
      <Choice<Treatment>
        label="Treatment"
        value={treatment.mixed ? null : treatment.value}
        options={[
          { id: 'smooth', label: 'Smooth' },
          { id: 'flatten', label: 'Flatten' },
          { id: 'shape', label: 'Shape' },
        ]}
        onChange={(treatment) => set({ treatment })}
      />
      {!treatment.mixed && treatment.value === 'shape' ? (
        <>
          <label className="brush-radius">
            <span>Shape</span>
            <select
              aria-label="Shape"
              value={shape.mixed ? 'mixed' : shape.value}
              onChange={(event) => set({ shape: event.target.value as RegionShape })}
            >
              {shape.mixed ? (
                <option value="mixed" disabled>
                  Mixed
                </option>
              ) : null}
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
        value={strength.value}
        mixed={strength.mixed}
        owned={owned}
        onSet={(strength) => set({ strength })}
      />
      <SwitchRow
        title="Keep detail"
        label="Keep detail"
        checked={keepDetail.value}
        mixed={keepDetail.mixed}
        onChange={(keepDetail) => set({ keepDetail })}
      />
      {keepDetail.value && !keepDetail.mixed ? (
        <>
          <AutoSetting
            label="Offset"
            values={values((i) => i.detail)}
            seed={seed('detail', fieldRange)}
            onSet={(detail) => set({ detail })}
          >
            {(detail, mixed, setDetail) => (
              <MillimetreField
                label="Offset"
                value={detail}
                mixed={mixed}
                owned={owned}
                onSet={setDetail}
              />
            )}
          </AutoSetting>
          <p className="anchor-help">
            How far a feature must deviate from the surface, raised or recessed, to be preserved.
          </p>
        </>
      ) : null}
      <AutoSetting
        label="Blend"
        values={values((i) => i.blend)}
        seed={seed('blend', fieldRange)}
        onSet={(blend) => set({ blend })}
      >
        {(blend, mixed, setBlend) => (
          <MillimetreField
            label="Blend"
            value={blend}
            mixed={mixed}
            owned={owned}
            onSet={setBlend}
          />
        )}
      </AutoSetting>
      {smooth ? (
        <>
          <AutoSetting
            label="Reach"
            values={values((i) => i.scale ?? null)}
            seed={seed('scale', reachRange)}
            onSet={(scale) => set({ scale })}
          >
            {(scale, mixed, setScale) => (
              <SliderSetting
                label="Reach"
                value={scale}
                mixed={mixed}
                range={reachRange}
                owned={owned}
                onSet={setScale}
              />
            )}
          </AutoSetting>
          <p className="anchor-help">The longest ripple Smooth removes.</p>
        </>
      ) : null}
      <FeatureActions targets={targets} />
    </>
  );
}

function BrushControls({ view, targets, owned }: ModeProps) {
  return (
    <>
      <Choice
        label="Brush"
        value={view.brush.kind}
        options={[
          { id: 'crease', label: 'Crease' },
          { id: 'flatten', label: 'Flatten' },
          { id: 'smooth', label: 'Smooth' },
        ]}
        onChange={(kind) => editor().setRefineBrush({ kind })}
      />
      <BrushSettings />
      <SliderSetting
        label="Strength"
        value={view.brush.strength}
        live
        begin={() => {
          const saved = view.brush.strength;
          return () => editor().setRefineBrush({ strength: saved });
        }}
        owned={owned}
        onSet={(strength) => editor().setRefineBrush({ strength })}
      />
      {targets.length ? <FeatureActions targets={targets} /> : null}
    </>
  );
}

const detectTitle = 'Finding edges and surfaces';

function DetectControls({ view, targets, owned }: ModeProps) {
  const waiting = useEditor((s) => !!(s.refine?.draftStatus || s.refine?.draggingHandle));
  const { detect, features } = view;
  const painted = useEditor((s) => (s.refine?.triangles.length ?? 0) > 0);
  const task = useActivity((s) =>
    s.tasks.find((task) => task.title === detectTitle && isTaskActive(task)),
  );
  const pending = useMemo(() => features.filter((f) => f.state === 'pending'), [features]);
  const ids = targets.map((f) => f.id);
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
      {detect.where === 'painted' ? <PaintControls /> : null}
      <SliderSetting
        label="Sensitivity"
        value={detect.sensitivity}
        live
        begin={() => {
          const saved = detect.sensitivity;
          return () => editor().setRefineDetect({ sensitivity: saved });
        }}
        owned={owned}
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
          disabled={detect.where === 'painted' && !painted}
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
          <PreviewOffHint />
          {view.chosenPoint ? <RemovePoint view={view} /> : null}
          <div className="warp-gap-row">
            <button
              className="button secondary"
              disabled={!ids.length}
              onClick={() => editor().dismissRefine(ids)}
            >
              Dismiss selected
            </button>
            <button
              className="button primary"
              disabled={!ids.length || waiting}
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

function CleanControls({ view, owned }: ModeProps) {
  const { clean } = view;
  const model = view.model!;
  const painted = useEditor((s) => (s.refine?.triangles.length ?? 0) > 0);
  const task = useActivity((s) =>
    s.tasks.find((task) => task.title === cleanTitle && isTaskActive(task)),
  );
  const set = (options: Partial<Omit<RefineSession['clean'], 'running'>>) =>
    editor().setRefineClean(options);
  const idle = !clean.smooth && !clean.sharpen && !clean.depth && !clean.square;
  return (
    <>
      <p className="anchor-help">
        Removes scan noise, crisps edges and deepens detail, as sharpening does for a photo. Square
        rebuilds rounded edges between faces at about 90° as sharp corners.
      </p>
      <Choice
        label="Area"
        value={clean.where}
        options={[
          { id: 'part', label: 'Whole part' },
          { id: 'painted', label: 'Painted area' },
        ]}
        onChange={(where) => set({ where })}
      />
      {clean.where === 'painted' ? <PaintControls /> : null}
      <SliderSetting
        label="Smooth"
        value={clean.smooth}
        owned={owned}
        onSet={(smooth) => set({ smooth })}
      />
      <SliderSetting
        label="Sharpen"
        value={clean.sharpen}
        owned={owned}
        onSet={(sharpen) => set({ sharpen })}
      />
      <SliderSetting
        label="Depth"
        value={clean.depth}
        most={cleanDepthMax}
        owned={owned}
        onSet={(depth) => set({ depth })}
      />
      <SliderSetting
        label="Square"
        value={clean.square}
        owned={owned}
        onSet={(square) => set({ square })}
      />
      <AutoSetting
        label="Size"
        values={[clean.size]}
        seed={() => {
          const start = manualStart(autoRule('size', model), cleanSizeRange);
          set({ size: start.value });
          return start.adjusted;
        }}
        onSet={(size) => set({ size })}
      >
        {(size, mixed, setSize) => (
          <SliderSetting
            label="Size"
            value={size}
            mixed={mixed}
            range={cleanSizeRange}
            owned={owned}
            onSet={setSize}
          />
        )}
      </AutoSetting>
      {clean.running ? (
        <>
          <div className="job-inline-progress" role="status">
            <p>
              {cleanTitle}
              {task?.progress != null ? ` · ${Math.round(task.progress * 100)}%` : ''}
            </p>
            <progress aria-label="Clean progress" max={1} value={task?.progress ?? undefined} />
          </div>
          <button
            className="button secondary full-width refine-spaced"
            onClick={() => editor().cancelRefineClean()}
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          className="button primary full-width refine-spaced"
          disabled={idle || (clean.where === 'painted' && !painted)}
          onClick={() => void editor().cleanRefine()}
        >
          Clean surface
        </button>
      )}
    </>
  );
}

/** Ends the session without a notice and leaves the tool. */
function cancel() {
  const state = editor();
  state.cancelRefine();
  state.setTool('select');
}

const modeTitles = {
  edge: 'Edge',
  region: 'Region',
  brush: 'Brush',
  detect: 'Detect',
  clean: 'Clean',
} as const;

export function RefineControls() {
  const view = useEditor(useShallow((s) => panelView(s.refine)));
  const part = useEditor(
    useShallow((s) => {
      const part = s.refine && s.scene.parts.find((p) => p.id === s.refine!.partId);
      return { name: part?.name, locked: !!part?.locked };
    }),
  );
  const features = view?.features;
  const counts = useMemo(() => (features ? featureCounts(features) : ''), [features]);
  const mode = view?.mode;
  const selected = view?.selected;
  const targets = useMemo(
    () => (mode && features && selected ? refineTargets({ mode, features, selected }) : []),
    [mode, features, selected],
  );
  if (!view)
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
  const building = view.stage === 'building';
  const target = targetKey(view.mode, targets);
  const props: ModeProps = { view, targets, owned: ownedBy(target) };
  return (
    <div className="warp-controls refine-controls">
      <Section title="Mode">
        <p className="anchor-help">
          Refining <strong>{part.name}</strong>.
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
            value={view.mode}
            options={[
              { id: 'edge', label: 'Edge' },
              { id: 'region', label: 'Region' },
              { id: 'brush', label: 'Brush' },
              { id: 'detect', label: 'Detect' },
              { id: 'clean', label: 'Clean' },
            ]}
            onChange={(mode) => editor().setRefineMode(mode)}
          />
        )}
      </Section>
      {building ? null : (
        <Section title={modeTitles[view.mode]}>
          {/* Keyed by target, so an edit under way is dropped when the target changes. */}
          {view.mode === 'edge' ? (
            <EdgeControls key={target} {...props} />
          ) : view.mode === 'region' ? (
            <RegionControls key={target} {...props} />
          ) : view.mode === 'brush' ? (
            <BrushControls key={target} {...props} />
          ) : view.mode === 'detect' ? (
            <DetectControls key={target} {...props} />
          ) : (
            <CleanControls key={target} {...props} />
          )}
        </Section>
      )}
      <p className="anchor-help refine-counts" role="status">
        {counts}
        {view.failure && <span className="refine-refusal">{view.failure}</span>}
      </p>
      {view.folds ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {foldWarning(view.folds)}
        </p>
      ) : null}
      {view.skipped ? (
        <p className="warp-warning" role="status">
          <TriangleAlert size={13} aria-hidden="true" />
          {skippedWarning(view.skipped)}
        </p>
      ) : null}
      {view.features.map((feature) =>
        feature.state === 'accepted' && feature.pieces && feature.pieces > 1 ? (
          <p className="warp-warning" role="status" key={feature.id}>
            <TriangleAlert size={13} aria-hidden="true" />
            {piecesWarning(feature.pieces)}
          </p>
        ) : null,
      )}
      <div className="warp-actions">
        <button className="button secondary" onClick={cancel}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={building || !view.edited || part.locked}
          title={
            part.locked
              ? `Unlock ${part.name} to apply the refinement.`
              : view.edited
                ? undefined
                : 'Accept a feature, make a stroke or clean the surface first.'
          }
          onClick={() => editor().applyRefine()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
