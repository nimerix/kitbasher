import { ChevronDown } from 'lucide-react';
import { useEditor } from '../core/store';
import type { SculptBrush, SculptureSettings } from '../core/types';
import { NumericInput } from './ui';

const brushes: Record<SculptBrush, string> = {
  draw: 'Draw',
  grab: 'Grab',
  smooth: 'Smooth',
  flatten: 'Flatten',
  crease: 'Crease',
  clay: 'Clay Buildup',
  inflate: 'Inflate/Deflate',
  mask: 'Mask',
};

function NumberSetting({
  label,
  value,
  min,
  max,
  step,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  unit?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="brush-radius">
      <span>{label}</span>
      <NumericInput
        label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        onCommit={onChange}
      />
      {unit && <small>{unit}</small>}
    </label>
  );
}

export function SculptControls() {
  const sculpt = useEditor((state) => state.sculpt);
  const setBrush = useEditor((state) => state.setSculptBrush);
  const setSettings = useEditor((state) => state.setSculptSettings);
  const reset = useEditor((state) => state.resetSculptBrush);
  const changeMask = useEditor((state) => state.changeSculptMask);
  if (!sculpt) return null;
  const { settings, mask, pending } = sculpt;
  const { brush } = settings;
  const patch = <K extends keyof Omit<SculptureSettings, 'brush'>>(
    key: K,
    value: SculptureSettings[K],
  ) => setSettings({ [key]: value });

  return (
    <div className="sculpt-controls">
      <div className="sculpt-brushes" role="group" aria-label="Brush">
        {(Object.keys(brushes) as SculptBrush[]).map((id) => (
          <button
            key={id}
            type="button"
            className={`button secondary ${brush === id ? 'active' : ''}`}
            aria-pressed={brush === id}
            onClick={() => setBrush(id)}
          >
            {brushes[id]}
          </button>
        ))}
      </div>
      <NumberSetting
        label="Radius"
        value={settings.radius}
        min={0.01}
        max={1000}
        step={0.1}
        unit="mm"
        onChange={(value) => patch('radius', value)}
      />
      <NumberSetting
        label="Strength"
        value={settings.strength}
        min={0}
        max={1}
        step={0.05}
        onChange={(value) => patch('strength', value)}
      />
      <NumberSetting
        label="Detail"
        value={settings.detail}
        min={0}
        max={1}
        step={0.05}
        onChange={(value) => patch('detail', value)}
      />
      <label className="sculpt-check">
        <input
          type="checkbox"
          checked={settings.symmetry}
          onChange={(event) => patch('symmetry', event.target.checked)}
        />
        Local X symmetry
      </label>
      <p className="field-help">
        {brush === 'mask'
          ? 'Drag to paint protection. Hold Alt to erase or Shift to soften.'
          : 'Drag on the part to sculpt. Hold Shift to smooth.'}
        {['draw', 'crease', 'clay', 'inflate'].includes(brush) ? ' Hold Alt to invert.' : ''}
      </p>
      <div className="sculpt-mask-controls" role="group" aria-label="Sculpt mask">
        <label className="sculpt-check">
          <input
            type="checkbox"
            checked={settings.maskVisible}
            onChange={(event) => patch('maskVisible', event.target.checked)}
          />
          Show mask
        </label>
        <div className="sculpt-mask-actions">
          <button
            type="button"
            className="button secondary"
            disabled={!!pending}
            onClick={() => changeMask('invert')}
          >
            Invert mask
          </button>
          <button
            type="button"
            className="button secondary"
            disabled={!mask || !!pending}
            onClick={() => changeMask('clear')}
          >
            Clear mask
          </button>
        </div>
      </div>
      <details className="inspector-section sculpt-advanced">
        <summary>
          Advanced brush settings <ChevronDown size={14} />
        </summary>
        <div className="sculpt-advanced-fields">
          <label className="brush-radius">
            <span>Falloff</span>
            <select
              value={settings.falloff}
              onChange={(event) =>
                patch('falloff', event.target.value as SculptureSettings['falloff'])
              }
            >
              <option value="soft">Soft</option>
              <option value="linear">Linear</option>
              <option value="hard">Hard</option>
            </select>
          </label>
          <NumberSetting
            label="Minimum edge size"
            value={settings.minEdge}
            min={0.001}
            max={100}
            step={0.01}
            unit="mm"
            onChange={(value) => patch('minEdge', value)}
          />
          <NumberSetting
            label="Dab spacing"
            value={settings.spacing}
            min={0.05}
            max={1}
            step={0.05}
            onChange={(value) => patch('spacing', value)}
          />
          <NumberSetting
            label="Stroke stabilization"
            value={settings.stabilization}
            min={0}
            max={0.95}
            step={0.05}
            onChange={(value) => patch('stabilization', value)}
          />
          <label className="sculpt-check">
            <input
              type="checkbox"
              checked={settings.pressureStrength}
              onChange={(event) => patch('pressureStrength', event.target.checked)}
            />
            Pen pressure changes strength
          </label>
          <label className="sculpt-check">
            <input
              type="checkbox"
              checked={settings.pressureRadius}
              onChange={(event) => patch('pressureRadius', event.target.checked)}
            />
            Pen pressure changes radius
          </label>
          {(settings.pressureStrength || settings.pressureRadius) && (
            <NumberSetting
              label="Pressure curve"
              value={settings.pressureCurve}
              min={0.25}
              max={4}
              step={0.25}
              onChange={(value) => patch('pressureCurve', value)}
            />
          )}
          {brush === 'draw' && (
            <>
              <label className="brush-radius">
                <span>Footprint</span>
                <select
                  value={settings.aspect < 1 ? 'ellipse' : 'round'}
                  onChange={(event) => patch('aspect', event.target.value === 'ellipse' ? 0.6 : 1)}
                >
                  <option value="round">Round</option>
                  <option value="ellipse">Elliptical</option>
                </select>
              </label>
              {settings.aspect < 1 && (
                <>
                  <NumberSetting
                    label="Roundness"
                    value={settings.aspect}
                    min={0.1}
                    max={0.99}
                    step={0.05}
                    onChange={(value) => patch('aspect', value)}
                  />
                  <NumberSetting
                    label="Rotation"
                    value={settings.rotation}
                    min={-180}
                    max={180}
                    step={5}
                    unit="°"
                    onChange={(value) => patch('rotation', value)}
                  />
                  <label className="sculpt-check">
                    <input
                      type="checkbox"
                      checked={settings.tilt}
                      onChange={(event) => patch('tilt', event.target.checked)}
                    />
                    Orient with pen tilt
                  </label>
                  <label className="sculpt-check">
                    <input
                      type="checkbox"
                      checked={settings.twist}
                      onChange={(event) => patch('twist', event.target.checked)}
                    />
                    Rotate with pen twist
                  </label>
                </>
              )}
            </>
          )}
          {brush === 'crease' && (
            <NumberSetting
              label="Pinch"
              value={settings.pinch}
              min={0}
              max={1}
              step={0.05}
              onChange={(value) => patch('pinch', value)}
            />
          )}
          <button type="button" className="button secondary" onClick={reset}>
            Reset brush settings
          </button>
        </div>
      </details>
    </div>
  );
}
