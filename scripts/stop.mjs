import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { defaultDataDir } from '../server/src/config.ts';

const dataDir = process.env.THEO_DATA_DIR ?? defaultDataDir();
let service;
try {
  service = JSON.parse(await readFile(path.join(dataDir, 'service.json'), 'utf8'));
} catch {
  console.log('Theologians is not running.');
  process.exit(0);
}

try {
  const response = await fetch(`http://127.0.0.1:${service.port}/api/system/shutdown`, {
    method: 'POST',
    headers: { 'x-theologians-control': service.controlToken, 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  console.log('Stop requested.');
} catch (error) {
  console.log(`Could not reach the service (${error instanceof Error ? error.message : error}).`);
}
