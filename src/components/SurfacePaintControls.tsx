import type { CSSProperties } from 'react';
import { ArrowRight, Check, Eraser, Paintbrush, Plus, Undo2, X } from 'lucide-react';
import { useEditor } from '../core/store';
import { contactColors, completedSurfacePairs } from '../core/surfaces';

export function SurfacePaintControls({
  rms,
  constrained,
}: {
  rms?: number;
  constrained?: boolean;
}) {
  const op = useEditor((s) => s.operation),
    radius = useEditor((s) => s.brushRadius),
    erase = useEditor((s) => s.brushErase),
    history = useEditor((s) => s.paintHistory),
    painting = useEditor((s) => s.painting);
  const complete = completedSurfacePairs(op.surfacePairs).length;
  const active = op.surfacePairs.find((pair) => pair.id === op.activeSurface?.pairId);
  const side = op.activeSurface?.side;
  return (
    <div className="surface-painter">
      <p className="field-help">
        Paint matching contact areas on both parts. Use at least 3 pairs spread across the join.
        Each color connects one moving patch to its target patch.
      </p>
      <div className="paint-brush-modes" role="group" aria-label="Surface brush mode">
        <button
          className={!erase ? 'active' : ''}
          aria-pressed={!erase}
          onClick={() => useEditor.getState().setBrush({ erase: false })}
        >
          <Paintbrush size={14} /> Paint
        </button>
        <button
          className={erase ? 'active' : ''}
          aria-pressed={erase}
          onClick={() => useEditor.getState().setBrush({ erase: true })}
        >
          <Eraser size={14} /> Erase
        </button>
        <button
          title="Undo last paint stroke"
          aria-label="Undo last paint stroke"
          disabled={!history.length}
          onClick={() => useEditor.getState().undoPaintStroke()}
        >
          <Undo2 size={14} />
        </button>
      </div>
      <label className="brush-radius">
        <span>Brush radius</span>
        <input
          aria-label="Brush radius"
          type="number"
          min={0.05}
          max={100}
          step={0.5}
          value={radius}
          onChange={(event) => {
            const value = event.target.valueAsNumber;
            if (Number.isFinite(value)) useEditor.getState().setBrush({ radius: value });
          }}
        />
        <small>mm</small>
      </label>
      <input
        className="brush-radius-slider"
        aria-label="Brush radius slider"
        type="range"
        min={0.1}
        max={20}
        step={0.1}
        value={Math.min(radius, 20)}
        onChange={(event) => useEditor.getState().setBrush({ radius: Number(event.target.value) })}
      />
      <div className="surface-pair-list">
        {op.surfacePairs.map((pair, i) => (
          <div
            className="surface-pair"
            key={pair.id}
            style={{ '--pair-color': contactColors[i % contactColors.length] } as CSSProperties}
          >
            <span className="surface-pair-number">{i + 1}</span>
            {(['source', 'target'] as const).map((current) => (
              <button
                key={current}
                className={`surface-patch-button ${op.activeSurface?.pairId === pair.id && side === current ? 'active' : ''}`}
                aria-label={`Paint ${current === 'source' ? 'moving' : 'target'} surface pair ${i + 1}`}
                aria-pressed={op.activeSurface?.pairId === pair.id && side === current}
                disabled={current === 'target' && !pair.source?.faces.length}
                onClick={() => useEditor.getState().chooseSurface(pair.id, current)}
              >
                <span>
                  {current === 'source' ? 'Moving' : 'Target'}
                  {pair[current]?.faces.length ? <Check size={11} /> : null}
                </span>
                <small>
                  {pair[current]?.faces.length
                    ? `${pair[current]!.faces.length.toLocaleString()} triangles`
                    : 'Paint patch'}
                </small>
              </button>
            ))}
            <button
              className="remove-surface-pair"
              aria-label={`Remove surface pair ${i + 1}`}
              title="Remove surface pair"
              onClick={() =>
                useEditor.getState().setOperation({
                  surfacePairs: op.surfacePairs.filter((entry) => entry.id !== pair.id),
                  activeSurface: op.activeSurface?.pairId === pair.id ? null : op.activeSurface,
                })
              }
            >
              <X size={13} />
            </button>
          </div>
        ))}
      </div>
      {active && side ? (
        <div className="paint-next-step" role="status">
          <span>
            {erase ? 'Erase' : 'Paint'} the {side === 'source' ? 'moving' : 'target'} patch for pair{' '}
            {op.surfacePairs.indexOf(active) + 1}.
          </span>
          <button
            className="button secondary full-width"
            disabled={!active[side]?.faces.length || painting}
            onClick={() =>
              side === 'source'
                ? useEditor.getState().chooseSurface(active.id, 'target')
                : useEditor.getState().setOperation({ activeSurface: null })
            }
          >
            {side === 'source' ? 'Next: paint target' : 'Finish pair'}
            <ArrowRight size={13} />
          </button>
        </div>
      ) : null}
      <button
        className="button secondary full-width add-surface-pair"
        disabled={complete < op.surfacePairs.length}
        onClick={() => useEditor.getState().addSurfacePair()}
      >
        <Plus size={14} /> Add surface pair
      </button>
      <div className="fit-summary" role="status">
        <span>
          {complete} complete surface {complete === 1 ? 'pair' : 'pairs'}
        </span>
        <strong>
          {painting
            ? 'Painting…'
            : complete < 3
              ? `${3 - complete} more required`
              : complete < op.surfacePairs.length
                ? 'Finish the incomplete pair'
                : 'Add another pair or fit'}
        </strong>
        {rms !== undefined && !painting ? (
          <output aria-label="Surface contact RMS error">
            {rms.toFixed(3)} mm contact RMS{constrained ? ' · constrained' : ''}
          </output>
        ) : null}
      </div>
      <p className="field-help paint-navigation-hint">
        Drag to paint whole mesh triangles. Hold Alt to erase. O orbits, H pans, Esc returns to
        painting. [ and ] resize the brush.
      </p>
    </div>
  );
}
