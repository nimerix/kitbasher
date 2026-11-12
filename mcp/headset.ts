import { existsSync, openAsBlob } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { createSample } from '../src/core/sample';
import { readSceneFile } from '../src/core/scene-file';
import { sharedDocument } from './document';
import { LiveView, openInBrowser } from './live';
import type { Sharing } from './live';

// Starts a scene that this computer's browser and a headset on the same network edit together.
const args = process.argv.slice(2);
const file = args.find((arg) => !arg.startsWith('--'));

const fail = (message: string): never => {
  console.error(message);
  process.exit(1);
};

if (args.includes('--help')) {
  console.log(`Usage: kitbasher-headset [scene.kitbash] [--no-open]

Shares a scene between the Kitbasher app on this computer and a headset on the same network.
Without a scene file it starts with the sample. Set KITBASHER_SHARE_PORT to change the port
the headset connects to, which is 8443.`);
  process.exit(0);
}

let scene = createSample();
if (file) {
  const path = resolve(file);
  if (!existsSync(path)) fail(`${path} does not exist.`);
  scene = await readSceneFile(await openAsBlob(path)).catch((error: Error) =>
    fail(`${path} could not be opened. ${error.message}`),
  );
}
sharedDocument.replace(scene);

// Kept between runs, so the headset's browser is asked to trust it once rather than every time.
const folder = join(homedir(), '.kitbasher');
await mkdir(folder, { recursive: true, mode: 0o700 });
const certificate = await getCertificate(folder, 'kitbasher', undefined, 365);

const spaced = (code: string) => `${code.slice(0, 3)} ${code.slice(3)}`;
const live = new LiveView(undefined, undefined, sharedDocument, 'people');
const url = await live.start().catch((error: Error) => fail(error.message));
const sharing = await live.share(certificate, undefined, ({ code }: Sharing) =>
  console.log(`\nToo many wrong codes were tried. The new code is ${spaced(code)}.`),
);
const opened = !args.includes('--no-open') && openInBrowser(url);

console.log(`
Kitbasher headset session · ${scene.name}

  On this computer   ${url}${opened ? '\n                     Opened in your browser.' : ''}

  In the headset     ${sharing.addresses[0] ?? 'No network connection was found.'}${sharing.addresses
    .slice(1)
    .map((address) => `\n                     ${address}`)
    .join('')}
  Code               ${spaced(sharing.code)}

The headset must be on the same network. Its browser will warn that the connection is not
private, because this computer makes its own certificate: choose Advanced, then Proceed.
Then enter the code and choose Headset in the viewport.

Press Ctrl+C to end the session. Save the scene from the app on this computer first.
`);

const stop = () => {
  live.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
