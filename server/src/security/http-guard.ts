import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Protects the local service from other websites and DNS rebinding:
 *  1. Host header must be 127.0.0.1:<port> or localhost:<port> (blocks DNS-rebinding attacks).
 *  2. Browser Origin / Sec-Fetch-Site must be same-origin (blocks cross-site requests).
 *  3. Every API call needs the per-boot session token in a custom header. Browsers can't attach custom
 *     headers cross-origin without a CORS preflight, which this server never approves.
 * Local tools (the desktop shell, `npm run stop`) use a separate control token from service.json (0600).
 */

export interface GuardConfig {
  port: number;
  extraAllowedOrigins: string[];
}

export interface GuardTokens {
  csrf: string;
  control: string;
}

export type GuardDecision =
  | { ok: true; via: 'public' | 'csrf' | 'control' }
  | { ok: false; status: number; code: string; message: string };

export function createTokens(): GuardTokens {
  return { csrf: randomBytes(32).toString('base64url'), control: randomBytes(32).toString('base64url') };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

const PUBLIC_API = new Set(['GET /api/health', 'GET /api/session']);
/** Endpoints a browser loads without custom headers (EventSource, <img>), so they accept ?token=. */
const QUERY_TOKEN_PATHS = [/^\/api\/events$/, /^\/api\/attachments\/[^/]+\/content$/];

export function createGuard(config: GuardConfig, tokens: GuardTokens) {
  const hosts = new Set([`127.0.0.1:${config.port}`, `localhost:${config.port}`]);
  const origins = new Set([`http://127.0.0.1:${config.port}`, `http://localhost:${config.port}`]);
  for (const origin of config.extraAllowedOrigins) {
    origins.add(origin);
    try {
      hosts.add(new URL(origin).host);
    } catch {
      // ignore malformed
    }
  }

  const deny = (status: number, code: string, message: string): GuardDecision => ({ ok: false, status, code, message });

  return function check(request: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
  }): GuardDecision {
    const header = (name: string): string | undefined => {
      const value = request.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };

    const host = (header('host') ?? '').toLowerCase();
    if (!hosts.has(host)) return deny(421, 'bad_host', 'Theologians only accepts requests addressed to 127.0.0.1 or localhost.');

    const origin = header('origin');
    if (origin !== undefined && !origins.has(origin)) return deny(403, 'bad_origin', 'Requests from other websites are not allowed.');

    const site = header('sec-fetch-site');
    if (site === 'cross-site') return deny(403, 'cross_site', 'Requests from other websites are not allowed.');
    if (site === 'same-site' && !(origin && config.extraAllowedOrigins.includes(origin))) {
      return deny(403, 'cross_site', 'Requests from other local sites are not allowed.');
    }

    const [path = '/', query = ''] = request.url.split('?');
    if (!path.startsWith('/api/')) return { ok: true, via: 'public' };
    if (PUBLIC_API.has(`${request.method} ${path}`)) return { ok: true, via: 'public' };

    const control = header('x-theologians-control');
    if (control && safeEqual(control, tokens.control)) return { ok: true, via: 'control' };

    let csrf = header('x-theologians-csrf');
    if (!csrf && request.method === 'GET' && QUERY_TOKEN_PATHS.some((re) => re.test(path))) {
      csrf = new URLSearchParams(query).get('token') ?? undefined;
    }
    if (!csrf || !safeEqual(csrf, tokens.csrf)) {
      return deny(403, 'session_token', 'Missing or outdated session token. Reload the window.');
    }
    return { ok: true, via: 'csrf' };
  };
}

export const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
  'x-frame-options': 'DENY',
};

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');
