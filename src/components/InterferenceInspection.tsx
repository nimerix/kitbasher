import { useEffect, useMemo, useRef, useState } from 'react';
import { Html, Line } from '@react-three/drei';
import { BufferAttribute, BufferGeometry, DoubleSide } from 'three';
import { ChevronDown, ChevronUp, Layers2, LoaderCircle, RotateCw, X } from 'lucide-react';
import type { InspectionState } from '../hooks/useInspection';
import type { InspectionSettings } from '../core/inspection-types';
import { useEditor } from '../core/store';
import { IconButton } from './ui';

export function InspectionToggle({ inspection }: { inspection: InspectionState }) {
  return (
    <button
      className={`inspection-toggle ${inspection.settings.enabled ? 'active' : ''}`}
      aria-pressed={inspection.settings.enabled}
      title="Inspect solid overlaps and near-contact surfaces"
      onClick={() =>
        useEditor.getState().setView({
          inspection: { ...inspection.settings, enabled: !inspection.settings.enabled },
          ...(inspection.settings.enabled ? {} : { explode: 0 }),
        })
      }
    >
      <Layers2 size={13} /> Interference
    </button>
  );
}

export function InspectionControls({ inspection }: { inspection: InspectionState }) {
  const [expanded, setExpanded] = useState(true);
  const settings = inspection.settings;
  const [draft, setDraft] = useState(String(settings.distance));
  const cancelledDistance = useRef(false);
  useEffect(() => setDraft(String(settings.distance)), [settings.distance]);
  if (!settings.enabled) return null;
  const update = (patch: Partial<InspectionSettings>) =>
    useEditor.getState().setView({ inspection: { ...settings, ...patch } });
  const result = inspection.result;
  const overlaps = result?.pairs.filter((pair) => pair.volume !== null && pair.volume > 0) ?? [];
  const nearby = result?.pairs.filter((pair) => pair.distance <= settings.distance + 1e-7) ?? [];
  const volume = overlaps.reduce((sum, pair) => sum + (pair.volume ?? 0), 0);
  const commitDistance = () => {
    if (cancelledDistance.current) {
      cancelledDistance.current = false;
      setDraft(String(settings.distance));
      return;
    }
    const distance = Number(draft);
    if (draft.trim() && Number.isFinite(distance) && distance >= 0) update({ distance });
    else setDraft(String(settings.distance));
  };
  return (
    <section
      className={`inspection-panel ${expanded ? '' : 'collapsed'}`}
      aria-label="Interference inspection"
    >
      <div className="inspection-heading">
        <button
          aria-label={expanded ? 'Collapse interference controls' : 'Expand interference controls'}
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <Layers2 size={14} />
          <strong>Interference</strong>
          {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
        <IconButton label="Close interference view" onClick={() => update({ enabled: false })}>
          <X size={13} />
        </IconButton>
      </div>
      {expanded ? (
        <div className="inspection-options">
          <label className="inspection-scope">
            Compare
            <select
              aria-label="Inspection scope"
              value={settings.scope}
              onChange={(event) =>
                update({ scope: event.target.value as InspectionSettings['scope'] })
              }
            >
              <option value="all">All visible parts</option>
              <option value="selected">Selected parts (2+)</option>
            </select>
          </label>
          <div className="inspection-layers">
            <label>
              <input
                type="checkbox"
                checked={settings.overlap}
                onChange={(event) => update({ overlap: event.target.checked })}
              />
              <i className="overlap-swatch" />
              Solid overlap
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.proximity}
                onChange={(event) => update({ proximity: event.target.checked })}
              />
              <i className="proximity-swatch" />
              Nearby surfaces
            </label>
          </div>
          <label className="inspection-distance">
            Within distance
            <div>
              <input
                aria-label="Near-contact distance in mm"
                type="number"
                min={0}
                step={0.1}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commitDistance}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') event.currentTarget.blur();
                  if (event.key === 'Escape') {
                    cancelledDistance.current = true;
                    setDraft(String(settings.distance));
                    event.currentTarget.blur();
                  }
                }}
              />
              <span>mm</span>
            </div>
          </label>
          <div className="inspection-layers secondary-layers">
            <label>
              <input
                type="checkbox"
                checked={settings.closestPoints}
                onChange={(event) => update({ closestPoints: event.target.checked })}
              />
              Closest-point markers
            </label>
            <label>
              <input
                type="checkbox"
                checked={settings.context}
                onChange={(event) => update({ context: event.target.checked })}
              />
              Show surrounding parts
            </label>
          </div>
        </div>
      ) : null}
      <div
        className="inspection-status"
        role="status"
        aria-live="polite"
        aria-busy={inspection.status === 'working'}
      >
        {inspection.status === 'working' ? (
          <span>
            <LoaderCircle size={12} className="spin" />
            Checking {inspection.count} parts…
          </span>
        ) : inspection.status === 'empty' ? (
          <span>
            {settings.scope === 'selected'
              ? 'Select at least two visible parts to compare.'
              : 'Add at least two visible parts to compare.'}
          </span>
        ) : inspection.status === 'error' ? (
          <>
            <p>{inspection.error}</p>
            <button onClick={inspection.retry}>
              <RotateCw size={12} />
              Try again
            </button>
          </>
        ) : result ? (
          <>
            {result.warnings.length ? (
              <span className="inspection-partial">Partial analysis · see notes below</span>
            ) : null}
            <div className="inspection-metrics">
              <strong className={overlaps.length ? 'has-overlap' : ''}>
                {overlaps.length} overlapping {overlaps.length === 1 ? 'pair' : 'pairs'}
              </strong>
              <span>
                {nearby.length} within {settings.distance} mm
              </span>
            </div>
            {volume > 0 ? (
              <span className="inspection-volume">
                {volume.toLocaleString(undefined, { maximumFractionDigits: 3 })} mm³ pairwise
                overlap
              </span>
            ) : null}
            <small>
              {result.checkedPairs} {result.checkedPairs === 1 ? 'pair' : 'pairs'} checked ·{' '}
              {result.solidPairs} solid checks
            </small>
          </>
        ) : null}
      </div>
      {expanded && result ? (
        <>
          {result.pairs.length ? (
            <ul className="inspection-pairs" aria-label="Contact pairs">
              {result.pairs.map((pair) => (
                <li key={`${pair.a}:${pair.b}`}>
                  <span title={`${pair.nameA} / ${pair.nameB}`}>
                    {pair.nameA} / {pair.nameB}
                  </span>
                  <strong>
                    {pair.volume && pair.volume > 0
                      ? `${pair.volume.toFixed(3)} mm³ overlap`
                      : `Gap ${pair.distance.toFixed(3)} mm`}
                  </strong>
                </li>
              ))}
            </ul>
          ) : null}
          {result.warnings.length ? (
            <div className="inspection-warnings" role="note">
              {result.warnings.map((warning) => (
                <p key={warning}>{warning}</p>
              ))}
            </div>
          ) : null}
          <p className="inspection-note">
            Amber follows surfaces within the distance of another part, including the interface.
            Band detail is approximate (about {Number(result.resolution.toPrecision(2))} mm). Solid
            overlap assumes closed, consistently wound meshes.
          </p>
        </>
      ) : null}
    </section>
  );
}

export function InspectionOverlay({ inspection }: { inspection: InspectionState }) {
  const result = inspection.result;
  const geometry = useMemo(() => {
    const make = (positions: Float32Array) => {
      const geometry = new BufferGeometry();
      geometry.setAttribute('position', new BufferAttribute(positions, 3));
      return geometry;
    };
    return result
      ? {
          overlaps: result.overlaps.map((overlap) => ({
            ...overlap,
            geometry: make(overlap.positions),
          })),
          surfaces: result.surfaces.map((surface) => ({
            ...surface,
            geometry: make(surface.positions),
          })),
        }
      : null;
  }, [result]);
  useEffect(
    () => () => {
      geometry?.overlaps.forEach((surface) => surface.geometry.dispose());
      geometry?.surfaces.forEach((surface) => surface.geometry.dispose());
    },
    [geometry],
  );
  if (!inspection.settings.enabled || !geometry || !result) return null;
  return (
    <group name="interference-inspection">
      {inspection.settings.proximity
        ? geometry.surfaces.map((surface) => (
            <mesh
              key={surface.id}
              name={`nearby:${surface.id}`}
              geometry={surface.geometry}
              renderOrder={2}
              raycast={() => {}}
            >
              <meshBasicMaterial
                color="#ffc25c"
                transparent
                opacity={0.8}
                side={DoubleSide}
                depthWrite={false}
                polygonOffset
                polygonOffsetFactor={-1}
                polygonOffsetUnits={-1}
              />
            </mesh>
          ))
        : null}
      {inspection.settings.overlap
        ? geometry.overlaps.map((overlap) => (
            <mesh
              key={`${overlap.a}:${overlap.b}`}
              name={`overlap:${overlap.a}:${overlap.b}`}
              geometry={overlap.geometry}
              renderOrder={3}
              raycast={() => {}}
            >
              <meshBasicMaterial
                color="#ff4d68"
                transparent
                opacity={1}
                depthWrite={false}
                side={DoubleSide}
                depthTest={false}
              />
            </mesh>
          ))
        : null}
      {inspection.settings.closestPoints
        ? result.pairs
            .filter((pair) => pair.distance <= inspection.settings.distance + 1e-7)
            .map((pair) => (
              <group key={`${pair.a}:${pair.b}`}>
                <Line
                  points={pair.points}
                  color="#82ecfa"
                  lineWidth={2}
                  depthTest={false}
                  raycast={() => {}}
                />
                {pair.points.map((point, i) => (
                  <mesh key={i} position={point} renderOrder={5} raycast={() => {}}>
                    <sphereGeometry args={[Math.max(0.1, result.resolution * 0.5), 10, 8]} />
                    <meshBasicMaterial color="#82ecfa" depthTest={false} />
                  </mesh>
                ))}
                <Html
                  position={pair.points[0]}
                  center
                  zIndexRange={[2, 0]}
                  style={{ pointerEvents: 'none' }}
                >
                  <span className="inspection-gap-label">{pair.distance.toFixed(3)} mm</span>
                </Html>
              </group>
            ))
        : null}
    </group>
  );
}
