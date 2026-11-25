import type { ReactNode } from 'react';
import { Grid2x2, Grid2x2Plus, LockKeyhole, Slash, Trash2, UnlockKeyhole } from 'lucide-react';
import { useEditor, type RefinePointSelection } from '../core/store';

const editor = () => useEditor.getState();

/** The guide and point a point menu acts on, while they still exist. */
function pointOf(target: RefinePointSelection) {
  const refine = editor().refine;
  const feature = refine?.features.find((f) => f.id === target.feature);
  if (!refine || feature?.state !== 'pending' || feature.feature.type !== 'edge') return null;
  const input = feature.feature.input;
  const point = input.segments[target.segment]?.points[target.index];
  return point ? { refine, input, point } : null;
}

/** The menu's heading: which point of which guide. */
export function refinePointTitle(target: RefinePointSelection) {
  const found = pointOf(target);
  if (!found) return 'Guide point';
  const lock = found.point.lock;
  const plane = found.input.plane?.name;
  const held = lock?.kind === 'fixed' ? 'fixed' : lock?.kind === 'line' ? 'on a line' : null;
  return ['Guide point', plane ? `on ${plane}` : null, held].filter(Boolean).join(', ');
}

/** One action of the point menu. */
function Item({
  label,
  icon,
  disabled = false,
  hint,
  danger = false,
  onSelect,
  close,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Why it is disabled, shown as its tooltip. */
  hint?: string;
  danger?: boolean;
  onSelect: () => void;
  close: (restore?: boolean) => void;
}) {
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      disabled={disabled}
      className={`context-action ${danger ? 'danger' : ''}`}
      data-label={label}
      title={disabled ? hint : undefined}
      onClick={() => {
        close(true);
        onSelect();
      }}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

/** A labelled group of the point menu, after a separator unless it is the first. */
function Group({
  label,
  first = false,
  children,
}: {
  label: string;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <div role="group" aria-label={label}>
      {first ? null : <div role="separator" className="context-separator" />}
      <div className="context-label" aria-hidden="true">
        {label}
      </div>
      {children}
    </div>
  );
}

/** The point menu's actions: Lock, then Delete. */
export function RefinePointItems({
  target,
  close,
}: {
  target: RefinePointSelection;
  close: (restore?: boolean) => void;
}) {
  const found = pointOf(target);
  if (!found) return null;
  const { refine, input, point } = found;
  const { feature, segment, index } = target;
  const lock = point.lock;
  const item = { close };
  return (
    <>
      <Group label="Lock" first>
        {refine.planes.map((plane) => (
          <Item
            key={plane.id}
            {...item}
            label={`To ${plane.name}`}
            icon={<Grid2x2 size={14} />}
            disabled={input.plane?.id === plane.id}
            hint="The guide is on this plane."
            onSelect={() => editor().setRefineGuidePlane(feature, plane.id)}
          />
        ))}
        <Item
          {...item}
          label="To a new plane"
          icon={<Grid2x2Plus size={14} />}
          onSelect={() =>
            editor().startRefinePicking({
              kind: 'plane',
              from: 'points',
              points: [],
              lock: feature,
            })
          }
        />
        <Item
          {...item}
          label="To a line"
          icon={<Slash size={14} />}
          onSelect={() => editor().startRefinePicking({ kind: 'line', point: target, points: [] })}
        />
        <Item
          {...item}
          label="Fixed"
          icon={<LockKeyhole size={14} />}
          disabled={lock?.kind === 'fixed'}
          hint="This point is fixed."
          onSelect={() => editor().lockRefinePoint(feature, segment, index, { kind: 'fixed' })}
        />
        <Item
          {...item}
          label="Unlock"
          icon={<UnlockKeyhole size={14} />}
          disabled={!lock}
          hint="This point has no lock of its own."
          onSelect={() => editor().lockRefinePoint(feature, segment, index, null)}
        />
      </Group>
      <Group label="Point">
        <Item
          {...item}
          label="Delete"
          icon={<Trash2 size={14} />}
          danger
          onSelect={() => editor().removeRefinePoint(feature, segment, index)}
        />
      </Group>
    </>
  );
}
