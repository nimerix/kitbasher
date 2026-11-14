import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Cloud,
  Copy,
  ClipboardPaste,
  Scissors,
  Pencil,
  BoxSelect,
  Crosshair,
  Paintbrush,
  Pin,
  FilePlus2,
  FolderOpen,
  GitMerge,
  Grid2X2,
  Hand,
  Import,
  Link2,
  LoaderCircle,
  Magnet,
  Shield,
  Maximize,
  MousePointer2,
  Move3D,
  Move,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Radius,
  Redo2,
  Rotate3D,
  Ruler,
  Save,
  Scaling,
  ScanEye,
  ScanLine,
  Settings2,
  SunMedium,
  Undo2,
  X,
} from 'lucide-react';
import { canRedo, canUndo, liveHost, liveSession, useEditor } from './core/store';
import {
  downloadCurrentScene,
  editorCommands,
  executeEditorCommand,
  saveCurrentScene,
} from './core/commands';
import { driveAutosave, flushDriveBeforeReplace, useDrive } from './core/drive-sync';
import { DriveButton, GoogleDriveDialog } from './components/GoogleDrive';
import { ActivityCenter, NotificationToasts } from './components/ActivityCenter';
import type { CommandId } from './core/commands';
import { isEditableTarget } from './core/context-menu';
import { EditorContextMenu } from './components/EditorContextMenu';
import { readSceneFile } from './core/scene-file';
import { useKeyboard, useLiveSession, useRecovery } from './hooks/useWorkbench';
import { usePreferences, useShortcut, withShortcut } from './core/preferences';
import { PreferencesPanel } from './components/PreferencesPanel';
import { PartsPanel } from './components/PartsPanel';
import { Inspector } from './components/Inspector';
import { moveSteps, rotationSteps } from './components/TransformAdjustments';
import { Dialogs } from './components/Dialogs';
import { IconButton, Keyboard, Logo, Modal, NumericInput, useDismiss } from './components/ui';
import { clipLimits } from './core/clipping';
import { partColorModes } from './core/appearance';
import type { SceneDocument, Tool } from './core/types';

const Viewport = lazy(() =>
  import('./components/Viewport').then((module) => ({ default: module.Viewport })),
);

function Header({ openScene }: { openScene: () => void }) {
  const name = useEditor((s) => s.scene.name),
    revision = useEditor((s) => s.revision),
    savedRevision = useEditor((s) => s.savedRevision),
    driveFile = useEditor((s) => s.driveFile);
  const driveSavedRevision = useDrive((s) => s.savedRevision);
  useEditor((state) => state.past);
  useEditor((state) => state.future);
  useEditor((state) => state.sharedHistory);
  useEditor((state) => state.selected);
  useEditor((state) => state.isolated);
  useEditor((state) => state.view.isolation);
  useEditor((state) => state.clipboard);
  useEditor((state) => state.busy);
  useEditor((state) => state.paintHistory);
  usePreferences((state) => state.keybindings);
  const partColors = useEditor((state) => state.view.partColors);
  const preferencesKey = useShortcut('preferences');
  const [menu, setMenu] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(name);
  const menus = useRef<HTMLElement>(null);
  const cancelRename = useRef(false);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(menus, !!menu, closeMenu);
  const act = (action: () => void) => {
    action();
    setMenu(null);
  };
  const save = () => executeEditorCommand('save');
  const commands = editorCommands({ openScene });
  const commandItem = (id: CommandId, Icon: typeof Copy) => (
    <button
      disabled={!commands[id].enabled}
      onClick={() => act(() => executeEditorCommand(id, { openScene }))}
    >
      <Icon size={14} />
      {commands[id].label}
      {commands[id].shortcut ? <kbd>{commands[id].shortcut}</kbd> : null}
    </button>
  );
  return (
    <header className="topbar">
      <div className="brand">
        <Logo />
        <span>
          kitbasher<span className="brand-period">.</span>
        </span>
      </div>
      <div className="header-divider" />
      <nav className="app-menus" aria-label="Editor menus" ref={menus}>
        {['File', 'Edit', 'View'].map((label) => (
          <div key={label} className="app-menu">
            <button
              className={menu === label ? 'active' : ''}
              aria-haspopup="true"
              aria-expanded={menu === label}
              onClick={() => setMenu(menu === label ? null : label)}
            >
              {label}
            </button>
            {menu === label ? (
              <div className="dropdown-menu">
                {label === 'File' ? (
                  <>
                    {commandItem('new', FilePlus2)}
                    {commandItem('open', FolderOpen)}
                    {commandItem('import', Import)}
                    <hr />
                    {commandItem('save', Save)}
                    {driveFile ? (
                      <button onClick={() => act(() => void downloadCurrentScene())}>
                        <ArrowDownToLine size={14} />
                        Download scene copy
                      </button>
                    ) : null}
                    {!liveSession ? (
                      <button onClick={() => act(() => useDrive.setState({ dialogOpen: true }))}>
                        <Cloud size={14} />
                        Google Drive…
                      </button>
                    ) : null}
                    {commandItem('export', ArrowDownToLine)}
                    <hr />
                    {commandItem('preferences', Settings2)}
                  </>
                ) : label === 'Edit' ? (
                  <>
                    {commandItem('undo', Undo2)}
                    {commandItem('redo', Redo2)}
                    <hr />
                    {commandItem('cut', Scissors)}
                    {commandItem('copy', Copy)}
                    {commandItem('paste', ClipboardPaste)}
                    {commandItem('duplicate', Copy)}
                    <hr />
                    {commandItem('rename', Pencil)}
                    {commandItem('delete', X)}
                    <hr />
                    {commandItem('selectAll', BoxSelect)}
                    {commandItem('deselect', X)}
                  </>
                ) : (
                  <>
                    <button onClick={() => act(() => useEditor.getState().focus(undefined, true))}>
                      <Maximize size={14} />
                      Frame all
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          useEditor.getState().setView({ grid: !useEditor.getState().view.grid }),
                        )
                      }
                    >
                      <Grid2X2 size={14} />
                      Toggle grid
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          useEditor
                            .getState()
                            .setView({ joints: !useEditor.getState().view.joints }),
                        )
                      }
                    >
                      <Link2 size={14} />
                      Show joints
                    </button>
                    <button
                      onClick={() =>
                        act(() =>
                          useEditor
                            .getState()
                            .setView({ wireframe: !useEditor.getState().view.wireframe }),
                        )
                      }
                    >
                      <Box size={14} />
                      Wireframe
                    </button>
                    <hr />
                    <span className="dropdown-label" aria-hidden="true">
                      Part colors
                    </span>
                    {partColorModes.map((mode) => (
                      <button
                        key={mode.id}
                        aria-label={`${mode.label} part colors`}
                        aria-pressed={partColors === mode.id}
                        title={mode.description}
                        onClick={() =>
                          act(() => useEditor.getState().setView({ partColors: mode.id }))
                        }
                      >
                        {partColors === mode.id ? (
                          <Check size={14} className="dropdown-check" />
                        ) : (
                          <span className="dropdown-check" />
                        )}
                        {mode.label}
                      </button>
                    ))}
                    <button onClick={() => act(() => useEditor.getState().setLightingPanel(true))}>
                      <SunMedium size={14} />
                      Lighting…
                    </button>
                    <hr />
                    {commandItem('isolate', ScanEye)}
                    {commandItem('isolateNearby', Radius)}
                  </>
                )}
              </div>
            ) : null}
          </div>
        ))}
      </nav>
      <div className="document-title">
        {editing ? (
          <input
            autoFocus
            value={draft}
            aria-label="Assembly name"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (!cancelRename.current) useEditor.getState().renameScene(draft);
              cancelRename.current = false;
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelRename.current = true;
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
            }}
          />
        ) : (
          <button
            title="Rename assembly"
            onClick={() => {
              setDraft(name);
              setEditing(true);
            }}
          >
            <span>{name}</span>
            {revision !== (driveFile ? driveSavedRevision : savedRevision) ? (
              <span
                className="unsaved-dot"
                title={driveFile ? 'Changes not yet saved to Drive' : 'Changes since file download'}
              />
            ) : null}
            <ChevronDown size={11} />
          </button>
        )}
        <span className="document-type">Assembly</span>
      </div>
      <div className="header-actions">
        <ActivityCenter />
        <a
          className="icon-button"
          href="./docs/"
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Documentation"
          title="Documentation"
        >
          <BookOpen size={17} />
        </a>
        <IconButton
          label="Help and keyboard shortcuts"
          onClick={() => useEditor.getState().setModal('help')}
        >
          <CircleHelp size={17} />
        </IconButton>
        <IconButton
          label={withShortcut('Preferences', preferencesKey)}
          onClick={() => executeEditorCommand('preferences')}
        >
          <Settings2 size={17} />
        </IconButton>
        <DriveButton />
        {!driveFile ? (
          <button className="button secondary save-button" aria-label="Save scene" onClick={save}>
            <Save size={14} />
            <span>Save scene</span>
          </button>
        ) : null}
        <button
          className="button primary export-button"
          onClick={() => useEditor.getState().setModal('export')}
        >
          <ArrowDownToLine size={15} />
          <span>Export</span>
          <ChevronDown size={12} />
        </button>
      </div>
    </header>
  );
}

function Toolbar({
  left,
  right,
  toggleLeft,
  toggleRight,
}: {
  left: boolean;
  right: boolean;
  toggleLeft: () => void;
  toggleRight: () => void;
}) {
  const tool = useEditor((s) => s.tool),
    view = useEditor((s) => s.view),
    undoable = useEditor((s) => canUndo(s) || s.paintHistory.length > 0),
    redoable = useEditor(canRedo),
    selected = useEditor((s) => s.selected);
  const pivotPicking = useEditor((s) => s.pivotPicking);
  const surfacePainting = useEditor((s) => s.tool === 'align' && s.operation.mode === 'surface');
  const keys = {
    select: useShortcut('select'),
    move: useShortcut('move'),
    rotate: useShortcut('rotate'),
    scale: useShortcut('scale'),
    transform: useShortcut('transform'),
    undo: useShortcut('undo'),
    redo: useShortcut('redo'),
    pivot: useShortcut('pivot'),
    align: useShortcut('align'),
    paint: useShortcut('paint'),
    anchors: useShortcut('anchors'),
    joint: useShortcut('joint'),
    measure: useShortcut('measure'),
  };
  const tools: { id: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
    { id: 'select', label: 'Select', shortcut: keys.select, icon: MousePointer2 },
    { id: 'translate', label: 'Move', shortcut: keys.move, icon: Move3D },
    { id: 'rotate', label: 'Rotate', shortcut: keys.rotate, icon: Rotate3D },
    { id: 'scale', label: 'Scale', shortcut: keys.scale, icon: Scaling },
    { id: 'transform', label: 'Transform', shortcut: keys.transform, icon: Move },
  ];
  return (
    <div className="toolbar" role="toolbar" aria-label="Assembly tools">
      <div className="toolbar-left">
        <IconButton label={left ? 'Hide parts panel' : 'Show parts panel'} onClick={toggleLeft}>
          {left ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </IconButton>
        <span className="tool-divider" />
        <div className="history-tools">
          <IconButton
            label={withShortcut('Undo', keys.undo)}
            disabled={!undoable}
            onClick={() => executeEditorCommand('undo')}
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            label={withShortcut('Redo', keys.redo)}
            disabled={!redoable}
            onClick={() => useEditor.getState().redo()}
          >
            <Redo2 size={15} />
          </IconButton>
        </div>
        <span className="tool-divider history-divider" />
        <div className="transform-tools">
          {tools.map(({ id, label, shortcut, icon: Icon }) => (
            <IconButton
              key={id}
              label={withShortcut(label, shortcut)}
              active={tool === id}
              onClick={() => useEditor.getState().setTool(id)}
            >
              <Icon size={17} />
              {id === 'translate' || id === 'rotate' || id === 'transform' ? (
                <span className="transform-tool-name">{label}</span>
              ) : null}
            </IconButton>
          ))}
          <IconButton
            label={withShortcut('Pick pivot point', keys.pivot)}
            active={pivotPicking}
            onClick={() => useEditor.getState().setPivotPicking(!pivotPicking)}
          >
            <Crosshair size={17} />
          </IconButton>
        </div>
        <span className="tool-divider" />
        <button
          className={`tool-button ${tool === 'align' && !surfacePainting ? 'active' : ''}`}
          title={withShortcut('Align parts', keys.align)}
          onClick={() => useEditor.getState().setTool('align')}
        >
          <ScanLine size={16} />
          <span>Align</span>
          {keys.align ? <Keyboard>{keys.align}</Keyboard> : null}
        </button>
        <button
          className={`tool-button paint-tool ${surfacePainting ? 'active' : ''}`}
          title={withShortcut('Paint contact surfaces', keys.paint)}
          onClick={() => {
            useEditor.getState().setTool('align');
            useEditor.getState().setOperation({ mode: 'surface' });
          }}
        >
          <Paintbrush size={16} />
          <span>Contact paint</span>
          {keys.paint ? <Keyboard>{keys.paint}</Keyboard> : null}
        </button>
        <button
          className={`tool-button ${tool === 'pins' ? 'active' : ''}`}
          title="Pin parts in space"
          onClick={() => useEditor.getState().setTool('pins')}
        >
          <Pin size={16} />
          <span>Pin</span>
        </button>
        <button
          className={`tool-button ${tool === 'anchors' ? 'active' : ''}`}
          title={withShortcut('Rigid anchor fit', keys.anchors)}
          onClick={() => useEditor.getState().setTool('anchors')}
        >
          <Crosshair size={16} />
          <span>Anchors</span>
          {keys.anchors ? <Keyboard>{keys.anchors}</Keyboard> : null}
        </button>
        <button
          className={`tool-button ${tool === 'joint' ? 'active' : ''}`}
          title={withShortcut('Create joint', keys.joint)}
          onClick={() => useEditor.getState().setTool('joint')}
        >
          <Link2 size={16} />
          <span>Joint</span>
          {keys.joint ? <Keyboard>{keys.joint}</Keyboard> : null}
        </button>
        <button
          className="tool-button merge-tool"
          disabled={selected.length < 2}
          onClick={() => useEditor.getState().setModal('merge')}
        >
          <GitMerge size={16} />
          <span>Merge</span>
        </button>
        <span className="tool-divider measurement-divider" />
        <IconButton
          label={withShortcut('Measure distance', keys.measure)}
          active={tool === 'measure'}
          onClick={() => useEditor.getState().setTool('measure')}
        >
          <Ruler size={17} />
        </IconButton>
      </div>
      <div className="toolbar-right">
        <button
          className={`snap-toggle ${view.snap ? 'active' : ''}`}
          aria-label="Snap"
          title="Snap transforms to increments"
          aria-pressed={view.snap}
          onClick={() => useEditor.getState().setView({ snap: !view.snap })}
        >
          <Magnet size={15} />
          <span>Snap</span>
          <span className={`mini-toggle ${view.snap ? 'on' : ''}`} />
        </button>
        {view.snap && tool === 'scale' ? (
          <span className="scale-snap-step">10%</span>
        ) : view.snap ? (
          <select
            className="snap-step"
            aria-label={tool === 'rotate' ? 'Snap angle' : 'Snap distance'}
            value={tool === 'rotate' ? view.rotationSnapStep : view.snapStep}
            onChange={(e) =>
              useEditor
                .getState()
                .setView(
                  tool === 'rotate'
                    ? { rotationSnapStep: Number(e.target.value) }
                    : { snapStep: Number(e.target.value) },
                )
            }
          >
            {[
              ...new Set([
                ...(tool === 'rotate' ? rotationSteps : moveSteps),
                tool === 'rotate' ? view.rotationSnapStep : view.snapStep,
              ]),
            ]
              .sort((a, b) => a - b)
              .map((step) => (
                <option key={step} value={step}>
                  {step}
                  {tool === 'rotate' ? '°' : ' mm'}
                </option>
              ))}
          </select>
        ) : null}
        <span className="tool-divider" />
        <button
          className={`clip-toggle ${view.clip.enabled ? 'active' : ''}`}
          title="Keep parts from passing through each other. Moves slide along other parts, and fits stop at their surfaces."
          aria-label="Avoid clipping"
          aria-pressed={view.clip.enabled}
          onClick={() =>
            useEditor.getState().setView({ clip: { ...view.clip, enabled: !view.clip.enabled } })
          }
        >
          <Shield size={15} />
          <span>No clip</span>
          <span className={`mini-toggle ${view.clip.enabled ? 'on' : ''}`} />
        </button>
        {view.clip.enabled ? (
          <label
            className="clip-overlap"
            title="How far parts may sink into each other, for seating imperfect scans"
          >
            <NumericInput
              label="Allowed overlap"
              value={view.clip.overlap}
              min={clipLimits.min}
              max={clipLimits.max}
              step={0.05}
              onCommit={(overlap) =>
                useEditor.getState().setView({ clip: { ...view.clip, overlap } })
              }
            />
            <small>mm</small>
          </label>
        ) : null}
        <span className="tool-divider" />
        <select
          className="space-button"
          aria-label="Preferred transform axes"
          title="Axes for handles and steps. Connected joints use joint axes; groups use world axes."
          value={view.space}
          onChange={(e) =>
            useEditor.getState().setView({ space: e.target.value as 'world' | 'local' })
          }
        >
          <option value="world">World</option>
          <option value="local">Local</option>
        </select>
        <span className="tool-divider" />
        <IconButton label={right ? 'Hide inspector' : 'Show inspector'} onClick={toggleRight}>
          {right ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </IconButton>
      </div>
    </div>
  );
}

function StatusBar() {
  const freeMode = useEditor((s) => s.freeTransform?.mode);
  const pivotPicking = useEditor((s) => s.pivotPicking),
    surfacePainting = useEditor((s) => s.tool === 'align' && s.operation.mode === 'surface');
  const recovery = useEditor((s) => s.recoveryStatus),
    tool = useEditor((s) => s.tool),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode)),
    indexing = useEditor((s) => s.indexingMeshes > 0),
    live = useEditor((s) => s.liveStatus);
  const hold = useShortcut('holdOrbit'),
    cancel = useShortcut('cancel'),
    pivot = useShortcut('pivot'),
    smaller = useShortcut('brushSmaller'),
    larger = useShortcut('brushLarger');
  const orbitHint = `Middle${hold ? ` / ${hold}` : ''}`;
  return (
    <footer className="statusbar">
      <div className="navigation-hints">
        <span>
          <MousePointer2 size={11} />
          Orbit <kbd>{orbitHint}</kbd>
        </span>
        <span>
          <Hand size={11} />
          Pan <kbd>Right drag</kbd>
        </span>
        <span>
          Zoom <kbd>Scroll</kbd>
        </span>
        <span className="status-context">
          {freeMode
            ? 'Move pointer · X / Y / Z: axis · Enter / click: confirm · Esc / right-click: cancel'
            : indexing
              ? 'Preparing a dense mesh · It can be clicked when this finishes'
              : navigationMode
                ? `${navigationMode === 'pan' ? 'Pan' : 'Orbit'} tool · Drag to navigate${cancel ? ` · ${cancel} to return` : ''}`
                : pivotPicking
                  ? `Click a model surface to set its pivot${[pivot, cancel].some(Boolean) ? ` · ${[pivot, cancel].filter(Boolean).join(' or ')} to cancel` : ''}`
                  : surfacePainting
                    ? `Drag to paint · Alt erases${smaller || larger ? ` · ${[smaller, larger].filter(Boolean).join(' / ')} brush size` : ''} · ${orbitHint} orbits`
                    : tool === 'align'
                      ? `Pick source → target · ${orbitHint} orbits`
                      : tool === 'pins'
                        ? 'Place hard or soft pins on the surface · Move or rotate to adjust the part'
                        : tool === 'anchors'
                          ? 'Add surface anchors · Drag a target to fit · Shift for fine adjustment'
                          : tool === 'joint'
                            ? 'Pick anchors to connect parts'
                            : ['translate', 'rotate', 'scale', 'transform'].includes(tool)
                              ? 'Hold Shift while dragging for 10× finer adjustment'
                              : 'Shift + click to select multiple'}
        </span>
      </div>
      <div className="local-save-status">
        {live ? (
          <>
            <span className={`status-dot${live === 'connected' ? '' : ' warning'}`} />
            <span>
              {live === 'connected'
                ? `${liveHost === 'people' ? 'Shared session' : 'Shared with agent'} · Edits sync both ways`
                : live === 'connecting'
                  ? liveHost === 'people'
                    ? 'Joining the session…'
                    : 'Connecting to agent…'
                  : `${liveHost === 'people' ? 'Session ended' : 'Agent disconnected'} · Edits stay in this tab · Save scene to keep them`}
            </span>
          </>
        ) : (
          <>
            {recovery === 'saving' ? (
              <LoaderCircle size={11} className="spin" />
            ) : recovery === 'error' ? (
              <span className="status-dot warning" />
            ) : (
              <CheckCircle2 size={11} />
            )}
            <span>
              {recovery === 'saving'
                ? 'Saving locally…'
                : recovery === 'error'
                  ? 'Recovery unavailable · save a scene file'
                  : 'Saved locally'}
            </span>
          </>
        )}
        <span className="statusbar-divider" />
        <span className="unit-label">mm</span>
      </div>
    </footer>
  );
}

function BusyOverlay() {
  const busy = useEditor((s) => s.busy);
  return busy ? (
    <div className="busy-overlay" role="status">
      <div>
        <LoaderCircle className="spin" size={18} />
        <span>{busy}</span>
      </div>
    </div>
  ) : null;
}

export default function App() {
  const [left, setLeft] = useState(() => window.innerWidth > 800),
    [right, setRight] = useState(() => window.innerWidth > 1050),
    [dragging, setDragging] = useState(false),
    [importFiles, setImportFiles] = useState<File[]>([]),
    [pendingScene, setPendingScene] = useState<SceneDocument | null>(null);
  const fileInput = useRef<HTMLInputElement>(null),
    dragDepth = useRef(0);
  const tool = useEditor((s) => s.tool),
    view = useEditor((s) => s.view),
    modal = useEditor((s) => s.modal);
  const openScene = useCallback(() => fileInput.current?.click(), []);
  const searchParts = useCallback(() => {
    setLeft(true);
    requestAnimationFrame(() => {
      document.querySelector<HTMLButtonElement>('.panel-tabs button')?.click();
      const search = document.querySelector<HTMLInputElement>('[aria-label="Search parts"]');
      search?.focus();
      search?.select();
    });
  }, []);
  const contextGesture = useRef({
    x: 0,
    y: 0,
    moved: false,
    active: false,
    pending: null as { target: Element; event: MouseEvent } | null,
  });
  useRecovery();
  useEffect(() => driveAutosave.start(), []);
  useLiveSession();
  useKeyboard(openScene, searchParts);
  useEffect(() => {
    // Keep press-time context menus out of the DOM until we know this is a click.
    // Replaying on the original target preserves mesh raycasting and brush menus.
    const move = (event: PointerEvent) => {
      const gesture = contextGesture.current;
      if (!gesture.active) return;
      if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5) {
        gesture.moved = true;
        gesture.pending = null;
      }
    };
    const up = (event: PointerEvent) => {
      const gesture = contextGesture.current;
      if (!gesture.active) return;
      move(event);
      gesture.active = false;
      const pending = gesture.pending;
      gesture.pending = null;
      if (!gesture.moved && pending?.target.isConnected) {
        pending.target.dispatchEvent(new MouseEvent('contextmenu', pending.event));
      }
    };
    const cancel = () => {
      contextGesture.current.active = false;
      contextGesture.current.moved = true;
      contextGesture.current.pending = null;
    };
    window.addEventListener('pointermove', move, true);
    window.addEventListener('pointerup', up, true);
    window.addEventListener('pointercancel', cancel, true);
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', up, true);
      window.removeEventListener('pointercancel', cancel, true);
      window.removeEventListener('blur', cancel);
    };
  }, []);
  useEffect(() => {
    if (tool === 'align' || tool === 'joint' || tool === 'anchors' || tool === 'pins')
      setRight(true);
  }, [tool]);
  useEffect(() => {
    // Dropped files belong to one import dialog, not to the next one opened from a menu.
    if (modal !== 'import') setImportFiles([]);
  }, [modal]);
  useEffect(() => {
    const onResize = () => {
      if (window.innerWidth < 760) {
        setLeft(false);
        setRight(false);
      }
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  const acceptFiles = async (files: File[]) => {
    const editor = useEditor.getState();
    if (!files.length || editor.busy) return;
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.kitbash')) {
      editor.setBusy('Opening scene…');
      try {
        setPendingScene(
          await readSceneFile(files[0], (fraction) =>
            editor.setBusy(`Opening scene… ${Math.round(fraction * 100)}%`),
          ),
        );
      } catch (error) {
        editor.notify((error as Error).message, 'error');
      } finally {
        editor.setBusy(null);
      }
    } else {
      setImportFiles(files);
      useEditor.getState().setModal('import');
    }
  };
  return (
    <div
      className={`workbench ${left ? 'show-parts' : ''} ${right ? 'show-inspector' : ''}`}
      onPointerDownCapture={(event) => {
        contextGesture.current = {
          x: event.clientX,
          y: event.clientY,
          moved: false,
          active: event.button === 2 || (event.button === 0 && event.ctrlKey),
          pending: null,
        };
      }}
      onPointerMoveCapture={(event) => {
        const gesture = contextGesture.current;
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5)
          gesture.moved = true;
      }}
      onContextMenuCapture={(event) => {
        const gesture = contextGesture.current;
        if (gesture.active && event.target instanceof Element && !isEditableTarget(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          if (!gesture.moved) {
            gesture.pending = { target: event.target, event: event.nativeEvent };
          }
          return;
        }
        if ((event.button === 2 || event.ctrlKey) && contextGesture.current.moved) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        const state = useEditor.getState();
        if (
          event.target instanceof HTMLCanvasElement &&
          state.tool === 'align' &&
          state.operation.mode === 'surface'
        ) {
          event.preventDefault();
          event.stopPropagation();
          state.openContextMenu({ x: event.clientX, y: event.clientY, kind: 'brush' });
        }
      }}
      onContextMenu={(event) => {
        const target = event.target;
        if (
          event.defaultPrevented ||
          isEditableTarget(target) ||
          useEditor.getState().modal ||
          !(target instanceof Element) ||
          target.closest('[role="dialog"]')
        )
          return;
        event.preventDefault();
        const partId = target.closest<HTMLElement>('[data-part-id]')?.dataset.partId;
        const state = useEditor.getState();
        state.openContextMenu({
          x: event.clientX,
          y: event.clientY,
          kind:
            target.closest('.viewport') &&
            state.tool === 'align' &&
            state.operation.mode === 'surface'
              ? 'brush'
              : undefined,
          ...(partId ? { partId } : {}),
        });
      }}
      onDragEnter={(e) => {
        e.preventDefault();
        if (e.dataTransfer.types.includes('Files')) {
          dragDepth.current++;
          setDragging(true);
        }
      }}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={(e) => {
        e.preventDefault();
        dragDepth.current--;
        if (dragDepth.current <= 0) {
          dragDepth.current = 0;
          setDragging(false);
        }
      }}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        dragDepth.current = 0;
        void acceptFiles(Array.from(e.dataTransfer.files));
      }}
    >
      <input
        ref={fileInput}
        className="sr-only"
        type="file"
        accept=".kitbash"
        aria-label="Open Kitbasher scene"
        onChange={(e) => {
          void acceptFiles(Array.from(e.target.files ?? []));
          e.target.value = '';
        }}
      />
      <Header openScene={openScene} />
      <Toolbar
        left={left}
        right={right}
        toggleLeft={() => {
          setLeft(!left);
          if (window.innerWidth < 760) setRight(false);
        }}
        toggleRight={() => {
          setRight(!right);
          if (window.innerWidth < 760) setLeft(false);
        }}
      />
      <div className="workspace">
        <PartsPanel onClose={() => setLeft(false)} />
        <div className="canvas-area">
          <Suspense
            fallback={
              <div className="viewport-loading">
                <LoaderCircle className="spin" size={22} />
                Opening your workbench…
              </div>
            }
          >
            <Viewport />
          </Suspense>
          <div className="explode-control">
            <button
              className={view.explode ? 'active' : ''}
              disabled={view.inspection.enabled}
              title={
                view.inspection.enabled
                  ? 'Close interference view to explode the assembly'
                  : 'Explode assembly'
              }
              onClick={() => useEditor.getState().setView({ explode: view.explode ? 0 : 40 })}
            >
              <Box size={13} />
              <span>Explode</span>
            </button>
            <input
              aria-label="Exploded view amount"
              title={
                view.inspection.enabled
                  ? 'Close interference view to explode the assembly'
                  : 'Explode assembly'
              }
              disabled={view.inspection.enabled}
              type="range"
              min={0}
              max={100}
              value={view.explode}
              onChange={(e) => useEditor.getState().setView({ explode: Number(e.target.value) })}
            />
            <span>{view.explode}%</span>
          </div>
        </div>
        <Inspector onClose={() => setRight(false)} />
        <PreferencesPanel />
      </div>
      <StatusBar />
      <footer className="site-footer">
        <span>© 2026 Michael Pearce</span>
        <nav aria-label="Project links">
          <a href="./docs/" target="_blank" rel="noopener noreferrer">
            Documentation
          </a>
          <a href="./privacy.html" target="_blank" rel="noopener noreferrer">
            Privacy Policy
          </a>
          <a href="https://github.com/nimerix/kitbasher" target="_blank" rel="noopener noreferrer">
            GitHub
          </a>
          <a
            href="https://github.com/nimerix/kitbasher/issues"
            target="_blank"
            rel="noopener noreferrer"
          >
            Report an issue
          </a>
          <a
            href="https://github.com/nimerix/kitbasher/blob/main/LICENSE"
            target="_blank"
            rel="noopener noreferrer"
          >
            MIT License
          </a>
        </nav>
      </footer>
      <BusyOverlay />
      <NotificationToasts />
      <Dialogs
        key={modal === 'import' ? importFiles.map((f) => f.name).join('|') : 'dialogs'}
        importFiles={importFiles}
      />
      <GoogleDriveDialog />
      {pendingScene ? (
        <Modal
          title={`Open ${pendingScene.name}?`}
          subtitle="This replaces the current workbench. Save a scene copy if you want to keep it."
          onClose={() => setPendingScene(null)}
        >
          <div className="open-scene-summary">
            <FolderOpen size={29} />
            <div>
              <strong>
                {pendingScene.parts.length} parts · {pendingScene.joints.length} joints
              </strong>
              <p>All geometry, placement, and joint constraints will be restored.</p>
            </div>
          </div>
          <div className="modal-footer">
            <button className="button secondary" onClick={saveCurrentScene}>
              Save current scene
            </button>
            <button
              className="button primary"
              onClick={async () => {
                if (!(await flushDriveBeforeReplace())) return;
                useEditor.getState().setScene(pendingScene);
                setPendingScene(null);
                useEditor.getState().notify('Scene opened');
              }}
            >
              Open scene
              <ArrowRight size={14} />
            </button>
          </div>
        </Modal>
      ) : null}
      <EditorContextMenu openScene={openScene} searchParts={searchParts} />
      {dragging ? (
        <div className="global-drop-overlay">
          <Import size={42} />
          <h2>Drop your parts here.</h2>
          <p>Models import together. Kitbasher scenes open as a workspace.</p>
        </div>
      ) : null}
    </div>
  );
}
