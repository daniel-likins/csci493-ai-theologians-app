import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppError } from '../lib/errors.ts';
import { truncateMiddle } from '../lib/text.ts';
import { sensitivePaths } from './files.ts';

const SANDBOX_EXEC = '/usr/bin/sandbox-exec';
const BWRAP_CANDIDATES = ['/usr/bin/bwrap', '/bin/bwrap', 'bwrap'];
const OUTPUT_CAP = 256 * 1024;

let sandboxChecked: boolean | null = null;
let bubblewrapPath: string | null = null;

export type SandboxKind = 'macos-sandbox-exec' | 'linux-bubblewrap' | 'unavailable';

/** Return the native command sandbox available on this machine. */
export function sandboxKind(): SandboxKind {
  if (process.platform === 'darwin') return sandboxAvailable() ? 'macos-sandbox-exec' : 'unavailable';
  if (process.platform === 'linux') return sandboxAvailable() ? 'linux-bubblewrap' : 'unavailable';
  return 'unavailable';
}

/** Commands stay disabled unless a supported OS sandbox is present and functional. */
export function sandboxAvailable(): boolean {
  if (sandboxChecked === null) {
    try {
      if (process.platform === 'darwin') {
        sandboxChecked = existsSync(SANDBOX_EXEC) && spawnSync(SANDBOX_EXEC, ['-p', '(version 1)(allow default)', '/usr/bin/true'], { timeout: 5000 }).status === 0;
      } else if (process.platform === 'linux') {
        bubblewrapPath = BWRAP_CANDIDATES.find((candidate) => {
          if (path.isAbsolute(candidate) && !existsSync(candidate)) return false;
          return spawnSync(candidate, ['--unshare-all', '--ro-bind', '/', '/', '--', '/bin/true'], { timeout: 5000 }).status === 0;
        }) ?? null;
        sandboxChecked = bubblewrapPath !== null;
      } else {
        sandboxChecked = false;
      }
    } catch {
      sandboxChecked = false;
    }
  }
  return sandboxChecked;
}

function sb(p: string): string {
  return `"${p.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const TOOLCHAIN_DIRS = ['.nvm', '.pyenv', '.rbenv', '.cargo', '.rustup', '.local/bin', '.local/lib', '.local/share/uv', 'Library/Python', '.bun', '.deno', '.sdkman', 'go/pkg'];

/**
 * Sandbox profile for model-proposed commands:
 *  - no network (unless the user enabled it in Settings)
 *  - writes only inside the working folder and a private temp folder
 *  - no reads from the home folder except the working folder and common toolchain folders
 *  - app data, SSH/cloud credentials, and OS credential stores are always off-limits
 */
export function buildSandboxProfile(options: { root: string; tmp: string; allowNetwork: boolean; dataDir: string }): string {
  const home = os.homedir();
  const toolchains = TOOLCHAIN_DIRS.map((d) => path.join(home, d)).filter((d) => existsSync(d));
  const lines = ['(version 1)', '(allow default)'];
  if (!options.allowNetwork) lines.push('(deny network*)');
  lines.push('(deny file-write*)');
  lines.push(
    `(allow file-write* (subpath ${sb(options.root)}) (subpath ${sb(options.tmp)}) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (literal "/dev/dtracehelper") (regex #"^/dev/fd/") (regex #"^/dev/ttys"))`,
  );
  lines.push(`(deny file-read* (subpath ${sb(home)}))`);
  lines.push('(allow file-read-metadata)');
  lines.push(`(allow file-read* (subpath ${sb(options.root)}) (subpath ${sb(options.tmp)})${toolchains.map((t) => ` (subpath ${sb(t)})`).join('')})`);
  lines.push(`(deny file-read* file-write* ${sensitivePaths(options.dataDir).map((p) => `(subpath ${sb(p)})`).join(' ')})`);
  lines.push(
    '(deny mach-lookup (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd.xpc") (global-name "com.apple.security.agent") (global-name "com.apple.secd") (global-name "com.apple.security.authhost"))',
  );
  return lines.join('\n');
}

/** Bubblewrap arguments create a new filesystem, process, IPC, UTS and (normally) network namespace. */
export function buildLinuxSandboxArgs(options: { root: string; cwd: string; tmp: string; allowNetwork: boolean; command: string }): string[] {
  const relativeCwd = path.relative(options.root, options.cwd);
  if (relativeCwd.startsWith('..') || path.isAbsolute(relativeCwd)) throw new AppError('bad_working_folder', 'Command folder is outside the workspace.', 400);
  const sandboxCwd = relativeCwd ? `/workspace/${relativeCwd.split(path.sep).join('/')}` : '/workspace';
  const args = ['--die-with-parent', '--new-session', '--unshare-all'];
  if (options.allowNetwork) args.push('--share-net');
  for (const directory of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc']) {
    if (existsSync(directory)) args.push('--ro-bind', directory, directory);
  }
  args.push(
    '--proc', '/proc',
    '--dev', '/dev',
    '--bind', options.root, '/workspace',
    '--bind', options.tmp, '/tmp',
    '--chdir', sandboxCwd,
    '--clearenv',
    '--setenv', 'PATH', '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    '--setenv', 'HOME', '/workspace',
    '--setenv', 'TMPDIR', '/tmp',
    '--setenv', 'LANG', 'C.UTF-8',
    '--setenv', 'TERM', 'dumb',
    '--setenv', 'NO_COLOR', '1',
    '--setenv', 'CI', '1',
    '--', '/bin/sh', '-c', options.command,
  );
  return args;
}

export interface CommandResult {
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  durationMs: number;
  timedOut: boolean;
  cancelled: boolean;
  truncated: boolean;
}

function capture(): { push: (chunk: Buffer) => void; value: () => { text: string; truncated: boolean } } {
  let head = '';
  let tail = '';
  let total = 0;
  return {
    push(chunk: Buffer) {
      const text = chunk.toString('utf8');
      total += text.length;
      if (head.length < OUTPUT_CAP / 2) head += text.slice(0, OUTPUT_CAP / 2 - head.length);
      tail = (tail + text).slice(-OUTPUT_CAP / 2);
    },
    value() {
      if (total <= OUTPUT_CAP / 2) return { text: head, truncated: false };
      return { text: `${head}\n…[${total - head.length - tail.length} characters omitted]…\n${tail}`, truncated: true };
    },
  };
}

export async function runSandboxedCommand(options: {
  command: string;
  cwd: string;
  root: string;
  timeoutMs: number;
  allowNetwork: boolean;
  dataDir: string;
  signal: AbortSignal;
}): Promise<CommandResult> {
  const kind = sandboxKind();
  if (kind === 'unavailable') {
    const detail = process.platform === 'win32'
      ? 'Windows does not provide a compatible command sandbox, so command execution is disabled. Chat and file tools remain available.'
      : process.platform === 'linux'
        ? 'Commands are disabled because bubblewrap (bwrap) is not installed or unavailable.'
        : 'Commands are disabled because the operating-system sandbox is unavailable.';
    throw new AppError('sandbox_unavailable', detail, 500);
  }
  const tmp = await realpath(await mkdtemp(path.join(os.tmpdir(), 'theologians-cmd-')));
  const profile = kind === 'macos-sandbox-exec'
    ? buildSandboxProfile({ root: options.root, tmp, allowNetwork: options.allowNetwork, dataDir: options.dataDir })
    : null;
  const started = Date.now();
  const out = capture();
  const err = capture();
  let timedOut = false;
  let cancelled = false;

  try {
    return await new Promise<CommandResult>((resolve, reject) => {
      const command = kind === 'macos-sandbox-exec' ? SANDBOX_EXEC : bubblewrapPath!;
      const args = kind === 'macos-sandbox-exec'
        ? ['-p', profile!, '/bin/sh', '-c', options.command]
        : buildLinuxSandboxArgs({ root: options.root, cwd: options.cwd, tmp, allowNetwork: options.allowNetwork, command: options.command });
      const child = spawn(command, args, {
        cwd: kind === 'macos-sandbox-exec' ? options.cwd : undefined,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: kind === 'macos-sandbox-exec'
          ? { PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', HOME: os.homedir(), TMPDIR: tmp, LANG: 'en_US.UTF-8', TERM: 'dumb', NO_COLOR: '1', CI: '1' }
          : process.env,
      });
      const kill = (): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, 'SIGTERM');
        } catch {
          // already gone
        }
        setTimeout(() => {
          try {
            process.kill(-child.pid!, 'SIGKILL');
          } catch {
            // already gone
          }
        }, 2000).unref();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);
      const onAbort = (): void => {
        cancelled = true;
        kill();
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
      child.stdout.on('data', out.push);
      child.stderr.on('data', err.push);
      child.on('error', (e) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        reject(new AppError('command_failed', `The command couldn't start: ${e.message}`, 500));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        options.signal.removeEventListener('abort', onAbort);
        const o = out.value();
        const e = err.value();
        resolve({
          exitCode: code,
          signal,
          stdout: o.text,
          stderr: e.text,
          durationMs: Date.now() - started,
          timedOut,
          cancelled,
          truncated: o.truncated || e.truncated,
        });
      });
    });
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function formatCommandResult(command: string, cwdLabel: string, result: CommandResult): string {
  const status = result.timedOut
    ? 'timed out and was stopped'
    : result.cancelled
      ? 'was cancelled'
      : `exited with code ${result.exitCode ?? `signal ${result.signal}`}`;
  const lines = [`$ ${command}`, `(in ${cwdLabel}) ${status} after ${(result.durationMs / 1000).toFixed(1)} s`];
  if (result.stdout.trim()) lines.push(`--- stdout ---\n${truncateMiddle(result.stdout, 10_000)}`);
  if (result.stderr.trim()) lines.push(`--- stderr ---\n${truncateMiddle(result.stderr, 5_000)}`);
  if (!result.stdout.trim() && !result.stderr.trim()) lines.push('(no output)');
  return lines.join('\n');
}
