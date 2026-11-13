/** Optional same-origin OAuth session for the Cloudflare-hosted workbench. */
export interface DriveAuthEnv {
  ASSETS: { fetch(request: Request): Promise<Response> };
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  // 32 random bytes encoded as 64 hex characters. Never a VITE_ build variable.
  DRIVE_SESSION_KEY?: string;
}

const scope = 'https://www.googleapis.com/auth/drive.file';
const cookieName = '__Host-kitbasher-drive';
const lifetime = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
interface Session {
  refresh: string;
  expires: number;
}
interface Tokens {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
}
const cookie = (value: string, age: number) =>
  `${cookieName}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
const reply = (body: unknown, status = 200, sessionCookie?: string) =>
  Response.json(body, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      ...(sessionCookie ? { 'Set-Cookie': sessionCookie } : {}),
    },
  });

async function key(env: DriveAuthEnv) {
  const bytes = Uint8Array.from(env.DRIVE_SESSION_KEY!.match(/../g)!, (pair) => parseInt(pair, 16));
  return crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
const context = (env: DriveAuthEnv, origin: string) =>
  encoder.encode(`${origin}\n${env.GOOGLE_CLIENT_ID}`);
async function seal(session: Session, env: DriveAuthEnv, origin: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: context(env, origin) },
      await key(env),
      encoder.encode(JSON.stringify(session)),
    ),
  );
  const bytes = new Uint8Array(iv.length + encrypted.length);
  bytes.set(iv);
  bytes.set(encrypted, iv.length);
  return btoa(String.fromCharCode(...bytes));
}
async function unseal(
  request: Request,
  env: DriveAuthEnv,
  origin: string,
): Promise<Session | null> {
  try {
    const value = request.headers
      .get('Cookie')
      ?.split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith(`${cookieName}=`))
      ?.slice(cookieName.length + 1);
    if (!value || value.length > 3800) return null;
    const bytes = Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
    const decoded = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: bytes.slice(0, 12), additionalData: context(env, origin) },
      await key(env),
      bytes.slice(12),
    );
    const session = JSON.parse(new TextDecoder().decode(decoded)) as Session;
    return typeof session.refresh === 'string' &&
      session.refresh &&
      Number.isFinite(session.expires) &&
      session.expires > Date.now()
      ? session
      : null;
  } catch {
    return null;
  }
}

async function exchange(env: DriveAuthEnv, params: Record<string, string>) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      ...params,
    }),
    signal: AbortSignal.timeout(15000),
  });
  const tokens = (await response.json()) as Tokens;
  return { ok: response.ok, tokens };
}

export default {
  async fetch(request: Request, env: DriveAuthEnv): Promise<Response> {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/drive/')) return env.ASSETS.fetch(request);
    // GIS popup codes are sent by our own page. A custom header and exact Origin
    // reject cross-site login/logout/refresh requests, including form submissions.
    if (
      request.method !== 'POST' ||
      request.headers.get('Origin') !== url.origin ||
      request.headers.get('X-Kitbasher-Drive') !== '1'
    )
      return reply({ error: 'Forbidden' }, 403);
    if (url.pathname === '/api/drive/disconnect') return reply({}, 200, cookie('', 0));
    if (!['/api/drive/session', '/api/drive/connect'].includes(url.pathname)) return reply({}, 404);
    if (
      !env.GOOGLE_CLIENT_ID ||
      !env.GOOGLE_CLIENT_SECRET ||
      !/^[a-f0-9]{64}$/i.test(env.DRIVE_SESSION_KEY ?? '')
    )
      return reply({ enabled: false });
    try {
      let session: Session | null = null;
      let result: Awaited<ReturnType<typeof exchange>>;
      if (url.pathname === '/api/drive/connect') {
        // Bound the code body without accepting arbitrary proxy/token parameters.
        const text = await request.text();
        if (text.length > 8192) return reply({ error: 'Invalid authorization code' }, 400);
        const { code } = JSON.parse(text);
        if (typeof code !== 'string' || !code || code.length > 4096)
          return reply({ error: 'Invalid authorization code' }, 400);
        result = await exchange(env, {
          code,
          grant_type: 'authorization_code',
          redirect_uri: url.origin,
        });
        // Never reuse another account's old refresh token when a code lacks one.
        if (result.ok && result.tokens.refresh_token)
          session = {
            refresh: result.tokens.refresh_token,
            expires: Date.now() + lifetime * 1000,
          };
      } else {
        session = await unseal(request, env, url.origin);
        if (!session) return reply({ enabled: true }, 200, cookie('', 0));
        result = await exchange(env, {
          refresh_token: session.refresh,
          grant_type: 'refresh_token',
        });
      }
      const { tokens } = result;
      if (!result.ok) {
        if (tokens.error === 'invalid_grant')
          return reply({ error: 'Reconnect Google Drive to renew access.' }, 401, cookie('', 0));
        // Provider outages/configuration errors must not discard a usable session.
        return reply({ error: 'Google sign-in is temporarily unavailable. Try again.' }, 503);
      }
      if (
        !session ||
        !tokens.access_token ||
        !Number.isFinite(tokens.expires_in) ||
        tokens.expires_in! <= 0 ||
        !tokens.scope?.split(' ').includes(scope)
      ) {
        return reply(
          { error: 'Google Drive access was not granted. Please connect again.' },
          401,
          cookie('', 0),
        );
      }
      if (tokens.refresh_token) session.refresh = tokens.refresh_token;
      const sealed = await seal(session, env, url.origin);
      if (sealed.length > 3800) return reply({ error: 'Google session could not be saved.' }, 503);
      return reply(
        {
          enabled: true,
          access_token: tokens.access_token,
          expires_in: tokens.expires_in,
          scope: tokens.scope,
        },
        200,
        cookie(sealed, Math.max(0, Math.floor((session.expires - Date.now()) / 1000))),
      );
    } catch {
      return reply({ error: 'Google sign-in is temporarily unavailable. Try again.' }, 503);
    }
  },
};
