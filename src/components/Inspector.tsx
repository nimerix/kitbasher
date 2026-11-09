import { AnchorControls } from './AnchorControls';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Box,
  Check,
  CheckCheck,
  ChevronDown,
  Copy,
  Crosshair,
  ExternalLink,
  Info,
  Link2,
  LockKeyhole,
  MousePointer2,
  Pencil,
  ScanLine,
  Settings2,
  SlidersHorizontal,
  Trash2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import { Euler, Quaternion, Vector3 } from 'three';
import { useEditor } from '../core/store';
import { useShortcut } from '../core/preferences';
import { isJointConnected, translationIsPinned } from '../core/constraints';
import { solveAlignment } from '../core/alignment';
import {
  degrees,
  quat,
  poseAtPivot,
  radians,
  rotationDegrees,
  sceneBounds,
  triangleCount,
} from '../core/geometry';
import { referencePlanes } from '../core/references';
import type { AlignmentMode, AxisLocks, Part, Vec3 } from '../core/types';
import { completedSurfacePairs } from '../core/surfaces';
import { SurfacePaintControls } from './SurfacePaintControls';
import { planeKindLabels } from '../core/plane-constraints';
import { IconButton, NumericInput, Section } from './ui';

function VectorFields({
  label,
  values,
  onCommit,
  disabled = false,
  locks,
  unit,
  step = 1,
  min,
}: {
  label: string;
  values: Vec3;
  onCommit: (values: Vec3) => void;
  disabled?: boolean;
  locks?: AxisLocks;
  unit?: string;
  step?: number;
  min?: number;
}) {
  return (
    <div className="vector-control">
      <div className="field-label">
        <span>{label}</span>
        <small>{unit}</small>
      </div>
      <div className="vector-fields">
        {(['X', 'Y', 'Z'] as const).map((axis, i) => (
          <label
            key={axis}
            className={`axis-field axis-${axis.toLowerCase()} ${disabled || locks?.[i] ? 'disabled' : ''}`}
          >
            <span>{axis}</span>
            <NumericInput
              label={`${label} ${axis}`}
              value={values[i]}
              step={step}
              min={min}
              disabled={disabled || locks?.[i]}
              onCommit={(value) => {
                const next = [...values] as Vec3;
                next[i] = value;
                onCommit(next);
              }}
            />
            {locks?.[i] ? <LockKeyhole size={9} /> : null}
          </label>
        ))}
      </div>
    </div>
  );
}

export function RotationLocks({
  locks,
  onChange,
  disabled = false,
}: {
  locks: AxisLocks;
  onChange: (locks: AxisLocks) => void;
  disabled?: boolean;
}) {
  return (
    <div className="rotation-locks">
      {(['X', 'Y', 'Z'] as const).map((axis, i) => (
        <button
          key={axis}
          className={locks[i] ? 'locked' : ''}
          aria-label={`${axis} rotation ${locks[i] ? 'locked' : 'free'}`}
          aria-pressed={locks[i]}
          disabled={disabled}
          onClick={() => {
            const next = [...locks] as AxisLocks;
            next[i] = !next[i];
            onChange(next);
          }}
        >
          <span className={`axis-letter axis-${axis.toLowerCase()}`}>{axis}</span>
          {locks[i] ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}
          <span>{locks[i] ? 'Locked' : 'Free'}</span>
        </button>
      ))}
    </div>
  );
}

function KeepConnectedToggle({
  enabled,
  onChange,
}: {
  enabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <div className="appearance-row connection-toggle">
      <span>
        <Link2 size={13} /> Keep connected
      </span>
      <button
        className={`toggle ${enabled ? 'on' : ''}`}
        role="switch"
        aria-label="Keep connected"
        aria-checked={enabled}
        onClick={() => onChange(!enabled)}
      >
        <span />
      </button>
    </div>
  );
}

function PartColorInput({ part }: { part: Part }) {
  const input = useRef<HTMLInputElement>(null);
  const editing = useRef(false);
  useEffect(() => {
    // React's onChange fires throughout a picker drag. Only the native change event ends it.
    const element = input.current!;
    const finish = () => {
      editing.current = false;
    };
    element.addEventListener('change', finish);
    return () => element.removeEventListener('change', finish);
  }, []);
  return (
    <input
      ref={input}
      aria-label="Part material color"
      type="color"
      value={part.color}
      onChange={(e) => {
        useEditor.getState().patchParts([part.id], { color: e.target.value }, !editing.current);
        editing.current = true;
      }}
    />
  );
}

function PartProperties({ part }: { part: Part }) {
  const pivotKey = useShortcut('pivot'),
    jointKey = useShortcut('joint');
  const joints = useEditor((s) => s.scene.joints),
    parts = useEditor((s) => s.scene.parts),
    view = useEditor((s) => s.view),
    transform = useEditor((s) => s.transform),
    patchParts = useEditor((s) => s.patchParts);
  const joint = joints.find((j) => j.childId === part.id),
    children = joints.filter((j) => j.parentId === part.id);
  const activeJoint = joint && isJointConnected(joint) ? joint : undefined;
  const pinned = translationIsPinned(parts, joints, part.id);
  const parent = activeJoint ? parts.find((p) => p.id === activeJoint.parentId) : undefined;
  const jointBase =
    activeJoint && parent ? quat(parent.quaternion).multiply(quat(activeJoint.restRotation)) : null;
  const localRotation = jointBase
    ? new Euler().setFromQuaternion(jointBase.clone().invert().multiply(quat(part.quaternion)))
    : null;
  const rotation: Vec3 = localRotation
    ? [degrees(localRotation.x), degrees(localRotation.y), degrees(localRotation.z)]
    : rotationDegrees(part);
  const size = sceneBounds([{ ...part, visible: true }]).getSize(new Vector3());
  const [editing, setEditing] = useState(false),
    [name, setName] = useState(part.name);
  const cancelRename = useRef(false);
  useEffect(() => {
    setName(part.name);
    setEditing(false);
  }, [part.id, part.name]);
  return (
    <>
      <div className="selected-part-heading">
        <div className="selected-part-icon">
          <Box size={27} strokeWidth={1.25} />
        </div>
        <div>
          <span className="eyebrow">SELECTED PART</span>
          {editing ? (
            <input
              autoFocus
              aria-label="Part name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => {
                if (!cancelRename.current && name.trim())
                  patchParts([part.id], { name: name.trim() });
                else setName(part.name);
                cancelRename.current = false;
                setEditing(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') cancelRename.current = true;
                if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
              }}
            />
          ) : (
            <button className="part-name-button" onClick={() => setEditing(true)}>
              <h2>{part.name}</h2>
              <Pencil size={11} />
            </button>
          )}
          <small>
            Mesh object <span>·</span>{' '}
            {part.source.includes('sample') ? 'Sample part' : part.source}
          </small>
        </div>
      </div>
      <Section
        title="Transform"
        action={
          <div className="coordinate-switch">
            <button
              className={view.space === 'world' ? 'active' : ''}
              onClick={() => useEditor.getState().setView({ space: 'world' })}
            >
              World
            </button>
            <button
              className={view.space === 'local' ? 'active' : ''}
              onClick={() => useEditor.getState().setView({ space: 'local' })}
            >
              Local
            </button>
          </div>
        }
      >
        <VectorFields
          label="Position"
          unit="mm"
          values={part.position}
          disabled={pinned}
          onCommit={(position) => transform(part.id, { position })}
        />
        <VectorFields
          label="Rotation"
          unit={activeJoint ? '° · joint axes' : '°'}
          values={rotation}
          disabled={part.locked}
          locks={activeJoint?.rotationLocks}
          onCommit={(values) => {
            const requested = new Quaternion().setFromEuler(
              new Euler(...(values.map(radians) as Vec3)),
            );
            transform(
              part.id,
              poseAtPivot(
                part,
                {
                  quaternion: (jointBase
                    ? jointBase.clone().multiply(requested)
                    : requested
                  ).toArray(),
                },
                activeJoint?.childAnchor,
              ),
            );
          }}
        />
        <VectorFields
          label="Scale"
          values={part.scale}
          step={0.1}
          min={0.001}
          disabled={part.locked}
          onCommit={(scale) =>
            transform(part.id, poseAtPivot(part, { scale }, activeJoint?.childAnchor))
          }
        />
        <div className="part-pivot-controls">
          <div className="field-label">
            <span>Pivot point</span>
            <small>{part.pivot ? 'Custom' : 'Mesh center'}</small>
          </div>
          <button
            className="button secondary full-width"
            onClick={() => useEditor.getState().setPivotPicking(true)}
          >
            Pick pivot on model {pivotKey ? <kbd>{pivotKey}</kbd> : null}
          </button>
          {part.pivot ? (
            <button
              className="reset-pivot-button"
              onClick={() => useEditor.getState().clearPartPivot(part.id)}
            >
              Reset pivot to mesh center
            </button>
          ) : null}
          <p className="field-help">
            {activeJoint
              ? 'The custom point controls camera orbit. This connected joint keeps its rotation anchor.'
              : 'Rotate, scale, and orbit around a clicked surface point. The pivot follows this part and is saved with the scene.'}
          </p>
        </div>
        {part.locked ? (
          <div className="inline-note">
            <LockKeyhole size={12} />
            <span>This part is locked in place.</span>
            <button onClick={() => patchParts([part.id], { locked: false })}>Unlock</button>
          </div>
        ) : activeJoint || pinned ? (
          <div className="inline-note">
            <Link2 size={12} />
            <span>
              {pinned
                ? 'A fixed connected part pins this anchor. Rotate on a free axis or turn Keep connected off.'
                : 'Move carries the connected assembly. Rotate pivots at this joint.'}
            </span>
          </div>
        ) : (
          <div className="transform-note">
            <MousePointer2 size={11} /> Use a tool or enter precise values.
          </div>
        )}
      </Section>
      <Section
        title="Connections"
        action={<span className="tiny-count">{(joint ? 1 : 0) + children.length}</span>}
      >
        {joint ? (
          <div className="joint-detail">
            <div className="field-label">
              <span>Parent joint</span>
              <button
                title="Remove joint"
                onClick={() => useEditor.getState().removeJoint(joint.id)}
              >
                <Trash2 size={12} />
              </button>
            </div>
            <div className="connection-name">
              <span className="connection-dot" />
              <span>{parts.find((p) => p.id === joint.parentId)?.name}</span>
              <Link2 size={13} />
            </div>
            <KeepConnectedToggle
              enabled={isJointConnected(joint)}
              onChange={(keepConnected) =>
                useEditor.getState().updateJoint(joint.id, { keepConnected })
              }
            />
            <div className="field-label rotation-lock-label">
              <span>Rotation constraints</span>
            </div>
            <RotationLocks
              locks={joint.rotationLocks}
              disabled={!activeJoint}
              onChange={(rotationLocks) =>
                useEditor.getState().updateJoint(joint.id, { rotationLocks })
              }
            />
            <p className="field-help">
              {activeJoint
                ? 'Anchors stay together during move, rotate, scale, and alignment. Rotation locks use the joint axes.'
                : 'Connection paused. Move, rotate, and align freely. Turning this on seats the child anchor at its parent again.'}
            </p>
          </div>
        ) : (
          <p className="muted-description">
            Connect this part to another with a fixed or rotating joint.
          </p>
        )}
        {children.length ? (
          <div className="child-connections">
            {children.map((j) => (
              <button key={j.id} onClick={() => useEditor.getState().select(j.childId)}>
                <Link2 size={12} />
                <span>{parts.find((p) => p.id === j.childId)?.name}</span>
                <ExternalLink size={10} />
              </button>
            ))}
          </div>
        ) : null}
        <button
          className="button secondary full-width create-joint-button"
          onClick={() => useEditor.getState().setTool('joint')}
        >
          <PlusJointIcon />
          Create joint{jointKey ? <span className="shortcut-text">{jointKey}</span> : null}
        </button>
      </Section>
      <Section title="Appearance">
        <div className="appearance-row">
          <span>Material tint</span>
          <label className="color-control">
            <PartColorInput key={part.id} part={part} />
            <span>{part.color.toUpperCase()}</span>
            <ChevronDown size={11} />
          </label>
        </div>
        <div className="appearance-row">
          <span>Visibility</span>
          <button
            className={`toggle ${part.visible ? 'on' : ''}`}
            role="switch"
            aria-checked={part.visible}
            aria-label="Part visible"
            onClick={() => patchParts([part.id], { visible: !part.visible })}
          >
            <span />
          </button>
        </div>
      </Section>
      <Section title="Mesh details">
        <div className="detail-grid">
          <span>Dimensions</span>
          <span>
            {size
              .toArray()
              .map((n) => n.toFixed(1))
              .join(' × ')}{' '}
            <small>mm</small>
          </span>
          <span>Vertices</span>
          <span>{part.geometry.getAttribute('position').count.toLocaleString()}</span>
          <span>Triangles</span>
          <span>{triangleCount(part.geometry).toLocaleString()}</span>
        </div>
      </Section>
      <div className="inspector-part-actions">
        <button
          className="button secondary"
          onClick={() => useEditor.getState().duplicateSelected()}
        >
          <Copy size={13} />
          Duplicate
        </button>
        <IconButton
          label="Delete selected parts"
          disabled={part.locked}
          onClick={() => useEditor.getState().deleteSelected()}
        >
          <Trash2 size={15} />
        </IconButton>
      </div>
    </>
  );
}

function PlusJointIcon() {
  return <Link2 size={14} />;
}

function AlignmentDiagram({ mode }: { mode: AlignmentMode }) {
  return (
    <svg viewBox="0 0 48 26" width="48" height="26" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.3">
        {mode === 'point' ? (
          <>
            <circle cx="10" cy="13" r="3" />
            <circle cx="38" cy="13" r="3" />
            <path d="M17 13h14m-4-4 4 4-4 4" />
          </>
        ) : mode === 'point-plane' ? (
          <>
            <circle cx="9" cy="13" r="3" />
            <path d="m32 4 9 5v14l-9-5V4ZM16 13h16m-4-4 4 4-4 4" />
          </>
        ) : mode === 'plane' ? (
          <>
            <path d="m5 4 8 5v14l-8-5V4Zm30 0 8 5v14l-8-5V4ZM19 13h10m-4-4 4 4-4 4" />
          </>
        ) : (
          <>
            <path d="m5 19 7-14 7 14H5Zm24 0 7-14 7 14H29Z" strokeDasharray="2 2" />
            {[
              [5, 19],
              [12, 5],
              [19, 19],
              [29, 19],
              [36, 5],
              [43, 19],
            ].map(([x, y], i) => (
              <circle key={i} cx={x} cy={y} r="2" fill="currentColor" stroke="none" />
            ))}
          </>
        )}
      </g>
    </svg>
  );
}

function AssemblyInspector() {
  const applyKey = useShortcut('apply'),
    cancelKey = useShortcut('cancel');
  const tool = useEditor((s) => s.tool),
    op = useEditor((s) => s.operation),
    scene = useEditor((s) => s.scene),
    setOperation = useEditor((s) => s.setOperation);
  const parts = scene.parts;
  const isJoint = tool === 'joint';
  const painting = useEditor((s) => s.painting);
  const isSurface = !isJoint && op.mode === 'surface';
  const modes: { id: AlignmentMode; label: string }[] = [
    { id: 'point', label: 'Point to point' },
    { id: 'point-plane', label: 'Point to plane' },
    { id: 'plane', label: 'Plane to plane' },
    { id: 'multi', label: '3+ point fit' },
    { id: 'surface', label: 'Paint contact surfaces' },
  ];
  const isFlush = isSurface && op.surfaceMethod === 'flush';
  const isPlaneSurface =
    isSurface && op.surfaceMethod && op.surfaceMethod !== 'contact' && !isFlush;
  const enoughPairs = isSurface
    ? completedSurfacePairs(op.surfacePairs).length >= (isPlaneSurface || isFlush ? 1 : 3) &&
      completedSurfacePairs(op.surfacePairs).length === op.surfacePairs.length
    : op.pairs.length >= (op.mode === 'multi' && !isJoint ? 3 : 1);
  const preview = useMemo(() => {
    if (isJoint || !enoughPairs || op.pending || painting) return null;
    try {
      return { result: solveAlignment(scene, op), error: null };
    } catch (error) {
      return { result: null, error: (error as Error).message };
    }
  }, [scene, op, enoughPairs, isJoint, painting]);
  const ready = enoughPairs && !op.pending && !painting && !preview?.error;
  const sourceJoint = scene.joints.find(
    (joint) => joint.childId === op.sourceId && isJointConnected(joint),
  );
  return (
    <div className="assembly-inspector">
      <div className="assembly-content">
        <div className="operation-heading">
          <div className="operation-icon">
            {isJoint ? <Link2 size={22} /> : <ScanLine size={22} />}
          </div>
          <h2>
            {isJoint
              ? 'Connect your parts'
              : isFlush
                ? 'Paint seams flush'
                : isSurface
                  ? 'Paint a closer fit'
                  : 'A perfect fit'}
          </h2>
          <p>
            {isJoint
              ? 'Pick two anchors. Keep them connected.'
              : isSurface
                ? isFlush
                  ? 'Correct tilt and height, not sideways spacing.'
                  : 'Mark the surfaces that belong together.'
                : 'A little precision. Everything in place.'}
          </p>
        </div>
        {!isJoint ? (
          <Section title="Alignment method">
            <div className="alignment-modes">
              {modes.map((mode) => (
                <button
                  key={mode.id}
                  className={`${op.mode === mode.id ? 'active' : ''} ${mode.id === 'surface' ? 'surface-mode' : ''}`}
                  onClick={() => setOperation({ mode: mode.id })}
                >
                  <AlignmentDiagram mode={mode.id} />
                  <span>{mode.label}</span>
                  {op.mode === mode.id ? <Check size={10} /> : null}
                </button>
              ))}
            </div>
          </Section>
        ) : null}
        <Section title={isJoint ? 'Joint anchors' : 'Parts to align'}>
          <div className="part-picker">
            <label>
              <span className="source-target-dot source" />
              Moving part
            </label>
            <select
              aria-label="Moving part"
              value={op.sourceId ?? ''}
              onChange={(e) => setOperation({ sourceId: e.target.value || null })}
            >
              <option value="">Choose a part…</option>
              {parts
                .filter((p) => p.id !== op.targetId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.locked ? ' (locked)' : ''}
                  </option>
                ))}
            </select>
          </div>
          <div className="part-picker">
            <label>
              <span className="source-target-dot target" />
              Target {isJoint || isSurface ? 'part' : 'part or plane'}
            </label>
            <select
              aria-label={isSurface ? 'Target part' : 'Target part or plane'}
              value={op.targetId ?? ''}
              onChange={(e) => setOperation({ targetId: e.target.value || null })}
            >
              <option value="">Choose or pick in viewport…</option>
              <optgroup label="Parts">
                {parts
                  .filter((p) => p.id !== op.sourceId)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </optgroup>
              {!isJoint && !isSurface ? (
                <optgroup label="Reference planes">
                  {referencePlanes.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </div>
          {isSurface ? (
            <SurfacePaintControls
              rms={preview?.result?.rms}
              constrained={preview?.result?.constrained}
              angleError={preview?.result?.angleError}
              regionErrors={
                preview?.result && 'regionErrors' in preview.result
                  ? preview.result.regionErrors
                  : undefined
              }
            />
          ) : (
            <>
              <div className="pick-instructions">
                <Crosshair size={15} />
                <p>
                  {op.pending
                    ? 'Now click the matching target surface.'
                    : op.pairs.length && op.mode !== 'multi'
                      ? 'Your matching pair is ready.'
                      : op.mode === 'multi' && !isJoint
                        ? `Pair ${op.pairs.length + 1}: click a point on the moving part.`
                        : 'Click a point on the moving part.'}
                </p>
              </div>
              <div className="picked-pairs">
                <div className="field-label">
                  <span>{op.mode === 'multi' && !isJoint ? 'Matching pairs' : 'Surface pair'}</span>
                  <button onClick={() => useEditor.getState().resetPicks()}>Reset</button>
                </div>
                {op.pairs.length ? (
                  op.pairs.map((_, i) => (
                    <div className="pair-row" key={i}>
                      <span className="pair-number">{i + 1}</span>
                      <span>
                        <span className="source-target-dot source" />
                        Source
                      </span>
                      <span className="pair-link">·····</span>
                      <span>
                        <span className="source-target-dot target" />
                        Target
                      </span>
                      <CheckCheck size={13} />
                      <button
                        title="Remove pair"
                        aria-label={`Remove pair ${i + 1}`}
                        onClick={() => setOperation({ pairs: op.pairs.filter((_, n) => n !== i) })}
                      >
                        <X size={11} />
                      </button>
                    </div>
                  ))
                ) : (
                  <div className="empty-pair">
                    <span className="pair-number">1</span>
                    <span>
                      {op.pending ? 'Source picked · choose target' : 'No points picked yet'}
                    </span>
                  </div>
                )}
                {op.pending && op.pairs.length ? (
                  <div className="empty-pair pending-pair" role="status">
                    <span className="pair-number">{op.pairs.length + 1}</span>
                    <span>Source picked · choose target</span>
                    <button
                      aria-label="Clear pending source"
                      title="Clear pending source"
                      onClick={() => setOperation({ pending: null })}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ) : null}
              </div>
              {op.mode === 'multi' && !isJoint ? (
                <>
                  <p className="field-help">
                    Pick 3 or more non-collinear matching pairs. Keep adding pairs for a
                    least-squares fit using every pair. Scale stays unchanged.
                  </p>
                  <div className="fit-summary" role="status">
                    <span>
                      {op.pairs.length} matching {op.pairs.length === 1 ? 'pair' : 'pairs'}
                    </span>
                    <strong>
                      {op.pending
                        ? 'Finish the target pick'
                        : enoughPairs
                          ? 'Add another pair or apply'
                          : `${3 - op.pairs.length} more required`}
                    </strong>
                    {preview?.result ? (
                      <output aria-label="Best-fit RMS error">
                        {preview.result.rms.toFixed(3)} mm RMS
                        {preview.result.constrained ? ' · constrained' : ''}
                      </output>
                    ) : null}
                  </div>
                </>
              ) : null}
            </>
          )}
          {preview?.error ? (
            <p className="field-help fit-error" role="status">
              {preview.error}
            </p>
          ) : null}
          {isFlush && preview?.result?.constrained ? (
            <p className="field-help fit-error" role="status">
              Some seams remain more than 0.05 mm or 1° out of alignment. Review the cyan preview
              and each seam’s errors before applying this compromise. Conflicting regions, locks,
              joints, or the 30° local correction limit can prevent a perfect fit.
            </p>
          ) : null}
          {sourceJoint && !isJoint ? (
            <p className="field-help">
              Keep connected is on. Alignment keeps the anchor and axis locks, and may carry
              connected parts. The target stays in place; RMS includes any constraint limits.
            </p>
          ) : null}
        </Section>
        {isJoint ? (
          <Section title="Joint constraints">
            <KeepConnectedToggle
              enabled={op.keepConnected}
              onChange={(keepConnected) => setOperation({ keepConnected })}
            />
            <p className="field-help">
              {op.keepConnected
                ? 'Keep anchors together when moving or aligning parts. Turn off any time to place a part independently.'
                : 'Seat anchors once, then leave parts free. Enable the connection later in the inspector.'}
            </p>
            <div className="field-label rotation-lock-label">
              <span>Lock rotation per axis</span>
            </div>
            <RotationLocks
              locks={op.rotationLocks}
              disabled={!op.keepConnected}
              onChange={(rotationLocks) => setOperation({ rotationLocks })}
            />
            <p className="field-help">
              Leave an axis free to make a hinge. Lock all three for a fixed joint.
            </p>
          </Section>
        ) : op.mode !== 'multi' ? (
          <Section title="Alignment options">
            {op.mode === 'plane' ||
            (isSurface &&
              !isFlush &&
              (!isPlaneSurface || ['mate', 'parallel'].includes(op.surfaceMethod!))) ? (
              <div className="appearance-row">
                <span>Opposing face normals</span>
                <button
                  className={`toggle ${op.flipNormal ? 'on' : ''}`}
                  role="switch"
                  aria-label="Opposing face normals"
                  aria-checked={op.flipNormal}
                  onClick={() => setOperation({ flipNormal: !op.flipNormal })}
                >
                  <span />
                </button>
              </div>
            ) : null}
            {(!isPlaneSurface && !isFlush) || op.surfaceMethod === 'mate' ? (
              <div className="offset-field">
                <span>Surface offset</span>
                <div>
                  <NumericInput
                    label="Alignment offset"
                    value={op.offset}
                    onCommit={(offset) => setOperation({ offset })}
                    step={0.1}
                  />
                  <small>mm</small>
                </div>
              </div>
            ) : null}
            {isPlaneSurface && op.surfaceMethod === 'angle' ? (
              <div className="offset-field">
                <span>Normal angle</span>
                <div>
                  <NumericInput
                    label="Plane alignment angle"
                    value={op.planeAngle ?? 0}
                    min={0}
                    max={180}
                    onCommit={(planeAngle) => setOperation({ planeAngle })}
                  />
                  <small>°</small>
                </div>
              </div>
            ) : null}
            {isPlaneSurface ? (
              <div className="appearance-row">
                <span>Keep constraint active</span>
                <button
                  role="switch"
                  aria-label="Keep plane constraints active"
                  aria-checked={op.retainConstraint ?? false}
                  className={`toggle ${op.retainConstraint ? 'on' : ''}`}
                  onClick={() => setOperation({ retainConstraint: !op.retainConstraint })}
                >
                  <span />
                </button>
              </div>
            ) : null}
            <p className="field-help">
              {isFlush
                ? 'Matches outward surface planes without pulling patch centers together. Uses the smallest practical local correction (up to 30°), keeps scale and mesh shape unchanged, and does not weld or fill gaps. Paint small, locally flat areas near each seam. Apply is undoable; paint regions are temporary.'
                : isPlaneSurface
                  ? op.surfaceMethod === 'mate'
                    ? 'Seats fitted planes with the signed offset. Sliding within the plane and rotation around its normal remain free. Retained constraints are editable in the Constraints tab.'
                    : 'Sets the angle between fitted plane normals. Translation and rotation that preserve this angle remain free. Retained constraints are editable in the Constraints tab.'
                  : isSurface
                    ? 'Uses all painted patches in a rigid surface fit. Contact RMS measures sampled distance to the matching patches; joint constraints may limit the fit.'
                    : op.mode === 'point-plane'
                      ? 'Projects the source point onto the target plane without changing rotation.'
                      : op.mode === 'plane'
                        ? 'Uses the picked face normals to orient and seat the moving part.'
                        : 'Moves the source point onto its matching target. Rotation stays unchanged.'}
            </p>
          </Section>
        ) : null}
      </div>
      <div className="assembly-apply">
        <button
          className="button primary full-width"
          aria-label={
            isJoint
              ? 'Create joint'
              : isFlush
                ? 'Apply flush fit'
                : isPlaneSurface
                  ? op.retainConstraint
                    ? 'Create plane constraints'
                    : `Apply ${planeKindLabels[op.surfaceMethod as keyof typeof planeKindLabels].toLowerCase()}`
                  : isSurface
                    ? 'Fit contact surfaces'
                    : 'Apply alignment'
          }
          disabled={!ready}
          onClick={() =>
            isJoint ? useEditor.getState().createJoint() : useEditor.getState().applyAlignment()
          }
        >
          {isJoint ? <Link2 size={15} /> : <Check size={15} />}{' '}
          {isJoint
            ? 'Create joint'
            : isFlush
              ? 'Apply flush fit'
              : isPlaneSurface
                ? op.retainConstraint
                  ? 'Create plane constraints'
                  : `Apply ${planeKindLabels[op.surfaceMethod as keyof typeof planeKindLabels].toLowerCase()}`
                : isSurface
                  ? 'Fit contact surfaces'
                  : 'Apply alignment'}
          {applyKey ? <kbd>{applyKey === 'Enter' ? '↵' : applyKey}</kbd> : null}
        </button>
        <button className="cancel-operation" onClick={() => useEditor.getState().setTool('select')}>
          Cancel {cancelKey ? <kbd>{cancelKey}</kbd> : null}
        </button>
      </div>
    </div>
  );
}

export function Inspector({ onClose }: { onClose: () => void }) {
  const focusKey = useShortcut('focus'),
    frameAllKey = useShortcut('frameAll');
  const selected = useEditor((s) => s.selected),
    scene = useEditor((s) => s.scene),
    tool = useEditor((s) => s.tool);
  const part = scene.parts.find((p) => p.id === selected[0]);
  return (
    <aside className="inspector-panel" aria-label="Properties inspector">
      <div className="inspector-title">
        <span>
          <SlidersHorizontal size={14} />
          {tool === 'anchors'
            ? 'Anchors'
            : tool === 'align'
              ? 'Alignment'
              : tool === 'joint'
                ? 'Joint builder'
                : 'Inspector'}
        </span>
        <div>
          <IconButton label="Workbench help" onClick={() => useEditor.getState().setModal('help')}>
            <Info size={14} />
          </IconButton>
          <IconButton
            label="Close inspector"
            className="mobile-panel-close icon-button"
            onClick={onClose}
          >
            <X size={15} />
          </IconButton>
        </div>
      </div>
      <div
        className={`inspector-scroll ${tool === 'align' || tool === 'joint' ? 'assembly-scroll' : ''}`}
      >
        {tool === 'anchors' ? (
          <AnchorControls />
        ) : tool === 'align' || tool === 'joint' ? (
          <AssemblyInspector />
        ) : selected.length > 1 ? (
          <>
            <div className="multi-selection">
              <div className="selected-part-icon">
                <Box size={28} />
              </div>
              <h2>{selected.length} parts selected</h2>
              <p>Transform them together, align them, or merge them into one mesh.</p>
            </div>
            <div className="multi-selection-actions">
              <button
                className="button primary full-width"
                onClick={() => useEditor.getState().setModal('merge')}
              >
                <BoxesIcon />
                Merge selected
              </button>
              <button
                className="button secondary full-width"
                onClick={() => useEditor.getState().setTool('align')}
              >
                <ScanLine size={14} />
                Align parts
              </button>
              <button
                className="button secondary full-width"
                onClick={() => useEditor.getState().duplicateSelected()}
              >
                <Copy size={14} />
                Duplicate parts
              </button>
              <button
                className="button secondary full-width"
                onClick={() => useEditor.getState().deleteSelected()}
              >
                <Trash2 size={14} />
                Delete unlocked parts
              </button>
            </div>
          </>
        ) : part ? (
          <PartProperties part={part} />
        ) : (
          <div className="inspector-empty">
            <MousePointer2 size={30} strokeWidth={1} />
            <h2>A place for every piece.</h2>
            <p>Select a part to inspect its position, rotation, and connections.</p>
            <div>
              <span>Multiselect</span>
              <kbd>Shift + click</kbd>
            </div>
            <div>
              <span>Focus selection</span>
              <kbd>{focusKey || '—'}</kbd>
            </div>
            <div>
              <span>Frame everything</span>
              <kbd>{frameAllKey || '—'}</kbd>
            </div>
          </div>
        )}
      </div>
      <div className="inspector-footer">
        <span className="status-dot" />
        Local workspace<span>Millimeters</span>
      </div>
    </aside>
  );
}

function BoxesIcon() {
  return <Settings2 size={14} />;
}
