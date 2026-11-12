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
configuration. The integration works with the existing static Vite deployment;
it does not require a backend or an OAuth client secret.

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
- OAuth access tokens stay in memory. Reconnect after a reload or token expiry;
  autosave never opens sign-in popups on its own. While disconnected, continue
  editing locally and reconnect to send the latest revision. Browser-only OAuth
  cannot refresh access indefinitely without a user gesture. Persistent background
  access would require a backend authorization-code flow with protected refresh
  tokens.
- Drive versions are checked before uploading. A detected remote change stops
  autosave: download your edits or **Save a new Drive copy**. To discard local edits
  and open the cloud version, **Stop autosave**, then open that scene. The version
  check is not an atomic multi-writer lock; use one editor per Drive file at a time.
  This feature does not merge simultaneous edits from different devices.
- **Stop autosave** detaches this scene. **Disconnect** also clears this tab's token.
  Neither deletes Drive files nor revokes access on other devices. Google account
  settings can revoke the app's authorization. Shared MCP/headset live sessions
  retain their existing host-managed save flow.

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
reload and reconnect, and open it from a second browser after closing the first.
Also test an interrupted large upload and a denied consent prompt. Confirm the
downloaded file reopens with geometry, transforms, and joints intact.

References: [Google token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model),
[Drive scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth),
[resumable uploads and reserved IDs](https://developers.google.com/workspace/drive/api/guides/manage-uploads).
