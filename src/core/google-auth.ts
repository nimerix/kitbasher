const driveScope = 'https://www.googleapis.com/auth/drive.file';
export const googleClientId = (import.meta.env.VITE_GOOGLE_CLIENT_ID ?? '').trim();

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
interface GoogleIdentity {
  accounts: {
    oauth2: {
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
// Access tokens deliberately live only in memory, never in a scene or browser storage.
let token: { value: string; expires: number } | null = null;

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
  return new Promise((resolve, reject) => {
    const google = identity();
    if (!googleClientId || !google) {
      reject(new Error('Google Drive is not ready to connect.'));
      return;
    }
    const client = google.accounts.oauth2.initTokenClient({
      client_id: googleClientId,
      scope: driveScope,
      include_granted_scopes: false,
      callback: (response) => {
        if (
          response.error ||
          !response.access_token ||
          !Number.isFinite(Number(response.expires_in)) ||
          Number(response.expires_in) <= 0 ||
          !response.scope?.split(' ').includes(driveScope)
        ) {
          reject(
            new DriveError('Google Drive access was not granted. Please connect again.', 'auth'),
          );
          return;
        }
        token = {
          value: response.access_token,
          expires: Date.now() + Number(response.expires_in) * 1000 - 30000,
        };
        resolve();
      },
      error_callback: ({ type }) => {
        reject(
          new Error(
            type === 'popup_closed'
              ? 'Google sign-in was closed. Your scene is still in this browser.'
              : 'Allow popups for Kitbasher, then connect to Google Drive again.',
          ),
        );
      },
    });
    client.requestAccessToken({ prompt: 'select_account' });
  });
}

export function driveAccessToken(): string {
  if (!token || Date.now() >= token.expires) {
    token = null;
    throw new DriveError('Reconnect to Google Drive to continue autosaving.', 'auth');
  }
  return token.value;
}

export function forgetDriveToken() {
  token = null;
}
