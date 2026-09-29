import { errorFromHttp, ProviderError, type HttpErrorContext } from './errors.ts';

export function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

export function isLocalHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    h.endsWith('.local') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

function describeNetworkFailure(url: string, err: unknown): string {
  let host = url;
  let local = false;
  try {
    const u = new URL(url);
    host = u.host;
    local = isLocalHost(u.hostname);
  } catch {
    // keep url
  }
  const cause = (err as { cause?: { code?: string } } | null)?.cause?.code;
  const hint = local
    ? 'Make sure the local model server is running.'
    : 'Check your internet connection and the base URL.';
  return `Couldn't reach ${host}${cause ? ` (${cause})` : ''}. ${hint}`;
}

function linkedController(signal: AbortSignal): { controller: AbortController; unlink: () => void } {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort(signal.reason);
  if (signal.aborted) controller.abort(signal.reason);
  else signal.addEventListener('abort', onAbort, { once: true });
  return { controller, unlink: () => signal.removeEventListener('abort', onAbort) };
}

export interface RequestOptions {
  url: string;
  headers: Record<string, string>;
  signal: AbortSignal;
  fetchImpl: typeof fetch;
  errorContext: HttpErrorContext;
  /** Maximum wait for response headers (model cold starts on institutional clusters can be slow). */
  headersTimeoutMs?: number;
}

async function send(options: RequestOptions, init: RequestInit): Promise<Response> {
  const { controller, unlink } = linkedController(options.signal);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, options.headersTimeoutMs ?? 120_000);
  try {
    const response = await options.fetchImpl(options.url, { ...init, signal: controller.signal });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw errorFromHttp(response.status, body, options.errorContext);
    }
    return response;
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    if (options.signal.aborted) throw new ProviderError('cancelled', 'Stopped.');
    if (timedOut) {
      throw new ProviderError('timeout', `${options.errorContext.connectionName} didn't respond in time.`);
    }
    throw new ProviderError('network', describeNetworkFailure(options.url, err));
  } finally {
    clearTimeout(timer);
    // The caller's signal still controls the body stream through fetch's own abort handling.
    options.signal.addEventListener('abort', () => controller.abort(), { once: true });
    unlink();
  }
}

export function openStream(options: RequestOptions & { body: unknown }): Promise<Response> {
  return send(options, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream', ...options.headers },
    body: JSON.stringify(options.body),
  });
}

export async function getJson<T>(options: RequestOptions): Promise<T> {
  const response = await send(options, { method: 'GET', headers: { accept: 'application/json', ...options.headers } });
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('bad_response', `${options.errorContext.connectionName} returned something that isn't JSON.`);
  }
}

export function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // fall through
  }
  return { __invalid_arguments: String(raw).slice(0, 2000) };
}
