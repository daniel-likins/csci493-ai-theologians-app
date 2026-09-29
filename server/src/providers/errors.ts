import type { AuthType, MessageErrorDto } from '../../../shared/types.ts';

export type ProviderErrorKind =
  | 'credential_missing'
  | 'token_command_failed'
  | 'auth'
  | 'expired'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'context_length'
  | 'bad_request'
  | 'model_not_found'
  | 'server'
  | 'overloaded'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'unsupported'
  | 'blocked'
  | 'bad_response';

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly status: number | null;
  readonly retryable: boolean;

  constructor(kind: ProviderErrorKind, message: string, options: { status?: number | null; retryable?: boolean } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryable =
      options.retryable ?? ['rate_limit', 'server', 'overloaded', 'network', 'timeout'].includes(kind);
  }
}

export interface HttpErrorContext {
  connectionName: string;
  authType: AuthType;
  modelId?: string;
}

/** Pull a human-readable message out of a provider's error body. Never includes request headers. */
export function extractProviderMessage(bodyText: string): string | null {
  const text = bodyText.trim();
  if (!text) return null;
  try {
    const json = JSON.parse(text) as unknown;
    const candidates: unknown[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === 'object') {
        const obj = value as Record<string, unknown>;
        if (obj.error && typeof obj.error === 'object') candidates.push((obj.error as Record<string, unknown>).message);
        if (typeof obj.error === 'string') candidates.push(obj.error);
        candidates.push(obj.message, obj.detail);
      }
    };
    visit(json);
    const found = candidates.find((c): c is string => typeof c === 'string' && c.length > 0);
    if (found) return found.slice(0, 400);
  } catch {
    // not JSON
  }
  if (/^<!doctype|^<html/i.test(text)) return null;
  return text.slice(0, 300);
}

export function errorFromHttp(status: number, bodyText: string, ctx: HttpErrorContext): ProviderError {
  const detail = extractProviderMessage(bodyText);
  const lower = (detail ?? '').toLowerCase();
  const said = detail ? ` The server said: “${detail}”` : '';
  const name = ctx.connectionName;
  const tokenBased = ctx.authType === 'token_command' || ctx.authType === 'bearer_token';

  if (status === 401 || (status === 403 && /expired|invalid.{0,20}token|unauthori[sz]ed|authenticat/.test(lower))) {
    if (tokenBased || /expired/.test(lower)) {
      return new ProviderError(
        'expired',
        `${name} rejected the access token — it has probably expired. Refresh or update the token in Settings → Models, then retry.${said}`,
        { status },
      );
    }
    return new ProviderError('auth', `${name} rejected the API key. Check the key in Settings → Models.${said}`, { status });
  }
  if (status === 403) {
    return new ProviderError(
      'permission',
      `${name} denied access. Your account may not have access to this model or endpoint.${said}`,
      { status },
    );
  }
  if (status === 404) {
    return new ProviderError(
      'model_not_found',
      `${name} couldn't find ${ctx.modelId ? `the model “${ctx.modelId}”` : 'that endpoint'}. Check the model ID and base URL in Settings → Models.${said}`,
      { status },
    );
  }
  if (status === 429) {
    if (/quota|billing|credit|insufficient|exceeded your current/.test(lower)) {
      return new ProviderError('quota', `${name} reports that the account is out of quota or credits.${said}`, {
        status,
        retryable: false,
      });
    }
    return new ProviderError('rate_limit', `${name} is rate-limiting requests. Wait a moment and retry.${said}`, { status });
  }
  if (
    status === 413 ||
    /context.{0,3}length|maximum context|context window|too many tokens|prompt is too long|input is too long|exceeds the (maximum|context)/.test(
      lower,
    )
  ) {
    return new ProviderError(
      'context_length',
      `The conversation is too long for this model's context window. Check the model's context size in Settings → Models, or start a new chat.${said}`,
      { status, retryable: false },
    );
  }
  if (status === 408 || status === 504) {
    return new ProviderError('timeout', `${name} timed out.${said}`, { status });
  }
  if (status === 503 || status === 529) {
    return new ProviderError('overloaded', `${name} is temporarily overloaded or unavailable. Retry in a moment.${said}`, { status });
  }
  if (status >= 500) {
    return new ProviderError('server', `${name} had a server error (${status}).${said}`, { status });
  }
  return new ProviderError('bad_request', `${name} rejected the request (${status}).${said}`, { status, retryable: false });
}

/** Convert any error thrown during generation into the message shown on the failed response. */
export function toMessageError(err: unknown, connectionId?: string): MessageErrorDto {
  if (err instanceof ProviderError) {
    const action: MessageErrorDto['action'] =
      err.kind === 'credential_missing' || err.kind === 'auth' || err.kind === 'expired' || err.kind === 'token_command_failed'
        ? 'reconnect'
        : err.kind === 'model_not_found' || err.kind === 'unsupported'
          ? 'settings'
          : err.retryable
            ? 'retry'
            : undefined;
    return { code: err.kind, message: err.message, retryable: err.retryable || err.kind === 'cancelled', action, connectionId };
  }
  const message = err instanceof Error ? err.message : String(err);
  const code = (err as { code?: string } | null)?.code ?? 'internal';
  return { code, message, retryable: true, action: 'retry', connectionId };
}
