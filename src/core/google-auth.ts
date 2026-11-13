const driveScope = 'https://www.googleapis.com/auth/drive.file';
export const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();

interface TokenResponse {
  enabled?: boolean;
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface GoogleIdentity {
  accounts: {
    oauth2: {
      initCodeClient(config: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        ux_mode: 'popup';
        callback: (response: { code?: string; error?: string }) => void;
        error_callback: (error: { type: string }) => void;
      }): { requestCode(): void };
      initTokenClient(config: {
        client_id: string;
        scope: string;
        include_granted_scopes: boolean;
        callback: (response: TokenResponse) => void;
        error_callback: (error: { type: string }) => void;
      }): { requestAccessToken(options: { prompt: string }): void };
    };
  };
}

const identity = () => (window as Window & { google?: GoogleIdentity }).google;
let loading: Promise<void> | undefined;
// Hosted sessions keep refresh credentials in an encrypted HttpOnly cookie.
// Static installs reuse only the short-lived access token in this tab's sessionStorage.
const storageKey = 'kitbasher.drive-token';
const disconnectedKey = 'kitbasher.drive-disconnected';
let token: { value: string; expires: number } | null = null;
let sessionEnabled = false;
let initialized: Promise<boolean> | undefined;
let refreshing: Promise<string> | undefined;
let generation = 0;
let disconnected = false;
try {
  const previous = sessionStorage.getItem(disconnectedKey);
  disconnected = previous === 'true' || previous === googleClientId;
  sessionEnabled = previous === googleClientId;
} catch {
  /* Storage unavailable. */
}

function storedToken() {
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) ?? 'null');
    if (
      stored?.clientId === googleClientId &&
      typeof stored.value === 'string' &&
      Number.isFinite(stored.expires) &&
      stored.expires > Date.now()
    )
      return stored;
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Browser storage can be disabled. In-memory auth still works. */
  }
  return null;
}

function acceptToken(response: TokenResponse) {
  if (
    response.error ||
    !response.access_token ||
    !Number.isFinite(Number(response.expires_in)) ||
    Number(response.expires_in) <= 0 ||
    !response.scope?.split(' ').includes(driveScope)
  ) {
    throw new DriveError('Google Drive access was not granted. Please connect again.', 'auth');
  }
  token = {
    value: response.access_token,
    expires: Date.now() + Number(response.expires_in) * 1000 - 30000,
  };
  try {
    if (sessionEnabled) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, JSON.stringify({ ...token, clientId: googleClientId }));
  } catch {
    /* Continue without reload persistence. */
  }
}

async function sessionRequest(action: string, body: object = {}): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetch(`/api/drive/${action}`, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'X-Kitbasher-Drive': '1' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch {
    throw new DriveError('Could not reach Google sign-in. Retry when connected.', 'retryable');
  }
  if (
    action === 'session' &&
    (response.status === 404 ||
      response.status === 405 ||
      (response.ok && !response.headers.get('Content-Type')?.includes('application/json')))
  )
    return { enabled: false };
  const data = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new DriveError(
      data.error ?? 'Google sign-in is unavailable. Try again.',
      response.status === 401 ? 'auth' : 'retryable',
      response.status,
    );
  return data;
}

/** Restore once on startup; never opens an OAuth popup in the background. */
export function restoreDriveSession(): Promise<boolean> {
  if (!googleClientId || disconnected) return Promise.resolve(false);
  if (initialized) return initialized.then(() => !!token && Date.now() < token.expires);
  const epoch = generation;
  initialized = (async () => {
    const response = await sessionRequest('session');
    if (epoch !== generation) return false;
    sessionEnabled = response.enabled === true;
    if (sessionEnabled) {
      forgetDriveToken();
      if (response.access_token) acceptToken(response);
    } else token = storedToken();
    return !!token;
  })().catch((error) => {
    initialized = undefined;
    if (error instanceof DriveError && error.kind === 'auth') {
      sessionEnabled = true;
      forgetDriveToken();
      return false;
    }
    throw error;
  });
  return initialized;
}

export async function refreshDriveToken(rejected?: string): Promise<string> {
  if (disconnected) throw new DriveError('Reconnect Google Drive to continue saving.', 'auth');
  if (rejected && token?.value !== rejected) return driveAccessToken();
  if (!sessionEnabled) {
    forgetDriveToken();
    throw new DriveError(
      'Reconnect Google Drive to renew access. Your local edits are safe.',
      'auth',
    );
  }
  if (refreshing) return refreshing;
  const epoch = generation;
  refreshing = sessionRequest('session')
    .then((response) => {
      if (epoch !== generation) throw new DriveError('Google Drive was disconnected.', 'auth');
      if (!response.access_token)
        throw new DriveError('Reconnect Google Drive to renew access.', 'auth');
      acceptToken(response);
      return token!.value;
    })
    .finally(() => {
      refreshing = undefined;
    });
  return refreshing;
}

export async function endDriveSession() {
  disconnected = true;
  try {
    sessionStorage.setItem(disconnectedKey, sessionEnabled ? googleClientId : 'true');
  } catch {
    /* Storage unavailable. */
  }
  generation++;
  forgetDriveToken();
  // Let an in-flight refresh set its cookie before clearing it, so a late
  // response cannot silently sign the browser back in after Disconnect.
  await refreshing?.catch(() => {});
  if (sessionEnabled) await sessionRequest('disconnect');
  initialized = undefined;
}

export class DriveError extends Error {
  constructor(
    message: string,
    readonly kind: 'auth' | 'retryable' | 'conflict' | 'error' = 'error',
    readonly status?: number,
  ) {
    super(message);
  }
}

/** Load when the Drive dialog opens, before the sign-in button receives a user gesture. */
export function loadGoogleIdentity(): Promise<void> {
  if (identity()?.accounts.oauth2) return Promise.resolve();
  if (loading) return loading;
  loading = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://accounts.google.com/gsi/client';
    script.async = true;
    const fail = () => {
      clearTimeout(timeout);
      script.remove();
      loading = undefined;
      reject(new Error('Google sign-in could not load. Check your connection and try again.'));
    };
    const timeout = setTimeout(fail, 15000);
    script.onerror = fail;
    script.onload = () => {
      if (!identity()?.accounts.oauth2) return fail();
      clearTimeout(timeout);
      resolve();
    };
    document.head.appendChild(script);
  });
  return loading;
}

/** Must be called directly from a click, without awaiting script loading first. */
export function authorizeDrive(): Promise<void> {
  disconnected = false;
  try {
    sessionStorage.removeItem(disconnectedKey);
  } catch {
    /* Storage unavailable. */
  }
  const epoch = ++generation;
  return new Promise((resolve, reject) => {
    const google = identity();
    if (!googleClientId || !google) {
      reject(new Error('Google Drive is not ready to connect.'));
      return;
    }
    const error_callback = ({ type }: { type: string }) =>
      reject(
        new Error(
          type === 'popup_closed'
            ? 'Google sign-in was closed. Your scene is still in this browser.'
            : 'Allow popups for Kitbasher, then connect to Google Drive again.',
        ),
      );
    const config = {
      client_id: googleClientId,
      scope: driveScope,
      include_granted_scopes: false,
      error_callback,
    };
    const complete = (response: TokenResponse) => {
      if (epoch !== generation) throw new DriveError('Google Drive was disconnected.', 'auth');
      acceptToken(response);
      initialized = Promise.resolve(true);
      resolve();
    };
    if (sessionEnabled) {
      google.accounts.oauth2
        .initCodeClient({
          ...config,
          ux_mode: 'popup',
          callback: (response) => {
            if (!response.code || response.error) {
              reject(
                new DriveError(
                  'Google Drive access was not granted. Please connect again.',
                  'auth',
                ),
              );
              return;
            }
            void sessionRequest('connect', { code: response.code }).then(complete).catch(reject);
          },
        })
        .requestCode();
    } else {
      google.accounts.oauth2
        .initTokenClient({
          ...config,
          callback: (response) => {
            try {
              complete(response);
            } catch (error) {
              reject(error);
            }
          },
        })
        .requestAccessToken({ prompt: '' });
    }
  });
}

export async function driveAccessToken(): Promise<string> {
  if (!token || Date.now() >= token.expires) {
    if (sessionEnabled) return refreshDriveToken();
    forgetDriveToken();
    throw new DriveError('Reconnect to Google Drive to continue autosaving.', 'auth');
  }
  return token.value;
}

export function forgetDriveToken() {
  token = null;
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    /* Storage unavailable. */
  }
}
