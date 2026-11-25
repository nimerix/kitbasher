import type { ReactNode } from 'react';
import {
  AlignHorizontalJustifyCenter,
  AlignVerticalJustifyCenter,
  Grid2x2,
  Grid2x2Plus,
  LockKeyhole,
  Slash,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import {
  type PairKind,
  constraintLabels,
  constraintRefusal,
  pairFits,
  pairKinds,
  samePoint,
} from '../core/refine-constraints';
import type { EdgeInput } from '../core/refine-edge';
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
      <Group label="Align">
        {(['horizontal', 'vertical'] as const).map((axis) => (
          <Item
            key={axis}
            {...item}
            label={axis === 'horizontal' ? 'Horizontal' : 'Vertical'}
            icon={
              axis === 'horizontal' ? (
                <AlignHorizontalJustifyCenter size={14} />
              ) : (
                <AlignVerticalJustifyCenter size={14} />
              )
            }
            disabled={!input.plane}
            hint="Align works on a guide on a sketch plane. Lock the guide to a plane first."
            onSelect={() =>
              editor().startRefinePicking({ kind: 'align', axis, point: target, points: [] })
            }
          />
        ))}
        {input.plane ? null : (
          <p className="context-hint">Lock the guide to a plane to align its points.</p>
        )}
      </Group>
      <Group label="Constrain">
        <PairItems input={input} feature={feature} pair={meeting(input, target)} close={close} />
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

/** The two segments that meet at a point, or null at an open end or an arc's middle. */
function meeting(input: EdgeInput, target: RefinePointSelection): [number, number] | null {
  const point = input.segments[target.segment]?.points[target.index];
  if (!point) return null;
  const found = input.segments.flatMap((s, i) =>
    s.points.some((p, k) => samePoint(p, point) && (k === 0 || k === s.points.length - 1))
      ? [i]
      : [],
  );
  return found.length === 2 ? [found[0], found[1]] : null;
}

/**
 * The segment constraints between two segments, each applied at once; or, with `pick`, each
 * waiting for a click on the other segment.
 */
function PairItems({
  input,
  feature,
  pair,
  pick,
  close,
}: {
  input: EdgeInput;
  feature: string;
  pair: [number, number] | null;
  pick?: number;
  close: (restore?: boolean) => void;
}) {
  const kinds =
    pick === undefined
      ? pairKinds
      : pairKinds.filter((kind) =>
          input.segments.some(
            (s, i) => i !== pick && pairFits(kind, input.segments[pick].kind, s.kind),
          ),
        );
  const reason = (kind: PairKind) => {
    if (!input.plane)
      return 'Constraints work on a guide on a sketch plane. Lock the guide to a plane first.';
    if (pick !== undefined) return null;
    if (!pair) return 'Two segments must meet at this point.';
    return constraintRefusal(input, { id: '', kind, segments: pair });
  };
  return (
    <>
      {kinds.map((kind) => {
        const why = reason(kind);
        return (
          <Item
            key={kind}
            close={close}
            label={constraintLabels[kind]}
            icon={<ConstraintGlyph kind={kind} />}
            disabled={!!why}
            hint={why ?? undefined}
            onSelect={() =>
              pick === undefined
                ? editor().addRefineConstraint(feature, { kind, segments: pair! })
                : editor().startRefinePicking({
                    kind: 'constrain',
                    constraint: kind,
                    feature,
                    segment: pick,
                    points: [],
                  })
            }
          />
        );
      })}
    </>
  );
}

/** The symbol a constraint is drawn with, in menus and beside the guide. */
export const constraintGlyphs: Record<keyof typeof constraintLabels, string> = {
  parallel: '∥',
  perpendicular: '⊥',
  collinear: '⋯',
  equal: '=',
  tangent: '⌒',
  concentric: '◎',
  horizontal: 'H',
  vertical: 'V',
  align: '⇹',
};

function ConstraintGlyph({ kind }: { kind: keyof typeof constraintLabels }) {
  return (
    <span className="constraint-glyph" aria-hidden="true">
      {constraintGlyphs[kind]}
    </span>
  );
}

/** The guide a segment menu acts on, while it still exists. */
function guideOf(feature: string) {
  const found = editor().refine?.features.find((f) => f.id === feature);
  return found?.state === 'pending' && found.feature.type === 'edge' ? found.feature.input : null;
}

/** A segment menu's heading. */
export function refineSegmentTitle(target: { feature: string; segment: number }) {
  const kind = guideOf(target.feature)?.segments[target.segment]?.kind;
  return kind ? `Guide ${kind}` : 'Guide segment';
}

/** A segment's menu: Constrain, then the other segment's click; Horizontal and Vertical at once. */
export function RefineSegmentItems({
  target,
  close,
}: {
  target: { feature: string; segment: number };
  close: (restore?: boolean) => void;
}) {
  const input = guideOf(target.feature);
  const segment = input?.segments[target.segment];
  if (!input || !segment) return null;
  const line = segment.kind === 'line';
  return (
    <Group label="Constrain" first>
      <PairItems
        input={input}
        feature={target.feature}
        pair={null}
        pick={target.segment}
        close={close}
      />
      {(['horizontal', 'vertical'] as const).map((kind) => (
        <Item
          key={kind}
          close={close}
          label={constraintLabels[kind]}
          icon={<ConstraintGlyph kind={kind} />}
          disabled={!input.plane || !line}
          hint={
            input.plane
              ? 'Only a line can be horizontal or vertical.'
              : 'Constraints work on a guide on a sketch plane. Lock the guide to a plane first.'
          }
          onSelect={() =>
            editor().addRefineConstraint(target.feature, { kind, segments: [target.segment] })
          }
        />
      ))}
    </Group>
  );
}

/** A constraint's menu: Delete. */
export function RefineConstraintItems({
  target,
  close,
}: {
  target: { feature: string; id: string };
  close: (restore?: boolean) => void;
}) {
  return (
    <Item
      close={close}
      label="Delete constraint"
      icon={<Trash2 size={14} />}
      danger
      onSelect={() => editor().removeRefineConstraint(target.feature, target.id)}
    />
  );
}

/** A constraint menu's heading. */
export function refineConstraintTitle(target: { feature: string; id: string }) {
  const constraint = guideOf(target.feature)?.constraints?.find((c) => c.id === target.id);
  return constraint ? `${constraintLabels[constraint.kind]} constraint` : 'Constraint';
}
