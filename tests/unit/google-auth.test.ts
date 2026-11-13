import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const scope = 'https://www.googleapis.com/auth/drive.file';
const clientId = 'test.apps.googleusercontent.com';
const response = { access_token: 'token', expires_in: 3600, scope };
let storage: Map<string, string>;
let fetcher: ReturnType<typeof vi.fn>;
let popup: ReturnType<typeof vi.fn<(...args: unknown[]) => void>>;
const auth = () => import('../../src/core/google-auth');
beforeEach(() => {
  vi.resetModules();
  vi.stubEnv('VITE_GOOGLE_CLIENT_ID', clientId);
  storage = new Map();
  vi.stubGlobal('sessionStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetcher);
  popup = vi.fn();
  vi.stubGlobal('window', {
    google: {
      accounts: {
        oauth2: {
          initTokenClient: (config: { callback: (r: unknown) => void }) => ({
            requestAccessToken: (options: unknown) => {
              popup(options);
              config.callback(response);
            },
          }),
          initCodeClient: (config: { callback: (r: unknown) => void }) => ({
            requestCode: () => {
              popup();
              config.callback({ code: 'code' });
            },
          }),
        },
      },
    },
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe('Drive authorization lifetime', () => {
  it('reuses a valid static token after reload and does not force account selection', async () => {
    let module = await auth();
    await module.restoreDriveSession();
    await module.authorizeDrive();
    expect(popup).toHaveBeenCalledWith({ prompt: '' });
    vi.resetModules();
    module = await auth();
    expect(await module.restoreDriveSession()).toBe(true);
    expect(await module.driveAccessToken()).toBe('token');
    expect(popup).toHaveBeenCalledTimes(1);
  });

  it('rejects expired or different-client cached tokens and clears them on disconnect', async () => {
    storage.set(
      'kitbasher.drive-token',
      JSON.stringify({ value: 'old', expires: Date.now() + 3600_000, clientId: 'other' }),
    );
    let module = await auth();
    expect(await module.restoreDriveSession()).toBe(false);
    await module.authorizeDrive();
    await module.endDriveSession();
    expect(storage.has('kitbasher.drive-token')).toBe(false);
    expect(await module.restoreDriveSession()).toBe(false);
    vi.resetModules();
    module = await auth();
    storage.set(
      'kitbasher.drive-token',
      JSON.stringify({ value: 'old', expires: Date.now() - 1, clientId }),
    );
    expect(await module.restoreDriveSession()).toBe(false);
    await expect(module.driveAccessToken()).rejects.toMatchObject({ kind: 'auth' });
  });

  it('restores and renews a hosted session without popups or storing bearer tokens', async () => {
    vi.useFakeTimers();
    fetcher
      .mockResolvedValueOnce(Response.json({ enabled: true, ...response }))
      .mockResolvedValueOnce(
        Response.json({ enabled: true, ...response, access_token: 'renewed' }),
      );
    const module = await auth();
    expect(await module.restoreDriveSession()).toBe(true);
    vi.advanceTimersByTime(3600_000);
    expect(await Promise.all([module.driveAccessToken(), module.driveAccessToken()])).toEqual([
      'renewed',
      'renewed',
    ]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(popup).not.toHaveBeenCalled();
    expect(storage.size).toBe(0);
  });

  it('uses a code popup when the host supports renewable sessions', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ enabled: true }))
      .mockResolvedValueOnce(Response.json({ enabled: true, ...response }));
    const module = await auth();
    expect(await module.restoreDriveSession()).toBe(false);
    await module.authorizeDrive();
    expect(fetcher.mock.calls[1][0]).toBe('/api/drive/connect');
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ code: 'code' });
    expect(await module.driveAccessToken()).toBe('token');
    expect(storage.size).toBe(0);
  });

  it('keeps network renewal failures retryable and requires reconnect for revoked access', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ enabled: true, ...response }))
      .mockRejectedValueOnce(new TypeError('offline'))
      .mockResolvedValueOnce(Response.json({ error: 'Reconnect' }, { status: 401 }));
    const module = await auth();
    await module.restoreDriveSession();
    await expect(module.refreshDriveToken('token')).rejects.toMatchObject({ kind: 'retryable' });
    await expect(module.refreshDriveToken('token')).rejects.toMatchObject({ kind: 'auth' });
    expect(popup).not.toHaveBeenCalled();
  });

  it('remembers disconnect across reload even if the cookie-clearing request fails offline', async () => {
    fetcher
      .mockResolvedValueOnce(Response.json({ enabled: true, ...response }))
      .mockRejectedValueOnce(new TypeError('offline'));
    let module = await auth();
    await module.restoreDriveSession();
    await expect(module.endDriveSession()).rejects.toMatchObject({ kind: 'retryable' });
    vi.resetModules();
    module = await auth();
    expect(await module.restoreDriveSession()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(popup).not.toHaveBeenCalled();
    fetcher.mockResolvedValueOnce(Response.json({ enabled: true, ...response }));
    await module.authorizeDrive();
    expect(fetcher.mock.calls[2][0]).toBe('/api/drive/connect');
  });

  it('ignores a late refresh response after disconnect', async () => {
    let finish!: (r: Response) => void;
    fetcher
      .mockResolvedValueOnce(Response.json({ enabled: true, ...response }))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValueOnce(Response.json({}));
    const module = await auth();
    await module.restoreDriveSession();
    const refreshing = module.refreshDriveToken('token');
    const disconnecting = module.endDriveSession();
    finish(Response.json({ enabled: true, ...response }));
    await expect(refreshing).rejects.toMatchObject({ kind: 'auth' });
    await disconnecting;
    await expect(module.driveAccessToken()).rejects.toMatchObject({ kind: 'auth' });
  });
});
