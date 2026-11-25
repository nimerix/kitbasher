import { useShallow } from 'zustand/react/shallow';
import type { ReactNode } from 'react';
import { Eraser, Paintbrush, Undo2 } from 'lucide-react';
import { useEditor, paintingRefine, paintingWarpRegion } from '../core/store';
import { activeBrush, contactBrush, refineBrush, type EditorBrush } from '../core/editor-brush';
import { useSliderEdit } from '../hooks/useSliderEdit';
import { LogRangeInput, NumericInput } from './ui';

function PaintSettings({ full, children }: { full: boolean; children: ReactNode }) {
  const erase = useEditor((state) => state.brushErase),
    history = useEditor((state) => state.paintHistory),
    plane = useEditor((state) => state.brushPlane);
  return (
    <>
      <div
        className={full ? 'paint-brush-modes' : 'paint-brush-modes without-undo'}
        role="group"
        aria-label="Surface brush mode"
      >
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
        {full ? (
          <button
            title="Undo last paint stroke"
            aria-label="Undo last paint stroke"
            disabled={!history.length}
            onClick={() => useEditor.getState().undoPaintStroke()}
          >
            <Undo2 size={14} />
          </button>
        ) : null}
      </div>
      {children}
      {full ? (
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
      ) : null}
    </>
  );
}

function RadiusFields({
  brush,
  label,
  draft,
  onSlide,
}: {
  brush: EditorBrush;
  label: string;
  draft?: number | null;
  onSlide?: (radius: number) => void;
}) {
  const radius = useEditor(brush.radius);
  const range = useEditor(useShallow(brush.slider));
  const set = (radius: number) => brush.setRadius(useEditor.getState(), radius);
  const shown = draft ?? radius;
  const slide = onSlide ?? set;
  return (
    <>
      <label className="brush-radius">
        <span>{label}</span>
        <NumericInput
          label={label}
          value={shown}
          min={brush.limits.min}
          max={brush.limits.max}
          step={brush.step}
          onCommit={set}
        />
        <small>mm</small>
      </label>
      {range.scale === 'linear' ? (
        <input
          className="brush-radius-slider"
          aria-label="Brush radius slider"
          type="range"
          min={range.min}
          max={range.max}
          step={0.1}
          value={Math.min(shown, range.max)}
          onChange={(event) => slide(Number(event.target.value))}
        />
      ) : (
        <LogRangeInput
          className="brush-radius-slider"
          label="Brush radius slider"
          value={shown}
          min={range.min}
          max={range.max}
          onChange={slide}
        />
      )}
    </>
  );
}

function RefineRadius({ partId }: { partId: string }) {
  const slider = useSliderEdit({
    owned: () => useEditor.getState().refine?.partId === partId,
    onSet: (value) => refineBrush.setRadius(useEditor.getState(), value),
  });
  return (
    <div
      className="refine-brush-radius"
      ref={slider.row}
      onPointerDown={slider.onPointerDown}
      onKeyDown={slider.onKeyDown}
    >
      <RadiusFields
        brush={refineBrush}
        label="Brush radius"
        draft={slider.draft}
        onSlide={slider.change}
      />
    </div>
  );
}

/** The inspector and the viewport popup edit the same active brush. */
export function BrushSettings({ label = 'Brush radius' }: { label?: string }) {
  const brush = useEditor(activeBrush);
  const painting = useEditor((state) => paintingWarpRegion(state) || paintingRefine(state));
  const refinePart = useEditor((state) => state.refine?.partId);
  if (!brush) return null;
  const fields =
    brush === refineBrush && refinePart ? (
      <RefineRadius key={refinePart} partId={refinePart} />
    ) : (
      <RadiusFields brush={brush} label={label} />
    );
  return painting || brush === contactBrush ? (
    <PaintSettings full={brush !== refineBrush}>{fields}</PaintSettings>
  ) : (
    fields
  );
}
