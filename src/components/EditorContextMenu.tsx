import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BoxSelect,
  ClipboardPaste,
  Copy,
  Crosshair,
  Eye,
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
  Rotate3D,
  Scaling,
  ScanLine,
  Scissors,
  Trash2,
  UnlockKeyhole,
} from 'lucide-react';
import { editorCommands, executeEditorCommand } from '../core/commands';
import type { CommandContext, CommandId } from '../core/commands';
import { useEditor } from '../core/store';
import type { EditorContextMenu as MenuLocation } from '../core/store';

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
  isolate: Focus,
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
    menu.current
      ?.querySelector<HTMLButtonElement>('[role="menuitem"]:not(:disabled)')
      ?.focus({ preventScroll: true });
  }, [location, reposition]);
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
        ['hide', 'isolate', unlocked ? 'lock' : 'unlock', 'showAll'],
        ['selectAll', 'deselect'],
      ]
    : [['paste', 'import'], ['selectAll', 'showAll'], ['frameAll']];
  return createPortal(
    <div
      ref={menu}
      className="editor-context-menu"
      role="menu"
      aria-label="Component actions"
      tabIndex={-1}
      style={position}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
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
    </div>,
    document.body,
  );
}
