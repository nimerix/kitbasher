import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Eraser, Palette, SlidersHorizontal } from 'lucide-react';
import { partColorModes } from '../core/appearance';
import {
  lightingLimits,
  lightingPresetIds,
  lightingPresets,
  matchingPreset,
  presetLighting,
} from '../core/lighting';
import { sceneLighting, useEditor } from '../core/store';
import { RadioGroup, RangeInput, useDismiss } from './ui';

/** Part colors and lighting, from the viewport's top bar. */
export function DisplayMenu() {
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null),
    trigger = useRef<HTMLButtonElement>(null);
  const mode = useEditor((s) => s.view.partColors);
  const preset = matchingPreset(useEditor(sceneLighting));
  const close = useCallback(() => {
    if (container.current?.contains(document.activeElement)) trigger.current?.focus();
    setOpen(false);
  }, []);
  useDismiss(container, open, close);
  return (
    <div className="display-menu" ref={container}>
      <button
        ref={trigger}
        className={`display-menu-button ${open ? 'active' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        title="Part colors and lighting"
        onClick={() => setOpen(!open)}
      >
        <Palette size={12} />
        <span className="display-menu-text">
          <span className="sr-only">Display: </span>
          {partColorModes.find((m) => m.id === mode)?.label}
          <span className="display-menu-dot"> · </span>
          {preset ? lightingPresets[preset].label : 'Custom'}
        </span>
        <ChevronDown size={11} />
      </button>
      {open ? <DisplayPopover close={close} /> : null}
    </div>
  );
}

function DisplayPopover({ close }: { close: () => void }) {
  const mode = useEditor((s) => s.view.partColors),
    parts = useEditor((s) => s.scene.parts),
    lighting = useEditor(sceneLighting);
  const popover = useRef<HTMLDivElement>(null);
  const preset = matchingPreset(lighting);
  const colored = parts.filter((p) => p.displayColor).length;
  useEffect(() => {
    popover.current?.querySelector<HTMLElement>('[role=radio][tabindex="0"]')?.focus();
  }, []);
  return (
    <div ref={popover} className="display-popover" role="dialog" aria-label="Display">
      <section>
        <h3>Part colors</h3>
        <RadioGroup
          label="Part colors"
          className="display-segmented"
          value={mode}
          options={partColorModes.map((m) => ({ id: m.id, label: m.label }))}
          onChange={(partColors) => useEditor.getState().setView({ partColors })}
        />
        <p className="display-help">{partColorModes.find((m) => m.id === mode)?.description}</p>
        {colored ? (
          <button
            className="display-action"
            onClick={() =>
              useEditor.getState().setDisplayColor(
                parts.map((p) => p.id),
                null,
              )
            }
          >
            <Eraser size={13} />
            Clear all editor colors
            <small>{colored}</small>
          </button>
        ) : null}
      </section>
      <section>
        <h3>Lighting</h3>
        <RadioGroup
          label="Lighting preset"
          className="display-presets"
          value={preset}
          options={lightingPresetIds.map((id) => ({
            id,
            label: (
              <>
                <span>
                  <strong>{lightingPresets[id].label}</strong>
                  <small>{lightingPresets[id].description}</small>
                </span>
                {preset === id ? <Check size={13} /> : null}
              </>
            ),
          }))}
          onChange={(id) => useEditor.getState().setLighting(presetLighting(id))}
        />
        <div className="display-range">
          <span>Brightness</span>
          <RangeInput
            label="Brightness"
            value={lighting.exposure}
            limit={lightingLimits.exposure}
            onChange={(exposure, checkpoint) =>
              useEditor
                .getState()
                .setLighting({ ...sceneLighting(useEditor.getState()), exposure }, checkpoint)
            }
          />
          <output>{Number(lighting.exposure.toFixed(2))}×</output>
        </div>
        <button
          className="display-action"
          onClick={() => {
            useEditor.getState().setLightingPanel(true);
            close();
          }}
        >
          <SlidersHorizontal size={13} />
          Edit lights…
        </button>
      </section>
    </div>
  );
}
