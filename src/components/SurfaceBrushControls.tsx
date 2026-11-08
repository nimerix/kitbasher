import { Eraser, Paintbrush, Undo2 } from 'lucide-react';
import { useEditor } from '../core/store';
import { NumericInput } from './ui';

export function SurfaceBrushControls() {
  const radius = useEditor((state) => state.brushRadius),
    erase = useEditor((state) => state.brushErase),
    history = useEditor((state) => state.paintHistory),
    plane = useEditor((state) => state.brushPlane);
  return (
    <>
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
        <NumericInput
          label="Brush radius"
          value={radius}
          min={0.05}
          max={100}
          step={0.5}
          onCommit={(value) => useEditor.getState().setBrush({ radius: value })}
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
      <div className="plane-brush-settings">
        <div className="appearance-row">
          <span>Stay on seed plane</span>
          <button
            role="switch"
            aria-label="Restrict brush to seed plane"
            aria-checked={plane.enabled}
            className={`toggle ${plane.enabled ? 'on' : ''}`}
            onClick={() => useEditor.getState().setBrush({ plane: { enabled: !plane.enabled } })}
          >
            <span />
          </button>
        </div>
        {plane.enabled ? (
          <>
            <label className="brush-radius">
              <span>Normal tolerance</span>
              <NumericInput
                label="Brush plane angle tolerance"
                value={plane.angle}
                min={0}
                max={90}
                onCommit={(angle) => useEditor.getState().setBrush({ plane: { angle } })}
              />
              <small>°</small>
            </label>
            <label className="brush-radius">
              <span>Plane tolerance</span>
              <NumericInput
                label="Brush plane distance tolerance"
                value={plane.distance}
                min={0}
                max={100}
                step={0.1}
                onCommit={(distance) => useEditor.getState().setBrush({ plane: { distance } })}
              />
              <small>mm</small>
            </label>
            <p className="field-help">
              Measured from this patch’s first hit. Clear a patch to choose a new seed plane.
            </p>
          </>
        ) : null}
      </div>
    </>
  );
}
