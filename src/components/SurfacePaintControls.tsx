import type { CSSProperties } from 'react';
import { ArrowRight, Check, Plus, X } from 'lucide-react';
import { useEditor } from '../core/store';
import { contactColors, completedSurfacePairs } from '../core/surfaces';
import { SurfaceBrushControls } from './SurfaceBrushControls';
import { planeKindLabels } from '../core/plane-constraints';
import type { SurfaceMethod } from '../core/types';

export function SurfacePaintControls({
  rms,
  constrained,
  angleError,
  regionErrors,
}: {
  rms?: number;
  constrained?: boolean;
  angleError?: number;
  regionErrors?: { region: number; distance: number; angle: number }[];
}) {
  const op = useEditor((s) => s.operation),
    erase = useEditor((s) => s.brushErase),
    painting = useEditor((s) => s.painting);
  const method = op.surfaceMethod ?? 'contact',
    required = method === 'contact' ? 3 : 1;
  const flush = method === 'flush';
  const complete = completedSurfacePairs(op.surfacePairs).length;
  const active = op.surfacePairs.find((pair) => pair.id === op.activeSurface?.pairId);
  const side = op.activeSurface?.side;
  return (
    <div className="surface-painter">
      <label className="surface-method-field">
        <span>Surface relationship</span>
        <select
          aria-label="Surface relationship"
          value={method}
          onChange={(event) =>
            useEditor
              .getState()
              .setOperation({ surfaceMethod: event.target.value as SurfaceMethod })
          }
        >
          <option value="contact">Contact best fit · 3+ pairs</option>
          <option value="flush">Paint flush · across seams</option>
          {Object.entries(planeKindLabels).map(([value, label]) => (
            <option key={value} value={value}>
              {label} · 1+ pairs
            </option>
          ))}
        </select>
      </label>
      <p className="field-help">
        {flush
          ? 'Choose the moving part, then drag across the seam onto its neighbor. Both sides are painted automatically, even across empty space. Add a seam for each connection to balance; each can use a different stationary neighbor.'
          : method === 'contact'
            ? 'Paint matching contact areas on both parts. Use at least 3 pairs spread across the join.'
            : 'Paint one or more pairs of planar areas to orient the parts using fitted planes.'}{' '}
        Each patch grows as one connected surface; start a new pair for a separate area.
      </p>
      <SurfaceBrushControls />
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
                disabled={!flush && current === 'target' && !pair.source?.faces.length}
                title={
                  pair[current]
                    ? useEditor
                        .getState()
                        .scene.parts.find((part) => part.id === pair[current]!.partId)?.name
                    : undefined
                }
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
      {active && side && !flush ? (
        <div className="paint-next-step" role="status">
          <span>
            {erase ? 'Erase' : 'Paint'} the {side === 'source' ? 'moving' : 'target'} patch for pair{' '}
            {op.surfacePairs.indexOf(active) + 1}.
          </span>
          <button
            className="clear-patch"
            disabled={!active[side]?.faces.length || painting}
            onClick={() =>
              useEditor.getState().setOperation({
                surfacePairs: op.surfacePairs.map((pair) =>
                  pair.id === active.id ? { ...pair, [side]: null } : pair,
                ),
              })
            }
          >
            Clear this patch
          </button>
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
        <Plus size={14} /> {flush ? 'Add seam' : 'Add surface pair'}
      </button>
      <div className="fit-summary" role="status">
        <span>
          {complete} complete surface {complete === 1 ? 'pair' : 'pairs'}
        </span>
        <strong>
          {painting
            ? 'Painting…'
            : complete < required
              ? `${required - complete} more required`
              : complete < op.surfacePairs.length
                ? 'Finish the incomplete pair'
                : flush
                  ? 'Add another seam or apply flush fit'
                  : method === 'contact'
                    ? 'Add another pair or fit'
                    : 'Ready for plane alignment'}
        </strong>
        {rms !== undefined && !painting ? (
          <output
            aria-label={
              flush
                ? 'Flush alignment residual'
                : method === 'contact'
                  ? 'Surface contact RMS error'
                  : 'Plane alignment residual'
            }
          >
            {flush
              ? `${rms.toFixed(3)} mm height RMS · ${(angleError ?? 0).toFixed(3)}° max tilt`
              : method === 'contact'
                ? `${rms.toFixed(3)} mm contact RMS`
                : `${(angleError ?? 0).toFixed(3)}° angle error${method === 'mate' ? ` · ${rms.toFixed(3)} mm seating error` : ''}`}
            {constrained ? (flush ? ' · best-fit compromise' : ' · constrained') : ''}
          </output>
        ) : null}
        {flush && !painting
          ? regionErrors?.map((region) => (
              <small key={region.region}>
                Seam {region.region}: {region.distance.toFixed(3)} mm height ·{' '}
                {region.angle.toFixed(3)}° tilt
              </small>
            ))
          : null}
      </div>
      {flush ? (
        <p className="field-help">
          Cyan ghost shows the proposed position. All seams share one rigid adjustment; joints,
          locks, and existing constraints stay authoritative. Unpainted connections without
          constraints are not protected. Height/tilt errors indicate a compromise, not a perfect
          fit.
        </p>
      ) : null}
      <p className="field-help paint-navigation-hint">
        Drag to paint connected mesh triangles. Alt erases. Middle-drag or Space + drag orbits;
        right-drag pans. Right-click adjusts the brush. O / H switch camera tools. [ and ] resize
        the brush.
      </p>
    </div>
  );
}
