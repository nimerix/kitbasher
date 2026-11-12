import { useCallback, useEffect, useRef, useState } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import type { WebGLRenderer } from 'three';
import { RectangleGoggles } from 'lucide-react';
import { useEditor } from '../core/store';
import { detectXR, enterXR, exitXR, useXR } from '../core/xr-session';
import type { XRMode } from '../core/xr';
import { XRRuntime } from '../xr/runtime';
import { useDismiss } from './ui';

// A session is handed to the renderer once, however often the effect that does it runs.
const bound = new WeakMap<XRSession, Promise<void>>();

async function bind(gl: WebGLRenderer, session: XRSession) {
  // Measured from the floor where the headset knows it, and from where the head started otherwise.
  let space: XRReferenceSpaceType = 'local-floor';
  try {
    await session.requestReferenceSpace(space);
  } catch {
    space = 'local';
  }
  gl.xr.setReferenceSpaceType(space);
  await gl.xr.setSession(session);
}

type Adopted = Parameters<XRRuntime['adopt']>;

/** Runs a headset session in the viewport's own scene. Draws nothing itself. */
export function HeadsetView() {
  const session = useXR((s) => s.session);
  const gl = useThree((s) => s.gl),
    scene = useThree((s) => s.scene),
    camera = useThree((s) => s.camera),
    controls = useThree((s) => s.controls),
    get = useThree((s) => s.get),
    setEvents = useThree((s) => s.setEvents),
    invalidate = useThree((s) => s.invalidate);
  const runtime = useRef<XRRuntime | null>(null);
  useEffect(() => {
    if (!session) return;
    let live = true;
    let ready = bound.get(session);
    if (!ready) bound.set(session, (ready = bind(gl, session)));
    ready
      .then(() => {
        if (!live) return;
        // Before the first headset frame, so nothing is ever drawn at the wrong scale.
        const created = new XRRuntime(gl, scene, session);
        created.adopt(get().camera as Adopted[0], get().controls as Adopted[1]);
        runtime.current = created;
        useXR.setState({ runtime: created });
      })
      .catch((error: Error) => {
        useEditor
          .getState()
          .notify(`The headset session could not start. ${error.message}`, 'error');
        void session.end().catch(() => {});
      });
    // The mouse has nothing to pick with while the camera is on someone's head.
    setEvents({ enabled: false });
    return () => {
      live = false;
      setEvents({ enabled: true });
      if (useXR.getState().runtime === runtime.current) useXR.setState({ runtime: null });
      runtime.current?.dispose();
      runtime.current = null;
      invalidate();
    };
  }, [session, gl, scene, get, setEvents, invalidate]);
  // Switching projection swaps the viewport's camera, which the headset then rides instead.
  useEffect(() => {
    runtime.current?.adopt(camera as Adopted[0], controls as Adopted[1]);
  }, [camera, controls]);
  // Before the camera controls and lights, which follow where the viewer now is.
  useFrame((_, __, frame) => runtime.current?.update(frame), -3);
  return null;
}

const modes: { id: XRMode; label: string; detail: string }[] = [
  { id: 'ar', label: 'In your room', detail: 'The model appears in the room around you' },
  { id: 'vr', label: 'Virtual space', detail: 'The model on the workbench grid, without the room' },
];

/**
 * Starts and ends a headset session where the browser offers one. On a computer that shares its
 * scene, it shows how a headset on the network joins instead.
 */
export function HeadsetButton() {
  const support = useXR((s) => s.support),
    mode = useXR((s) => s.mode),
    last = useXR((s) => s.settings.mode),
    sharing = useXR((s) => s.sharing);
  const [open, setOpen] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(container, open, close);
  useEffect(() => {
    void detectXR();
  }, []);
  const offered = modes.filter((m) => support[m.id]);
  const joining = offered.length ? null : sharing;
  if (!offered.length && !joining) return null;
  const menu = !mode && (!!joining || offered.length > 1);
  const enter = (id: XRMode) => {
    setOpen(false);
    void enterXR(id);
  };
  return (
    <div className="headset-menu" ref={container}>
      <button
        className={`headset-button ${mode || open ? 'active' : ''}`}
        aria-haspopup={menu ? (joining ? 'dialog' : 'true') : undefined}
        aria-expanded={menu ? open : undefined}
        aria-pressed={mode ? true : undefined}
        title={
          mode
            ? 'Leave the headset view'
            : joining
              ? 'Join this scene from a headset'
              : 'Assemble in a headset'
        }
        onClick={() => (mode ? exitXR() : menu ? setOpen(!open) : enter(offered[0].id))}
      >
        <RectangleGoggles size={13} />
        <span className="headset-button-text">{mode ? 'Leave headset' : 'Headset'}</span>
      </button>
      {!open || !menu ? null : joining ? (
        <div
          className="headset-popover headset-join"
          role="dialog"
          aria-label="Join from a headset"
        >
          <p>In the headset’s browser, open</p>
          {joining.addresses.length ? (
            joining.addresses.map((address) => <code key={address}>{address}</code>)
          ) : (
            <code>No network connection was found</code>
          )}
          <p>and enter this code</p>
          <strong className="headset-code">
            {joining.code.slice(0, 3)} {joining.code.slice(3)}
          </strong>
          <small>
            The headset must be on the same network. Its browser warns that the connection is not
            private, because this computer makes its own certificate: choose Advanced, then Proceed.
          </small>
        </div>
      ) : (
        <div className="headset-popover" role="menu" aria-label="Headset view">
          {offered.map((m) => (
            <button
              key={m.id}
              role="menuitem"
              autoFocus={m.id === last}
              onClick={() => enter(m.id)}
            >
              <strong>{m.label}</strong>
              <small>{m.detail}</small>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
