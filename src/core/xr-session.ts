import { create } from 'zustand';
import { useEditor } from './store';
import { defaultXRSettings, readXRSettings, saveXRSettings } from './xr';
import type { XRMode, XRSettings } from './xr';
import type { XRRuntime } from '../xr/runtime';

interface XRState {
  /** The kinds of session this browser and headset offer. */
  support: Record<XRMode, boolean>;
  session: XRSession | null;
  mode: XRMode | null;
  /** The headset shows the room behind the scene, so nothing may be drawn over all of it. */
  passthrough: boolean;
  /** Set once the session is drawing and its hands can act. */
  runtime: XRRuntime | null;
  settings: XRSettings;
  /** How a headset joins the scene this tab shares: addresses to open, and a code to type. */
  sharing: { addresses: string[]; code: string } | null;
}

export const useXR = create<XRState>(() => ({
  support: { vr: false, ar: false },
  session: null,
  mode: null,
  passthrough: false,
  runtime: null,
  settings: typeof window === 'undefined' ? defaultXRSettings : readXRSettings(),
  sharing: null,
}));

const sessionModes = { vr: 'immersive-vr', ar: 'immersive-ar' } as const;

export function setXRSettings(patch: Partial<XRSettings>) {
  const settings = { ...useXR.getState().settings, ...patch };
  saveXRSettings(settings);
  useXR.setState({ settings });
}

export async function detectXR() {
  const xr = typeof navigator === 'undefined' ? undefined : navigator.xr;
  if (!xr) return;
  const offers = (mode: XRSessionMode) => xr.isSessionSupported(mode).catch(() => false);
  const [vr, ar] = await Promise.all([offers(sessionModes.vr), offers(sessionModes.ar)]);
  useXR.setState({ support: { vr, ar } });
}

/** Must run in a click, which is what lets a page start a headset session. */
export async function enterXR(mode: XRMode) {
  const xr = navigator.xr;
  if (!xr || useXR.getState().session) return;
  try {
    const session = await xr.requestSession(sessionModes[mode], {
      optionalFeatures: ['local-floor', 'hand-tracking'],
    });
    session.addEventListener('end', () => {
      if (useXR.getState().session === session)
        useXR.setState({ session: null, mode: null, passthrough: false, runtime: null });
    });
    const blend = session.environmentBlendMode;
    setXRSettings({ mode });
    useXR.setState({ session, mode, passthrough: blend ? blend !== 'opaque' : mode === 'ar' });
  } catch (error) {
    useEditor
      .getState()
      .notify(`The headset session could not start. ${(error as Error).message}`, 'error');
  }
}

export function exitXR() {
  void useXR
    .getState()
    .session?.end()
    .catch(() => {});
}
