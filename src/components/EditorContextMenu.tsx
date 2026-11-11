import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BoxSelect,
  ClipboardPaste,
  Copy,
  Crosshair,
  Eye,
  EyeClosed,
  EyeOff,
  Focus,
  GitMerge,
  Import,
  Layers2,
  Link2,
  LockKeyhole,
  Maximize,
  Move3D,
  Paintbrush,
  Pencil,
  Radius,
  Rotate3D,
  Scaling,
  ScanEye,
  ScanLine,
  Scissors,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import { editorCommands, executeEditorCommand } from '../core/commands';
import type { CommandContext, CommandId } from '../core/commands';
import { useEditor } from '../core/store';
import type { EditorContextMenu as MenuLocation } from '../core/store';
import { SurfaceBrushControls } from './SurfaceBrushControls';

const icons = {
  copy: Copy,
  cut: Scissors,
  paste: ClipboardPaste,
  duplicate: Copy,
  rename: Pencil,
  delete: Trash2,
  move: Move3D,
  rotate: Rotate3D,
  scale: Scaling,
  focus: Focus,
  frameAll: Maximize,
  pivot: Crosshair,
  align: ScanLine,
  paint: Paintbrush,
  joint: Link2,
  merge: GitMerge,
  inspect: Layers2,
  hide: EyeOff,
  hideOthers: EyeClosed,
  isolate: ScanEye,
  isolateNearby: Radius,
  showAll: Eye,
  lock: LockKeyhole,
  unlock: UnlockKeyhole,
  selectAll: BoxSelect,
  deselect: BoxSelect,
  import: Import,
};

export function EditorContextMenu(props: CommandContext) {
  const location = useEditor((state) => state.contextMenu);
  return location ? <OpenContextMenu location={location} actions={props} /> : null;
}

function OpenContextMenu({
  location,
  actions,
}: {
  location: MenuLocation;
  actions: CommandContext;
}) {
  const state = useEditor();
  const brush = location.kind === 'brush';
  const menu = useRef<HTMLDivElement>(null);
  const previousFocus = useRef(document.activeElement as HTMLElement | null);
  const typeahead = useRef({ query: '', time: 0 });
  const [position, setPosition] = useState({ left: location.x, top: location.y });
  const context = { ...actions, point: location.point };
  const commands = editorCommands(context);
  const selected = state.scene.parts.filter((part) => state.selected.includes(part.id));
  const hasSelection = selected.length > 0;
  const unlocked = selected.some((part) => !part.locked);
  const close = useCallback((restore = false) => {
    if (menu.current?.contains(document.activeElement))
      (document.activeElement as HTMLElement).blur();
    useEditor.getState().closeContextMenu();
    if (restore) {
      const target = previousFocus.current;
      if (target?.isConnected && !menu.current?.contains(target))
        target.focus({ preventScroll: true });
      else document.querySelector<HTMLElement>('.viewport')?.focus({ preventScroll: true });
    }
  }, []);
  const reposition = useCallback(() => {
    const bounds = menu.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      left: Math.max(8, Math.min(location.x, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(location.y, window.innerHeight - bounds.height - 8)),
    });
  }, [location.x, location.y]);
  useLayoutEffect(() => {
    reposition();
    const first = menu.current?.querySelector<HTMLElement>(
      brush ? '[aria-label="Brush radius"]' : '[role="menuitem"]:not(:disabled)',
    );
    first?.focus({ preventScroll: true });
    if (first instanceof HTMLInputElement) first.select();
  }, [location, reposition, brush]);
  useLayoutEffect(() => {
    const observer = new ResizeObserver(reposition);
    observer.observe(menu.current!);
    return () => observer.disconnect();
  }, [reposition]);
  useEffect(() => {
    const pointer = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const scroll = (event: Event) => {
      if (!menu.current?.contains(event.target as Node)) close();
    };
    const dismiss = () => close();
    document.addEventListener('pointerdown', pointer, true);
    document.addEventListener('scroll', scroll, true);
    window.addEventListener('resize', reposition);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', pointer, true);
      document.removeEventListener('scroll', scroll, true);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('blur', dismiss);
    };
  }, [close, reposition]);

  const item = (id: keyof typeof icons, compact = false) => {
    const command = commands[id];
    const Icon = icons[id];
    return (
      <button
        key={id}
        role="menuitem"
        tabIndex={-1}
        disabled={!command.enabled}
        className={`${compact ? 'context-tool' : 'context-action'} ${id === 'delete' ? 'danger' : ''}`}
        data-label={command.label}
        title={compact ? `${command.label} (${command.shortcut})` : undefined}
        aria-label={compact ? command.label : undefined}
        onClick={() => {
          close(true);
          executeEditorCommand(id as CommandId, context);
        }}
      >
        <Icon size={14} />
        <span>{command.label}</span>
        {command.shortcut && !compact ? <kbd>{command.shortcut}</kbd> : null}
      </button>
    );
  };
  const groups: (keyof typeof icons)[][] = hasSelection
    ? [
        ['cut', 'copy', 'paste', 'duplicate'],
        ['rename', 'delete'],
        ['focus', 'pivot', 'align', 'paint', 'joint', 'merge', 'inspect'],
        ['isolate', 'isolateNearby'],
        ['hide', 'hideOthers', unlocked ? 'lock' : 'unlock', 'showAll'],
        ['selectAll', 'deselect'],
      ]
    : [
        ['paste', 'import'],
        ['selectAll', 'showAll'],
        state.isolated ? ['frameAll', 'isolate', 'isolateNearby'] : ['frameAll'],
      ];
  return createPortal(
    <div
      ref={menu}
      className={`editor-context-menu ${brush ? 'brush-context-menu' : ''}`}
      role={brush ? 'dialog' : 'menu'}
      aria-label={brush ? 'Paint brush settings' : 'Component actions'}
      tabIndex={-1}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if (brush) {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            close(true);
          }
          if (event.key === 'Tab') {
            const controls = Array.from(
              menu.current!.querySelectorAll<HTMLElement>(
                'button:not(:disabled), input:not(:disabled)',
              ),
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
          return;
        }
        const items = Array.from(
          menu.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
        );
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        let next: HTMLButtonElement | undefined;
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          close(true);
          return;
        }
        if (event.key === ' ') {
          event.preventDefault();
          event.stopPropagation();
          items[index]?.click();
          return;
        }
        if (event.key === 'Tab') {
          close(true);
          return;
        }
        if (event.key === 'ArrowDown' || event.key === 'ArrowRight')
          next = items[(index + 1) % items.length];
        if (event.key === 'ArrowUp' || event.key === 'ArrowLeft')
          next = items[(index - 1 + items.length) % items.length];
        if (event.key === 'Home') next = items[0];
        if (event.key === 'End') next = items.at(-1);
        if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
          const now = performance.now();
          const prior = now - typeahead.current.time < 700 ? typeahead.current.query : '';
          const query = prior === event.key.toLowerCase() ? prior : prior + event.key.toLowerCase();
          typeahead.current = { query, time: now };
          const ordered = [...items.slice(index + 1), ...items.slice(0, index + 1)];
          next = ordered.find((item) => item.dataset.label?.toLowerCase().startsWith(query));
          event.preventDefault();
          event.stopPropagation();
        }
        if (next) {
          event.preventDefault();
          event.stopPropagation();
          next.focus({ preventScroll: true });
          next.scrollIntoView({ block: 'nearest' });
        }
      }}
    >
      {brush ? (
        <>
          <div className="context-heading">
            <span>Paint brush settings</span>
            <small>Right-click to adjust · Right-drag to pan</small>
          </div>
          <SurfaceBrushControls />
          <button className="button secondary full-width" onClick={() => close(true)}>
            Done
          </button>
        </>
      ) : (
        <>
          <div className="context-heading" role="presentation">
            <span>
              {selected.length === 1
                ? selected[0].name
                : hasSelection
                  ? `${selected.length} components selected`
                  : 'Assembly actions'}
            </span>
            {hasSelection ? (
              <small>
                {selected.filter((part) => part.locked).length
                  ? 'Includes locked parts'
                  : 'Component actions'}
              </small>
            ) : null}
          </div>
          {hasSelection ? (
            <>
              <div className="context-tools" role="group" aria-label="Transform tools">
                {(['move', 'rotate', 'scale'] as const).map((id) => item(id, true))}
              </div>
              <div role="separator" className="context-separator" />
            </>
          ) : null}
          {groups.map((group, index) => (
            <div key={index} role="group">
              {index ? <div role="separator" className="context-separator" /> : null}
              {group.map((id) => item(id))}
            </div>
          ))}
        </>
      )}
    </div>,
    document.body,
  );
}
