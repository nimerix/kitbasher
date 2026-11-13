import { useMemo } from 'react';
import { Crosshair, Info, Magnet, Minus, Move3D, Plus, Rotate3D } from 'lucide-react';
import { useEditor } from '../core/store';
import { useShortcut, withShortcut } from '../core/preferences';
import { stepTransform, transformSelection } from '../core/transform-selection';
import { NumericInput } from './ui';

export const moveSteps = [0.01, 0.1, 0.5, 1, 5, 10];
export const rotationSteps = [0.1, 1, 5, 15, 45, 90];

export function TransformAdjustments() {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    view = useEditor((s) => s.view),
    isolated = useEditor((s) => s.isolated),
    nearbyParts = useEditor((s) => s.nearbyParts),
    pivotPicking = useEditor((s) => s.pivotPicking),
    navigationMode = useEditor((s) => s.navigationMode),
    temporaryOrbit = useEditor((s) => s.temporaryOrbit),
    tool = useEditor((s) => s.tool);
  const moveKey = useShortcut('move'),
    rotateKey = useShortcut('rotate'),
    freeMoveKey = useShortcut('freeMove'),
    freeRotateKey = useShortcut('freeRotate');
  const selection = useMemo(
    () =>
      transformSelection(
        {
          scene,
          selected,
          view,
          isolated,
          nearbyParts,
          pivotPicking,
          navigationMode,
          temporaryOrbit,
        },
        tool,
      ),
    [
      scene,
      selected,
      view,
      isolated,
      nearbyParts,
      pivotPicking,
      navigationMode,
      temporaryOrbit,
      tool,
    ],
  );
  const active = tool === 'translate' || tool === 'rotate';
  const rotating = tool === 'rotate',
    unit = rotating ? '°' : 'mm';
  const step = rotating ? view.rotationSnapStep : view.snapStep;
  const adjust = (axis: 0 | 1 | 2, direction: number) => {
    // Read fresh state so rapid repeated clicks always start from the last accepted pose.
    const state = useEditor.getState();
    if (state.tool !== 'translate' && state.tool !== 'rotate') return;
    const amount = state.tool === 'rotate' ? state.view.rotationSnapStep : state.view.snapStep;
    const patches = stepTransform(
      transformSelection(state, state.tool),
      state.tool,
      axis,
      direction * amount,
    );
    if (patches.length) state.transformMany(patches, true, state.tool === 'translate', true);
  };
  return (
    <div className="transform-adjustments">
      <div className="transform-mode-buttons" role="group" aria-label="Transform tool">
        {(
          [
            ['translate', 'Move', Move3D, moveKey],
            ['rotate', 'Rotate', Rotate3D, rotateKey],
          ] as const
        ).map(([mode, label, Icon, key]) => (
          <button
            key={mode}
            aria-pressed={tool === mode}
            title={withShortcut(label, key)}
            onClick={() => useEditor.getState().setTool(mode)}
          >
            <Icon size={15} aria-hidden="true" /> {label} {key ? <kbd>{key}</kbd> : null}
          </button>
        ))}
      </div>
      {freeMoveKey || freeRotateKey ? (
        <p className="transform-help free-transform-shortcuts">
          Free with pointer:
          {freeMoveKey ? (
            <span>
              {' '}
              <kbd>{freeMoveKey}</kbd> move
            </span>
          ) : null}
          {freeRotateKey ? (
            <span>
              {' '}
              <kbd>{freeRotateKey}</kbd> rotate
            </span>
          ) : null}
        </p>
      ) : null}
      <div className="transform-setting-row">
        <span>Axes</span>
        {selection.axes === 'joint' ? (
          <strong>Joint axes</strong>
        ) : (
          <div className="coordinate-switch" role="group" aria-label="Handle and step axes">
            {(['world', 'local'] as const).map((space) => (
              <button
                key={space}
                aria-pressed={selection.axes === space}
                disabled={space === 'local' && selection.parts.length > 1}
                onClick={() => useEditor.getState().setView({ space })}
              >
                {space === 'world' ? 'World' : 'Local'}
              </button>
            ))}
          </div>
        )}
      </div>
      <p className="transform-help">
        {selection.axes === 'joint'
          ? 'Handles and steps follow the connected joint.'
          : selection.parts.length > 1
            ? 'Groups use world axes and move together.'
            : selection.axes === 'local'
              ? 'Handles and steps follow the part’s orientation.'
              : 'Handles and steps follow the scene’s fixed axes.'}
      </p>
      {active ? (
        <>
          <div className="transform-setting-row">
            <label htmlFor={rotating ? 'rotation-step' : 'move-step'}>Step</label>
            <div className="transform-step-input">
              <NumericInput
                key={tool}
                id={rotating ? 'rotation-step' : 'move-step'}
                label={rotating ? 'Rotation step' : 'Move step'}
                value={step}
                min={0.001}
                max={rotating ? 180 : undefined}
                step={rotating ? 1 : 0.1}
                onCommit={(value) =>
                  useEditor
                    .getState()
                    .setView(rotating ? { rotationSnapStep: value } : { snapStep: value })
                }
              />
              <span>{unit}</span>
            </div>
            <button
              className="transform-snap"
              aria-label="Snap dragging"
              aria-pressed={view.snap}
              title="Use this step when dragging handles"
              onClick={() => useEditor.getState().setView({ snap: !view.snap })}
            >
              <Magnet size={13} aria-hidden="true" /> Snap {view.snap ? 'on' : 'off'}
            </button>
          </div>
          <div
            className="transform-step-buttons"
            role="group"
            aria-label={rotating ? 'Rotate by step' : 'Move by step'}
          >
            {(['X', 'Y', 'Z'] as const).map((axis, i) => (
              <div key={axis} className={`transform-axis axis-${axis.toLowerCase()}`}>
                <span className={`axis-letter axis-${axis.toLowerCase()}`}>{axis}</span>
                {([-1, 1] as const).map((direction) => (
                  <button
                    key={direction}
                    disabled={!!selection.blocked || !!selection.locks?.[i]}
                    aria-label={`${rotating ? 'Rotate' : 'Move'} ${axis} ${direction < 0 ? 'negative' : 'positive'}`}
                    title={`${direction < 0 ? '−' : '+'}${step} ${unit} on ${axis}`}
                    onClick={() => adjust(i as 0 | 1 | 2, direction)}
                  >
                    {direction < 0 ? (
                      <Minus size={14} aria-hidden="true" />
                    ) : (
                      <Plus size={14} aria-hidden="true" />
                    )}
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p className="transform-help">
            Each − / + adjusts by {step} {unit}. Hold Shift for 10× finer dragging.
          </p>
          {rotating && selection.parts.length ? (
            <p className="transform-pivot">
              <Crosshair size={12} aria-hidden="true" /> Pivot: {selection.pivotLabel.toLowerCase()}
            </p>
          ) : null}
          <div role="status" className="transform-availability">
            {selection.blocked ? (
              <>
                <Info size={13} aria-hidden="true" />
                <span>{selection.blocked}</span>
              </>
            ) : selection.skipped ? (
              <span>
                Adjusting {selection.parts.length} of {selected.length} selected parts. Connections
                and locks still apply.
              </span>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
