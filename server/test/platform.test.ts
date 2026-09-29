import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { DATA_FOLDER_NAME, defaultDataDirForPlatform } from '../src/config.ts';
import {
  KeychainSecretStore,
  LinuxSecretServiceStore,
  MemorySecretStore,
  WindowsDpapiSecretStore,
  createSecretStore,
} from '../src/secrets/secret-store.ts';
import { buildLinuxSandboxArgs } from '../src/tools/exec.ts';

test('default data directories follow each operating system convention', () => {
  assert.equal(defaultDataDirForPlatform('darwin', {}, '/Users/student'), path.join('/Users/student', 'Library', 'Application Support', DATA_FOLDER_NAME));
  assert.equal(defaultDataDirForPlatform('linux', { XDG_DATA_HOME: '/home/student/.data' }, '/home/student'), path.join('/home/student/.data', 'theologians'));
  assert.equal(defaultDataDirForPlatform('win32', { APPDATA: '/Users/student/AppData/Roaming' }, '/Users/student'), path.join('/Users/student/AppData/Roaming', DATA_FOLDER_NAME));
});

test('credential store selection is platform-specific', () => {
  assert.ok(createSecretStore('Theologians', '/tmp/data', 'darwin') instanceof KeychainSecretStore);
  assert.ok(createSecretStore('Theologians', '/tmp/data', 'linux') instanceof LinuxSecretServiceStore);
  assert.ok(createSecretStore('Theologians', '/tmp/data', 'win32') instanceof WindowsDpapiSecretStore);
});

test('the in-memory credential store validates and round-trips values', async () => {
  const store = new MemorySecretStore();
  await store.set('connection:class-model', 'secret-value');
  assert.equal(await store.get('connection:class-model'), 'secret-value');
  await store.delete('connection:class-model');
  assert.equal(await store.get('connection:class-model'), null);
  await assert.rejects(store.set('bad account', 'secret-value'));
  await assert.rejects(store.set('connection:test', 'line\nbreak'));
});

test('Linux sandbox isolates the workspace and disables networking by default', () => {
  const args = buildLinuxSandboxArgs({ root: '/projects/demo', cwd: '/projects/demo/src', tmp: '/tmp/private', allowNetwork: false, command: 'npm test' });
  assert.deepEqual(args.slice(0, 3), ['--die-with-parent', '--new-session', '--unshare-all']);
  assert.equal(args.includes('--share-net'), false);
  assert.ok(args.includes('/workspace'));
  assert.ok(args.includes('/workspace/src'));
  assert.deepEqual(args.slice(-4), ['--', '/bin/sh', '-c', 'npm test']);
});

test('Linux sandbox only shares networking when explicitly enabled', () => {
  const args = buildLinuxSandboxArgs({ root: '/projects/demo', cwd: '/projects/demo', tmp: '/tmp/private', allowNetwork: true, command: 'true' });
  assert.ok(args.includes('--share-net'));
});
