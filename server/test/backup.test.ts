import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { selectRetained } from '../src/backup/backup-service.ts';
import { makePdf } from './fixtures/make-pdf.ts';
import { addModel, createTestEnv } from './helpers.ts';

describe('backups', () => {
  test('restore brings back data and attachments, after making a safety backup', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', title: 'Before backup' });
      const pdf = await ctx.attachments.upload({ workspaceId: augustine.id, conversationId: chat.id, filename: 'a.pdf', declaredMime: 'application/pdf', data: makePdf(['Some real text on the first page here.']) });
      ctx.conversations.appendMessage({ conversationId: chat.id, role: 'user', content: 'with attachment', attachmentIds: [pdf.id] });
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'long_term_goal', certainty: 'confirmed', text: 'Original goal' });
      const backup = await ctx.backups.create('manual');
      assert.equal(backup.attachmentCount, 1);

      ctx.conversations.delete(chat.id);
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'idea', certainty: 'tentative', text: 'Added after backup' });
      await ctx.attachments.collectGarbage();

      const result = await ctx.backups.restore(backup.id);
      assert.equal(result.missingAttachments, 0);
      assert.equal(ctx.conversations.get(chat.id).title, 'Before backup');
      assert.deepEqual(ctx.memory.listItems(augustine.id).map((i) => i.text), ['Original goal']);
      const restoredFile = ctx.attachments.fileInfo(pdf.id).path;
      assert.ok((await readFile(restoredFile)).length > 0, 'attachment file restored');
      assert.ok((await ctx.backups.list()).some((b) => b.reason === 'before_restore'), 'a safety backup was made first');
    } finally {
      await env.cleanup();
    }
  });

  test('retention keeps daily, weekly, monthly, manual, and safety backups within limits', () => {
    const entries = [];
    const start = Date.UTC(2026, 0, 1, 12);
    for (let day = 0; day < 240; day++) entries.push({ id: `auto-${day}`, createdAt: new Date(start + day * 86_400_000).toISOString(), reason: 'automatic' as const });
    for (let i = 0; i < 15; i++) entries.push({ id: `manual-${i}`, createdAt: new Date(start + i * 3_600_000).toISOString(), reason: 'manual' as const });
    for (let i = 0; i < 8; i++) entries.push({ id: `safety-${i}`, createdAt: new Date(start + i * 7_200_000).toISOString(), reason: 'before_restore' as const });
    const keep = selectRetained(entries);
    const autos = [...keep].filter((id) => id.startsWith('auto-'));
    assert.ok(keep.has('auto-239'), 'newest automatic backup kept');
    assert.ok(autos.length >= 7 && autos.length <= 17, `automatic backups bounded (kept ${autos.length})`);
    assert.equal([...keep].filter((id) => id.startsWith('manual-')).length, 10);
    assert.equal([...keep].filter((id) => id.startsWith('safety-')).length, 5);
  });
});

describe('export and import', () => {
  test('export excludes credentials; replace-import into a fresh install recovers everything', async () => {
    const source = createTestEnv();
    const target = createTestEnv();
    try {
      const { ctx } = source;
      const { connection } = await addModel(ctx, { authType: 'bearer_token', baseUrl: 'https://gateway.example/v1', secret: 'SUPER-SECRET-TOKEN-123' });
      await ctx.webSearch.setKey('tavily', 'tvly-SECRET-SEARCH-KEY');
      const augustine = ctx.workspaces.getBySlug('augustine');
      const folder = ctx.conversations.createFolder(augustine.id, 'Research');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', folderId: folder.id, title: 'Exported chat' });
      const pdf = await ctx.attachments.upload({ workspaceId: augustine.id, conversationId: chat.id, filename: 'paper.pdf', declaredMime: 'application/pdf', data: makePdf(['A study of Augustine, page one text.']) });
      ctx.conversations.appendMessage({ conversationId: chat.id, role: 'user', content: 'Summarize the paper', attachmentIds: [pdf.id] });
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'current_focus', certainty: 'confirmed', text: 'The Confessions' });
      const general = ctx.profiles.getDefaultGeneral();
      ctx.profiles.update(general.id, { tone: 'Exported tone' });

      const exported = await ctx.transfer.export();
      const bytes = await readFile(exported.path);
      const files = unzipSync(bytes);
      const everything = Object.values(files).map((f) => Buffer.from(f).toString('latin1')).join('\n');
      assert.doesNotMatch(everything, /SUPER-SECRET-TOKEN-123|tvly-SECRET-SEARCH-KEY/, 'no credentials in the export');
      assert.equal(JSON.parse(strFromU8(files['manifest.json']!)).includesSecrets, false);

      const t = target.ctx;
      const preview = await t.transfer.preview(bytes);
      assert.equal(preview.counts.conversations, 1);
      assert.ok(preview.warnings.some((w) => /without API keys/.test(w)));
      await t.transfer.apply(preview.token, 'replace');

      const importedAugustine = t.workspaces.getBySlug('augustine');
      assert.equal(t.conversations.get(chat.id).title, 'Exported chat');
      assert.equal(t.conversations.listFolders(importedAugustine.id)[0]?.name, 'Research');
      assert.equal(t.conversations.listMessages(chat.id)[0]?.attachments[0]?.filename, 'paper.pdf');
      assert.ok((await readFile(t.attachments.fileInfo(pdf.id).path)).length > 0);
      assert.deepEqual(t.memory.listItems(importedAugustine.id).map((i) => i.text), ['The Confessions']);
      assert.equal(t.profiles.get(general.id).tone, 'Exported tone');
      const importedConnection = await t.connections.get(connection.id);
      assert.equal(importedConnection.status, 'needs_credentials');
      assert.equal(importedConnection.hasSecret, false);
      assert.ok((await t.backups.list()).some((b) => b.reason === 'before_import'));
    } finally {
      await source.cleanup();
      await target.cleanup();
    }
  });

  test('merge-import never overwrites existing records', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const item = ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'progress', certainty: 'confirmed', text: 'Old progress' });
      const exported = await ctx.transfer.export();
      ctx.memory.updateItem({ kind: 'user' }, item.id, { text: 'Newer local progress' });
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', title: 'Local only' });
      const preview = await ctx.transfer.preview(await readFile(exported.path));
      assert.ok((preview.conflicts.memory_items ?? 0) >= 1);
      const result = await ctx.transfer.apply(preview.token, 'merge');
      assert.ok(result.skipped.memory_items! >= 1);
      assert.equal(ctx.memory.listItems(augustine.id)[0]?.text, 'Newer local progress');
      assert.equal(ctx.conversations.get(chat.id).title, 'Local only');
    } finally {
      await env.cleanup();
    }
  });

  test('a damaged export is rejected before anything changes', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'note', certainty: 'confirmed', text: 'Keep me' });
      const exported = await ctx.transfer.export();
      const files = unzipSync(await readFile(exported.path));
      files['data.json'] = strToU8(strFromU8(files['data.json']!).replace('Keep me', 'Tampered'));
      const tampered = `${exported.path}.tampered.zip`;
      await writeFile(tampered, zipSync(files));
      await assert.rejects(ctx.transfer.preview(await readFile(tampered)), /checksum/);
      await assert.rejects(ctx.transfer.preview(Buffer.from('not a zip')), /valid Theologians export/);
      assert.equal(ctx.memory.listItems(augustine.id)[0]?.text, 'Keep me');
    } finally {
      await env.cleanup();
    }
  });
});
