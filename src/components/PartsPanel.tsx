import { useState } from 'react';
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
  Link2,
  LockKeyhole,
  Plus,
  Search,
  Trash2,
  UnlockKeyhole,
  X,
} from 'lucide-react';
import { useEditor } from '../core/store';
import { referencePlanes } from '../core/references';
import { triangleCount } from '../core/geometry';
import { IconButton } from './ui';
import { ConstraintList } from './ConstraintList';

export function PartsPanel({ onClose }: { onClose: () => void }) {
  const scene = useEditor((s) => s.scene),
    selected = useEditor((s) => s.selected),
    view = useEditor((s) => s.view);
  const select = useEditor((s) => s.select),
    patchParts = useEditor((s) => s.patchParts),
    setView = useEditor((s) => s.setView);
  const [tab, setTab] = useState<'parts' | 'joints' | 'constraints'>('parts'),
    [query, setQuery] = useState(''),
    [expanded, setExpanded] = useState(true);
  const filtered = scene.parts.filter((p) => p.name.toLowerCase().includes(query.toLowerCase()));
  const triangles = scene.parts.reduce((sum, p) => sum + triangleCount(p.geometry), 0);
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
              ? filtered.map((part) => (
                  <div
                    key={part.id}
                    data-part-id={part.id}
                    className={`part-row ${selected.includes(part.id) ? 'selected' : ''} ${!part.visible ? 'muted' : ''}`}
                  >
                    <button
                      className="part-select"
                      aria-haspopup="menu"
                      onClick={(e) => select(part.id, e.shiftKey || e.metaKey || e.ctrlKey)}
                      onDoubleClick={() => useEditor.getState().focus()}
                      title={part.name}
                    >
                      <span className="tree-branch" />
                      <Box size={14} />
                      <span>{part.name}</span>
                      {scene.joints.some((j) => j.childId === part.id) ? (
                        <Link2 className="part-joint-icon" size={11} />
                      ) : null}
                    </button>
                    <div className="part-actions">
                      <button
                        title={part.visible ? 'Hide part' : 'Show part'}
                        aria-label={`${part.visible ? 'Hide' : 'Show'} ${part.name}`}
                        onClick={() => patchParts([part.id], { visible: !part.visible })}
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
                ))
              : null}
            {!filtered.length ? <div className="panel-empty">No matching parts</div> : null}
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
