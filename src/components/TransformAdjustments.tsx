import { useMemo } from 'react';
import {
  Crosshair,
  Info,
  Magnet,
  Minus,
  Move3D,
  Move,
  Plus,
  Rotate3D,
  Scaling,
} from 'lucide-react';
import { chooseTransformTool, stepSelection } from '../core/commands';
import { useEditor } from '../core/store';
import { usePreferences, useShortcut, withShortcut } from '../core/preferences';
import { activeTransformTool, transformSelection } from '../core/transform-selection';
import { NumericInput } from './ui';

export const moveSteps = [0.01, 0.1, 0.5, 1, 5, 10];
export const rotationSteps = [0.1, 1, 5, 15, 45, 90];

export function TransformAdjustments() {
  const scaling = usePreferences((s) => s.transform.scaling);
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    view = useEditor((s) => s.view),
    isolated = useEditor((s) => s.isolated),
    nearbyParts = useEditor((s) => s.nearbyParts),
    pivotPicking = useEditor((s) => s.pivotPicking),
    navigationMode = useEditor((s) => s.navigationMode),
    temporaryOrbit = useEditor((s) => s.temporaryOrbit),
    editorTool = useEditor((s) => s.tool),
    warp = useEditor((s) => s.warp),
    tool = useEditor(activeTransformTool);
  const moveKey = useShortcut('move'),
    rotateKey = useShortcut('rotate'),
    scaleKey = useShortcut('scale'),
    freeMoveKey = useShortcut('freeMove'),
    freeRotateKey = useShortcut('freeRotate');
  const transformKey = useShortcut('transform');
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
          tool: editorTool,
          warp,
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
      editorTool,
      warp,
      tool,
    ],
  );
  const active = tool === 'translate' || tool === 'rotate';
  const rotating = tool === 'rotate',
    unit = rotating ? '°' : 'mm';
  const points = selection.kind === 'warp';
  // A control point has no orientation or size of its own.
  const single = points && selection.parts.length === 1;
  const needsTwo = 'Rotate and scale need two or more control points.';
  const step = rotating ? view.rotationSnapStep : view.snapStep;
  return (
    <div className="transform-adjustments">
      <div
        className={points ? 'transform-mode-buttons with-scale' : 'transform-mode-buttons'}
        role="group"
        aria-label="Transform tool"
      >
        {(
          [
            ['transform', 'Transform', Move, transformKey],
            ['translate', 'Move', Move3D, moveKey],
            ['rotate', 'Rotate', Rotate3D, rotateKey],
            // The toolbar's Scale would leave the warp, so points choose it here.
            ...(points ? ([['scale', 'Scale', Scaling, scaleKey]] as const) : []),
          ] as const
        ).map(([mode, label, Icon, key]) => (
          <button
            key={mode}
            data-combined={mode === 'transform' ? true : undefined}
            aria-pressed={tool === mode}
            title={withShortcut(label, key)}
            onClick={() => chooseTransformTool(mode)}
          >
            <Icon size={15} aria-hidden="true" /> {label} {key ? <kbd>{key}</kbd> : null}
          </button>
        ))}
      </div>
      {tool === 'transform' ? (
        <div className="combined-transform-options">
          <label className="transform-scale-option">
            <input
              type="checkbox"
              checked={scaling}
              onChange={(event) =>
                usePreferences.getState().setTransformScaling(event.target.checked)
              }
            />{' '}
            Enable scaling
          </label>
          <p className="transform-help">
            Drag an arrow to move, a ring to rotate{scaling ? ', or a cube to scale' : ''}.{' '}
            {!single && !selection.locks?.some(Boolean)
              ? 'The outer ring rotates in the plane of the viewport.'
              : null}
          </p>
          <p className="transform-help">
            Shift: fine adjustment · Uses Snap and the selected pivot.
          </p>
          <div className="transform-setting-row">
            <span>Move snap</span>
            <div className="transform-step-input">
              <NumericInput
                label="Transform move snap"
                value={view.snapStep}
                min={0.001}
                step={0.1}
                onCommit={(snapStep) => useEditor.getState().setView({ snapStep })}
              />
              <span>mm</span>
            </div>
          </div>
          <div className="transform-setting-row">
            <span>Rotation snap</span>
            <div className="transform-step-input">
              <NumericInput
                label="Transform rotation snap"
                value={view.rotationSnapStep}
                min={0.001}
                max={180}
                onCommit={(rotationSnapStep) => useEditor.getState().setView({ rotationSnapStep })}
              />
              <span>°</span>
            </div>
          </div>
          {selection.blocked || single ? (
            <p className="transform-help" role="status">
              {selection.blocked ?? needsTwo}
            </p>
          ) : null}
        </div>
      ) : null}
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
                disabled={
                  space === 'local' && (selection.parts.length > 1 || selection.kind === 'warp')
                }
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
            ? points
              ? 'Selected points move together in world axes.'
              : 'Groups use world axes and move together.'
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
                    disabled={!!selection.blocked || !!selection.locks?.[i] || (rotating && single)}
                    aria-label={`${rotating ? 'Rotate' : 'Move'} ${axis} ${direction < 0 ? 'negative' : 'positive'}`}
                    title={`${direction < 0 ? '−' : '+'}${step} ${unit} on ${axis}`}
                    onClick={() => stepSelection(i as 0 | 1 | 2, direction)}
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
            {selection.blocked || (rotating && single) ? (
              <>
                <Info size={13} aria-hidden="true" />
                <span>{selection.blocked ?? needsTwo}</span>
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
      {tool === 'scale' && points ? (
        <p className="transform-help transform-availability" role="status">
          {selection.blocked ??
            (single ? needsTwo : 'Drag a scale handle to spread or gather the selected points.')}
        </p>
      ) : null}
    </div>
  );
}
