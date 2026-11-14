import { useRef } from 'react';
import { Move3D, Pin, Rotate3D, Trash2 } from 'lucide-react';
import { pinGaps } from '../core/pins';
import { useEditor } from '../core/store';
import { IconButton, NumericInput, Section } from './ui';

export function PinControls() {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected);
  const tool = useEditor((s) => s.tool),
    picking = useEditor((s) => s.pinPicking);
  const active = useEditor((s) => s.activePin),
    exploded = useEditor((s) => s.view.explode > 0);
  const slider = useRef<boolean | null>(null);
  const part = scene.parts.find((p) => p.id === selected[0]);
  const pins = part?.pins ?? [],
    gaps = part ? pinGaps(part) : [];
  const current = pins.find((pin) => pin.id === active) ?? pins[0];
  const disabled = !part || part.locked || !part.visible || exploded;
  return (
    <Section title="Pins">
      <p className="anchor-help">
        Hard pins hold a surface point in space. Soft pins act like rubber bands: stronger pins give
        less, weaker pins stretch farther. The part stays rigid.
      </p>
      {tool === 'pins' && (
        <label className="anchor-part-label">
          Part to pin
          <select
            aria-label="Part to pin"
            value={part?.id ?? ''}
            onChange={(e) => {
              useEditor.getState().select(e.target.value || null);
              useEditor.setState({ activePin: null, pinPicking: null });
            }}
          >
            <option value="">Choose a part</option>
            {scene.parts.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
                {p.locked ? ' (locked)' : ''}
              </option>
            ))}
          </select>
        </label>
      )}
      <div className="pin-actions">
        {(['hard', 'soft'] as const).map((kind) => (
          <button
            key={kind}
            className={`button ${picking === kind ? 'primary' : 'secondary'}`}
            disabled={disabled}
            aria-pressed={picking === kind}
            onClick={() => {
              if (tool !== 'pins') useEditor.getState().setTool('pins');
              useEditor.setState({ pinPicking: picking === kind ? null : kind });
            }}
          >
            <Pin size={14} />
            {kind === 'hard' ? 'Pin' : 'Soft pin'}
          </button>
        ))}
      </div>
      <p className="anchor-help" role="status">
        {disabled
          ? 'Choose a visible, unlocked part and reset Explode to edit pins.'
          : picking
            ? `Click the selected part’s surface to place ${picking} pins.`
            : 'Move or rotate the part to feel the resistance. Pins stay active in every movement tool.'}
      </p>
      {picking && (
        <button
          className="button secondary full-width"
          onClick={() => useEditor.setState({ pinPicking: null })}
        >
          Finish placing pins
        </button>
      )}
      {pins.length > 0 && (
        <>
          <div className="anchor-list" aria-label="Part pins">
            {pins.map((pin, i) => (
              <div key={pin.id} className="anchor-row">
                <button
                  className={current?.id === pin.id ? 'active' : ''}
                  aria-pressed={current?.id === pin.id}
                  onClick={() => useEditor.setState({ activePin: pin.id, pinPicking: null })}
                >
                  <span>
                    {pin.kind === 'hard' ? 'Pin' : 'Soft pin'} {i + 1}
                  </span>
                  <span>
                    {pin.kind === 'hard' ? 'Fixed' : `${pin.priority} · ${gaps[i].toFixed(2)} mm`}
                  </span>
                </button>
                <IconButton
                  label={`Remove pin ${i + 1}`}
                  disabled={disabled}
                  onClick={() => useEditor.getState().removePin(part!.id, pin.id)}
                >
                  <Trash2 size={13} />
                </IconButton>
              </div>
            ))}
          </div>
          {current && part && (
            <div className="pin-settings" key={current.id}>
              <label className="anchor-part-label">
                Pin {pins.indexOf(current) + 1} type
                <select
                  aria-label="Pin type"
                  value={current.kind}
                  disabled={disabled}
                  onChange={(e) =>
                    useEditor
                      .getState()
                      .updatePin(part.id, current.id, { kind: e.target.value as 'hard' | 'soft' })
                  }
                >
                  <option value="hard">Hard pin · fixed point</option>
                  <option value="soft">Soft pin · elastic</option>
                </select>
              </label>
              {current.kind === 'soft' ? (
                <>
                  <label className="pin-priority">
                    Priority
                    <NumericInput
                      label="Soft pin priority"
                      value={current.priority}
                      min={0}
                      max={100}
                      step={1}
                      disabled={disabled}
                      onCommit={(priority) =>
                        useEditor.getState().updatePin(part.id, current.id, { priority })
                      }
                    />
                  </label>
                  <input
                    className="pin-slider"
                    type="range"
                    aria-label="Soft pin priority slider"
                    min={0}
                    max={100}
                    step={1}
                    disabled={disabled}
                    value={current.priority}
                    onPointerDown={() => {
                      slider.current = true;
                    }}
                    onPointerUp={() => {
                      slider.current = null;
                    }}
                    onPointerCancel={() => {
                      slider.current = null;
                    }}
                    onBlur={() => {
                      slider.current = null;
                    }}
                    onChange={(e) => {
                      useEditor
                        .getState()
                        .updatePin(
                          part.id,
                          current.id,
                          { priority: Number(e.target.value) },
                          slider.current !== false,
                        );
                      if (slider.current !== null) slider.current = false;
                    }}
                  />
                  <div className="pin-range">
                    <span>0 · free</span>
                    <span>100 · strongest</span>
                  </div>
                  <p className="anchor-help">
                    Stretch: {gaps[pins.indexOf(current)].toFixed(3)} mm. Resistance increases with
                    priority. The part stays where you release it; resting points remain fixed until
                    reset.
                  </p>
                </>
              ) : (
                <p className="anchor-help">
                  One pin allows rotation around its point. Two allow rotation around their shared
                  axis. Three spread-out pins hold the whole pose. Switching a soft pin to hard
                  locks its current surface point.
                </p>
              )}
            </div>
          )}
          <button
            className="button secondary full-width"
            disabled={disabled}
            onClick={() => useEditor.getState().rebasePins(part!.id)}
          >
            Reset resting points
          </button>
          {tool === 'pins' && (
            <div className="pin-actions">
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => useEditor.getState().setTool('translate')}
              >
                <Move3D size={14} />
                Move part
              </button>
              <button
                className="button secondary"
                disabled={disabled}
                onClick={() => useEditor.getState().setTool('rotate')}
              >
                <Rotate3D size={14} />
                Rotate part
              </button>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
