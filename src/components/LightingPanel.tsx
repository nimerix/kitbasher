import { useEffect, useRef, useState } from 'react';
import type { ReactNode, Ref } from 'react';
import { Lightbulb, Plus, RotateCcw, Save, Sun, Trash2, Video, X } from 'lucide-react';
import {
  addLight,
  lightAngles,
  lightingLimits,
  lightingPresetIds,
  lightingPresets,
  matchingPreset,
  positionFromAngles,
  presetLighting,
  reframeLight,
  removeLight,
  updateLight,
} from '../core/lighting';
import { sceneLighting, useEditor } from '../core/store';
import { same } from '../core/sync';
import type { LightKind, SceneLight, SceneLighting } from '../core/types';
import {
  ColorControl,
  IconButton,
  NumericInput,
  RadioGroup,
  RangeInput,
  Switch,
  VectorFields,
} from './ui';
import type { ViewProjection } from './Annotations';

// Handlers read the store, not the render, so every step of a drag builds on the last one.
const current = () => sceneLighting(useEditor.getState());
const apply = (lighting: SceneLighting, checkpoint = true) =>
  useEditor.getState().setLighting(lighting, checkpoint);
const patchLighting = (patch: Partial<SceneLighting>, checkpoint = true) =>
  apply({ ...current(), ...patch }, checkpoint);
const patchLight = (id: string, patch: Partial<SceneLight>, checkpoint = true) =>
  apply(updateLight(current(), id, patch), checkpoint);

const angleLimit = (min: number, max: number) => ({ min, max, step: 1 });

export function LightingPanel({ projection }: { projection: ViewProjection }) {
  const open = useEditor((s) => s.lightingPanel);
  return open ? <OpenLightingPanel projection={projection} /> : null;
}

function OpenLightingPanel({ projection }: { projection: ViewProjection }) {
  const lighting = useEditor(sceneLighting),
    own = useEditor((s) => s.scene.lighting !== undefined),
    defaultLighting = useEditor((s) => s.defaultLighting),
    activeId = useEditor((s) => s.activeLight);
  const panel = useRef<HTMLElement>(null),
    editor = useRef<HTMLElement>(null);
  // Lights picked in the list are beside their editor. Others, added or picked in the viewport, scroll to it.
  const pickedInList = useRef(false);
  const active = lighting.lights.find((l) => l.id === activeId);
  const preset = matchingPreset(lighting);
  const full = lighting.lights.length >= lightingLimits.lights;
  const close = () => useEditor.getState().setLightingPanel(false);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    return () => {
      if (
        previous?.isConnected &&
        (!document.activeElement || document.activeElement === document.body)
      )
        previous.focus();
    };
  }, []);
  useEffect(() => {
    // Undo can remove the light being edited. Keep editing one while any exist.
    const first = lighting.lights[0]?.id ?? null;
    if (!active && first !== activeId) {
      pickedInList.current = true;
      useEditor.getState().setActiveLight(first);
    }
  }, [active, activeId, lighting.lights]);
  const shownLight = useRef(activeId);
  useEffect(() => {
    if (shownLight.current === activeId) return;
    shownLight.current = activeId;
    if (!pickedInList.current) editor.current?.scrollIntoView({ block: 'nearest' });
    pickedInList.current = false;
  }, [activeId]);

  const add = (kind: LightKind) => {
    const added = addLight(current(), kind);
    if (!added) return;
    apply(added.lighting);
    useEditor.getState().setActiveLight(added.id);
  };

  return (
    <aside
      ref={panel}
      className="lighting-panel"
      role="dialog"
      aria-modal="false"
      aria-labelledby="lighting-title"
      tabIndex={-1}
      onBlur={(event) => {
        // A button that disappears or is disabled by its own click would drop focus to the page.
        if (event.relatedTarget) return;
        const left = event.target as HTMLElement;
        requestAnimationFrame(() => {
          const lost = !document.activeElement || document.activeElement === document.body;
          if (lost && (!left.isConnected || left.matches(':disabled'))) panel.current?.focus();
        });
      }}
      onKeyDown={(event) => {
        // Escape in a text or number field cancels that edit instead.
        const target = event.target;
        const typing =
          target instanceof HTMLInputElement &&
          (target.type === 'text' || target.type === 'number');
        if (event.key === 'Escape' && !event.defaultPrevented && !typing) {
          event.preventDefault();
          close();
        }
      }}
    >
      <header className="lighting-heading">
        <div>
          <h2 id="lighting-title">Lighting</h2>
          <p>{own ? 'This scene has its own lighting' : 'Using your default lighting'}</p>
        </div>
        <IconButton label="Close lighting" onClick={close}>
          <X size={15} />
        </IconButton>
      </header>
      <div className="lighting-body">
        <section className="lighting-section" aria-label="Presets">
          <RadioGroup
            label="Lighting preset"
            className="lighting-presets"
            value={preset}
            options={lightingPresetIds.map((id) => ({
              id,
              label: lightingPresets[id].label,
              title: lightingPresets[id].description,
            }))}
            onChange={(id) => apply(presetLighting(id))}
          />
          <p className="lighting-help">
            {preset ? lightingPresets[preset].description : 'Custom lighting'}
          </p>
        </section>
        <section className="lighting-section" aria-label="Scene light">
          <LightingRange
            label="Brightness"
            value={lighting.exposure}
            limit={lightingLimits.exposure}
            unit="×"
            onChange={(exposure, checkpoint) => patchLighting({ exposure }, checkpoint)}
          />
          <LightingRange
            label="Ambient"
            value={lighting.ambient}
            limit={lightingLimits.ambient}
            onChange={(ambient, checkpoint) => patchLighting({ ambient }, checkpoint)}
          />
          <LightingRange
            label="Sky fill"
            value={lighting.hemisphere}
            limit={lightingLimits.hemisphere}
            onChange={(hemisphere, checkpoint) => patchLighting({ hemisphere }, checkpoint)}
          />
          <div className="lighting-colors">
            <LightingField label="Sky">
              <ColorControl
                label="Sky color"
                value={lighting.sky}
                onChange={(sky, checkpoint) => patchLighting({ sky }, checkpoint)}
              />
            </LightingField>
            <LightingField label="Ground">
              <ColorControl
                label="Ground color"
                value={lighting.ground}
                onChange={(ground, checkpoint) => patchLighting({ ground }, checkpoint)}
              />
            </LightingField>
          </div>
          <LightingField label="Shadows">
            <Switch
              label="Shadows"
              checked={lighting.shadows}
              onChange={(shadows) => patchLighting({ shadows })}
            />
          </LightingField>
        </section>
        <section className="lighting-section" aria-labelledby="lighting-lights">
          <div className="lighting-section-heading">
            <h3 id="lighting-lights">Lights</h3>
            <span>
              {lighting.lights.length} / {lightingLimits.lights}
            </span>
          </div>
          {lighting.lights.length ? (
            <ul className="light-list">
              {lighting.lights.map((light) => (
                <li
                  key={light.id}
                  className={`light-row ${light.id === active?.id ? 'active' : ''} ${light.enabled ? '' : 'off'}`}
                >
                  <Switch
                    label={`Enable ${light.name || 'light'}`}
                    checked={light.enabled}
                    onChange={(enabled) => patchLight(light.id, { enabled })}
                  />
                  <button
                    className="light-select"
                    aria-pressed={light.id === active?.id}
                    onClick={() => {
                      pickedInList.current = true;
                      useEditor.getState().setActiveLight(light.id);
                    }}
                  >
                    {light.kind === 'point' ? <Lightbulb size={13} /> : <Sun size={13} />}
                    <span className="light-name">
                      {light.name || 'Untitled'}
                      <span className="sr-only">
                        {light.kind === 'point' ? ', point light' : ', directional light'}
                        {light.camera ? ', follows the camera' : ''}
                      </span>
                    </span>
                    {light.camera ? (
                      <Video size={12} className="light-camera" aria-hidden="true" />
                    ) : null}
                    <span
                      className="light-color"
                      aria-hidden="true"
                      style={{ background: light.color }}
                    />
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="lighting-help">No lights. Ambient and sky fill still light the scene.</p>
          )}
          <div className="light-add">
            <button className="button secondary" disabled={full} onClick={() => add('directional')}>
              <Plus size={12} />
              Add directional
            </button>
            <button className="button secondary" disabled={full} onClick={() => add('point')}>
              <Plus size={12} />
              Add point
            </button>
          </div>
          {full ? (
            <p className="lighting-help">A scene can have up to {lightingLimits.lights} lights.</p>
          ) : null}
        </section>
        {active ? (
          <LightEditor
            key={active.id}
            ref={editor}
            light={active}
            shadows={lighting.shadows}
            projection={projection}
          />
        ) : null}
        <footer className="lighting-footer">
          <div>
            <button
              className="button secondary"
              disabled={!own}
              onClick={() => useEditor.getState().setLighting(null)}
            >
              <RotateCcw size={12} />
              Reset to default
            </button>
            <button
              className="button secondary"
              disabled={same(lighting, defaultLighting)}
              onClick={() => {
                useEditor.getState().setDefaultLighting(lighting);
                useEditor.getState().notify('New scenes will use this lighting');
              }}
            >
              <Save size={12} />
              Use as default
            </button>
          </div>
          {matchingPreset(defaultLighting) !== 'studio' ? (
            <button
              className="lighting-link"
              onClick={() => {
                useEditor.getState().setDefaultLighting(null);
                useEditor.getState().notify('Default lighting restored to Studio');
              }}
            >
              Restore built-in default
            </button>
          ) : null}
          <p className="lighting-note">
            Saved with the scene for the editor only, never exported. With the Select tool, drag a
            light's handle in the viewport to move it.
          </p>
        </footer>
      </div>
    </aside>
  );
}

function LightEditor({
  ref,
  light,
  shadows,
  projection,
}: {
  ref: Ref<HTMLElement>;
  light: SceneLight;
  shadows: boolean;
  projection: ViewProjection;
}) {
  const [name, setName] = useState(light.name);
  const cancelRename = useRef(false);
  useEffect(() => setName(light.name), [light.name]);
  const angles = lightAngles(light.position);
  const turn = (azimuth: number, elevation: number, checkpoint: boolean) => {
    const latest = current().lights.find((l) => l.id === light.id);
    if (!latest) return;
    patchLight(
      light.id,
      { position: positionFromAngles(azimuth, elevation, Math.hypot(...latest.position)) },
      checkpoint,
    );
  };
  const latestAngles = () => {
    const latest = current().lights.find((l) => l.id === light.id);
    return latest ? lightAngles(latest.position) : angles;
  };
  const remove = () => {
    const lights = current().lights;
    const index = lights.findIndex((l) => l.id === light.id);
    const next = lights[index + 1] ?? lights[index - 1];
    apply(removeLight(current(), light.id));
    useEditor.getState().setActiveLight(next?.id ?? null);
  };
  return (
    <section
      ref={ref}
      className="lighting-section light-editor"
      aria-labelledby="light-editor-title"
    >
      <div className="lighting-section-heading">
        <h3 id="light-editor-title">
          {light.kind === 'point' ? <Lightbulb size={12} /> : <Sun size={12} />}
          {light.kind === 'point' ? 'Point light' : 'Directional light'}
        </h3>
      </div>
      <LightingField label="Name">
        <input
          className="lighting-text"
          aria-label="Light name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => {
            if (!cancelRename.current && name.trim() && name.trim() !== light.name)
              patchLight(light.id, { name: name.trim() });
            else setName(light.name);
            cancelRename.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') cancelRename.current = true;
            if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
          }}
        />
      </LightingField>
      <LightingField label="Color">
        <ColorControl
          label="Light color"
          value={light.color}
          onChange={(color, checkpoint) => patchLight(light.id, { color }, checkpoint)}
        />
      </LightingField>
      <LightingRange
        label="Intensity"
        value={light.intensity}
        limit={lightingLimits.intensity}
        onChange={(intensity, checkpoint) => patchLight(light.id, { intensity }, checkpoint)}
      />
      {light.kind === 'directional' ? (
        <>
          <LightingRange
            label="Azimuth"
            value={angles.azimuth}
            limit={angleLimit(-180, 180)}
            unit="°"
            onChange={(azimuth, checkpoint) => turn(azimuth, latestAngles().elevation, checkpoint)}
          />
          <LightingRange
            label="Elevation"
            value={angles.elevation}
            limit={angleLimit(-90, 90)}
            unit="°"
            onChange={(elevation, checkpoint) =>
              turn(latestAngles().azimuth, elevation, checkpoint)
            }
          />
          <p className="lighting-help">
            {light.camera
              ? 'Angles are from the camera: 0° azimuth shines from behind you.'
              : 'Azimuth 0° shines from the front, 90° from the right.'}
          </p>
          <LightingField label="Cast shadows">
            <Switch
              label="Cast shadows"
              checked={light.castShadow}
              onChange={(castShadow) => patchLight(light.id, { castShadow })}
            />
          </LightingField>
          {light.castShadow && (!shadows || light.camera) ? (
            <p className="lighting-help">
              {!shadows
                ? 'Turn on Shadows above to see this light’s shadow.'
                : 'Lights that follow the camera don’t cast shadows.'}
            </p>
          ) : null}
        </>
      ) : (
        <>
          <VectorFields
            label={light.camera ? 'Light position from camera' : 'Light position'}
            unit="mm"
            values={light.position}
            onCommit={(position) => patchLight(light.id, { position })}
          />
          <LightingField label="Range">
            <span className="lighting-number">
              <NumericInput
                label="Light range"
                value={light.range}
                min={lightingLimits.range.min}
                max={lightingLimits.range.max}
                onCommit={(range) => patchLight(light.id, { range })}
              />
              <small>mm</small>
            </span>
          </LightingField>
          <p className="lighting-help">
            {light.range ? 'Fades out by this distance.' : '0 reaches everything.'}
          </p>
        </>
      )}
      <LightingField label="Follow camera">
        <Switch
          label="Follow camera"
          checked={light.camera}
          onChange={(follow) => {
            const view = projection.camera;
            const next = view ? reframeLight(light, view.matrixWorld, follow) : light;
            patchLight(light.id, { camera: follow, position: next.position });
          }}
        />
      </LightingField>
      <button className="button secondary light-delete" onClick={remove}>
        <Trash2 size={12} />
        Delete light
      </button>
    </section>
  );
}

function LightingField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lighting-field">
      <span>{label}</span>
      {children}
    </div>
  );
}

function LightingRange({
  label,
  value,
  limit,
  unit,
  onChange,
}: {
  label: string;
  value: number;
  limit: { min: number; max: number; step: number };
  unit?: string;
  onChange: (value: number, checkpoint: boolean) => void;
}) {
  return (
    <div className="lighting-range">
      <span>{label}</span>
      <RangeInput label={label} value={value} limit={limit} onChange={onChange} />
      <span className="lighting-number">
        <NumericInput
          label={`${label} value`}
          value={Number(value.toFixed(limit.step >= 1 ? 1 : 2))}
          min={limit.min}
          max={limit.max}
          step={limit.step}
          onCommit={(next) => onChange(next, true)}
        />
        {unit ? <small>{unit}</small> : null}
      </span>
    </div>
  );
}
