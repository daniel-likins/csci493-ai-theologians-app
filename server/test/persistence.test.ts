import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { LATEST_SCHEMA_VERSION, runMigrations, schemaVersion } from '../src/db/migrations.ts';
import { seedDefaults } from '../src/db/seed.ts';
import { createTestEnv } from './helpers.ts';

describe('persistence', () => {
  test('seeds the three missions as data, idempotently, without overwriting edits', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      assert.deepEqual(
        ctx.workspaces.list().map((w) => w.name),
        ['Augustine', 'Aquinas', 'Luther'],
      );
      assert.equal(ctx.workspaces.listSections()[0]?.name, 'Theologians');
      const goals = ctx.profiles.getGoals(ctx.workspaces.getBySlug('luther').id);
      assert.equal(goals.name, 'Luther');
      ctx.profiles.update(goals.id, { name: 'Scripture coach' });
      seedDefaults(ctx.db);
      seedDefaults(ctx.db);
      assert.equal(ctx.profiles.get(goals.id).name, 'Scripture coach');
      assert.equal(ctx.profiles.list().filter((p) => p.kind === 'goals').length, 3);
      assert.equal(ctx.profiles.list().filter((p) => p.kind === 'master').length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test('migrations are idempotent and refuse a database from a newer version', async () => {
    const env = createTestEnv();
    try {
      const { db } = env.ctx;
      assert.equal(schemaVersion(db), LATEST_SCHEMA_VERSION);
      assert.deepEqual(runMigrations(db).applied, []);
      db.run("INSERT INTO schema_migrations (version, name, applied_at) VALUES (999, 'future', ?)", new Date().toISOString());
      assert.throws(() => runMigrations(db), (err: { code?: string }) => err.code === 'database_too_new');
    } finally {
      await env.cleanup();
    }
  });

  test('relaunching keeps chats, folders, drafts, settings, and approved memories', async () => {
    const env = createTestEnv();
    const { ctx } = env;
    const augustine = ctx.workspaces.getBySlug('augustine');
    const folder = ctx.conversations.createFolder(augustine.id, 'Patristics');
    const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', folderId: folder.id, title: 'Confessions notes' });
    ctx.conversations.appendMessage({ conversationId: chat.id, role: 'user', content: 'What does Augustine teach about grace?' });
    ctx.conversations.saveDraft(chat.id, 'an unsent thought', []);
    ctx.prefs.set('ui.theme', 'dark');
    ctx.prefs.set(`draft.new.${augustine.id}`, { text: 'draft for a new chat', attachmentIds: [], updatedAt: null }, undefined, false);
    ctx.workspaces.updateSettings(augustine.id, { memoryAutosave: true, checkinFrequency: 'weekly' });
    ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'long_term_goal', certainty: 'confirmed', text: 'Read the Confessions' });
    const goals = ctx.profiles.getGoals(augustine.id);
    ctx.profiles.update(goals.id, { tone: 'Very gentle' });
    await env.close();

    const again = env.reopen();
    try {
      const c = again.ctx;
      assert.equal(c.conversations.listFolders(augustine.id)[0]?.name, 'Patristics');
      const reopened = c.conversations.get(chat.id);
      assert.equal(reopened.title, 'Confessions notes');
      assert.equal(reopened.folderId, folder.id);
      assert.equal(reopened.draft, 'an unsent thought');
      assert.equal(c.conversations.listMessages(chat.id).length, 1);
      assert.equal(c.prefs.get('ui.theme', 'system'), 'dark');
      assert.equal(c.prefs.get<{ text: string }>(`draft.new.${augustine.id}`, { text: '' }).text, 'draft for a new chat');
      assert.equal(c.workspaces.getSettings(augustine.id).memoryAutosave, true);
      assert.equal(c.workspaces.getSettings(augustine.id).checkinFrequency, 'weekly');
      assert.deepEqual(c.memory.listItems(augustine.id).map((i) => i.text), ['Read the Confessions']);
      assert.equal(c.profiles.get(goals.id).tone, 'Very gentle');
    } finally {
      await again.cleanup();
    }
  });

  test('folders and chats are scoped to their mission', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const luther = ctx.workspaces.getBySlug('luther');
      const lutherFolder = ctx.conversations.createFolder(luther.id, 'Sermons');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat' });
      assert.throws(() => ctx.conversations.update(chat.id, { folderId: lutherFolder.id }), /same mission/);
      assert.throws(() => ctx.conversations.createFolder(luther.id, 'sermons'), /already a folder/);
      const augustineFolder = ctx.conversations.createFolder(augustine.id, 'Grace');
      ctx.conversations.update(chat.id, { folderId: augustineFolder.id });
      ctx.conversations.deleteFolder(augustineFolder.id);
      assert.equal(ctx.conversations.get(chat.id).folderId, null, 'deleting a folder keeps its chats');
      assert.equal(ctx.conversations.list(luther.id, 'chat').length, 0);
      assert.equal(ctx.conversations.list(augustine.id, 'chat').length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test('search is scoped to the mission and matches titles and message text', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const luther = ctx.workspaces.getBySlug('luther');
      const a = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', title: 'Grace and freedom' });
      ctx.conversations.appendMessage({ conversationId: a.id, role: 'user', content: 'Explain grace in the Confessions' });
      const b = ctx.conversations.create({ workspaceId: luther.id, kind: 'chat', title: 'Sermons' });
      ctx.conversations.appendMessage({ conversationId: b.id, role: 'user', content: 'The Greek word χάρις appears in this sermon' });
      assert.deepEqual(ctx.conversations.search(augustine.id, ['chat'], 'grace').map((h) => h.conversationId), [a.id]);
      assert.deepEqual(ctx.conversations.search(augustine.id, ['chat'], 'freedom').map((h) => h.matchedIn), ['title']);
      assert.deepEqual(ctx.conversations.search(luther.id, ['chat'], 'χάρις').map((h) => h.conversationId), [b.id]);
    } finally {
      await env.cleanup();
    }
  });

  test('optimistic concurrency rejects stale edits from another window', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat' });
      ctx.conversations.update(chat.id, { title: 'From window A' }, chat.version);
      assert.throws(() => ctx.conversations.update(chat.id, { title: 'From window B' }, chat.version), /another window/);
      assert.equal(ctx.conversations.get(chat.id).title, 'From window A');
    } finally {
      await env.cleanup();
    }
  });

  test('a response left streaming by a crash is marked interrupted on restart, keeping its text', async () => {
    const env = createTestEnv();
    const { ctx } = env;
    const augustine = ctx.workspaces.getBySlug('augustine');
    const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat' });
    ctx.conversations.appendMessage({ conversationId: chat.id, role: 'user', content: 'hello' });
    const partial = ctx.conversations.appendMessage({ conversationId: chat.id, role: 'assistant', parts: [{ type: 'text', text: 'Partial ans' }], status: 'streaming' });
    await env.close();
    const again = env.reopen();
    try {
      const message = again.ctx.conversations.getMessage(partial.id);
      assert.equal(message.status, 'interrupted');
      assert.equal(message.content, 'Partial ans');
    } finally {
      await again.cleanup();
    }
  });

  test('refuses to mix its data into a folder another program is using, and leaves that folder untouched', async () => {
    const foreign = mkdtempSync(path.join(os.tmpdir(), 'theologians-foreign-'));
    writeFileSync(path.join(foreign, 'theologians.sqlite3'), 'another program');
    mkdirSync(path.join(foreign, 'backups'));
    try {
      assert.throws(() => createTestEnv({ dir: foreign }), /didn't create/);
      assert.deepEqual(readdirSync(foreign).sort(), ['backups', 'theologians.sqlite3']);
    } finally {
      rmSync(foreign, { recursive: true, force: true });
    }

    const env = createTestEnv();
    assert.ok(existsSync(path.join(env.dir, '.theologians-data.json')), 'Theologians marks folders it owns');
    writeFileSync(path.join(env.dir, 'notes-the-user-added.txt'), 'fine');
    await env.close();
    const again = env.reopen();
    await again.cleanup();
  });
});
