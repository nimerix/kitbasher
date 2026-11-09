import { Crosshair, Trash2 } from 'lucide-react';
import { anchorGaps } from '../core/anchor-fit';
import { useEditor } from '../core/store';
import type { Vec3 } from '../core/types';
import { IconButton, NumericInput, Section } from './ui';

export function AnchorControls() {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected);
  const active = useEditor((s) => s.activeAnchor),
    picking = useEditor((s) => s.anchorPicking);
  const exploded = useEditor((s) => s.view.explode > 0);
  const part = scene.parts.find((p) => p.id === selected[0]);
  const anchors = part?.anchors ?? [];
  const current = anchors.find((a) => a.id === active) ?? anchors[0];
  const disabled = !part || part.locked || !part.visible || exploded;
  const gaps = part ? anchorGaps(part) : [];
  const rms = Math.sqrt(gaps.reduce((sum, gap) => sum + gap * gap, 0) / (gaps.length || 1));
  return (
    <div className="anchor-controls">
      <Section title="Rigid anchor fit">
        <p className="anchor-help">
          Place anchors around the interface. Move one target to fit the part while the other
          targets stay in place. The part only moves and rotates.
        </p>
        <label className="anchor-part-label">
          Moving part
          <select
            aria-label="Anchor moving part"
            value={part?.id ?? ''}
            onChange={(e) => {
              useEditor.getState().select(e.target.value || null);
              useEditor.setState({ activeAnchor: null, anchorPicking: false });
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
        <button
          className={`button ${picking ? 'primary' : 'secondary'} full-width`}
          disabled={disabled}
          aria-pressed={picking}
          onClick={() => useEditor.setState({ anchorPicking: !picking })}
        >
          <Crosshair size={14} />
          {picking ? 'Finish adding anchors' : 'Add anchors on surface'}
        </button>
        <p className="anchor-help">
          {disabled
            ? 'Choose a visible, unlocked part and reset Explode to edit anchors.'
            : picking
              ? 'Click the moving part to add points. Spread three anchors around its interface, then finish adding.'
              : 'Select a numbered anchor and drag its XYZ handle. Hold Shift for 10× finer movement.'}
        </p>
        {anchors.length > 0 && (
          <>
            <div className="anchor-list" aria-label="Fit anchors">
              {anchors.map((anchor, i) => (
                <div key={anchor.id} className="anchor-row">
                  <button
                    className={current?.id === anchor.id ? 'active' : ''}
                    aria-pressed={current?.id === anchor.id}
                    onClick={() =>
                      useEditor.setState({ activeAnchor: anchor.id, anchorPicking: false })
                    }
                  >
                    <span>Anchor {i + 1}</span>
                    <span>{gaps[i].toFixed(3)} mm</span>
                  </button>
                  <IconButton
                    label={`Remove anchor ${i + 1}`}
                    disabled={disabled}
                    onClick={() => useEditor.getState().removeFitAnchor(part!.id, anchor.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            </div>
            <p className="anchor-help" role="status">
              Fit gap: {rms.toFixed(3)} mm RMS. Lines show the gap between each surface point and
              its target.
            </p>
          </>
        )}
      </Section>
      {current && part && (
        <Section title={`Anchor ${anchors.indexOf(current) + 1} target · world mm`}>
          <div className="anchor-coordinates">
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <label key={axis}>
                {axis}
                <NumericInput
                  label={`Anchor target ${axis}`}
                  value={current.target[i]}
                  step={0.01}
                  disabled={disabled}
                  onCommit={(value) => {
                    const target: Vec3 = [...current.target];
                    target[i] = value;
                    useEditor.getState().moveFitAnchor(part.id, current.id, target);
                  }}
                />
              </label>
            ))}
          </div>
          <p className="anchor-help">
            Targets are balanced equally. Incompatible targets leave a gap; the mesh never
            stretches. Existing joints and plane constraints still apply.
          </p>
          <button
            className="button secondary full-width"
            disabled={disabled}
            onClick={() => useEditor.getState().rebaseFitAnchors(part.id)}
          >
            Hold current positions
          </button>
          <p className="anchor-help">
            Set all targets to the part’s current position before starting another adjustment.
          </p>
        </Section>
      )}
    </div>
  );
}
