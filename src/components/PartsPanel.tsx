import { Fragment, useMemo, useRef, useState } from 'react';
import type { MouseEvent } from 'react';
import {
  ArrowDownToLine,
  Box,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Eye,
  EyeOff,
  FolderOpen,
  Group,
  Link2,
  LockKeyhole,
  Plus,
  ScanEye,
  Search,
  Trash2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import { useEditor } from '../core/store';
import { referencePlanes } from '../core/references';
import { triangleCount } from '../core/geometry';
import { partTree, selectionRange, treeOrder } from '../core/part-tree';
import type { PartTreeEntry } from '../core/part-tree';
import type { Part } from '../core/types';
import { distinctColors, swatchBackground, swatchColors } from '../core/appearance';
import { IconButton } from './ui';
import { ConstraintList } from './ConstraintList';

export function PartsPanel({ onClose }: { onClose: () => void }) {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    isolated = useEditor((s) => s.isolated),
    view = useEditor((s) => s.view);
  const select = useEditor((s) => s.select),
    patchParts = useEditor((s) => s.patchParts),
    setView = useEditor((s) => s.setView);
  const [tab, setTab] = useState<'parts' | 'joints' | 'constraints'>('parts'),
    [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState(true);
  const tree = useMemo(() => partTree(scene, query), [scene, query]);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set()),
    [renaming, setRenaming] = useState<string | null>(null);
  const cancelRename = useRef(false);
  // Where Shift+click ranges from: the last part clicked here, or else the last one selected.
  const anchor = useRef<string | null>(null);
  /** Clicks a part, or a group with these parts. */
  const choose = (event: MouseEvent, ids: string[]) => {
    const state = useEditor.getState();
    if (event.shiftKey) {
      const from =
        anchor.current && state.selected.includes(anchor.current)
          ? anchor.current
          : state.selected.at(-1);
      anchor.current = from ?? ids[0];
      state.selectParts(selectionRange(treeOrder(tree), from, ids));
      return;
    }
    anchor.current = ids[0];
    if (event.metaKey || event.ctrlKey) state.select(ids[0], true, ids.length > 1);
    else state.selectParts(ids);
  };
  const distinct = useMemo(() => distinctColors(scene.parts), [scene.parts]);
  const triangles = scene.parts.reduce((sum, p) => sum + triangleCount(p.geometry), 0);
  const partRow = (part: Part, inGroup: boolean) => {
    // On a row of a larger selection, the eye shows or hides the selection.
    const selectedRow = selected.length > 1 && selected.includes(part.id);
    return (
      <div
        key={part.id}
        data-part-id={part.id}
        className={`part-row ${inGroup ? 'in-group' : ''} ${selected.includes(part.id) ? 'selected' : ''} ${!part.visible ? 'muted' : ''} ${isolated && !isolated.includes(part.id) ? 'outside-isolation' : ''}`}
      >
        <button
          className="part-select"
          aria-haspopup="menu"
          onClick={(e) => choose(e, [part.id])}
          onDoubleClick={() => useEditor.getState().focus()}
          title={part.name}
        >
          <span className="tree-branch" />
          <Box size={14} />
          <span
            className="part-swatch"
            aria-hidden="true"
            style={{
              background: swatchBackground(
                swatchColors(part, view.partColors, distinct.get(part.id)),
              ),
            }}
          />
          <span>{part.name}</span>
          {scene.joints.some((j) => j.childId === part.id) ? (
            <Link2 className="part-joint-icon" size={11} />
          ) : null}
          {isolated?.includes(part.id) ? (
            <ScanEye className="part-isolated-icon" size={11} aria-label="Isolated" />
          ) : null}
        </button>
        <div className="part-actions">
          <button
            title={
              selectedRow
                ? `${part.visible ? 'Hide' : 'Show'} ${selected.length} selected parts`
                : part.visible
                  ? 'Hide part'
                  : 'Show part'
            }
            aria-label={`${part.visible ? 'Hide' : 'Show'} ${part.name}${selectedRow ? ` and ${selected.length - 1} more selected` : ''}`}
            onClick={() =>
              patchParts(selectedRow ? selected : [part.id], { visible: !part.visible })
            }
          >
            {part.visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
          <button
            title={part.locked ? 'Unlock part' : 'Lock part'}
            aria-label={`${part.locked ? 'Unlock' : 'Lock'} ${part.name}`}
            className={part.locked ? 'always-visible' : ''}
            onClick={() => patchParts([part.id], { locked: !part.locked })}
          >
            {part.locked ? <LockKeyhole size={12} /> : <UnlockKeyhole size={12} />}
          </button>
        </div>
      </div>
    );
  };
  const groupRow = ({ group, parts }: Extract<PartTreeEntry, { kind: 'group' }>) => {
    const ids = parts.map((part) => part.id);
    const whole = ids.every((id) => selected.includes(id));
    const open = !collapsed.has(group.id);
    const visible = parts.some((part) => part.visible);
    // Like a part's eye: on a group that is part of a larger selection, it acts on the selection.
    const others = whole ? selected.length - ids.length : 0;
    const rename = (name: string) => {
      if (!cancelRename.current) useEditor.getState().renameGroup(group.id, name);
      cancelRename.current = false;
      setRenaming(null);
    };
    return (
      <div
        data-group-id={group.id}
        className={`part-row group-row ${whole ? 'selected' : ''} ${!visible ? 'muted' : ''} ${isolated && !ids.some((id) => isolated.includes(id)) ? 'outside-isolation' : ''}`}
        onContextMenu={() => {
          if (!whole) useEditor.getState().selectParts(ids);
        }}
      >
        <span className="tree-branch" />
        <button
          className="group-toggle"
          aria-label={`${open ? 'Collapse' : 'Expand'} ${group.name}`}
          aria-expanded={open}
          onClick={() =>
            setCollapsed((current) => {
              const next = new Set(current);
              if (open) next.add(group.id);
              else next.delete(group.id);
              return next;
            })
          }
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        {renaming === group.id ? (
          <input
            className="group-name-input"
            aria-label="Group name"
            defaultValue={group.name}
            autoFocus
            onFocus={(e) => e.target.select()}
            onBlur={(e) => rename(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') cancelRename.current = true;
              if (e.key === 'Enter' || e.key === 'Escape') e.currentTarget.blur();
            }}
          />
        ) : (
          <button
            className="part-select"
            aria-haspopup="menu"
            onClick={(e) => choose(e, ids)}
            onDoubleClick={() => setRenaming(group.id)}
            title={`${group.name} · double-click to rename`}
          >
            <Group size={14} />
            <span>{group.name}</span>
            <span className="tree-count">{parts.length}</span>
          </button>
        )}
        <div className="part-actions">
          <button
            title={`${visible ? 'Hide' : 'Show'} ${others ? `${selected.length} selected parts` : 'group'}`}
            aria-label={`${visible ? 'Hide' : 'Show'} ${group.name}${others ? ` and ${others} more selected` : ''}`}
            onClick={() => patchParts(others ? selected : ids, { visible: !visible })}
          >
            {visible ? <Eye size={12} /> : <EyeOff size={12} />}
          </button>
        </div>
      </div>
    );
  };
  return (
    <aside className="parts-panel" aria-label="Scene parts">
      <div className="panel-tabs">
        <button className={tab === 'parts' ? 'active' : ''} onClick={() => setTab('parts')}>
          Parts <span>{scene.parts.length}</span>
        </button>
        <button className={tab === 'joints' ? 'active' : ''} onClick={() => setTab('joints')}>
          Joints <span>{scene.joints.length}</span>
        </button>
        <button
          className={tab === 'constraints' ? 'active' : ''}
          onClick={() => setTab('constraints')}
        >
          Constraints <span>{scene.constraints?.length ?? 0}</span>
        </button>
        <IconButton
          label="Close parts panel"
          className="mobile-panel-close icon-button"
          onClick={onClose}
        >
          <X size={16} />
        </IconButton>
      </div>
      <div className="parts-search">
        <Search size={14} />
        <input
          aria-label="Search parts"
          placeholder={
            tab === 'parts'
              ? 'Find a part…'
              : tab === 'joints'
                ? 'Find a joint…'
                : 'Find a constraint…'
          }
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <kbd>⌕</kbd>
      </div>
      <div className="collection-heading">
        <span>SCENE COLLECTION</span>
        <IconButton label="Import parts" onClick={() => useEditor.getState().setModal('import')}>
          <Plus size={15} />
        </IconButton>
      </div>
      <div className="part-tree">
        {tab === 'parts' ? (
          <>
            <button className="tree-folder" onClick={() => setExpanded(!expanded)}>
              {expanded ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
              <FolderOpen size={15} />
              <span>{scene.name}</span>
              <span className="tree-count">{scene.parts.length}</span>
            </button>
            {expanded
              ? tree.map((entry) =>
                  entry.kind === 'part' ? (
                    partRow(entry.part, false)
                  ) : (
                    <Fragment key={entry.group.id}>
                      {groupRow(entry)}
                      {collapsed.has(entry.group.id)
                        ? null
                        : entry.shown.map((part) => partRow(part, true))}
                    </Fragment>
                  ),
                )
              : null}
            {!tree.length ? (
              <div className="panel-empty">
                {scene.parts.length ? 'No matching parts' : 'No parts yet'}
              </div>
            ) : null}
          </>
        ) : tab === 'constraints' ? (
          <ConstraintList query={query} />
        ) : (
          <div className="joint-list">
            {scene.joints
              .filter((j) => j.name.toLowerCase().includes(query.toLowerCase()))
              .map((joint) => (
                <div
                  className={`joint-tree-row ${selected.includes(joint.childId) ? 'active' : ''}`}
                  key={joint.id}
                >
                  <button onClick={() => select(joint.childId)}>
                    <CircleDot size={16} />
                    <span>
                      <strong>{joint.name}</strong>
                      <small>
                        {scene.parts.find((p) => p.id === joint.parentId)?.name} →{' '}
                        {scene.parts.find((p) => p.id === joint.childId)?.name}
                        {joint.keepConnected === false ? ' · paused' : ''}
                      </small>
                    </span>
                  </button>
                  <IconButton
                    label={`Remove ${joint.name}`}
                    onClick={() => useEditor.getState().removeJoint(joint.id)}
                  >
                    <Trash2 size={13} />
                  </IconButton>
                </div>
              ))}
            {!scene.joints.length ? (
              <div className="panel-empty">
                <Link2 size={23} />
                <p>No joints yet</p>
                <span>Pick two surface points to connect your parts.</span>
                <button
                  className="button secondary"
                  onClick={() => useEditor.getState().setTool('joint')}
                >
                  Create a joint
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>
      <div className="reference-planes">
        <div className="collection-heading">
          <span>REFERENCE PLANES</span>
          <span className="tiny-count">3</span>
        </div>
        {referencePlanes.map((plane, i) => (
          <button
            key={plane.id}
            className={`plane-row ${view.planes.includes(plane.id) ? 'active' : ''}`}
            onClick={() =>
              setView({
                planes: view.planes.includes(plane.id)
                  ? view.planes.filter((id) => id !== plane.id)
                  : [...view.planes, plane.id],
              })
            }
          >
            <span className={`plane-symbol plane-${i}`} />
            <span>{plane.name}</span>
            {view.planes.includes(plane.id) ? <Eye size={13} /> : <EyeOff size={13} />}
          </button>
        ))}
      </div>
      <div
        className="import-zone"
        role="button"
        tabIndex={0}
        onClick={() => useEditor.getState().setModal('import')}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') useEditor.getState().setModal('import');
        }}
      >
        <div className="import-zone-icon">
          <ArrowDownToLine size={18} />
        </div>
        <strong>Bring your parts together</strong>
        <p>Drop 3D files anywhere to import</p>
        <span>STL · OBJ · GLB · 3MF</span>
      </div>
      <div className="scene-summary">
        <Boxes size={13} />
        <span>{scene.parts.length} parts</span>
        <span className="summary-dot" />
        <span>
          {new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
            triangles,
          )}{' '}
          triangles
        </span>
      </div>
    </aside>
  );
}
