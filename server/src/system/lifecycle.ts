import { spawn } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config.ts';

export interface ServiceFile {
  app: 'theologians';
  pid: number;
  port: number;
  url: string;
  version: string;
  startedAt: string;
  bootId: string;
  controlToken: string;
  dataDir: string;
}

export function serviceFilePath(dataDir: string): string {
  return path.join(dataDir, 'service.json');
}

export function readServiceFile(dataDir: string): ServiceFile | null {
  try {
    const parsed = JSON.parse(readFileSync(serviceFilePath(dataDir), 'utf8')) as ServiceFile;
    return parsed.app === 'theologians' ? parsed : null;
  } catch {
    return null;
  }
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The running service for this data folder, if one is really alive and answering. */
export async function findRunningService(dataDir: string): Promise<ServiceFile | null> {
  const file = readServiceFile(dataDir);
  if (!file || !pidAlive(file.pid)) return null;
  try {
    const response = await fetch(`http://127.0.0.1:${file.port}/api/health`, { signal: AbortSignal.timeout(1500) });
    const json = (await response.json()) as { app?: string; bootId?: string };
    return json.app === 'theologians' && json.bootId === file.bootId ? file : null;
  } catch {
    return null;
  }
}

/**
 * Service lifecycle:
 * - One backend per data folder (service.json + the fixed port prevent duplicates).
 * - Every open view (desktop window or browser tab) holds a live event connection.
 * - When started with an idle timeout (the desktop app does this), the service exits after that many
 *   minutes with no open views and no running work. All data is committed as it changes, so stopping
 *   never loses saved work.
 */
export class Lifecycle {
  readonly #config: AppConfig;
  readonly #activeWork: () => number;
  readonly #onIdle: () => void;
  #views = 0;
  #timer: NodeJS.Timeout | null = null;

  constructor(config: AppConfig, activeWork: () => number, onIdle: () => void) {
    this.#config = config;
    this.#activeWork = activeWork;
    this.#onIdle = onIdle;
  }

  get openViews(): number {
    return this.#views;
  }

  start(): void {
    this.#schedule();
  }

  viewOpened(): void {
    this.#views++;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  viewClosed(): void {
    this.#views = Math.max(0, this.#views - 1);
    this.#schedule();
  }

  #schedule(): void {
    const minutes = this.#config.idleShutdownMinutes;
    if (minutes === null || this.#views > 0) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = setTimeout(() => {
      this.#timer = null;
      if (this.#views > 0) return;
      if (this.#activeWork() > 0) this.#schedule();
      else this.#onIdle();
    }, minutes * 60_000);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
  }

  writeServiceFile(file: ServiceFile): void {
    const target = serviceFilePath(this.#config.dataDir);
    writeFileSync(target, JSON.stringify(file, null, 2), { mode: 0o600 });
    chmodSync(target, 0o600);
  }

  removeServiceFile(bootId: string): void {
    const current = readServiceFile(this.#config.dataDir);
    if (current?.bootId === bootId && existsSync(serviceFilePath(this.#config.dataDir))) {
      rmSync(serviceFilePath(this.#config.dataDir), { force: true });
    }
  }
}

/** Run a small operating-system integration helper without invoking a shell. */
export function runHelper(command: string, args: string[], timeoutMs = 120_000): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', () => {
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}
