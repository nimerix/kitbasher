import { CircleDot, ScanLine, Trash2 } from 'lucide-react';
import { useEditor } from '../core/store';
import { planeConstraintResidual, planeKindLabels } from '../core/plane-constraints';
import type { PlaneConstraintKind } from '../core/types';
import { IconButton, NumericInput } from './ui';

export function ConstraintList({ query }: { query: string }) {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected);
  const constraints = scene.constraints ?? [],
    update = useEditor((s) => s.updateConstraint);
  return (
    <div className="constraint-list">
      <p className="field-help">
        Target planes drive moving parts. Suppress a relationship to place a part freely; joints and
        other active constraints still apply.
      </p>
      {constraints
        .filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
        .map((constraint) => {
          const residual = planeConstraintResidual(scene.parts, constraint);
          const source = scene.parts.find((p) => p.id === constraint.sourceId),
            target = scene.parts.find((p) => p.id === constraint.targetId);
          return (
            <section
              className={`constraint-card ${selected.includes(constraint.sourceId) ? 'active' : ''}`}
              key={constraint.id}
              aria-label={constraint.name}
            >
              <div className="constraint-heading">
                <button
                  className="constraint-select"
                  title="Select moving part"
                  onClick={() => useEditor.getState().select(constraint.sourceId)}
                >
                  <CircleDot size={14} />
                </button>
                <input
                  aria-label={`Constraint name ${constraint.name}`}
                  key={constraint.name}
                  defaultValue={constraint.name}
                  onBlur={(event) => {
                    const name = event.target.value.trim();
                    if (name && name !== constraint.name) update(constraint.id, { name });
                    else event.target.value = constraint.name;
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur();
                  }}
                />
                <IconButton
                  label={`Remove ${constraint.name}`}
                  onClick={() => useEditor.getState().removeConstraint(constraint.id)}
                >
                  <Trash2 size={12} />
                </IconButton>
              </div>
              <p className="constraint-endpoints" title={`${target?.name} → ${source?.name}`}>
                {target?.name} → {source?.name}
              </p>
              <label className="constraint-field">
                <span>Relationship</span>
                <select
                  aria-label={`Relationship for ${constraint.name}`}
                  value={constraint.kind}
                  onChange={(event) =>
                    update(constraint.id, { kind: event.target.value as PlaneConstraintKind })
                  }
                >
                  {Object.entries(planeKindLabels).map(([kind, label]) => (
                    <option key={kind} value={kind}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
              {constraint.kind === 'mate' ? (
                <label className="constraint-field">
                  <span>Offset (mm)</span>
                  <NumericInput
                    label={`Offset for ${constraint.name}`}
                    value={constraint.offset}
                    step={0.1}
                    onCommit={(offset) => update(constraint.id, { offset })}
                  />
                </label>
              ) : null}
              {constraint.kind === 'angle' ? (
                <label className="constraint-field">
                  <span>Normal angle (°)</span>
                  <NumericInput
                    label={`Angle for ${constraint.name}`}
                    value={constraint.angle}
                    min={0}
                    max={180}
                    onCommit={(angle) => update(constraint.id, { angle })}
                  />
                </label>
              ) : null}
              {['mate', 'parallel'].includes(constraint.kind) ? (
                <label className="constraint-field">
                  <span>Face direction</span>
                  <select
                    aria-label={`Face direction for ${constraint.name}`}
                    value={constraint.opposed ? 'opposed' : 'same'}
                    onChange={(event) =>
                      update(constraint.id, { opposed: event.target.value === 'opposed' })
                    }
                  >
                    <option value="opposed">Opposing normals</option>
                    <option value="same">Same normals</option>
                  </select>
                </label>
              ) : null}
              <div className="appearance-row">
                <span>{constraint.enabled ? 'Active' : 'Suppressed'}</span>
                <button
                  role="switch"
                  aria-label={`Enable ${constraint.name}`}
                  aria-checked={constraint.enabled}
                  className={`toggle ${constraint.enabled ? 'on' : ''}`}
                  onClick={() => update(constraint.id, { enabled: !constraint.enabled })}
                >
                  <span />
                </button>
              </div>
              <output
                className={`constraint-residual ${constraint.enabled && !residual.satisfied ? 'fit-error' : ''}`}
                aria-label={`Residual for ${constraint.name}`}
              >
                {constraint.enabled
                  ? `${(residual.angle * 180) / Math.PI < 0.001 ? '<0.001' : ((residual.angle * 180) / Math.PI).toFixed(3)}°${constraint.kind === 'mate' ? ` · ${residual.distance.toFixed(3)} mm` : ''}`
                  : 'Not enforced'}
              </output>
            </section>
          );
        })}
      {!constraints.length ? (
        <div className="panel-empty">
          <ScanLine size={23} />
          <p>No plane constraints yet</p>
          <span>
            Paint matching surfaces, choose a plane relationship, and turn on Keep constraint
            active.
          </span>
          <button
            className="button secondary"
            onClick={() => {
              useEditor.getState().setTool('align');
              useEditor
                .getState()
                .setOperation({ mode: 'surface', surfaceMethod: 'mate', retainConstraint: true });
            }}
          >
            Create a plane constraint
          </button>
        </div>
      ) : null}
    </div>
  );
}
