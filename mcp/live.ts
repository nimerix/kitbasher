import { spawn } from 'node:child_process';
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { networkInterfaces } from 'node:os';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BufferGeometry } from 'three';
import {
  appendGeometry,
  parseSceneDocument,
  readGeometry,
  validateLayout,
} from '../src/core/scene-file';
import { sharedScene } from '../src/core/sync';
import type { GeometryLayout } from '../src/core/types';
import { EditConflict, agent, sharedDocument } from './document';
import type { SharedDocument } from './document';
import { runCompute } from './compute';
import { nativeMeshPolicy } from './native-mesh';
import { binaryGeometry } from '../src/core/geometry';
import { restoreGeometry } from '../src/core/geometry-transfer';
import type { MeshProcessOptions } from '../src/core/mesh-processing';

const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.png': 'image/png',
  '.json': 'application/json',
};

const defaultAppDirectory = () => fileURLToPath(new URL('../dist/', import.meta.url));
// Mesh keys are three.js UUIDs. Anything else is refused before it reaches a map or a URL.
const meshKey = /^[\w-]{1,64}$/;
// A JSON string past this length cannot be parsed. Meshes travel separately, so a scene never nears it.
const maxEditBytes = 256 * 2 ** 20;

function bodyOf(geometry: BufferGeometry) {
  const parts: BlobPart[] = [];
  const { layout } = appendGeometry(geometry, parts, 0);
  return { layout, parts };
}

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readBody(request: IncomingMessage, limit = Infinity) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) throw new RequestError(413, 'This change is too large to send.');
    chunks.push(chunk);
  }
  return chunks;
}

/** How another device on the network joins: an address to open and a code to type there. */
export interface Sharing {
  addresses: string[];
  code: string;
}

// A guessed code has five tries in a million before a new one replaces it.
const codeAttempts = 5;
const defaultSharePort = 8443;

const sharePort = () => {
  const wanted = process.env.KITBASHER_SHARE_PORT;
  return wanted && Number.isInteger(Number(wanted)) ? Number(wanted) : defaultSharePort;
};

const networkAddresses = () =>
  Object.values(networkInterfaces())
    .flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => entry!.address);

const joinPage = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Kitbasher — Join</title>
    <style>
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #191b1e;
        color: #e2e4e8; font: 18px system-ui, sans-serif; }
      form { display: grid; gap: 18px; width: min(360px, 86vw); text-align: center; }
      h1 { margin: 0; font-size: 26px; }
      h1 span { color: #ed9f60; }
      p { margin: 0; color: #9499a3; line-height: 1.45; }
      input { font: 600 40px ui-monospace, monospace; letter-spacing: 8px; text-align: center;
        padding: 14px 8px; color: inherit; background: #202226; border: 1px solid #454b54;
        border-radius: 8px; width: 100%; box-sizing: border-box; }
      button { font: 600 20px system-ui, sans-serif; padding: 14px; color: #1b1d20;
        background: #ed9f60; border: 0; border-radius: 8px; }
      output { min-height: 1.5em; color: #f0a39a; }
    </style>
  </head>
  <body>
    <form>
      <h1>kitbasher<span>.</span></h1>
      <p>Enter the code showing in Kitbasher on your computer.</p>
      <input name="code" inputmode="numeric" autocomplete="off" maxlength="6" autofocus
        aria-label="Code" />
      <button>Join</button>
      <output role="status"></output>
    </form>
    <script>
      const form = document.querySelector('form'), status = document.querySelector('output');
      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        status.textContent = '';
        try {
          const response = await fetch('join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code: form.code.value }),
          });
          const result = await response.json();
          if (response.ok) location.href = result.url;
          else status.textContent = result.error;
        } catch {
          status.textContent = 'The computer could not be reached.';
        }
      });
    </script>
  </body>
</html>
`;

const clientOf = (value: unknown) => {
  // The agent's own history is not a browser tab's to undo.
  if (typeof value !== 'string' || !/^[\w-]{1,64}$/.test(value) || value === agent)
    throw new RequestError(400, 'The tab did not identify itself.');
  return value;
};

/**
 * Serves the built app on loopback and shares the scene with it. Every tab is a full editor of the
 * agent's scene, with its own camera, selection, and tools. Parts and relationships are small and
 * sent on every change. Meshes never change, so each one crosses once, by key, in either direction.
 *
 * Sharing also answers other devices on the network, such as a headset, over an encrypted
 * connection. They reach the scene only by typing a code that shows on this computer.
 */
export class LiveView {
  private server: Server | null = null;
  private shared: Server | null = null;
  private url: string | null = null;
  private readonly token = randomBytes(16).toString('hex');
  private readonly clients = new Set<ServerResponse>();
  private readonly computing = new Set<AbortController>();
  /** The tabs on this computer, which are shown how another device joins. */
  private readonly local = new Set<ServerResponse>();
  private code = '';
  private misses = 0;
  private codeChanged: ((sharing: Sharing) => void) | null = null;
  private readonly layouts = new WeakMap<BufferGeometry, GeometryLayout>();
  private unsubscribe: (() => void) | null = null;
  private pending: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(
    private readonly appDirectory = defaultAppDirectory(),
    private readonly port = Number(process.env.KITBASHER_LIVE_PORT) || 0,
    private readonly document: SharedDocument = sharedDocument,
    /** Who holds the scene: an agent, or only the people editing it. */
    private readonly host: 'agent' | 'people' = 'agent',
  ) {}

  get viewers() {
    return this.clients.size;
  }

  async start() {
    if (this.url) return this.url;
    if (!existsSync(resolve(this.appDirectory, 'index.html')))
      throw new Error(
        `The Kitbasher app has not been built at ${this.appDirectory}. Run npm run build in the Kitbasher folder first.`,
      );
    const server = createServer((request, response) => this.answer(request, response));
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(this.port, '127.0.0.1', done);
    });
    // The agent's session decides how long this runs, not an open browser tab.
    server.unref();
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The live view has no address.');
    this.url = `http://127.0.0.1:${address.port}/${this.token}/?${this.query}`;
    this.unsubscribe = this.document.subscribe(() => this.schedule());
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) client.write(': keep-alive\n\n');
    }, 20000);
    this.keepAlive.unref();
    return this.url;
  }

  /**
   * Also answers other devices on the network, encrypted with this certificate and its key in
   * one PEM. Unlike the loopback server, this one keeps the process running.
   */
  async share(
    certificate: string,
    port = sharePort(),
    onCodeChange?: (sharing: Sharing) => void,
  ): Promise<Sharing> {
    await this.start();
    if (this.shared) return this.sharing!;
    const listen = (port: number) => {
      const server = createSecureServer(
        { key: certificate, cert: certificate },
        (request, response) => this.answer(request, response, true),
      );
      return new Promise<Server>((done, fail) => {
        server.once('error', fail);
        server.listen(port, '0.0.0.0', () => done(server));
      });
    };
    // The usual port makes an address worth bookmarking. Any free one still works.
    this.shared = await listen(port).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EADDRINUSE') throw error;
      return listen(0);
    });
    this.newCode();
    this.codeChanged = onCodeChange ?? null;
    return this.sharing!;
  }

  /** How another device joins, or null when the scene is not shared beyond this computer. */
  get sharing(): Sharing | null {
    const address = this.shared?.address();
    if (!address || typeof address === 'string') return null;
    return {
      addresses: networkAddresses().map((ip) => `https://${ip}:${address.port}`),
      code: this.code,
    };
  }

  stop() {
    for (const controller of this.computing) controller.abort();
    this.unsubscribe?.();
    if (this.pending) clearTimeout(this.pending);
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.local.clear();
    this.server?.close();
    this.shared?.close();
    this.shared?.closeAllConnections();
    this.server = this.shared = null;
    this.url = null;
  }

  private get query() {
    return this.host === 'agent' ? 'live=1' : 'live=shared';
  }

  private newCode() {
    this.code = String(randomInt(1_000_000)).padStart(6, '0');
    this.misses = 0;
    const sharing = this.sharing!;
    this.codeChanged?.(sharing);
    const message = this.shareMessage();
    for (const client of this.local) client.write(message);
  }

  private shareMessage() {
    return `event: share\ndata: ${JSON.stringify(this.sharing)}\n\n`;
  }

  private answer(request: IncomingMessage, response: ServerResponse, network = false) {
    this.route(request, response, network).catch((error) => {
      const status = error instanceof RequestError ? error.status : 500;
      if (!response.headersSent)
        response
          .writeHead(status, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ error: (error as Error).message }));
      else response.destroy();
    });
  }

  private schedule() {
    this.pending ??= setTimeout(() => {
      this.pending = null;
      this.broadcast();
    }, 30);
  }

  private message() {
    const { scene, version, epoch } = this.document;
    const geometries: Record<string, GeometryLayout> = {};
    for (const { geometry } of scene.parts) {
      let layout = this.layouts.get(geometry);
      if (!layout) {
        layout = bodyOf(geometry).layout;
        this.layouts.set(geometry, layout);
      }
      geometries[geometry.uuid] = layout;
    }
    return `event: scene\ndata: ${JSON.stringify({
      version,
      epoch,
      scene: sharedScene(scene),
      geometries,
      history: this.document.historyCounts(),
    })}\n\n`;
  }

  private broadcast() {
    if (!this.clients.size) return;
    const message = this.message();
    for (const client of this.clients) client.write(message);
  }

  private async route(request: IncomingMessage, response: ServerResponse, network: boolean) {
    const host = request.headers.host ?? '';
    const port = ((network ? this.shared : this.server)?.address() as { port: number } | null)
      ?.port;
    // Another site can point its own name at this address, so only this host is answered.
    const names = ['127.0.0.1', 'localhost', ...(network ? networkAddresses() : [])];
    if (!names.some((name) => host === `${name}:${port}`)) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    if (network && url.pathname === '/') {
      if (request.method === 'GET')
        response
          .writeHead(200, { 'Content-Type': contentTypes['.html'], 'Cache-Control': 'no-store' })
          .end(joinPage);
      else response.writeHead(404).end();
      return;
    }
    if (network && url.pathname === '/join' && request.method === 'POST')
      return this.join(request, response);
    const prefix = `/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const post = request.method === 'POST';
    if (post && path === 'live/process') return this.processMesh(request, response);
    if (post && path === 'live/edit') return this.edit(request, response);
    if (post && (path === 'live/undo' || path === 'live/redo'))
      return this.history(request, response, path === 'live/undo' ? 'undo' : 'redo');
    if (post && path.startsWith('live/geometry/'))
      return this.upload(path.slice('live/geometry/'.length), request, response);
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    if (path === 'live/events') return this.events(response, network);
    if (path === 'live/compute') return this.reply(response, 200, nativeMeshPolicy());
    if (path.startsWith('live/geometry/'))
      return this.geometry(path.slice('live/geometry/'.length), response);
    this.file(path || 'index.html', response);
  }

  /** Trades the code a person typed for the address of the scene. */
  private async join(request: IncomingMessage, response: ServerResponse) {
    const typed = Buffer.from(String((await this.json(request, 1024))?.code ?? '').trim());
    const code = Buffer.from(this.code);
    if (typed.length === code.length && timingSafeEqual(typed, code)) {
      this.misses = 0;
      return this.reply(response, 200, { url: `/${this.token}/?${this.query}` });
    }
    const replaced = ++this.misses >= codeAttempts;
    if (replaced) this.newCode();
    this.reply(response, 403, {
      error: replaced
        ? 'Too many wrong codes. A new one is showing on your computer.'
        : 'That is not the code showing on your computer.',
    });
  }

  private reply(response: ServerResponse, status: number, body: object) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  private async json(request: IncomingMessage, limit = maxEditBytes) {
    const text = Buffer.concat(await readBody(request, limit)).toString('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new RequestError(400, 'The tab sent a change that could not be read.');
    }
  }

  private async edit(request: IncomingMessage, response: ServerResponse) {
    const body = await this.json(request);
    const client = clientOf(body?.client);
    if (!Number.isSafeInteger(body.base) || !Number.isSafeInteger(body.epoch))
      throw new RequestError(400, 'The change does not say which version it was made on.');
    try {
      let scene;
      try {
        scene = parseSceneDocument(body.scene, 2, (reference) => {
          const geometry =
            typeof reference === 'string' ? this.document.mesh(reference) : undefined;
          if (!geometry) throw new EditConflict('A part refers to a mesh that was never sent.');
          return geometry;
        });
      } catch (error) {
        if (error instanceof EditConflict) throw error;
        throw new RequestError(400, (error as Error).message);
      }
      const version = this.document.apply(client, {
        base: body.base,
        epoch: body.epoch,
        scene,
        checkpoint: body.checkpoint !== false,
        replace: body.replace === true,
      });
      this.reply(response, 200, { version });
    } catch (error) {
      if (!(error instanceof EditConflict)) throw error;
      this.reply(response, 409, { error: error.message, version: this.document.version });
    }
  }

  private async history(
    request: IncomingMessage,
    response: ServerResponse,
    direction: 'undo' | 'redo',
  ) {
    const client = clientOf((await this.json(request))?.client);
    try {
      const result = this.document[direction](client);
      this.reply(
        response,
        200,
        result ?? { changed: false, empty: true, version: this.document.version },
      );
    } catch (error) {
      this.reply(response, 409, {
        error: (error as Error).message,
        version: this.document.version,
      });
    }
  }

  private async upload(key: string, request: IncomingMessage, response: ServerResponse) {
    if (!meshKey.test(key)) throw new RequestError(400, 'That is not a mesh key.');
    let layout: GeometryLayout;
    try {
      layout = JSON.parse(String(request.headers['x-kitbasher-layout']));
    } catch {
      throw new RequestError(400, 'The mesh was sent without its layout.');
    }
    const chunks = await readBody(request);
    if (this.document.mesh(key)) {
      response.writeHead(204).end();
      return;
    }
    // Chunks stay separate, so a mesh of several gigabytes needs no single buffer that large.
    const data = new Blob(chunks as BlobPart[]);
    let geometry: BufferGeometry;
    try {
      validateLayout(layout, 0, data.size);
      geometry = await readGeometry(data, layout);
    } catch (error) {
      throw new RequestError(400, (error as Error).message);
    }
    geometry.uuid = key;
    this.document.addMesh(key, geometry);
    response.writeHead(204).end();
  }

  /** Compute a preview only. Applying it remains an explicit, undoable editor action. */
  private async processMesh(request: IncomingMessage, response: ServerResponse) {
    const controller = new AbortController();
    this.computing.add(controller);
    const cancel = () => controller.abort();
    response.once('close', cancel);
    let geometry: BufferGeometry | undefined;
    let resultGeometry: BufferGeometry | undefined;
    try {
      let layout: GeometryLayout;
      let options: MeshProcessOptions;
      try {
        layout = JSON.parse(String(request.headers['x-kitbasher-layout']));
        options = JSON.parse(String(request.headers['x-kitbasher-options']));
      } catch {
        throw new RequestError(400, 'The mesh or processing options are missing.');
      }
      const data = new Blob((await readBody(request, 256 * 1024 * 1024)) as BlobPart[]);
      try {
        validateLayout(layout, 0, data.size);
        geometry = await readGeometry(data, layout);
      } catch (error) {
        throw new RequestError(400, (error as Error).message);
      }
      const result = await runCompute(
        { kind: 'process', mesh: binaryGeometry(geometry), options },
        controller.signal,
      );
      if (controller.signal.aborted) return;
      resultGeometry = restoreGeometry(result.geometry);
      const body = bodyOf(resultGeometry);
      const blob = new Blob(body.parts);
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': blob.size,
        'Cache-Control': 'no-store',
        'X-Kitbasher-Layout': JSON.stringify(body.layout),
        'X-Kitbasher-Error': JSON.stringify(result.error),
        'X-Kitbasher-Backend': result.backend,
      });
      response.end(Buffer.from(await blob.arrayBuffer()));
    } finally {
      this.computing.delete(controller);
      response.removeListener('close', cancel);
      geometry?.dispose();
      resultGeometry?.dispose();
    }
  }

  private events(response: ServerResponse, network: boolean) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    this.clients.add(response);
    if (!network) this.local.add(response);
    response.on('close', () => {
      this.clients.delete(response);
      this.local.delete(response);
    });
    response.write(this.message());
    // Only a tab on this computer is told the code, which is what lets another device in.
    if (!network && this.shared) response.write(this.shareMessage());
  }

  private geometry(key: string, response: ServerResponse) {
    const geometry = this.document.mesh(key);
    if (!geometry) {
      response.writeHead(404).end();
      return;
    }
    const data = new Blob(bodyOf(geometry).parts);
    response.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': data.size,
    });
    void (async () => {
      const reader = data.stream().getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done || response.destroyed) break;
        if (!response.write(value)) await new Promise((resume) => response.once('drain', resume));
      }
      response.end();
    })().catch(() => response.destroy());
  }

  private file(path: string, response: ServerResponse) {
    const root = resolve(this.appDirectory);
    const file = resolve(root, path);
    if (
      (file !== root && !file.startsWith(root + sep)) ||
      !existsSync(file) ||
      !statSync(file).isFile()
    ) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(file).toLowerCase()] ?? 'application/octet-stream',
      ...(process.env.KITBASHER_CROSS_ORIGIN_ISOLATED === '1'
        ? {
            'Cross-Origin-Opener-Policy': 'same-origin',
            'Cross-Origin-Embedder-Policy': 'require-corp',
          }
        : {}),
    });
    createReadStream(file).pipe(response);
  }
}

export function openInBrowser(url: string) {
  const [command, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true });
    // A machine without a browser still gets the address in the tool result.
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
