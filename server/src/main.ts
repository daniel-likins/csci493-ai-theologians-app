import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import path from 'node:path';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { assertDataDirUsable, createAppContext } from './context.ts';
import { createSecretStore } from './secrets/secret-store.ts';
import { findRunningService } from './system/lifecycle.ts';

async function main(): Promise<void> {
  const config = loadConfig();

  const running = await findRunningService(config.dataDir);
  if (running) {
    console.log(`Theologians is already running at ${running.url} (process ${running.pid}). Using that instance.`);
    return;
  }

  try {
    assertDataDirUsable(config.dataDir);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const logDir = path.join(config.dataDir, 'logs');
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  const logFile = path.join(logDir, 'server.log');
  // Logs record requests that failed and lifecycle events only — never message content, keys, or tokens.
  const log = (line: string): void => {
    try {
      if ((statSync(logFile, { throwIfNoEntry: false })?.size ?? 0) > 5 * 1024 * 1024) renameSync(logFile, `${logFile}.1`);
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
    } catch {
      // logging must never break the app
    }
  };

  let stopping = false;
  let shutdown: (reason: string) => Promise<void> = async () => undefined;
  const ctx = createAppContext(config, {
    secrets: createSecretStore(config.keychainService, config.dataDir),
    log,
    onIdle: () => void shutdown('no open windows'),
  });
  const app = await buildApp(ctx);

  shutdown = async (reason: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log(`stopping: ${reason}`);
    ctx.lifecycle.stop();
    ctx.backups.stop();
    ctx.suggestions.cancelAll();
    ctx.generation.cancelAll();
    await Promise.race([ctx.generation.idle(), new Promise((r) => setTimeout(r, 3000))]);
    for (const res of ctx.sseClients) res.end();
    await app.close().catch(() => undefined);
    ctx.lifecycle.removeServiceFile(ctx.bootId);
    ctx.db.close();
    console.log(`Theologians stopped (${reason}).`);
    process.exit(0);
  };
  ctx.requestShutdown = (reason) => void shutdown(reason);

  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    console.error(
      code === 'EADDRINUSE'
        ? `Port ${config.port} is already in use by another program, so Theologians can't start. Quit that program or set THEO_PORT.`
        : `Theologians couldn't start: ${err instanceof Error ? err.message : err}`,
    );
    ctx.db.close();
    process.exit(1);
  }

  const url = `http://127.0.0.1:${config.port}`;
  ctx.lifecycle.writeServiceFile({
    app: 'theologians',
    pid: process.pid,
    port: config.port,
    url,
    version: config.version,
    startedAt: ctx.startedAt,
    bootId: ctx.bootId,
    controlToken: ctx.tokens.control,
    dataDir: config.dataDir,
  });
  ctx.lifecycle.start();
  ctx.backups.start();
  void ctx.attachments.collectGarbage().catch(() => undefined);
  log(`started ${config.mode} ${config.version} at ${url}`);
  console.log(
    [
      `Theologians is running at ${url}`,
      `Data: ${config.dataDir}`,
      config.idleShutdownMinutes ? `Stops after ${config.idleShutdownMinutes} minutes with no open windows.` : 'Press Ctrl+C to stop.',
    ].join('\n'),
  );

  process.on('SIGINT', () => void shutdown('interrupt'));
  process.on('SIGTERM', () => void shutdown('terminate'));
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err.stack ?? err.message}`));
  process.on('unhandledRejection', (reason) => log(`unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`));
}

void main();
