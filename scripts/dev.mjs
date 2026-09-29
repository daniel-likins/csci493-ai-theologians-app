import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const children = [];
let stopping = false;

function stopAll() {
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill();
}

function start(name, args, env = {}) {
  const child = spawn(process.execPath, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...env },
  });
  children.push(child);
  child.on('exit', (code) => {
    if (stopping) return;
    console.log(`${name} exited (${code ?? 'signal'}).`);
    stopAll();
    process.exitCode = code ?? 1;
  });
}

start('backend', ['server/src/main.ts', '--dev'], {
  THEO_PORT: '47832',
  THEO_DATA_DIR: path.join(root, '.dev-data'),
  THEO_DEV_ORIGINS: 'http://127.0.0.1:5183',
});
start('frontend', [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), '--config', 'web/vite.config.ts']);

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);
console.log('Theologians development UI → http://127.0.0.1:5183');
