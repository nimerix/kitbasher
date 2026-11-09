import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
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
 */
export class LiveView {
  private server: Server | null = null;
  private url: string | null = null;
  private readonly token = randomBytes(16).toString('hex');
  private readonly clients = new Set<ServerResponse>();
  private readonly layouts = new WeakMap<BufferGeometry, GeometryLayout>();
  private unsubscribe: (() => void) | null = null;
  private pending: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;

  constructor(
    private readonly appDirectory = defaultAppDirectory(),
    private readonly port = Number(process.env.KITBASHER_LIVE_PORT) || 0,
    private readonly document: SharedDocument = sharedDocument,
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
    const server = createServer((request, response) => {
      this.route(request, response).catch((error) => {
        const status = error instanceof RequestError ? error.status : 500;
        if (!response.headersSent)
          response
            .writeHead(status, { 'Content-Type': 'application/json' })
            .end(JSON.stringify({ error: (error as Error).message }));
        else response.destroy();
      });
    });
    await new Promise<void>((done, fail) => {
      server.once('error', fail);
      server.listen(this.port, '127.0.0.1', done);
    });
    // The agent's session decides how long this runs, not an open browser tab.
    server.unref();
    this.server = server;
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('The live view has no address.');
    this.url = `http://127.0.0.1:${address.port}/${this.token}/?live=1`;
    this.unsubscribe = this.document.subscribe(() => this.schedule());
    this.keepAlive = setInterval(() => {
      for (const client of this.clients) client.write(': keep-alive\n\n');
    }, 20000);
    this.keepAlive.unref();
    return this.url;
  }

  stop() {
    this.unsubscribe?.();
    if (this.pending) clearTimeout(this.pending);
    if (this.keepAlive) clearInterval(this.keepAlive);
    for (const client of this.clients) client.end();
    this.clients.clear();
    this.server?.close();
    this.server = null;
    this.url = null;
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

  private async route(request: IncomingMessage, response: ServerResponse) {
    const host = request.headers.host ?? '';
    const port = (this.server?.address() as { port: number } | null)?.port;
    // Another site can point its own name at this address, so only this host is answered.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    const prefix = `/${this.token}/`;
    if (!url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    const post = request.method === 'POST';
    if (post && path === 'live/edit') return this.edit(request, response);
    if (post && (path === 'live/undo' || path === 'live/redo'))
      return this.history(request, response, path === 'live/undo' ? 'undo' : 'redo');
    if (post && path.startsWith('live/geometry/'))
      return this.upload(path.slice('live/geometry/'.length), request, response);
    if (request.method !== 'GET') {
      response.writeHead(404).end();
      return;
    }
    if (path === 'live/events') return this.events(response);
    if (path.startsWith('live/geometry/'))
      return this.geometry(path.slice('live/geometry/'.length), response);
    this.file(path || 'index.html', response);
  }

  private reply(response: ServerResponse, status: number, body: object) {
    response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  }

  private async json(request: IncomingMessage) {
    const text = Buffer.concat(await readBody(request, maxEditBytes)).toString('utf8');
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

  private events(response: ServerResponse) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
    response.write(this.message());
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
