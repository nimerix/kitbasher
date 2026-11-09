import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BufferGeometry } from 'three';
import { appendGeometry, sceneMetadata } from '../src/core/scene-file';
import { useEditor } from '../src/core/store';
import type { GeometryLayout, SceneDocument } from '../src/core/types';

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

function bodyOf(geometry: BufferGeometry) {
  const parts: BlobPart[] = [];
  const { layout } = appendGeometry(geometry, parts, 0);
  return { layout, parts };
}

/**
 * Serves the built app on loopback and streams the scene to it. Parts and relationships are small
 * and sent on every change. Meshes never change, so a tab fetches each one once, by id.
 */
export class LiveView {
  private server: Server | null = null;
  private url: string | null = null;
  private readonly token = randomBytes(16).toString('hex');
  private readonly clients = new Set<ServerResponse>();
  private readonly layouts = new WeakMap<BufferGeometry, GeometryLayout>();
  private readonly geometries = new Map<string, BufferGeometry>();
  private unsubscribe: (() => void) | null = null;
  private pending: NodeJS.Timeout | null = null;
  private keepAlive: NodeJS.Timeout | null = null;
  private sequence = 0;

  constructor(
    private readonly appDirectory = defaultAppDirectory(),
    private readonly port = Number(process.env.KITBASHER_LIVE_PORT) || 0,
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
      try {
        this.route(request, response);
      } catch {
        response.writeHead(500).end();
      }
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
    this.unsubscribe = useEditor.subscribe((state, previous) => {
      if (state.scene !== previous.scene) this.schedule();
    });
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

  private message(scene: SceneDocument) {
    const geometries: Record<string, GeometryLayout> = {};
    this.geometries.clear();
    for (const part of scene.parts) {
      const { geometry } = part;
      this.geometries.set(geometry.uuid, geometry);
      let layout = this.layouts.get(geometry);
      if (!layout) {
        layout = bodyOf(geometry).layout;
        this.layouts.set(geometry, layout);
      }
      geometries[geometry.uuid] = layout;
    }
    return JSON.stringify({
      sequence: ++this.sequence,
      scene: {
        ...sceneMetadata(scene),
        parts: scene.parts.map((part) => ({ ...part, geometry: part.geometry.uuid })),
      },
      geometries,
    });
  }

  private broadcast() {
    if (!this.clients.size) return;
    const message = `event: scene\ndata: ${this.message(useEditor.getState().scene)}\n\n`;
    for (const client of this.clients) client.write(message);
  }

  private route(request: IncomingMessage, response: ServerResponse) {
    const host = request.headers.host ?? '';
    const port = (this.server?.address() as { port: number } | null)?.port;
    // Another site can point its own name at this address, so only this host is answered.
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
      response.writeHead(403).end();
      return;
    }
    const url = new URL(request.url ?? '/', `http://${host}`);
    const prefix = `/${this.token}/`;
    if (request.method !== 'GET' || !url.pathname.startsWith(prefix)) {
      response.writeHead(404).end();
      return;
    }
    const path = decodeURIComponent(url.pathname.slice(prefix.length));
    if (path === 'live/events') return this.events(response);
    if (path.startsWith('live/geometry/'))
      return this.geometry(path.slice('live/geometry/'.length), response);
    this.file(path || 'index.html', response);
  }

  private events(response: ServerResponse) {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    this.clients.add(response);
    response.on('close', () => this.clients.delete(response));
    response.write(`event: scene\ndata: ${this.message(useEditor.getState().scene)}\n\n`);
  }

  private geometry(id: string, response: ServerResponse) {
    const geometry = this.geometries.get(id);
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
