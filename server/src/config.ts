import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const APP_NAME = 'Theologians';
export const PROJECT_ROOT = path.resolve(import.meta.dirname, '..', '..');
export const DEFAULTS_DIR = path.join(PROJECT_ROOT, 'server', 'defaults');
/** Give Unix accounts distinct defaults. Windows, which has no numeric uid, uses the base port. */
export function defaultPortForUid(uid: number): number {
  return 47831 + ((((uid - 501) % 1000) + 1000) % 1000) * 10;
}
export const DEFAULT_PORT = defaultPortForUid(process.getuid?.() ?? 501);
/** The service only ever listens on loopback. Remote access is intentionally not configurable. */
export const LOOPBACK_HOST = '127.0.0.1';

export type RunMode = 'production' | 'development' | 'test';

export interface AppConfig {
  mode: RunMode;
  version: string;
  host: string;
  port: number;
  dataDir: string;
  dbFile: string;
  attachmentsDir: string;
  defaultBackupDir: string;
  webDistDir: string;
  /** Extra browser origins allowed to call the API (only the Vite dev server in development). */
  extraAllowedOrigins: string[];
  /** Exit after this many minutes with no open views and no running work. null = run until stopped. */
  idleShutdownMinutes: number | null;
  keychainService: string;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(path.join(PROJECT_ROOT, 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function flag(argv: string[], name: string): string | undefined {
  const prefix = `--${name}=`;
  const hit = argv.find((arg) => arg === `--${name}` || arg.startsWith(prefix));
  if (hit === undefined) return undefined;
  return hit === `--${name}` ? 'true' : hit.slice(prefix.length);
}

/** Use a dedicated folder so Theologians never shares another application's data. */
export const DATA_FOLDER_NAME = `${APP_NAME} Workspace`;

export function defaultDataDirForPlatform(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv = process.env,
  home = os.homedir(),
): string {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', DATA_FOLDER_NAME);
  if (platform === 'win32') return path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), DATA_FOLDER_NAME);
  return path.join(env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'theologians');
}

export function defaultDataDir(): string {
  return defaultDataDirForPlatform(process.platform);
}

export function loadConfig(
  overrides: Partial<AppConfig> = {},
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv.slice(2),
): AppConfig {
  const mode: RunMode =
    overrides.mode ?? (flag(argv, 'dev') ? 'development' : ((env.THEO_MODE as RunMode | undefined) ?? 'production'));
  const dataDir = path.resolve(overrides.dataDir ?? flag(argv, 'data-dir') ?? env.THEO_DATA_DIR ?? defaultDataDir());
  const port = Number(overrides.port ?? flag(argv, 'port') ?? env.THEO_PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`Invalid port: ${port}`);

  const idleRaw = flag(argv, 'idle-exit') ?? env.THEO_IDLE_EXIT_MINUTES;
  const idleShutdownMinutes =
    overrides.idleShutdownMinutes !== undefined
      ? overrides.idleShutdownMinutes
      : idleRaw === undefined || idleRaw === '' || idleRaw === '0'
        ? null
        : Math.max(1, Number(idleRaw === 'true' ? 15 : idleRaw));

  const extraAllowedOrigins =
    overrides.extraAllowedOrigins ??
    (env.THEO_DEV_ORIGINS ?? '')
      .split(',')
      .map((o) => o.trim())
      .filter((o) => /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(o));

  return {
    mode,
    version: overrides.version ?? readVersion(),
    host: LOOPBACK_HOST,
    port,
    dataDir,
    dbFile: overrides.dbFile ?? path.join(dataDir, 'theologians.db'),
    attachmentsDir: overrides.attachmentsDir ?? path.join(dataDir, 'attachments'),
    defaultBackupDir: overrides.defaultBackupDir ?? path.join(dataDir, 'Backups'),
    webDistDir: overrides.webDistDir ?? env.THEO_WEB_DIST ?? path.join(PROJECT_ROOT, 'web', 'dist'),
    extraAllowedOrigins,
    idleShutdownMinutes,
    keychainService:
      overrides.keychainService ?? env.THEO_KEYCHAIN_SERVICE ?? (mode === 'production' ? APP_NAME : `${APP_NAME} (${mode})`),
  };
}
