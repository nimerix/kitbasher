import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  CheckCircle2,
  ChevronRight,
  FileBox,
  FileJson,
  FolderOpen,
  Layers3,
  Link2,
  LoaderCircle,
  MousePointer2,
  Package,
  Plus,
  ScanLine,
  ShieldCheck,
  Upload,
  X,
} from 'lucide-react';
import { useEditor } from '../core/store';
import { primaryShortcut, saveCurrentScene } from '../core/commands';
import {
  download,
  downloadScene,
  export3mf,
  exportBlenderPackage,
  exportGlb,
  exportStl,
  importModels,
  modelDimensions,
  safeFilename,
} from '../core/files';
import type { ImportOptions } from '../core/files';
import { mergeParts } from '../core/merge';
import { createSample } from '../core/sample';
import { sceneSubset } from '../core/scene-file';
import { Modal } from './ui';

export type ExportFormat = 'glb' | '3mf' | 'stl' | 'kitbash' | 'blender';

function ExportDialog() {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    notify = useEditor((s) => s.notify);
  const [format, setFormat] = useState<ExportFormat>('glb'),
    [scope, setScope] = useState('all'),
    [name, setName] = useState(scene.name),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const parts = scene.parts.filter((p) =>
    scope === 'selected' ? selected.includes(p.id) : scope === 'visible' ? p.visible : true,
  );
  const dimensions = modelDimensions(parts);
  const options: {
    id: ExportFormat;
    name: string;
    ext: string;
    description: string;
    icon: typeof Box;
  }[] = [
    {
      id: 'glb',
      name: 'Blender / glTF',
      ext: '.glb',
      description: 'Separate objects, names, colors & transforms',
      icon: Box,
    },
    {
      id: 'blender',
      name: 'Blender with joints',
      ext: '.zip',
      description: 'GLB + Blender script that creates a .blend file',
      icon: Link2,
    },
    {
      id: '3mf',
      name: 'Multipart model',
      ext: '.3mf',
      description: 'Separate parts, placement & millimeter scale',
      icon: Package,
    },
    {
      id: 'stl',
      name: 'Print-ready geometry',
      ext: '.stl',
      description: 'All chosen triangles in a single binary STL',
      icon: Layers3,
    },
    {
      id: 'kitbash',
      name: 'Kitbasher scene',
      ext: '.kitbash',
      description: 'Editable parts, joints, colors & source metadata',
      icon: FileJson,
    },
  ];
  const close = () => {
    if (!busy) useEditor.getState().setModal(null);
  };
  const doExport = async () => {
    setBusy(true);
    setError('');
    try {
      const filename = safeFilename(name),
        document = sceneSubset(scene, parts);
      if (format === 'glb')
        await download(await exportGlb(document, parts), `${filename}.glb`, 'model/gltf-binary');
      if (format === 'blender')
        await download(
          await exportBlenderPackage(document, parts),
          `${filename}-blender.zip`,
          'application/zip',
        );
      if (format === '3mf')
        await download(export3mf(document, parts), `${filename}.3mf`, 'model/3mf');
      if (format === 'stl') await download(exportStl(parts), `${filename}.stl`, 'model/stl');
      if (format === 'kitbash') await downloadScene(document, name);
      notify(
        `Exported ${parts.length} ${parts.length === 1 ? 'part' : 'parts'} · ${options.find((o) => o.id === format)!.ext}`,
      );
      useEditor.getState().setModal(null);
    } catch (error) {
      // 3MF is XML text, so a dense assembly can exceed the browser's string limit.
      setError(
        error instanceof RangeError
          ? 'This assembly is too large for this format. Export it as STL or a Kitbasher scene.'
          : (error as Error).message,
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Ready for the next step."
      subtitle="Take your assembly wherever you make things."
      onClose={close}
      wide
    >
      <div className="export-layout">
        <div className="export-formats">
          <div className="field-label">FILE FORMAT</div>
          {options.map((option) => (
            <button
              key={option.id}
              className={`export-format ${format === option.id ? 'active' : ''}`}
              onClick={() => setFormat(option.id)}
            >
              <option.icon size={20} strokeWidth={1.4} />
              <span>
                <strong>{option.name}</strong>
                <small>{option.description}</small>
              </span>
              <span className="format-extension">{option.ext}</span>
              {format === option.id ? (
                <CheckCircle2 size={16} />
              ) : (
                <span className="format-radio" />
              )}
            </button>
          ))}
        </div>
        <div className="export-settings">
          <label className="form-field">
            <span>File name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              aria-label="Export file name"
            />
          </label>
          <label className="form-field">
            <span>Include</span>
            <select
              aria-label="Export scope"
              value={scope}
              onChange={(e) => setScope(e.target.value)}
            >
              <option value="all">All parts ({scene.parts.length})</option>
              <option value="visible">
                Visible parts ({scene.parts.filter((p) => p.visible).length})
              </option>
              <option value="selected" disabled={!selected.length}>
                Selected parts ({selected.length})
              </option>
            </select>
          </label>
          <div className="export-summary">
            <Package size={28} strokeWidth={1} />
            <strong>
              {parts.length} {parts.length === 1 ? 'part' : 'parts'}
            </strong>
            <span>
              {dimensions
                .toArray()
                .map((n) => n.toFixed(1))
                .join(' × ')}{' '}
              mm
            </span>
            <small>
              {format === 'glb'
                ? 'Meters in GLB · real-world size in Blender'
                : format === '3mf'
                  ? 'Millimeters · independent mesh objects'
                  : format === 'stl'
                    ? 'Millimeters · Y-up converted to Z-up'
                    : format === 'blender'
                      ? 'Joint anchors & axis locks included'
                      : 'Complete assembly data included'}
            </small>
          </div>
          <p className="export-note">
            <ShieldCheck size={13} />
            Your files stay on your device.
          </p>
        </div>
      </div>
      {format === 'stl' ? (
        <div className="dialog-info">
          <InfoIcon />
          <span>
            STL stores triangles only. Use Boolean union first if you need a continuous solid.
            Meshes are not automatically made watertight.
          </span>
        </div>
      ) : null}
      {format === '3mf' ? (
        <div className="dialog-info">
          <InfoIcon />
          <span>
            3MF keeps each part separate. Joint constraints and material colors are preserved in
            .kitbash and the Blender package.
          </span>
        </div>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-footer">
        <button className="button secondary" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button
          className="button primary"
          disabled={busy || !parts.length || !name.trim()}
          onClick={doExport}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : <ArrowDownToLine size={15} />}{' '}
          {busy ? 'Preparing file…' : 'Export assembly'}
          <ArrowRight size={14} />
        </button>
      </div>
    </Modal>
  );
}

function InfoIcon() {
  return <ShieldCheck size={16} />;
}

export function ImportDialog({ initialFiles = [] }: { initialFiles?: File[] }) {
  const [files, setFiles] = useState<File[]>(initialFiles),
    [options, setOptions] = useState<ImportOptions>({ units: 'auto', up: 'auto', center: true }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const input = useRef<HTMLInputElement>(null);
  const close = () => {
    if (!busy) useEditor.getState().setModal(null);
  };
  const doImport = async () => {
    setBusy(true);
    setError('');
    const { setBusy: setStatus } = useEditor.getState();
    try {
      const parts = await importModels(files, options, setStatus);
      const state = useEditor.getState();
      state.addParts(parts);
      state.setModal(null);
      state.notify(`Imported ${parts.length} ${parts.length === 1 ? 'part' : 'parts'}`);
    } catch (error) {
      setError((error as Error).message);
    } finally {
      setStatus(null);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Every assembly starts with parts."
      subtitle="Import your scans, meshes, or an existing multipart model."
      onClose={close}
    >
      <input
        ref={input}
        type="file"
        multiple
        accept=".stl,.obj,.glb,.gltf,.3mf"
        className="sr-only"
        aria-label="Choose model files"
        onChange={(e) => {
          setFiles(Array.from(e.target.files ?? []));
          setError('');
          // Otherwise choosing a file again after removing it fires no change event.
          e.target.value = '';
        }}
      />
      <button
        className="file-drop-area"
        onClick={() => input.current?.click()}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setFiles(Array.from(e.dataTransfer.files));
          setError('');
        }}
      >
        <div className="drop-area-icon">
          <Upload size={25} strokeWidth={1.3} />
        </div>
        <strong>
          {files.length
            ? `${files.length} ${files.length === 1 ? 'file' : 'files'} selected`
            : 'Drop your models here'}
        </strong>
        <span>
          {files.length ? 'Click to choose different files' : 'or click to browse your files'}
        </span>
        <small>STL · OBJ · GLB · embedded GLTF · 3MF</small>
      </button>
      {files.length ? (
        <div className="import-file-list">
          {files.map((file, i) => (
            <div key={`${file.name}-${i}`}>
              <FileBox size={15} />
              <span>{file.name}</span>
              <small>{(file.size / 1024 / 1024).toFixed(1)} MB</small>
              <button
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles(files.filter((_, n) => n !== i))}
              >
                <X size={13} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      <div className="import-options">
        <label className="form-field">
          <span>Source units</span>
          <select
            value={options.units}
            onChange={(e) =>
              setOptions({ ...options, units: e.target.value as ImportOptions['units'] })
            }
          >
            <option value="auto">Automatic by format</option>
            <option value="mm">Millimeters</option>
            <option value="cm">Centimeters</option>
            <option value="m">Meters</option>
            <option value="in">Inches</option>
          </select>
        </label>
        <label className="form-field">
          <span>Up axis</span>
          <select
            value={options.up}
            onChange={(e) => setOptions({ ...options, up: e.target.value as ImportOptions['up'] })}
          >
            <option value="auto">Automatic by format</option>
            <option value="z">Z up (STL / CAD)</option>
            <option value="y">Y up (glTF)</option>
          </select>
        </label>
      </div>
      <label className="checkbox-field">
        <input
          type="checkbox"
          checked={options.center}
          onChange={(e) => setOptions({ ...options, center: e.target.checked })}
        />
        <span>Center the imported assembly on the ground plane</span>
      </label>
      <p className="field-help">
        Relative placement is preserved. Auto uses meters / Y up for glTF and millimeters / Z up for
        STL, OBJ, and 3MF. For textured assets, use a self-contained GLB.
      </p>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-footer">
        <button className="button secondary" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button className="button primary" disabled={!files.length || busy} onClick={doImport}>
          {busy ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}{' '}
          {busy ? 'Reading geometry…' : 'Import parts'}
        </button>
      </div>
    </Modal>
  );
}

function MergeDialog() {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    parts = scene.parts.filter((p) => selected.includes(p.id));
  const [mode, setMode] = useState<'combine' | 'union'>('combine'),
    [name, setName] = useState('Merged assembly'),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  useEffect(() => () => worker.current?.terminate(), []);
  const close = () => {
    if (busy) {
      worker.current?.terminate();
      worker.current = null;
    }
    useEditor.getState().setModal(null);
  };
  const doMerge = async () => {
    setBusy(true);
    setError('');
    try {
      const part = await mergeParts(parts, mode, name, (w) => {
        worker.current = w;
      });
      const state = useEditor.getState();
      state.replaceWithMerged(
        part,
        parts.map((p) => p.id),
      );
      state.setModal(null);
      state.notify(
        `${parts.length} parts ${mode === 'union' ? 'united' : 'combined'} into one mesh`,
      );
    } catch (error) {
      setError((error as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title="Make it one."
      subtitle={`${parts.length} selected parts → one mesh object`}
      onClose={close}
    >
      <div className="merge-illustration">
        <div>
          <Box size={28} />
          <Box size={28} />
          <Box size={28} />
        </div>
        <ChevronRight size={20} />
        <div className="merged-cube">
          <Box size={45} strokeWidth={1.3} />
        </div>
      </div>
      <label className="form-field">
        <span>Merged part name</span>
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="merge-options">
        <button
          className={mode === 'combine' ? 'active' : ''}
          disabled={busy}
          onClick={() => setMode('combine')}
        >
          <Layers3 size={22} />
          <span>
            <strong>Combine meshes</strong>
            <small>
              One object. Keeps all original triangles. Fast and reliable for scanned parts.
            </small>
          </span>
          {mode === 'combine' ? <CheckCircle2 size={17} /> : null}
        </button>
        <button
          className={mode === 'union' ? 'active' : ''}
          disabled={busy}
          onClick={() => setMode('union')}
        >
          <Package size={22} />
          <span>
            <strong>Boolean union</strong>
            <small>Fuses overlapping volumes. Requires closed, manifold meshes.</small>
          </span>
          {mode === 'union' ? <CheckCircle2 size={17} /> : null}
        </button>
      </div>
      <div className="dialog-info">
        <ShieldCheck size={16} />
        <span>
          This replaces the selected parts and their joints. You can undo it. Save a scene copy to
          keep the original assembly.
        </span>
      </div>
      {parts.some((p) => p.locked) ? (
        <p className="form-error">Unlock the selected parts before merging.</p>
      ) : null}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="modal-footer">
        <button className="button secondary" onClick={close}>
          {busy ? 'Cancel operation' : 'Cancel'}
        </button>
        <button
          className="button primary"
          disabled={parts.length < 2 || busy || parts.some((p) => p.locked) || !name.trim()}
          onClick={doMerge}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : <Layers3 size={15} />}{' '}
          {busy ? 'Merging geometry…' : 'Merge parts'}
        </button>
      </div>
    </Modal>
  );
}

function RenameDialog() {
  const part = useEditor((state) =>
    state.scene.parts.find((part) => part.id === state.selected[0]),
  );
  const [name, setName] = useState(part?.name ?? '');
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const close = () => useEditor.getState().setModal(null);
  return (
    <Modal
      title="Rename component"
      subtitle="Give this part a name that is easy to find."
      onClose={close}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!part || !name.trim()) return;
          useEditor.getState().patchParts([part.id], { name: name.trim() });
          close();
        }}
      >
        <div className="modal-body">
          <label className="form-field">
            Component name
            <input
              ref={input}
              aria-label="Component name"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button type="button" className="button secondary" onClick={close}>
            Cancel
          </button>
          <button type="submit" className="button primary" disabled={!part || !name.trim()}>
            Rename component
          </button>
        </div>
      </form>
    </Modal>
  );
}

function HelpDialog() {
  const controls = [
    ['Orbit tool', 'O · left drag or direction buttons'],
    ['Pan tool', 'H · left drag or direction buttons'],
    ['Orbit while picking / painting', 'Middle drag / hold Space + drag'],
    ['Fine move / rotate / scale', 'Hold Shift while dragging · 10× finer'],
    ['Pan', 'Right drag or Shift + left drag'],
    ['Zoom', 'Scroll / pinch'],
    ['Select multiple', 'Shift / Ctrl / ⌘ + click'],
    ['Select all components', primaryShortcut('A')],
    ['Deselect all', primaryShortcut('A', true) + ' / Esc'],
    [
      'Copy / Cut / Paste components',
      `${primaryShortcut('C')} / ${primaryShortcut('X')} / ${primaryShortcut('V')}`,
    ],
    ['Rename component', 'F2'],
    ['Find a component', primaryShortcut('F')],
    ['Context menu', 'Right-click / Shift + F10'],
    ['Center orbit on selection', '. (keeps zoom)'],
    ['Orbit selection by default', 'Shift + .'],
    ['Focus selection', 'F (frames selection)'],
    ['Frame all parts', 'Home'],
    ['Move / Rotate / Scale', 'G / R / S'],
    ['Paint contact surfaces', 'B · drag to paint'],
    ['Paint brush size / Erase', '[ and ] / hold Alt'],
    ['Pick pivot on model', 'P · click a surface'],
    ['Align / Joint / Measure', 'A / J / D'],
    ['Front / Right / Top', '1 / 3 / 7'],
    ['Toggle projection', '5'],
    ['Undo / Redo', `${primaryShortcut('Z')} / ${primaryShortcut('Z', true)} / Ctrl+Y`],
    ['Save / Open', `${primaryShortcut('S')} / ${primaryShortcut('O')}`],
    ['New assembly / Import', `${primaryShortcut('N')} / ${primaryShortcut('I')}`],
    ['Export', primaryShortcut('E', true)],
    ['Duplicate', primaryShortcut('D')],
    ['Delete unlocked parts', 'Delete / Backspace'],
    ['Finish / Cancel tool', 'Enter / Esc'],
    ['Exit camera tool', 'Esc (keeps picked pairs)'],
  ];
  return (
    <Modal
      title="A workbench that gets out of your way."
      subtitle="A few useful things to know before your next assembly."
      onClose={() => useEditor.getState().setModal(null)}
      wide
    >
      <div className="help-layout">
        <div>
          <h3>
            <MousePointer2 size={16} />
            Navigation & shortcuts
          </h3>
          <div className="shortcut-list">
            {controls.map(([name, key]) => (
              <div key={name}>
                <span>{name}</span>
                <kbd>{key}</kbd>
              </div>
            ))}
          </div>
        </div>
        <div>
          <h3>
            <ScanLine size={16} />
            Getting a precise fit
          </h3>
          <ol className="help-steps">
            <li>
              Select the moving part, then choose <strong>Align</strong>.
            </li>
            <li>Pick a method and a target part or reference plane.</li>
            <li>
              Click matching source and target surfaces. Plane alignment uses the face normals.
            </li>
            <li>For a 3+ point fit, add at least three pairs spread across a surface.</li>
            <li>
              For contact painting, paint a moving patch, then its matching target patch. Finish at
              least three pairs and choose Fit contact surfaces. Middle-drag or hold Space to orbit,
              or right-drag to pan, without losing your patches.
            </li>
            <li>
              Paint stays on one connected surface. Enable Stay on seed plane to limit both face
              angle and distance from your first hit. Use a separate pair for each disconnected
              patch.
            </li>
            <li>
              For coarse placement, choose Mate planes, Parallel, Perpendicular, or Angle with one
              or more painted pairs. Keep constraint active saves the relationship; edit, suppress,
              or delete it in the Constraints tab. Plane mates allow sliding and twisting; angle
              constraints leave translation free.
            </li>
            <li>
              Press P and click a spot to set a saved pivot for orbit, rotation, and scale.
              Connected joints keep their own rotation anchors.
            </li>
            <li>
              Apply, then create a <strong>Joint</strong> to lock anchors together. Leave selected
              rotation axes free for hinges.
            </li>
          </ol>
          <h3>
            <FolderOpen size={16} />
            Saving & exporting
          </h3>
          <p>
            Save a <strong>.kitbash</strong> scene for editable geometry and joints. Changes also
            recover automatically in this browser.
          </p>
          <p>
            <strong>GLB</strong> opens in Blender with separate named parts. The Blender package
            includes a script to recreate joint anchors and save a native <strong>.blend</strong>.{' '}
            <strong>3MF</strong> keeps multipart geometry at millimeter scale.
          </p>
          <p className="help-limitation">
            Geometry and vertex colors are preserved on import. Textures, rigging, and animation are
            not retained. Boolean union needs repaired, closed scan meshes.
          </p>
        </div>
      </div>
    </Modal>
  );
}

function NewDialog() {
  const create = (sample: boolean) => {
    useEditor
      .getState()
      .setScene(sample ? createSample() : { name: 'Untitled assembly', parts: [], joints: [] });
  };
  return (
    <Modal
      title="Start something new."
      subtitle="Save your current assembly before opening a fresh workbench."
      onClose={() => useEditor.getState().setModal(null)}
    >
      <div className="new-options">
        <button onClick={() => create(false)}>
          <Plus size={25} />
          <strong>Empty assembly</strong>
          <span>A clean space for your own parts.</span>
          <ArrowRight size={17} />
        </button>
        <button onClick={() => create(true)}>
          <Box size={25} />
          <strong>Scout · MK.04</strong>
          <span>Explore the editable sample assembly.</span>
          <ArrowRight size={17} />
        </button>
      </div>
      <div className="modal-footer">
        <button className="button secondary" onClick={() => useEditor.getState().setModal(null)}>
          Cancel
        </button>
        <button className="button secondary" onClick={saveCurrentScene}>
          <ArrowDownToLine size={14} />
          Save current scene
        </button>
      </div>
    </Modal>
  );
}

export function Dialogs({ importFiles }: { importFiles: File[] }) {
  const modal = useEditor((s) => s.modal);
  if (modal === 'export') return <ExportDialog />;
  if (modal === 'import') return <ImportDialog initialFiles={importFiles} />;
  if (modal === 'merge') return <MergeDialog />;
  if (modal === 'help') return <HelpDialog />;
  if (modal === 'new') return <NewDialog />;
  if (modal === 'rename') return <RenameDialog />;
  return null;
}
