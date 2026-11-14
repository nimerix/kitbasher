import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react';
import { Gamepad2, Keyboard, MousePointer2, Plus, RotateCcw, ScanSearch, X } from 'lucide-react';
import {
  bindingFromEvent,
  bindingsFor,
  formatBinding,
  keyActionIds,
  keyActions,
  keyGroups,
} from '../core/keybindings';
import type { KeyActionId, KeyGroup } from '../core/keybindings';
import { defaultPreferences, preferenceLimits, usePreferences } from '../core/preferences';
import type { MarkerSettings, PreferencesTab } from '../core/preferences';
import { useEditor } from '../core/store';
import { notchPixels, zoomResponse } from '../core/zoom';
import type { ZoomSettings } from '../core/zoom';
import { layoutCallouts } from '../core/callouts';
import { IconButton, NumericInput } from './ui';
import {
  defaultXRInputSettings,
  useXRInput,
  xrAxisActions,
  xrButtonActions,
  xrButtonLabels,
  xrButtons,
} from '../core/xr-input';
import type { XRAxisAction, XRButtonAction } from '../core/xr-input';

const tabs: { id: PreferencesTab; label: string; icon: typeof Keyboard }[] = [
  { id: 'navigation', label: 'Navigation', icon: MousePointer2 },
  { id: 'markers', label: 'Markers', icon: ScanSearch },
  { id: 'keyboard', label: 'Keyboard', icon: Keyboard },
  { id: 'headset', label: 'Headset', icon: Gamepad2 },
];

export function PreferencesPanel() {
  const tab = usePreferences((state) => state.panel);
  return tab ? <OpenPreferences tab={tab} /> : null;
}

function OpenPreferences({ tab }: { tab: PreferencesTab }) {
  const panel = useRef<HTMLElement>(null);
  const tabList = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    tabList.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
    return () => {
      // Return to where the panel was opened from, unless focus has since moved elsewhere.
      if (
        previous?.isConnected &&
        (!document.activeElement || document.activeElement === document.body)
      )
        previous.focus();
    };
  }, []);
  const close = () => usePreferences.getState().closePanel();
  const choose = (next: PreferencesTab) => usePreferences.getState().openPanel(next);
  const onTabKey = (event: ReactKeyboardEvent) => {
    const index = tabs.findIndex((t) => t.id === tab);
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const target =
      event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : step ? index + step : -1;
    if (target < 0 && !step) return;
    event.preventDefault();
    const next = tabs[(target + tabs.length) % tabs.length];
    choose(next.id);
    requestAnimationFrame(() =>
      tabList.current?.querySelector<HTMLElement>(`#preferences-tab-${next.id}`)?.focus(),
    );
  };
  return (
    <aside
      ref={panel}
      className="preferences-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="preferences-title"
      onKeyDown={(event) => {
        // Escape in a field cancels that edit rather than closing the panel.
        const field = event.target instanceof HTMLInputElement && event.target.type !== 'range';
        if (event.key === 'Escape' && !event.defaultPrevented && !field) {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="preferences-heading">
        <div>
          <h2 id="preferences-title">Preferences</h2>
          <p>Saved in this browser and used for every scene.</p>
        </div>
        <IconButton label="Close preferences" onClick={close}>
          <X size={16} />
        </IconButton>
      </header>
      <div
        ref={tabList}
        className="preferences-tabs"
        role="tablist"
        aria-label="Preference sections"
        onKeyDown={onTabKey}
      >
        {tabs.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            id={`preferences-tab-${id}`}
            role="tab"
            aria-selected={tab === id}
            aria-controls="preferences-tabpanel"
            tabIndex={tab === id ? 0 : -1}
            className={tab === id ? 'active' : ''}
            onClick={() => choose(id)}
          >
            <Icon size={13} />
            {label}
          </button>
        ))}
      </div>
      <div
        id="preferences-tabpanel"
        className="preferences-body"
        role="tabpanel"
        aria-labelledby={`preferences-tab-${tab}`}
      >
        {tab === 'navigation' ? (
          <NavigationPreferences />
        ) : tab === 'markers' ? (
          <MarkerPreferences />
        ) : tab === 'keyboard' ? (
          <KeyboardPreferences />
        ) : (
          <HeadsetPreferences />
        )}
      </div>
    </aside>
  );
}

function SectionHeading({
  title,
  onReset,
  modified,
}: {
  title: string;
  onReset?: () => void;
  modified?: boolean;
}) {
  return (
    <div className="preferences-section-heading">
      <h3>{title}</h3>
      {onReset ? (
        <button className="preferences-reset" disabled={!modified} onClick={onReset}>
          <RotateCcw size={11} />
          Reset
        </button>
      ) : null}
    </div>
  );
}

function RangeField({
  label,
  value,
  limit,
  unit,
  display,
  help,
  onChange,
}: {
  label: string;
  value: number;
  limit: { min: number; max: number; step: number };
  unit?: string;
  display?: string;
  help?: ReactNode;
  onChange: (value: number) => void;
}) {
  return (
    <div className="preference-range">
      <div className="preference-range-label">
        <span>{label}</span>
        {display ? (
          <output>{display}</output>
        ) : (
          <span className="preference-number">
            <NumericInput
              label={`${label} value`}
              value={value}
              min={limit.min}
              max={limit.max}
              step={limit.step}
              onCommit={onChange}
            />
            {unit ? <small>{unit}</small> : null}
          </span>
        )}
      </div>
      <input
        type="range"
        aria-label={label}
        min={limit.min}
        max={limit.max}
        step={limit.step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      {help ? <p className="preference-help">{help}</p> : null}
    </div>
  );
}

function SwitchField({
  label,
  checked,
  help,
  onChange,
}: {
  label: string;
  checked: boolean;
  help?: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="preference-switch">
      <div>
        <span>{label}</span>
        <button
          type="button"
          role="switch"
          aria-label={label}
          aria-checked={checked}
          className={`toggle ${checked ? 'on' : ''}`}
          onClick={() => onChange(!checked)}
        >
          <span />
        </button>
      </div>
      {help ? <p className="preference-help">{help}</p> : null}
    </div>
  );
}

function SegmentedField<T extends string>({
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
    <div className="preference-segmented">
      <span>{label}</span>
      <div role="radiogroup" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.id}
            role="radio"
            aria-checked={value === option.id}
            className={value === option.id ? 'active' : ''}
            onClick={() => onChange(option.id)}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

const same = <T extends object>(a: T, b: T) =>
  (Object.keys(a) as (keyof T)[]).every((key) => a[key] === b[key]);
const percent = (amount: number) => `${Math.round((Math.exp(amount) - 1) * 100)}%`;

function HeadsetPreferences() {
  const settings = useXRInput((state) => state.settings);
  const setSettings = useXRInput((state) => state.setSettings);
  return (
    <>
      <section className="preferences-section">
        <SectionHeading
          title="Quest controller bindings"
          modified={JSON.stringify(settings) !== JSON.stringify(defaultXRInputSettings)}
          onReset={() => useXRInput.getState().reset()}
        />
        <p className="preference-help section-help">
          Trigger uses the active tool; grip moves the world. Button and stick changes apply
          immediately, including during a headset session.
        </p>
        {xrButtons.map((button) => (
          <label className="preference-select" key={button}>
            <span>{xrButtonLabels[button]}</span>
            <select
              aria-label={`${xrButtonLabels[button]} action`}
              value={settings.buttons[button]}
              onChange={(event) =>
                setSettings({
                  buttons: {
                    ...settings.buttons,
                    [button]: event.target.value as XRButtonAction,
                  },
                })
              }
            >
              {xrButtonActions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.label}
                </option>
              ))}
            </select>
          </label>
        ))}
      </section>
      <section className="preferences-section">
        <SectionHeading title="World navigation" />
        <p className="preference-help section-help">
          Hold either grip to move the world. With that controller's stick, up/down zooms and
          left/right turns. One controller is enough. Release the grip and center the stick to
          return to editing.
        </p>
        <RangeField
          label="World zoom speed"
          value={settings.zoomSpeed}
          display={`${settings.zoomSpeed.toFixed(2)}×`}
          limit={{ min: 0.25, max: 2, step: 0.05 }}
          help="Adjusts thumbstick zoom speed. Zoom stops when you release the stick."
          onChange={(zoomSpeed) => setSettings({ zoomSpeed })}
        />
        <SegmentedField
          label="World turn step"
          value={String(settings.turnAngle)}
          options={[
            { id: '15', label: '15°' },
            { id: '30', label: '30°' },
            { id: '45', label: '45°' },
          ]}
          onChange={(turnAngle) => setSettings({ turnAngle: Number(turnAngle) as 15 | 30 | 45 })}
        />
        <SwitchField
          label="Trigger drags empty space"
          checked={settings.triggerWorld}
          help="Legacy controller behavior: a trigger miss or locked part moves the world. Off keeps trigger clicks for editing. Bare-hand pinches on empty space can still move the world."
          onChange={(triggerWorld) => setSettings({ triggerWorld })}
        />
        <p className="preference-help">
          The headset's View page also offers zoom, turn, frame, and Previous view controls.
        </p>
      </section>
      <section className="preferences-section">
        <SectionHeading title="Thumbsticks" />
        {(['left', 'right'] as const).map((hand) => (
          <label className="preference-select" key={hand}>
            <span>{hand === 'left' ? 'Left stick' : 'Right stick'}</span>
            <select
              aria-label={`${hand === 'left' ? 'Left' : 'Right'} thumbstick action`}
              value={settings.axes[hand]}
              onChange={(event) =>
                setSettings({
                  axes: { ...settings.axes, [hand]: event.target.value as XRAxisAction },
                })
              }
            >
              {xrAxisActions.map((action) => (
                <option key={action.id} value={action.id}>
                  {action.label}
                </option>
              ))}
            </select>
          </label>
        ))}
        <p className="preference-help">
          Active tool adjustment changes brush size while painting, alignment offset while fitting,
          and moves, rotates, or scales the selection with those tools. Precision makes adjustments
          smaller. World zoom / turn dedicates a stick to navigation without holding a grip.
        </p>
        <RangeField
          label="Stick deadzone"
          value={settings.deadzone}
          display={`${Math.round(settings.deadzone * 100)}%`}
          limit={{ min: 0.05, max: 0.5, step: 0.01 }}
          help="Ignore small stick movements to prevent drift."
          onChange={(deadzone) => setSettings({ deadzone })}
        />
        <SegmentedField
          label="Tool hand"
          value={settings.dominantHand}
          options={[
            { id: 'left', label: 'Left' },
            { id: 'right', label: 'Right' },
          ]}
          onChange={(dominantHand) => setSettings({ dominantHand })}
        />
        <p className="preference-help">
          The wrist palette sits on the opposite hand. Face button names stay on their physical
          controllers when the tool hand changes.
        </p>
      </section>
      <p className="preferences-tip">
        Bindings and world navigation settings are also available on the headset panel. Meta and
        menu buttons remain reserved by the headset.
      </p>
    </>
  );
}

function NavigationPreferences() {
  const zoom = usePreferences((state) => state.zoom);
  const scaling = usePreferences((state) => state.transform.scaling);
  const orbitSelection = useEditor((state) => state.view.orbitSelection);
  const setZoom = usePreferences((state) => state.setZoom);
  return (
    <>
      <section className="preferences-section">
        <SectionHeading
          title="Scroll zoom"
          modified={!same(zoom, defaultPreferences.zoom)}
          onReset={() => usePreferences.getState().resetSection('zoom')}
        />
        <RangeField
          label="Sensitivity"
          value={zoom.sensitivity}
          limit={preferenceLimits.sensitivity}
          unit="×"
          help="Scales every zoom step from the wheel, trackpad, and zoom buttons."
          onChange={(sensitivity) => setZoom({ sensitivity })}
        />
        <RangeField
          label="Response curve"
          value={zoom.curve}
          limit={preferenceLimits.curve}
          help="Below 1, small and large wheel steps zoom more evenly. At 1, zoom follows scroll distance exactly, which suits trackpads. Above 1, fast scrolling accelerates."
          onChange={(curve) => setZoom({ curve })}
        />
        <ZoomCurve zoom={zoom} />
        <RangeField
          label="Smoothing"
          value={zoom.smoothing}
          limit={preferenceLimits.smoothing}
          display={zoom.smoothing ? `${zoom.smoothing}%` : 'Off'}
          help="How long the view glides toward each zoom step. Off jumps immediately."
          onChange={(smoothing) => setZoom({ smoothing })}
        />
        <SwitchField
          label="Invert scroll direction"
          checked={zoom.invert}
          help="Scrolling down zooms in. Trackpad pinch always follows your fingers."
          onChange={(invert) => setZoom({ invert })}
        />
      </section>
      <section className="preferences-section">
        <SectionHeading title="Orbit" />
        <SwitchField
          label="Orbit around selection"
          checked={orbitSelection}
          help="Orbit gestures turn around the selected parts while keeping your pan offset."
          onChange={(value) => useEditor.getState().setView({ orbitSelection: value })}
        />
      </section>
      <p className="preferences-tip">
        This panel stays open, so you can scroll over the viewport to try each change.
      </p>
      <section className="preferences-section">
        <SectionHeading title="Transform tool" />
        <SwitchField
          label="Enable scaling in Transform tool"
          checked={scaling}
          help="Show scale cubes alongside the move arrows and rotation rings. Turn off to remove scale handles from this tool."
          onChange={(value) => usePreferences.getState().setTransformScaling(value)}
        />
      </section>
    </>
  );
}

/** Zoom per wheel event across one to three notches, against proportional zoom. */
function ZoomCurve({ zoom }: { zoom: ZoomSettings }) {
  const width = 268,
    height = 74,
    pad = 6,
    span = 3;
  const step = (notches: number, curve = zoom.curve, sensitivity = zoom.sensitivity) =>
    zoomResponse(notches, curve) * sensitivity;
  const top = Math.max(step(span), step(span, 1, 1), 0.01);
  const path = (curve?: number, sensitivity?: number) =>
    Array.from({ length: 49 }, (_, i) => {
      const n = (i / 48) * span;
      const x = pad + (n / span) * (width - pad * 2);
      const y = height - pad - (step(n, curve, sensitivity) / top) * (height - pad * 2);
      return `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ');
  const notchX = pad + (1 / span) * (width - pad * 2),
    notchY = height - pad - (step(1) / top) * (height - pad * 2);
  return (
    <figure className="zoom-curve">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Zoom step by scroll distance">
        <line className="axis" x1={pad} y1={height - pad} x2={width - pad} y2={height - pad} />
        <line className="axis" x1={notchX} y1={pad} x2={notchX} y2={height - pad} />
        <path className="reference" d={path(1, 1)} />
        <path className="curve" d={path()} />
        <circle cx={notchX} cy={notchY} r={3} />
      </svg>
      <figcaption>
        <span>
          One notch <strong>{percent(step(1))}</strong>
        </span>
        <span>
          Fine step <strong>{percent(step(5 / notchPixels))}</strong>
        </span>
        <span className="zoom-curve-key">Dashed: proportional</span>
      </figcaption>
    </figure>
  );
}

function MarkerPreferences() {
  const markers = usePreferences((state) => state.markers);
  const set = usePreferences((state) => state.setMarkers);
  return (
    <>
      <section className="preferences-section">
        <SectionHeading
          title="Point markers"
          modified={!same(markers, defaultPreferences.markers)}
          onReset={() => usePreferences.getState().resetSection('markers')}
        />
        <p className="preference-help section-help">
          Anchors, pivots, picked surface points, measurements, joints, and painted patches.
        </p>
        <RangeField
          label="Point size"
          value={markers.size}
          limit={preferenceLimits.size}
          unit="px"
          help="Stays the same on screen at any zoom."
          onChange={(size) => set({ size })}
        />
        <RangeField
          label="Label size"
          value={markers.labelSize}
          limit={preferenceLimits.labelSize}
          unit="px"
          onChange={(labelSize) => set({ labelSize })}
        />
        <SegmentedField
          label="Labels"
          value={markers.style}
          options={[
            { id: 'inline', label: 'Beside point' },
            { id: 'callout', label: 'Callout' },
          ]}
          onChange={(style) => set({ style })}
        />
        {markers.style === 'callout' ? (
          <>
            <SegmentedField
              label="Callout placement"
              value={markers.placement}
              options={[
                { id: 'model', label: 'Clear of model' },
                { id: 'offset', label: 'Preferred length' },
              ]}
              onChange={(placement) => set({ placement })}
            />
            {markers.placement === 'model' ? (
              <RangeField
                key="clearance"
                label="Clearance from model"
                value={markers.clearance}
                limit={preferenceLimits.clearance}
                unit="px"
                help="Labels and horizontal arms clear the model by this gap. Each callout adjusts independently to avoid other labels and lines."
                onChange={(clearance) => set({ clearance })}
              />
            ) : (
              <RangeField
                key="leader"
                label="Preferred leader length"
                value={markers.leader}
                limit={preferenceLimits.leader}
                unit="px"
                help="Preferred length of the angled arm. Both arms adjust when needed to clear the model, other labels, and lines."
                onChange={(leader) => set({ leader })}
              />
            )}
          </>
        ) : null}
        <MarkerPreview markers={markers} />
      </section>
    </>
  );
}

/** A small drawing of a part with two picks, laid out by the viewport's own callout rules. */
function MarkerPreview({ markers }: { markers: MarkerSettings }) {
  const width = 268,
    height = 150,
    model = { left: 46, right: 222, top: 84, bottom: 138 };
  const points = [
    { x: 96, y: 104, label: 'S1', color: '#eda763' },
    { x: 118, y: 124, label: 'T1', color: '#9ccec6' },
    { x: 186, y: 112, label: 'Pivot', color: '#c9dcf8' },
  ];
  const r = markers.size / 2;
  const labelHeight = markers.labelSize + 6;
  const widthOf = (label: string) => label.length * markers.labelSize * 0.62 + 9;
  const placed =
    markers.style === 'callout'
      ? layoutCallouts(
          points.map((p) => ({
            x: p.x,
            y: p.y,
            width: widthOf(p.label),
            height: labelHeight,
            radius: r,
            modelBounds: model,
          })),
          markers,
          { width, height },
          4,
        )
      : points.map((p) => ({ x: p.x, y: p.y - r - 3 - labelHeight / 2, leader: null }));
  return (
    <figure className="marker-preview">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Marker preview">
        <rect
          className="preview-model"
          x={model.left}
          y={model.top}
          width={model.right - model.left}
          height={model.bottom - model.top}
          rx={6}
        />
        {placed.map((label, i) =>
          label.leader ? (
            <polyline
              key={`leader-${i}`}
              points={label.leader.map((point) => `${point.x},${point.y}`).join(' ')}
              fill="none"
              stroke={points[i].color}
            />
          ) : null,
        )}
        {points.map((p) => (
          <circle key={p.label} cx={p.x} cy={p.y} r={r} fill={p.color} />
        ))}
        {placed.map((label, i) => (
          <g key={`label-${i}`} transform={`translate(${label.x} ${label.y})`}>
            {markers.style === 'inline' ? (
              <rect
                className="preview-label"
                x={-widthOf(points[i].label) / 2}
                y={-labelHeight / 2}
                width={widthOf(points[i].label)}
                height={labelHeight}
                rx={3}
              />
            ) : null}
            <text fill={points[i].color} fontSize={markers.labelSize} dy="0.35em">
              {points[i].label}
            </text>
          </g>
        ))}
      </svg>
    </figure>
  );
}

const groupLabels: Record<KeyGroup, string> = {
  Tools: 'Tools',
  Camera: 'Camera & view',
  Edit: 'Editing',
  File: 'File & app',
};

function KeyboardPreferences() {
  const overrides = usePreferences((state) => state.keybindings);
  const [query, setQuery] = useState('');
  const [recording, setRecording] = useState<{ id: KeyActionId; replace?: string } | null>(null);
  const [notice, setNotice] = useState<{ id: KeyActionId; text: string } | null>(null);
  const search = query.trim().toLowerCase();
  const visible = useMemo(
    () =>
      keyActionIds.filter(
        (id) =>
          !search ||
          keyActions[id].label.toLowerCase().includes(search) ||
          bindingsFor(id, overrides).some((b) => formatBinding(b).toLowerCase().includes(search)),
      ),
    [overrides, search],
  );
  const record = (id: KeyActionId, binding: string, replace?: string) => {
    const displaced = usePreferences.getState().assignBinding(id, binding, replace);
    setRecording(null);
    setNotice(
      displaced.length
        ? {
            id,
            text: `${formatBinding(binding)} was moved here from ${displaced.map((d) => keyActions[d].label).join(', ')}.`,
          }
        : null,
    );
  };
  return (
    <>
      <div className="keybind-toolbar">
        <input
          type="search"
          aria-label="Search shortcuts"
          placeholder="Search actions or keys"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <button
          className="preferences-reset"
          disabled={!Object.keys(overrides).length}
          onClick={() => {
            usePreferences.getState().resetBindings();
            setNotice(null);
          }}
        >
          <RotateCcw size={11} />
          Reset all
        </button>
      </div>
      <p className="preference-help section-help">
        Click a key to change it. A key can only belong to one action, so assigning it moves it.
      </p>
      {keyGroups.map((group) => {
        const ids = visible.filter((id) => keyActions[id].group === group);
        if (!ids.length) return null;
        return (
          <section key={group} className="keybind-group" aria-label={groupLabels[group]}>
            <h3>{groupLabels[group]}</h3>
            {ids.map((id) => (
              <KeybindRow
                key={id}
                id={id}
                bindings={bindingsFor(id, overrides)}
                modified={!!overrides[id]}
                recording={recording?.id === id ? recording : null}
                notice={notice?.id === id ? notice.text : null}
                onRecord={(replace) => {
                  setNotice(null);
                  setRecording({ id, replace });
                }}
                onCancel={() => setRecording(null)}
                onCapture={(binding, replace) => record(id, binding, replace)}
              />
            ))}
          </section>
        );
      })}
      {!visible.length ? <p className="preferences-empty">No shortcuts match “{query}”.</p> : null}
    </>
  );
}

function KeybindRow({
  id,
  bindings,
  modified,
  recording,
  notice,
  onRecord,
  onCancel,
  onCapture,
}: {
  id: KeyActionId;
  bindings: readonly string[];
  modified: boolean;
  recording: { replace?: string } | null;
  notice: string | null;
  onRecord: (replace?: string) => void;
  onCancel: () => void;
  onCapture: (binding: string, replace?: string) => void;
}) {
  const label = keyActions[id].label;
  const recorder = (
    <KeyRecorder
      label={label}
      onCancel={onCancel}
      onCapture={(binding) => onCapture(binding, recording?.replace)}
    />
  );
  return (
    <div className={`keybind-row ${modified ? 'is-modified' : ''}`}>
      <span className="keybind-label">{label}</span>
      <div className="keybind-keys">
        {bindings.map((binding) =>
          recording?.replace === binding ? (
            <span key={binding}>{recorder}</span>
          ) : (
            <span key={binding} className="keybind-chip">
              <button
                className="keybind-key"
                aria-label={`Change ${formatBinding(binding)} for ${label}`}
                onClick={() => onRecord(binding)}
              >
                <kbd>{formatBinding(binding)}</kbd>
              </button>
              <button
                className="keybind-remove"
                aria-label={`Remove ${formatBinding(binding)} from ${label}`}
                onClick={() => usePreferences.getState().removeBinding(id, binding)}
              >
                <X size={10} />
              </button>
            </span>
          ),
        )}
        {recording && !recording.replace ? (
          recorder
        ) : (
          <IconButton label={`Add shortcut for ${label}`} onClick={() => onRecord()}>
            <Plus size={12} />
          </IconButton>
        )}
        {modified ? (
          <IconButton
            label={`Reset ${label} shortcut`}
            onClick={() => usePreferences.getState().resetBindings(id)}
          >
            <RotateCcw size={11} />
          </IconButton>
        ) : null}
      </div>
      {notice ? (
        <p className="keybind-notice" role="status">
          {notice}
        </p>
      ) : null}
    </div>
  );
}

function KeyRecorder({
  label,
  onCapture,
  onCancel,
}: {
  label: string;
  onCapture: (binding: string) => void;
  onCancel: () => void;
}) {
  const element = useRef<HTMLSpanElement>(null);
  const [held, setHeld] = useState('');
  useEffect(() => element.current?.focus(), []);
  // The recorder leaves the page once it finishes, so put focus back on its row.
  const finish = (done: () => void) => {
    const row = element.current?.closest('.keybind-row');
    done();
    requestAnimationFrame(() => row?.querySelector<HTMLElement>('.keybind-keys button')?.focus());
  };
  return (
    <span
      ref={element}
      className="keybind-recorder"
      role="button"
      tabIndex={0}
      aria-label={`Press the new shortcut for ${label}. Escape cancels.`}
      onBlur={onCancel}
      onKeyDown={(event) => {
        // Tab still moves focus, which ends recording.
        if (event.key === 'Tab') return;
        event.preventDefault();
        event.stopPropagation();
        if (event.key === 'Escape') {
          finish(onCancel);
          return;
        }
        const binding = bindingFromEvent(event.nativeEvent);
        if (binding) finish(() => onCapture(binding));
        else
          setHeld(
            [
              (event.metaKey || event.ctrlKey) && 'Mod',
              event.altKey && 'Alt',
              event.shiftKey && 'Shift',
            ]
              .filter(Boolean)
              .join('+'),
          );
      }}
      onKeyUp={(event) => {
        event.stopPropagation();
        if (!event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) setHeld('');
      }}
    >
      {held ? `${formatBinding(`${held}+…`).replace(/\+…$/, '')} + …` : 'Press keys…'}
    </span>
  );
}
