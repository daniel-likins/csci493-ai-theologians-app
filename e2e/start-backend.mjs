import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = mkdtempSync(path.join(os.tmpdir(), 'theologians-e2e-'));
const child = spawn(process.execPath, ['server/src/main.ts'], {
  cwd: path.resolve(import.meta.dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, THEO_DATA_DIR: dataDir, THEO_PORT: '47970', THEO_MODE: 'test', THEO_KEYCHAIN_SERVICE: 'Theologians (e2e)' },
});

let stopping = false;
function stop() {
  if (stopping) return;
  stopping = true;
  child.kill();
}

process.on('SIGINT', stop);
process.on('SIGTERM', stop);
child.on('exit', (code) => {
  stopping = true;
  rmSync(dataDir, { recursive: true, force: true });
  process.exitCode = code ?? 1;
});
