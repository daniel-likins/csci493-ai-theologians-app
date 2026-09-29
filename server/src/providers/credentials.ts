import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import type { AuthType, Protocol } from '../../../shared/types.ts';
import type { SecretStore } from '../secrets/secret-store.ts';
import { ProviderError } from './errors.ts';
import type { ConnectionRecord } from './types.ts';

const TOKEN_CACHE_MS = 10 * 60_000;
const TOKEN_COMMAND_TIMEOUT_MS = 90_000;
const COMMON_BIN_DIRS = process.platform === 'win32'
  ? []
  : ['/opt/homebrew/bin', '/usr/local/bin', '/opt/anaconda3/bin', '/usr/bin', '/bin'];

export function secretAccount(connectionId: string): string {
  return `connection:${connectionId}`;
}

export function authHeaders(protocol: Protocol, authType: AuthType, credential: string | null): Record<string, string> {
  if (!credential || authType === 'none') return {};
  if (authType === 'api_key' && protocol === 'anthropic_messages') return { 'x-api-key': credential };
  if (authType === 'api_key' && protocol === 'gemini_generate_content') return { 'x-goog-api-key': credential };
  return { authorization: `Bearer ${credential}` };
}

/**
 * Run a user-configured command that prints an access token (e.g. ALCF's official
 * `inference_auth_token.py get_access_token`, which refreshes Globus tokens itself).
 * Runs without a shell; only Settings can configure it, never a model.
 */
export function runTokenCommand(connection: ConnectionRecord): Promise<string> {
  const argv = connection.tokenCommand;
  if (!argv || argv.length === 0 || !argv[0]) {
    return Promise.reject(
      new ProviderError('credential_missing', `No token command is configured for ${connection.name}. Set one in Settings → Models.`),
    );
  }
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        PATH: [...COMMON_BIN_DIRS, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
        HOME: os.homedir(),
        ...(process.platform === 'win32'
          ? { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, TEMP: process.env.TEMP, TMP: process.env.TMP }
          : {}),
        LANG: 'en_US.UTF-8',
      },
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new ProviderError('token_command_failed', `The token command for ${connection.name} took too long and was stopped.`));
    }, TOKEN_COMMAND_TIMEOUT_MS);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(
        new ProviderError(
          'token_command_failed',
          err.code === 'ENOENT'
            ? `Couldn't run “${argv[0]}”. Use the full path to the program (for example, locate Python with \`where python\` on Windows or \`which python3\` on macOS/Linux).`
            : `Couldn't run the token command for ${connection.name}: ${err.message}`,
        ),
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      const token = lines.at(-1) ?? '';
      if (code === 0 && token && !/\s/.test(token) && token.length >= 16) {
        resolve(token);
        return;
      }
      const errTail = (stderr.trim() || stdout.trim()).split('\n').slice(-3).join(' ').slice(0, 300);
      const reauth =
        connection.preset === 'alcf'
          ? ' ALCF may need you to sign in again: run `python inference_auth_token.py authenticate --force` in a terminal, then retry.'
          : '';
      reject(
        new ProviderError(
          'token_command_failed',
          `The token command for ${connection.name} didn't return a token${code !== 0 ? ` (exit code ${code})` : ''}.${reauth}${errTail ? ` Output: ${errTail}` : ''}`,
        ),
      );
    });
  });
}

export class CredentialResolver {
  readonly #secrets: SecretStore;
  readonly #tokenCache = new Map<string, { token: string; at: number }>();
  readonly #runCommand: (connection: ConnectionRecord) => Promise<string>;

  constructor(secrets: SecretStore, runCommand: (connection: ConnectionRecord) => Promise<string> = runTokenCommand) {
    this.#secrets = secrets;
    this.#runCommand = runCommand;
  }

  async resolve(connection: ConnectionRecord, options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    switch (connection.authType) {
      case 'none':
        return null;
      case 'api_key':
      case 'bearer_token': {
        const secret = await this.#secrets.get(secretAccount(connection.id));
        if (!secret) {
          throw new ProviderError(
            'credential_missing',
            `No ${connection.authType === 'api_key' ? 'API key' : 'token'} is saved for ${connection.name}. Add it in Settings → Models.`,
          );
        }
        return secret;
      }
      case 'token_command': {
        const cached = this.#tokenCache.get(connection.id);
        if (!options.forceRefresh && cached && Date.now() - cached.at < TOKEN_CACHE_MS) return cached.token;
        const token = await this.#runCommand(connection);
        this.#tokenCache.set(connection.id, { token, at: Date.now() });
        return token;
      }
    }
  }

  invalidate(connectionId: string): void {
    this.#tokenCache.delete(connectionId);
  }
}
