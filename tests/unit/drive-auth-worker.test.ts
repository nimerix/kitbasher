import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { type DriveAuthEnv } from '../../worker/drive-auth';

const origin = 'https://kitbasher.example';
const scope = 'https://www.googleapis.com/auth/drive.file';
const env: DriveAuthEnv = {
  ASSETS: { fetch: async () => new Response('assets') },
  GOOGLE_CLIENT_ID: 'test-client',
  GOOGLE_CLIENT_SECRET: 'test-secret',
  DRIVE_SESSION_KEY: 'ab'.repeat(32),
};
const tokens = {
  access_token: 'short-lived',
  refresh_token: 'private-refresh',
  expires_in: 3600,
  scope,
};
const request = (action: string, cookie?: string, requestOrigin = origin) =>
  new Request(`${origin}/api/drive/${action}`, {
    method: 'POST',
    headers: {
      Origin: requestOrigin,
      'X-Kitbasher-Drive': '1',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify({ code: 'one-use-code' }),
  });
const connect = () => worker.fetch(request('connect'), env);
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('hosted Drive sessions', () => {
  it('exchanges a popup code and keeps the refresh token only in an encrypted HttpOnly cookie', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(tokens));
    vi.stubGlobal('fetch', fetcher);
    const response = await connect();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      enabled: true,
      access_token: tokens.access_token,
      expires_in: 3600,
      scope,
    });
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly; Secure; SameSite=Strict');
    expect(cookie).not.toContain(tokens.refresh_token);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    const params = fetcher.mock.calls[0][1].body as URLSearchParams;
    expect(Object.fromEntries(params)).toEqual({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code: 'one-use-code',
      grant_type: 'authorization_code',
      redirect_uri: origin,
    });
  });

  it('renews access after an hour without another authorization code or extending the 30-day session', async () => {
    vi.useFakeTimers();
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(tokens))
      .mockResolvedValueOnce(
        Response.json({ ...tokens, refresh_token: undefined, access_token: 'renewed' }),
      );
    vi.stubGlobal('fetch', fetcher);
    const cookie = (await connect()).headers.get('Set-Cookie')!.split(';')[0];
    vi.advanceTimersByTime(3600_000);
    const response = await worker.fetch(request('session', cookie), env);
    expect(await response.json()).toMatchObject({ access_token: 'renewed' });
    expect(fetcher.mock.calls[1][1].body.get('refresh_token')).toBe(tokens.refresh_token);
    expect(response.headers.get('Set-Cookie')).toContain(`Max-Age=${30 * 86400 - 3600}`);
    vi.advanceTimersByTime(30 * 86400_000);
    expect(await (await worker.fetch(request('session', cookie), env)).json()).toEqual({
      enabled: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('rejects cross-site requests and missing CSRF headers before any token exchange', async () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    expect(
      (await worker.fetch(request('connect', undefined, 'https://other.example'), env)).status,
    ).toBe(403);
    expect(
      (
        await worker.fetch(
          new Request(`${origin}/api/drive/session`, {
            method: 'POST',
            headers: { Origin: origin },
          }),
          env,
        )
      ).status,
    ).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects tampered cookies and cookies issued for a different OAuth client', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json(tokens));
    vi.stubGlobal('fetch', fetcher);
    const cookie = (await connect()).headers.get('Set-Cookie')!.split(';')[0];
    for (const [value, config] of [
      [`${cookie.slice(0, -8)}AAAAAAAA`, env],
      [cookie, { ...env, GOOGLE_CLIENT_ID: 'other-client' }],
    ] as const) {
      expect(await (await worker.fetch(request('session', value), config)).json()).toEqual({
        enabled: true,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('keeps sessions through provider outages but clears a revoked grant', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(tokens))
      .mockResolvedValueOnce(Response.json({ error: 'temporarily_unavailable' }, { status: 503 }))
      .mockResolvedValueOnce(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    vi.stubGlobal('fetch', fetcher);
    const cookie = (await connect()).headers.get('Set-Cookie')!.split(';')[0];
    const outage = await worker.fetch(request('session', cookie), env);
    expect(outage.status).toBe(503);
    expect(outage.headers.get('Set-Cookie')).toBeNull();
    const revoked = await worker.fetch(request('session', cookie), env);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('never attaches an old account refresh token to a new code missing refresh consent', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(tokens))
      .mockResolvedValueOnce(Response.json({ ...tokens, refresh_token: undefined }));
    vi.stubGlobal('fetch', fetcher);
    const cookie = (await connect()).headers.get('Set-Cookie')!.split(';')[0];
    const response = await worker.fetch(request('connect', cookie), env);
    expect(response.status).toBe(401);
    expect(response.headers.get('Set-Cookie')).toContain('Max-Age=0');
  });

  it('requires the Drive scope, clears sessions on disconnect, and serves static installations without secrets', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...tokens, scope: '' })));
    expect((await connect()).status).toBe(401);
    expect((await worker.fetch(request('disconnect'), env)).headers.get('Set-Cookie')).toContain(
      'Max-Age=0',
    );
    expect(await (await worker.fetch(request('session'), { ASSETS: env.ASSETS })).json()).toEqual({
      enabled: false,
    });
    expect(await (await worker.fetch(new Request(origin), env)).text()).toBe('assets');
  });
});
