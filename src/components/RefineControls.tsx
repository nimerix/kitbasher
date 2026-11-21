import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import { useShallow } from 'zustand/react/shallow';
import { LoaderCircle, TriangleAlert } from 'lucide-react';
import { isTaskActive, useActivity } from '../core/activity';
import { fittedSizeRange, partSize } from '../core/geometry';
import type { EdgeInput, EdgeSolve } from '../core/refine-edge';
import type { RegionInput, RegionSolve, RegionShape, Treatment } from '../core/refine-region';
import {
  refineBrushRadius,
  refineDraftLimit,
  refineEdited,
  refineSolved,
  useEditor,
  type RefineFeature,
  type RefineSession,
} from '../core/store';
import {
  autoRule,
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
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { LogRangeInput, NumericInput, RadioGroup, Section } from './ui';

const editor = () => useEditor.getState();

const isSlider = (target: EventTarget | null) =>
  target instanceof HTMLInputElement && target.type === 'range';

/** What the panel shows of the session: everything but the painted triangles. */
const panelView = (refine: RefineSession | null) =>
  refine && {
    partId: refine.partId,
    stage: refine.stage,
    model: refine.model,
    // A new draft means new solves to show, such as a fitted shape or an Auto end.
    draft: refine.draft,
    mode: refine.mode,
    features: refine.features,
    selected: refine.selected,
    edge: refine.edge,
    region: refine.region,
    brush: refine.brush,
    detect: refine.detect,
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

/** Keys that change a range input's value. */
const editingKeys = new Set([
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
]);

/**
 * One slider's edit. Unless `live`, a value is shown while dragged and set once, when let go or
 * changed by key; a blur during a drag waits for the release. A live edit sets each value and
 * remembers, through `begin`, how to put back what it started from. Escape cancels the edit (a
 * live one with one write back) and the rest of that drag is ignored; so is a value whose target
 * is no longer the panel's, and a live drag whose control goes away is put back. A press on a
 * mixed slider starts at `least`, the value it shows.
 */
function useSliderEdit({
  owned,
  onSet,
  live = false,
  begin,
  mixed = false,
  least = 0,
}: {
  owned: () => boolean;
  onSet: (value: number) => void;
  live?: boolean;
  begin?: () => () => void;
  mixed?: boolean;
  least?: number;
}) {
  const [draft, setDraft] = useState<number | null>(null);
  const edit = useRef({
    pending: null as number | null,
    restore: null as (() => void) | null,
    dragging: false,
    cancelled: false,
    /** Whether the drag's pointer is known to be pressed still. */
    held: false,
    /** Removes the drag's window listeners. */
    detach: null as (() => void) | null,
  });
  const latest = useRef({ owned, onSet, live, begin });
  latest.current = { owned, onSet, live, begin };
  const row = useRef<HTMLElement | null>(null);
  const finish = useRef(() => {});
  // Ends a drag's hold on the control, whether it finished or was cancelled.
  const release = () => {
    const current = edit.current;
    current.detach?.();
    current.detach = null;
    current.dragging = false;
    current.cancelled = false;
    current.held = false;
  };
  // Drops the edit, putting a live one back; a drag stays cancelled until its pointer is let go.
  const cancel = useRef(() => {});
  cancel.current = () => {
    const current = edit.current;
    const { restore } = current;
    current.pending = null;
    current.restore = null;
    current.cancelled = true;
    setDraft(null);
    restore?.();
  };
  finish.current = () => {
    const current = edit.current;
    const next = current.pending;
    current.pending = null;
    current.restore = null;
    release();
    setDraft(null);
    if (next !== null && latest.current.owned()) latest.current.onSet(next);
  };
  /**
   * Follows a drag through the window: its release finishes it. A cancelled drag ends when the
   * pointer shows no button pressed, on pointercancel, or when the window regains focus, so a
   * release the window never saw does not leave the control locked.
   */
  const follow = () => {
    const current = edit.current;
    current.detach?.();
    const up = (event: globalThis.PointerEvent) => {
      current.held = false;
      if (!current.dragging) return;
      if (current.cancelled) release();
      else if (event.type === 'pointerup') finish.current();
    };
    const moved = (event: globalThis.PointerEvent) => {
      if (event.buttons === 0) up(event);
    };
    const aborted = () => {
      if (!current.cancelled) cancel.current();
      release();
    };
    const focused = (event: Event) => {
      if (event.target === window && current.cancelled) release();
    };
    window.addEventListener('pointerup', up);
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointercancel', aborted);
    window.addEventListener('focus', focused);
    current.detach = () => {
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointercancel', aborted);
      window.removeEventListener('focus', focused);
    };
  };
  useEffect(() => {
    const element = row.current!;
    const current = edit.current;
    // A range input fires a native change when it is let go, by pointer or by key, and when it
    // blurs; a drag ends at the pointer's release instead.
    const changed = (event: Event) => {
      if (isSlider(event.target) && !current.dragging) finish.current();
    };
    const blurred = (event: Event) => {
      if (isSlider(event.target) && !current.dragging) finish.current();
    };
    // The window losing focus mid-drag cancels it: the release may never reach the page.
    const deactivated = (event: Event) => {
      if (event.type === 'blur' && event.target !== window) return;
      if (event.type === 'visibilitychange' && document.visibilityState !== 'hidden') return;
      if (current.dragging && !current.cancelled) cancel.current();
    };
    element.addEventListener('change', changed);
    element.addEventListener('focusout', blurred);
    window.addEventListener('blur', deactivated);
    document.addEventListener('visibilitychange', deactivated);
    return () => {
      element.removeEventListener('change', changed);
      element.removeEventListener('focusout', blurred);
      window.removeEventListener('blur', deactivated);
      document.removeEventListener('visibilitychange', deactivated);
      // A control that goes away, or whose target changed, drops its draft and its drag; a live
      // drag it abandons is put back as it was before the drag began.
      const { restore } = current;
      current.pending = null;
      current.restore = null;
      restore?.();
      current.detach?.();
      current.detach = null;
      current.dragging = false;
    };
  }, []);
  const change = (next: number) => {
    const current = edit.current;
    const { owned, onSet, live, begin } = latest.current;
    if (current.cancelled || !owned()) return;
    if (!live) {
      current.pending = next;
      setDraft(next);
      return;
    }
    current.restore ??= begin?.() ?? null;
    onSet(next);
  };
  return {
    draft,
    hidden: mixed && draft === null,
    change,
    row: (element: HTMLElement | null) => {
      row.current = element;
    },
    onPointerDown: (event: PointerEvent) => {
      if (!isSlider(event.target) || event.button !== 0) return;
      const current = edit.current;
      release();
      current.dragging = true;
      current.held = true;
      follow();
      if (mixed && draft === null) change(least);
    },
    onKeyDown: (event: KeyboardEvent) => {
      if (!isSlider(event.target)) return;
      const current = edit.current;
      if (event.key !== 'Escape') {
        // A key that edits the slider ends a cancelled drag: the user has moved on from it. Any
        // other key does so only once its pointer is no longer known to be pressed.
        if (!current.dragging) current.cancelled = false;
        else if (current.cancelled && (editingKeys.has(event.key) || !current.held)) release();
        return;
      }
      if (current.pending === null && !current.restore) return;
      event.preventDefault();
      cancel.current();
    },
  };
}

/**
 * A slider with a number field. A percent setting holds 0 to 1 and shows 0 to 100; a setting with
 * `range` is in mm on a logarithmic slider. Unless `live`, a drag sets its value once on release;
 * a live one gives `begin` to put the value back on Escape.
 */
function SliderSetting({
  label,
  value,
  mixed = false,
  range,
  live = false,
  begin,
  owned,
  onSet,
}: {
  label: string;
  value: number;
  mixed?: boolean;
  range?: { min: number; max: number };
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
          max={100}
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
        max={range ? range.max : 100}
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
  return (
    <>
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
      <FeatureActions targets={targets} />
    </>
  );
}

const widthRange = { min: 0.1, max: 5 };
const reachRange = { min: 0.3, max: 5 };

const shapes: { id: RegionShape; label: string }[] = [
  { id: 'auto', label: 'Auto' },
  { id: 'cylinder', label: 'Cylinder' },
  { id: 'cone', label: 'Cone' },
  { id: 'sphere', label: 'Sphere' },
  { id: 'sweep', label: 'Sweep' },
];

/** The brush radius on the session's part, set once a drag is let go. */
function BrushRadius() {
  const radius = useEditor(refineBrushRadius);
  const size = useEditor((s) => {
    const part = s.refine && s.scene.parts.find((p) => p.id === s.refine!.partId);
    return part ? partSize(part) : 0;
  });
  const range = fittedSizeRange(size);
  const set = (value: number) => editor().setRefineBrushRadius(value);
  const slider = useSliderEdit({ owned: always, onSet: set });
  const shown = slider.draft ?? radius;
  return (
    <div
      className="refine-brush-radius"
      ref={slider.row}
      onPointerDown={slider.onPointerDown}
      onKeyDown={slider.onKeyDown}
    >
      <label className="brush-radius">
        <span>Brush radius</span>
        <NumericInput
          label="Brush radius"
          value={shown}
          min={0.05}
          max={100}
          step={0.1}
          onCommit={set}
        />
        <small>mm</small>
      </label>
      <LogRangeInput
        className="brush-radius-slider"
        label="Brush radius slider"
        value={shown}
        min={range.min}
        max={range.max}
        onChange={slider.change}
      />
    </div>
  );
}

const always = () => true;

/** Paint and Erase, the brush radius, and how much is painted. Session undo takes paint back. */
function PaintControls() {
  const painted = useEditor((s) => s.refine?.triangles.length ?? 0);
  return (
    <>
      <SurfaceBrushControls paintUndo={false} seedPlane={false} radius={<BrushRadius />} />
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
      <BrushRadius />
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

/** Ends the session without a notice and leaves the tool. */
function cancel() {
  const state = editor();
  state.cancelRefine();
  state.setTool('select');
}

const modeTitles = { edge: 'Edge', region: 'Region', brush: 'Brush', detect: 'Detect' } as const;

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
          ) : (
            <DetectControls key={target} {...props} />
          )}
        </Section>
      )}
      <p className="anchor-help refine-counts" role="status">
        {counts}
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
                : 'Accept a feature or make a stroke first.'
          }
          onClick={() => editor().applyRefine()}
        >
          Apply
        </button>
      </div>
    </div>
  );
}
