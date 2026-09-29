import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { AppError } from '../lib/errors.ts';

/** OS-backed credential storage. Secrets never touch SQLite, logs, API responses, exports, or the web bundle. */
export interface SecretStore {
  readonly description: string;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const ACCOUNT_RE = /^[a-z_]+:[A-Za-z0-9._-]{1,128}$/;
const SECURITY_BIN = '/usr/bin/security';
const ERR_ITEM_NOT_FOUND = 44;

function validateAccount(account: string): void {
  if (!ACCOUNT_RE.test(account)) throw new AppError('bad_secret_account', 'Invalid credential identifier.', 400);
}

export function validateSecret(secret: string): void {
  if (secret.length === 0) throw new AppError('empty_secret', 'The key or token is empty.', 400);
  if (secret.length > 16_384) throw new AppError('secret_too_long', 'The key or token is too long.', 400);
  if (/[\r\n\0]/.test(secret)) throw new AppError('bad_secret', 'The key or token contains line breaks. Paste just the key itself.', 400);
}

function runProcess(
  command: string,
  args: string[],
  stdin: string | null,
  options: { timeoutMessage: string; unavailableMessage: string; timeoutMs?: number },
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() => reject(new AppError('credential_store_timeout', options.timeoutMessage, 504)));
    }, options.timeoutMs ?? 20_000);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (err) => finish(() => reject(new AppError('credential_store_unavailable', `${options.unavailableMessage} (${err.message}).`, 500))));
    child.on('close', (code) => finish(() => resolve({ code: code ?? -1, stdout, stderr })));
    child.stdin.on('error', () => undefined);
    child.stdin.end(stdin ?? '');
  });
}

function runSecurity(args: string[], stdin: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess(SECURITY_BIN, args, stdin, {
    timeoutMessage: 'The macOS Keychain did not respond. If a Keychain dialog is open, answer it and try again.',
    unavailableMessage: 'The macOS Keychain is unavailable',
  });
}

const ENCODED_PREFIX = 'b64:';
function encodeForKeychain(secret: string): string {
  return ENCODED_PREFIX + Buffer.from(secret, 'utf8').toString('base64');
}
function decodeFromKeychain(stored: string): string {
  return stored.startsWith(ENCODED_PREFIX) ? Buffer.from(stored.slice(ENCODED_PREFIX.length), 'base64').toString('utf8') : stored;
}

/** macOS login Keychain via `/usr/bin/security`; secret material is sent only over stdin. */
export class KeychainSecretStore implements SecretStore {
  readonly description = 'macOS Keychain';
  readonly service: string;
  constructor(service: string) {
    if (/["\\\n]/.test(service)) throw new Error('Invalid credential service name');
    this.service = service;
  }

  async get(account: string): Promise<string | null> {
    validateAccount(account);
    const result = await runSecurity(['find-generic-password', '-s', this.service, '-a', account, '-w'], null);
    if (result.code === ERR_ITEM_NOT_FOUND) return null;
    if (result.code !== 0) throw new AppError('credential_store_error', `Could not read a credential from the macOS Keychain (code ${result.code}).`, 500);
    return decodeFromKeychain(result.stdout.replace(/\n$/, ''));
  }

  async set(account: string, secret: string): Promise<void> {
    validateAccount(account);
    validateSecret(secret);
    const hex = Buffer.from(encodeForKeychain(secret), 'utf8').toString('hex');
    await runSecurity(['-i'], `add-generic-password -U -s "${this.service}" -a "${account}" -X ${hex}\n`);
    if ((await this.get(account)) !== secret) throw new AppError('credential_store_error', 'Saving the credential to the macOS Keychain failed.', 500);
  }

  async delete(account: string): Promise<void> {
    validateAccount(account);
    const result = await runSecurity(['delete-generic-password', '-s', this.service, '-a', account], null);
    if (result.code !== 0 && result.code !== ERR_ITEM_NOT_FOUND) throw new AppError('credential_store_error', `Could not remove the credential from the macOS Keychain (code ${result.code}).`, 500);
  }
}

const DPAPI_PROTECT = `$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$b=[Text.Encoding]::UTF8.GetBytes([string]$r.secret);$c=[Security.Cryptography.ProtectedData]::Protect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Convert]::ToBase64String($c))`;
const DPAPI_UNPROTECT = `$ErrorActionPreference='Stop';$r=[Console]::In.ReadToEnd()|ConvertFrom-Json;$c=[Convert]::FromBase64String([string]$r.cipher);$b=[Security.Cryptography.ProtectedData]::Unprotect($c,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))`;

/** Windows DPAPI, scoped to the signed-in user. Only encrypted blobs are written to disk. */
export class WindowsDpapiSecretStore implements SecretStore {
  readonly description = 'Windows Credential Protection (DPAPI)';
  readonly service: string;
  readonly directory: string;
  readonly #powershell: string;

  constructor(service: string, dataDir: string, env: NodeJS.ProcessEnv = process.env) {
    this.service = service;
    this.directory = path.join(dataDir, 'credentials');
    this.#powershell = env.SystemRoot ? path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
  }

  #file(account: string): string {
    return path.join(this.directory, `${createHash('sha256').update(`${this.service}\0${account}`).digest('hex')}.dpapi`);
  }

  #run(script: string, request: object): Promise<{ code: number; stdout: string; stderr: string }> {
    return runProcess(this.#powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], JSON.stringify(request), {
      timeoutMessage: 'Windows credential protection did not respond.',
      unavailableMessage: 'Windows credential protection is unavailable',
    });
  }

  async get(account: string): Promise<string | null> {
    validateAccount(account);
    let cipher: string;
    try {
      cipher = (await readFile(this.#file(account), 'utf8')).trim();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    const result = await this.#run(DPAPI_UNPROTECT, { cipher });
    if (result.code !== 0) throw new AppError('credential_store_error', 'Windows could not decrypt this credential for the current user.', 500);
    return result.stdout;
  }

  async set(account: string, secret: string): Promise<void> {
    validateAccount(account);
    validateSecret(secret);
    const result = await this.#run(DPAPI_PROTECT, { secret });
    if (result.code !== 0 || !result.stdout.trim()) throw new AppError('credential_store_error', 'Windows could not protect this credential.', 500);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const target = this.#file(account);
    const temporary = `${target}.${process.pid}.tmp`;
    await writeFile(temporary, result.stdout.trim(), { mode: 0o600 });
    await rename(temporary, target);
  }

  async delete(account: string): Promise<void> {
    validateAccount(account);
    await unlink(this.#file(account)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}

function runSecretTool(args: string[], stdin: string | null): Promise<{ code: number; stdout: string; stderr: string }> {
  return runProcess('secret-tool', args, stdin, {
    timeoutMessage: 'The Linux Secret Service did not respond. Unlock your login keyring and try again.',
    unavailableMessage: 'Linux credential storage requires secret-tool (install libsecret-tools) and an unlocked Secret Service',
  });
}

/** Linux Secret Service (for example GNOME Keyring or KWallet) via `secret-tool`. */
export class LinuxSecretServiceStore implements SecretStore {
  readonly description = 'Linux Secret Service';
  readonly service: string;
  constructor(service: string) { this.service = service; }

  async get(account: string): Promise<string | null> {
    validateAccount(account);
    const result = await runSecretTool(['lookup', 'service', this.service, 'account', account], null);
    if (result.code === 1 && !result.stdout) return null;
    if (result.code !== 0) throw new AppError('credential_store_error', 'Could not read the credential from the Linux Secret Service.', 500);
    return result.stdout.replace(/\n$/, '');
  }

  async set(account: string, secret: string): Promise<void> {
    validateAccount(account);
    validateSecret(secret);
    const result = await runSecretTool(['store', `--label=${this.service}`, 'service', this.service, 'account', account], secret);
    if (result.code !== 0) throw new AppError('credential_store_error', 'Could not save the credential to the Linux Secret Service.', 500);
  }

  async delete(account: string): Promise<void> {
    validateAccount(account);
    const result = await runSecretTool(['clear', 'service', this.service, 'account', account], null);
    if (result.code !== 0 && result.code !== 1) throw new AppError('credential_store_error', 'Could not remove the credential from the Linux Secret Service.', 500);
  }
}

export function createSecretStore(service: string, dataDir: string, platform: NodeJS.Platform = process.platform): SecretStore {
  if (platform === 'darwin') return new KeychainSecretStore(service);
  if (platform === 'win32') return new WindowsDpapiSecretStore(service, dataDir);
  if (platform === 'linux') return new LinuxSecretServiceStore(service);
  throw new Error(`Theologians does not yet support secure credential storage on ${platform}.`);
}

/** In-memory store for automated tests. Never used for real data. */
export class MemorySecretStore implements SecretStore {
  readonly description = 'in-memory (tests only)';
  readonly #values = new Map<string, string>();
  async get(account: string): Promise<string | null> { validateAccount(account); return this.#values.get(account) ?? null; }
  async set(account: string, secret: string): Promise<void> { validateAccount(account); validateSecret(secret); this.#values.set(account, secret); }
  async delete(account: string): Promise<void> { this.#values.delete(account); }
}
