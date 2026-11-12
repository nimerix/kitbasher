import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { networkInterfaces, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getCertificate } from '@vitejs/plugin-basic-ssl';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SharedDocument } from '../../../mcp/document';
import { LiveView } from '../../../mcp/live';
import type { Sharing } from '../../../mcp/live';
import { createSample } from '../../../src/core/sample';

let folder: string;
let certificate: string;
beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), 'kitbasher-sharing-'));
  await mkdir(join(folder, 'app', 'assets'), { recursive: true });
  await writeFile(join(folder, 'app', 'index.html'), '<title>Kitbasher</title>');
  certificate = await getCertificate(join(folder, 'certificate'));
});
afterAll(() => rm(folder, { recursive: true, force: true }));

let live: LiveView;
let local: URL;
let sharing: Sharing;
let network: string;
const changes: Sharing[] = [];

beforeEach(async () => {
  const document = new SharedDocument();
  document.replace(createSample());
  live = new LiveView(join(folder, 'app'), 0, document, 'people');
  local = new URL(await live.start());
  changes.length = 0;
  sharing = await live.share(certificate, 0, (next) => changes.push(next));
  // Reached over loopback here, which the server answers like any of this machine's addresses.
  network = `https://127.0.0.1:${port()}`;
});
afterEach(() => live.stop());

// Read from the server itself, so these also run on a machine with no network.
const port = () =>
  (live as unknown as { shared: { address: () => { port: number } } }).shared.address().port;

interface Reply {
  status: number;
  body: string;
  type: string;
}

function send(
  url: string,
  options: { method?: string; host?: string; body?: unknown } = {},
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'https:';
    const request = (secure ? httpsRequest : httpRequest)(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: `${parsed.pathname}${parsed.search}`,
        method: options.method ?? 'GET',
        headers: {
          ...(options.host ? { Host: options.host } : {}),
          ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        // The certificate is made on this machine, as the headset's browser is told.
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode!,
            body: Buffer.concat(chunks).toString(),
            type: String(response.headers['content-type'] ?? ''),
          }),
        );
      },
    );
    request.on('error', reject);
    request.end(options.body === undefined ? undefined : JSON.stringify(options.body));
  });
}

const enter = (code: string) => send(`${network}/join`, { method: 'POST', body: { code } });

/** The first few server-sent events of a stream, by name. */
function events(url: string, wanted: number) {
  return new Promise<string[]>((resolve, reject) => {
    const parsed = new URL(url);
    const secure = parsed.protocol === 'https:';
    const names: string[] = [];
    const request = (secure ? httpsRequest : httpRequest)(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname,
        ...(secure ? { rejectUnauthorized: false } : {}),
      },
      (response) => {
        let buffer = '';
        const finish = () => {
          request.destroy();
          resolve(names);
        };
        // A stream with fewer events than wanted is done once it has gone quiet.
        const quiet = setTimeout(finish, 300);
        response.on('data', (chunk) => {
          buffer += chunk;
          for (const match of buffer.matchAll(/^event: (\w+)$/gm)) names.push(match[1]);
          buffer = '';
          if (names.length >= wanted) {
            clearTimeout(quiet);
            finish();
          }
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

describe('sharing a scene with another device', () => {
  it('gives an encrypted address on the network and a six-digit code', () => {
    const addresses = Object.values(networkInterfaces())
      .flat()
      .filter((entry) => entry?.family === 'IPv4' && !entry.internal);
    expect(sharing.addresses).toHaveLength(addresses.length);
    for (const address of sharing.addresses) expect(address).toMatch(/^https:\/\/[\d.]+:\d+$/);
    expect(sharing.code).toMatch(/^\d{6}$/);
    expect(local.searchParams.get('live')).toBe('shared');
    expect(local.protocol).toBe('http:');
  });

  it('asks for the code, and gives the scene’s address only for the right one', async () => {
    const page = await send(`${network}/`);
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/text\/html/);
    expect(page.body).toContain('Enter the code');
    expect(page.body).not.toContain(local.pathname.slice(1, -1));

    const wrong = await enter(sharing.code === '000000' ? '000001' : '000000');
    expect(wrong.status).toBe(403);
    expect(wrong.body).not.toContain(local.pathname.slice(1, -1));

    const right = await enter(` ${sharing.code} `);
    expect(right.status).toBe(200);
    const { url } = JSON.parse(right.body);
    expect(url).toBe(`${local.pathname}?live=shared`);
    expect((await send(`${network}${url}`)).body).toContain('Kitbasher');
  });

  it('serves nothing else without the scene’s address', async () => {
    for (const path of ['/assets/main.js', '/live/events', '/index.html', `/${'0'.repeat(32)}/`])
      expect((await send(`${network}${path}`)).status).toBe(404);
    expect((await send(`${network}/join`)).status).toBe(404);
    expect((await send(`${network}/`, { method: 'POST', body: {} })).status).toBe(404);
  });

  it('replaces the code after five wrong ones, and tells the computer', async () => {
    const first = sharing.code;
    const wrong = first === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++)
      expect(JSON.parse((await enter(wrong)).body).error).toMatch(/not the code/);
    expect(changes).toEqual([]);
    expect(JSON.parse((await enter(wrong)).body).error).toMatch(/new one is showing/);
    expect(changes).toHaveLength(1);
    expect(changes[0].code).toMatch(/^\d{6}$/);
    expect(live.sharing!.code).toBe(changes[0].code);
    if (changes[0].code !== first) expect((await enter(first)).status).toBe(403);
    expect((await enter(changes[0].code)).status).toBe(200);
  });

  it('counts wrong codes again after a right one', async () => {
    const wrong = sharing.code === '111111' ? '222222' : '111111';
    for (let i = 0; i < 4; i++) await enter(wrong);
    expect((await enter(sharing.code)).status).toBe(200);
    for (let i = 0; i < 4; i++) await enter(wrong);
    expect(live.sharing!.code).toBe(sharing.code);
  });

  it('refuses a code that is not short text', async () => {
    expect((await enter('1'.repeat(5000))).status).toBe(413);
    const odd = await send(`${network}/join`, { method: 'POST', body: { code: { length: 6 } } });
    expect(odd.status).toBe(403);
  });

  it('answers only to this machine’s own addresses', async () => {
    const shared = port();
    expect((await send(`${network}/`, { host: `attacker.example:${shared}` })).status).toBe(403);
    expect((await send(`${network}/`, { host: 'attacker.example' })).status).toBe(403);
    expect((await send(`${network}/`, { host: `localhost:${shared}` })).status).toBe(200);
    for (const address of sharing.addresses)
      expect((await send(`${network}/`, { host: new URL(address).host })).status).toBe(200);
    // The unencrypted server stays loopback only, with no way in by code.
    const base = `${local.origin}${local.pathname}`;
    for (const address of sharing.addresses)
      expect(
        (await send(base, { host: `${new URL(address).hostname}:${local.port}` })).status,
      ).toBe(403);
    expect((await send(`${local.origin}/`)).status).toBe(404);
    expect(
      (await send(`${local.origin}/join`, { method: 'POST', body: { code: sharing.code } })).status,
    ).toBe(404);
  });

  it('tells the code only to tabs on this computer', async () => {
    const path = `${local.pathname}live/events`;
    expect(await events(`${local.origin}${path}`, 2)).toEqual(['scene', 'share']);
    expect(await events(`${network}${path}`, 2)).toEqual(['scene']);
  });

  it('stops answering the network when stopped', async () => {
    live.stop();
    expect(live.sharing).toBeNull();
    await expect(send(`${network}/`)).rejects.toThrow();
  });
});

describe('a scene that is not shared', () => {
  it('has no network address and tells tabs nothing about joining', async () => {
    const alone = new LiveView(join(folder, 'app'), 0, new SharedDocument());
    const url = new URL(await alone.start());
    expect(alone.sharing).toBeNull();
    expect(url.searchParams.get('live')).toBe('1');
    expect(await events(`${url.origin}${url.pathname}live/events`, 2)).toEqual(['scene']);
    alone.stop();
  });
});
