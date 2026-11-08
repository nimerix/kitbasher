import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowRight,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  CircleHelp,
  Copy,
  ClipboardPaste,
  Scissors,
  Pencil,
  BoxSelect,
  Crosshair,
  Paintbrush,
  FilePlus2,
  FolderOpen,
  GitMerge,
  Grid2X2,
  Hand,
  Import,
  Link2,
  LoaderCircle,
  Magnet,
  Maximize,
  MousePointer2,
  Move3D,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Redo2,
  Rotate3D,
  Ruler,
  Save,
  Scaling,
  ScanLine,
  Undo2,
  X,
} from 'lucide-react';
import { useEditor } from './core/store';
import { editorCommands, executeEditorCommand } from './core/commands';
import type { CommandId } from './core/commands';
import { isEditableTarget } from './core/context-menu';
import { EditorContextMenu } from './components/EditorContextMenu';
import { parseScene } from './core/scene-file';
import { saveSceneFile } from './core/files';
import { useKeyboard, useRecovery } from './hooks/useWorkbench';
import { PartsPanel } from './components/PartsPanel';
import { Inspector } from './components/Inspector';
import { Dialogs } from './components/Dialogs';
import { IconButton, Keyboard, Logo, Modal } from './components/ui';
import type { SceneDocument, Tool } from './core/types';

const Viewport = lazy(() =>
  import('./components/Viewport').then((module) => ({ default: module.Viewport })),
);

function Header({ openScene }: { openScene: () => void }) {
  const name = useEditor((s) => s.scene.name),
    revision = useEditor((s) => s.revision),
    savedRevision = useEditor((s) => s.savedRevision);
  useEditor((state) => state.past);
  useEditor((state) => state.future);
  useEditor((state) => state.selected);
  useEditor((state) => state.clipboard);
  useEditor((state) => state.busy);
  useEditor((state) => state.paintHistory);
  const [menu, setMenu] = useState<string | null>(null),
    [editing, setEditing] = useState(false),
    [draft, setDraft] = useState(name);
  const headerRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (e: PointerEvent) => {
      if (!headerRef.current?.contains(e.target as Node)) setMenu(null);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
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
    <header className="topbar" ref={headerRef}>
      <div className="brand">
        <Logo />
        <span>
          kitbasher<span className="brand-period">.</span>
        </span>
      </div>
      <div className="header-divider" />
      <nav className="app-menus" aria-label="Editor menus">
        {['File', 'Edit', 'View'].map((label) => (
          <div key={label} className="app-menu">
            <button
              className={menu === label ? 'active' : ''}
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
                    {commandItem('export', ArrowDownToLine)}
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
              useEditor.getState().renameScene(draft);
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur();
              if (e.key === 'Escape') setEditing(false);
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
            {revision !== savedRevision ? (
              <span className="unsaved-dot" title="Changes since file download" />
            ) : null}
            <ChevronDown size={11} />
          </button>
        )}
        <span className="document-type">Assembly</span>
      </div>
      <div className="header-actions">
        <IconButton
          label="Help and keyboard shortcuts"
          onClick={() => useEditor.getState().setModal('help')}
        >
          <CircleHelp size={17} />
        </IconButton>
        <button className="button secondary save-button" onClick={save}>
          <Save size={14} />
          <span>Save scene</span>
        </button>
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
    past = useEditor((s) => s.past),
    future = useEditor((s) => s.future),
    selected = useEditor((s) => s.selected);
  const pivotPicking = useEditor((s) => s.pivotPicking);
  const surfacePainting = useEditor((s) => s.tool === 'align' && s.operation.mode === 'surface');
  const tools: { id: Tool; label: string; shortcut: string; icon: typeof MousePointer2 }[] = [
    { id: 'select', label: 'Select', shortcut: 'V', icon: MousePointer2 },
    { id: 'translate', label: 'Move', shortcut: 'G', icon: Move3D },
    { id: 'rotate', label: 'Rotate', shortcut: 'R', icon: Rotate3D },
    { id: 'scale', label: 'Scale', shortcut: 'S', icon: Scaling },
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
            label="Undo (Ctrl/⌘ Z)"
            disabled={!past.length}
            onClick={() => useEditor.getState().undo()}
          >
            <Undo2 size={15} />
          </IconButton>
          <IconButton
            label="Redo (Ctrl/⌘ Shift Z)"
            disabled={!future.length}
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
              label={`${label} (${shortcut})`}
              active={tool === id}
              onClick={() => useEditor.getState().setTool(id)}
            >
              <Icon size={17} />
            </IconButton>
          ))}
          <IconButton
            label="Pick pivot point (P)"
            active={pivotPicking}
            onClick={() => useEditor.getState().setPivotPicking(!pivotPicking)}
          >
            <Crosshair size={17} />
          </IconButton>
        </div>
        <span className="tool-divider" />
        <button
          className={`tool-button ${tool === 'align' && !surfacePainting ? 'active' : ''}`}
          title="Align parts (A)"
          onClick={() => useEditor.getState().setTool('align')}
        >
          <ScanLine size={16} />
          <span>Align</span>
          <Keyboard>A</Keyboard>
        </button>
        <button
          className={`tool-button paint-tool ${surfacePainting ? 'active' : ''}`}
          title="Paint contact surfaces (B)"
          onClick={() => {
            useEditor.getState().setTool('align');
            useEditor.getState().setOperation({ mode: 'surface' });
          }}
        >
          <Paintbrush size={16} />
          <span>Contact paint</span>
          <Keyboard>B</Keyboard>
        </button>
        <button
          className={`tool-button ${tool === 'joint' ? 'active' : ''}`}
          onClick={() => useEditor.getState().setTool('joint')}
        >
          <Link2 size={16} />
          <span>Joint</span>
          <Keyboard>J</Keyboard>
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
          label="Measure distance (D)"
          active={tool === 'measure'}
          onClick={() => useEditor.getState().setTool('measure')}
        >
          <Ruler size={17} />
        </IconButton>
      </div>
      <div className="toolbar-right">
        <button
          className={`snap-toggle ${view.snap ? 'active' : ''}`}
          title="Snap transforms to increments"
          aria-pressed={view.snap}
          onClick={() => useEditor.getState().setView({ snap: !view.snap })}
        >
          <Magnet size={15} />
          <span>Snap</span>
          <span className={`mini-toggle ${view.snap ? 'on' : ''}`} />
        </button>
        {view.snap ? (
          <select
            className="snap-step"
            aria-label="Snap distance"
            value={view.snapStep}
            onChange={(e) => useEditor.getState().setView({ snapStep: Number(e.target.value) })}
          >
            <option value={0.1}>0.1 mm</option>
            <option value={0.5}>0.5 mm</option>
            <option value={1}>1 mm</option>
            <option value={5}>5 mm</option>
          </select>
        ) : null}
        <span className="tool-divider" />
        <button
          className="space-button"
          title="Switch transform coordinate system"
          onClick={() =>
            useEditor.getState().setView({ space: view.space === 'world' ? 'local' : 'world' })
          }
        >
          <span className="world-icon">⊕</span>
          {view.space === 'world' ? 'World' : 'Local'}
          <ChevronDown size={11} />
        </button>
        <span className="tool-divider" />
        <IconButton label={right ? 'Hide inspector' : 'Show inspector'} onClick={toggleRight}>
          {right ? <PanelRightClose size={16} /> : <PanelRightOpen size={16} />}
        </IconButton>
      </div>
    </div>
  );
}

function StatusBar() {
  const pivotPicking = useEditor((s) => s.pivotPicking),
    surfacePainting = useEditor((s) => s.tool === 'align' && s.operation.mode === 'surface');
  const recovery = useEditor((s) => s.recoveryStatus),
    tool = useEditor((s) => s.tool),
    navigationMode = useEditor((s) => (s.temporaryOrbit ? 'orbit' : s.navigationMode));
  return (
    <footer className="statusbar">
      <div className="navigation-hints">
        <span>
          <MousePointer2 size={11} />
          Orbit <kbd>Middle / Space</kbd>
        </span>
        <span>
          <Hand size={11} />
          Pan <kbd>Right drag</kbd>
        </span>
        <span>
          Zoom <kbd>Scroll</kbd>
        </span>
        <span className="status-context">
          {navigationMode
            ? `${navigationMode === 'pan' ? 'Pan' : 'Orbit'} tool · Drag to navigate · Esc to return`
            : pivotPicking
              ? 'Click a model surface to set its pivot · P or Esc to cancel'
              : surfacePainting
                ? 'Drag to paint · Alt erases · [ / ] brush size · Middle / Space orbits'
                : tool === 'align'
                  ? 'Pick source → target · Middle / Space orbits'
                  : tool === 'joint'
                    ? 'Pick anchors to connect parts'
                    : ['translate', 'rotate', 'scale'].includes(tool)
                      ? 'Hold Shift while dragging for 10× finer adjustment'
                      : 'Shift + click to select multiple'}
        </span>
      </div>
      <div className="local-save-status">
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
        <span className="statusbar-divider" />
        <span className="unit-label">mm</span>
      </div>
    </footer>
  );
}

function Toast() {
  const toast = useEditor((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(
      () => useEditor.setState({ toast: null }),
      toast.kind === 'error' ? 7000 : 3500,
    );
    return () => clearTimeout(timeout);
  }, [toast]);
  return toast ? (
    <div className={`toast toast-${toast.kind}`} role="status">
      {toast.kind === 'success' ? (
        <CheckCircle2 size={16} />
      ) : toast.kind === 'error' ? (
        <CircleHelp size={16} />
      ) : (
        <Check size={16} />
      )}
      <span>{toast.message}</span>
      <button aria-label="Dismiss notification" onClick={() => useEditor.setState({ toast: null })}>
        <X size={14} />
      </button>
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
    view = useEditor((s) => s.view);
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
  const contextGesture = useRef({ x: 0, y: 0, moved: false, selection: [] as string[] });
  useRecovery();
  useKeyboard(openScene, searchParts);
  useEffect(() => {
    // Some platforms emit contextmenu on right-button down. Close that early
    // menu once the gesture becomes a pan, even if the pointer is over its portal.
    const move = (event: PointerEvent) => {
      const gesture = contextGesture.current;
      if (
        !(event.buttons & 2) ||
        Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) <= 5
      )
        return;
      gesture.moved = true;
      if (useEditor.getState().contextMenu) {
        useEditor.setState({ contextMenu: null, selected: gesture.selection });
        document.querySelector<HTMLElement>('.viewport')?.focus({ preventScroll: true });
      }
    };
    window.addEventListener('pointermove', move, true);
    return () => window.removeEventListener('pointermove', move, true);
  }, []);
  useEffect(() => {
    if (tool === 'align' || tool === 'joint') setRight(true);
  }, [tool]);
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
    if (!files.length) return;
    if (files.length === 1 && files[0].name.toLowerCase().endsWith('.kitbash')) {
      try {
        const scene = parseScene(JSON.parse(await files[0].text()));
        setPendingScene(scene);
      } catch (error) {
        useEditor.getState().notify((error as Error).message, 'error');
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
          selection: useEditor.getState().selected,
        };
      }}
      onPointerMoveCapture={(event) => {
        const gesture = contextGesture.current;
        if (Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) > 5)
          gesture.moved = true;
      }}
      onContextMenuCapture={(event) => {
        if ((event.button === 2 || event.ctrlKey) && contextGesture.current.moved) {
          event.preventDefault();
          event.stopPropagation();
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
        useEditor
          .getState()
          .openContextMenu({ x: event.clientX, y: event.clientY, ...(partId ? { partId } : {}) });
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
      </div>
      <StatusBar />
      <Toast />
      <Dialogs
        key={
          useEditor((s) => s.modal) === 'import'
            ? importFiles.map((f) => f.name).join('|')
            : 'dialogs'
        }
        importFiles={importFiles}
      />
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
            <button
              className="button secondary"
              onClick={() => {
                saveSceneFile(useEditor.getState().scene);
                useEditor.getState().markSaved();
              }}
            >
              Save current scene
            </button>
            <button
              className="button primary"
              onClick={() => {
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
