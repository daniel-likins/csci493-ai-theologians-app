// Thin client for the local Theologians service. Every call carries the session token and this view's id.

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export const clientId: string = crypto.randomUUID();

function tokenFromPage(): string | null {
  const content = document.querySelector<HTMLMetaElement>('meta[name="theologians-csrf"]')?.content ?? '';
  return content && !content.startsWith('__') ? content : null;
}

let csrfToken: string | null = tokenFromPage();

export async function sessionToken(refresh = false): Promise<string> {
  if (refresh || !csrfToken) {
    const response = await fetch('/api/session', { cache: 'no-store' });
    if (!response.ok) throw new ApiError("Couldn't connect to Theologians' local service.", 'offline', response.status);
    csrfToken = ((await response.json()) as { csrfToken: string }).csrfToken;
  }
  return csrfToken;
}

interface RequestOptions {
  body?: unknown;
  raw?: BodyInit;
  headers?: Record<string, string>;
  keepalive?: boolean;
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}, retried = false): Promise<T> {
  let response: Response;
  try {
    const token = await sessionToken();
    response = await fetch(path, {
      method,
      keepalive: options.keepalive,
      headers: {
        'x-theologians-csrf': token,
        'x-theologians-client': clientId,
        ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...options.headers,
      },
      body: options.raw ?? (options.body !== undefined ? JSON.stringify(options.body) : undefined),
    });
  } catch (err) {
    if (err instanceof ApiError) throw err;
    throw new ApiError("Theologians' local service isn't reachable. It may have stopped — reopen the app to start it again.", 'offline', 0);
  }
  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { error?: { code?: string; message?: string; details?: unknown } } | null;
    const code = payload?.error?.code ?? 'http_error';
    if (code === 'session_token' && !retried) {
      await sessionToken(true);
      return request<T>(method, path, options, true);
    }
    throw new ApiError(payload?.error?.message ?? `Request failed (${response.status}).`, code, response.status, payload?.error?.details);
  }
  const text = await response.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export const api = {
  get: <T>(path: string) => request<T>('GET', path),
  post: <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} }),
  put: <T>(path: string, body: unknown, keepalive = false) => request<T>('PUT', path, { body, keepalive }),
  patch: <T>(path: string, body: unknown) => request<T>('PATCH', path, { body }),
  delete: <T>(path: string) => request<T>('DELETE', path),
  upload: <T>(path: string, file: Blob, type: string) =>
    request<T>('POST', path, { raw: file, headers: { 'content-type': 'application/octet-stream', 'x-file-type': type || 'application/octet-stream' } }),
};

export function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

export const isDesktopShell = /TheologiansDesktop/.test(navigator.userAgent);
