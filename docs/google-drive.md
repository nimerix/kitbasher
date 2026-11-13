# Google Drive autosave

Click **Google Drive** in the header or **File → Google Drive**, connect your Google
account, then choose **Save this scene to Drive**. Kitbasher creates one ordinary
`.kitbash` file in My Drive and updates that file as you work. Renaming the assembly
also renames its Drive file. **Saved to Drive** means the latest edited revision has
finished uploading. **File → Download scene copy** remains available, and the file
in Drive can also be downloaded and opened as a normal Kitbasher scene.

The Google Drive dialog lists scenes saved by Kitbasher, newest first, with
pagination. Select a scene and confirm **Open scene** to resume autosaving to it.
Files uploaded to Drive outside Kitbasher are not listed; download and open those
locally, then save them to Drive from Kitbasher.

## Enable Drive for an installation

Drive is optional. Local editing, recovery, downloads, and exports need no Google
configuration. Static deployments reuse a valid access token across reloads in the
same tab. Hosted deployments can renew access automatically using the optional
Cloudflare session worker below.

1. Create or select a project in [Google Cloud Console](https://console.cloud.google.com/).
2. Enable the **Google Drive API** in that project.
3. Configure Google Auth Platform's branding, audience, and consent screen. Request
   only `https://www.googleapis.com/auth/drive.file`. For an external application
   in Testing, add the Google accounts that will test it as test users. Complete
   Google's publication requirements before opening access to other users.
4. Create an OAuth client with application type **Web application**. Add each exact
   **Authorized JavaScript origin**, including its port: for example
   `http://localhost:5173`, `http://127.0.0.1:5173`, and `https://kitbasher.app`.
   Add preview origins separately when needed. The popup token flow does not need
   a redirect URI. Production origins must use HTTPS; local development may use
   localhost. Arbitrary plain-HTTP LAN addresses are not suitable for Google sign-in.
5. Copy `.env.example` to `.env.local` and set `VITE_GOOGLE_CLIENT_ID` to that public
   client ID (`…apps.googleusercontent.com`). Restart Vite. For a hosted app, set
   the same variable in the build environment and rebuild/redeploy `dist/`.
   **Never supply a client secret in a Vite environment variable.**

If a host sets a Content Security Policy, allow Google's Identity Services script
and authentication frames, and Drive API connections, following Google's
[client setup requirements](https://developers.google.com/identity/oauth2/web/guides/load-3p-authorization-library).
Do not enable a restrictive Cross-Origin-Opener-Policy that breaks OAuth popups;
Google documents `same-origin-allow-popups` for this integration when necessary.

## Saving and recovery behavior

- Edits are grouped for 1.5 seconds. Continuous editing triggers a save within eight
  seconds when another upload is not already running. Only one upload runs at a
  time; edits during an upload become the next revision. Camera/selection changes
  do not trigger Drive writes.
- Uploads use Drive's resumable API in 8 MiB chunks. A lost response is checked
  against the upload session before continuing. Transient failures retry with
  backoff, up to 30 seconds between attempts; returning online retries immediately.
  Reserved file IDs prevent duplicate files when a create response is lost.
- Every save uploads the complete binary scene. Large scans therefore take longer
  and use more bandwidth; this is background autosave, not mesh-delta streaming.
  Wait for **Saved to Drive** before closing the tab. Pending Drive edits trigger
  the browser's leave-page warning even if local recovery has finished.
- IndexedDB recovery continues independently. It stores the Drive file binding
  alongside the local scene, so reconnecting after a reload updates the same file.
  Downloaded `.kitbash` files contain neither Drive bindings nor credentials.
  Opening a local file or starting a new scene clears the previous cloud binding.
- On static hosts, short-lived access tokens are kept in this tab's session storage,
  scoped to the configured client ID, and reused until expiry. Reconnection no longer
  forces the account chooser. Google still requires a click after token expiry;
  autosave never launches popups on its own.
- With the hosted session worker enabled, access tokens stay in memory and renew
  automatically, including after reload and a Drive 401 response. Sessions last up
  to 30 days, unless Google revokes or expires the grant earlier. Transient network
  errors retry without clearing the session. Refresh tokens never reach JavaScript
  or scene files.
- Drive content checksums distinguish file edits from metadata-only version changes.
  Older recovery records and uncertain upload acknowledgements are checked against
  the actual cloud bytes before declaring a conflict. A real conflict pauses saving
  and offers **Load Drive version**, **Overwrite Drive version**, **Save a new Drive
  copy**, and **Check again**. Loading and overwriting require a second confirmation;
  canceling or a failed download preserves the local scene. Overwriting checks the
  remote version again before upload. A changed remote version needs another decision.
  This preflight is not an atomic multi-writer lock: use one editor per Drive file.
  Kitbasher does not merge simultaneous edits from different devices.
- **Stop autosave** detaches this scene. **Disconnect** also clears the tab's token
  and, when enabled, the hosted session cookie. Neither deletes Drive files nor
  revokes access on other devices. Google account settings can revoke the app's
  authorization. Shared MCP/headset sessions retain their host-managed save flow.

## Enable automatic session renewal on Cloudflare

Browser-only OAuth cannot refresh access without a user gesture. The included
`worker/drive-auth.ts` uses Google's authorization-code popup flow and serves the
Vite build through the `ASSETS` binding in `wrangler.jsonc`. The frontend discovers
this same-origin service automatically; it falls back to browser-only auth on
static hosts or when the worker reports that sessions are not configured.

1. Keep `VITE_GOOGLE_CLIENT_ID` in the **build** environment. Set runtime
   `GOOGLE_CLIENT_ID` to the **same** Web application client ID.
2. Add the exact production origin (for example `https://kitbasher.app`) to that
   client's **Authorized redirect URIs** as well as its JavaScript origins. GIS
   popup code exchanges use the page origin as their redirect URI.
3. Set two **Worker secrets**, never `VITE_` variables: `GOOGLE_CLIENT_SECRET` (from
   that OAuth client) and `DRIVE_SESSION_KEY` (32 cryptographically random bytes as
   64 hexadecimal characters). For CLI setup use `npx wrangler secret put NAME`.
   The session key encrypts refresh tokens using AES-GCM; rotating it signs users
   out. Do not commit secrets or place them in `dist/`.
4. Build with `npm run build`. Configure the existing Worker deployment to use
   `npx wrangler deploy` and this repository's config, rather than an assets-only
   deploy command. Match the config's Worker name to the existing installation
   before deploying. This change does not itself configure or deploy production.
5. Publish the Google OAuth app for production. External apps left in Google's
   Testing status may receive refresh tokens that expire after seven days.

The session is an encrypted, authenticated, Secure/HttpOnly/SameSite=Strict cookie
bound to the host and OAuth client, with a fixed 30-day expiry. No session database
is required. Session endpoints require POST, an exact same-origin `Origin` and a
custom header, and return non-cacheable responses without CORS permission. Only
OAuth exchanges pass through the worker; scene uploads/downloads still go directly
to Drive. No credentials or token-response bodies are logged by the application.
Google revocation and the session expiry limit reuse of a copied session cookie;
Disconnect clears the current browser cookie, rather than revoking Google's grant.
A connect response without a refresh token fails safely; remove Kitbasher's grant
in Google Account permissions and reconnect if Google does not issue a new one.

## Verification

```sh
npm test
npm run build
npm run test:e2e:drive
```

The dedicated Drive browser tests start an isolated server on port 5178 with a
dummy public client ID and mocked Google Identity/Drive responses. They exercise
the real controls, binary uploads, IndexedDB recovery, reopen, offline retry,
expired authorization, permission denial, conflicts, downloads, and narrow layout.
Unit tests cover coalescing, upload ordering, late acknowledgements, chunk resume,
and failure classification. These tests do not prove acceptance by a live Google
OAuth project or Drive account.

For a live check after configuring the client ID: connect an allowed test account,
save a small scene, edit and rename it, verify the same file changes in Drive,
reload without reconnecting, wait through an access-token expiry on the hosted
installation, and open it from a second browser after closing the first.
Also test an interrupted large upload and a denied consent prompt. Confirm the
downloaded file reopens with geometry, transforms, and joints intact.

References: [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Google code model](https://developers.google.com/identity/oauth2/web/guides/use-code-model),
[Drive file versions and checksums](https://developers.google.com/workspace/drive/api/reference/rest/v3/files),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[resumable uploads and reserved IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
