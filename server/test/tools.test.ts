import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';
import { sandboxAvailable } from '../src/tools/exec.ts';
import { applyEdit, FileScope, prepareEdit, validateWorkingFolder } from '../src/tools/files.ts';
import { addModel, chatRequests, createTestEnv, waitFor } from './helpers.ts';
import { makePdf } from './fixtures/make-pdf.ts';
import { scriptedChat } from './fixtures/mock-provider.ts';

function tempFolder(): string {
  return realpathSync(mkdtempSync(path.join(os.tmpdir(), 'theologians-work-')));
}

describe('file scope', () => {
  test('paths are confined to the working folder, including through symlinks', async () => {
    const root = tempFolder();
    const outside = tempFolder();
    try {
      writeFileSync(path.join(outside, 'secret.txt'), 'top secret');
      mkdirSync(path.join(root, 'src'));
      symlinkSync(outside, path.join(root, 'link'));
      const scope = new FileScope(root, '/nonexistent-data-dir');
      assert.equal((await scope.resolve('src/new.ts')).inside, true);
      assert.equal((await scope.resolve('../escape.txt')).inside, false);
      assert.equal((await scope.resolve(path.join(outside, 'secret.txt'))).inside, false);
      assert.equal((await scope.resolve('link/secret.txt')).inside, false, 'a symlink cannot escape the folder');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('working folders must be specific project folders', async () => {
    const dataDir = tempFolder();
    try {
      await assert.rejects(validateWorkingFolder(os.homedir(), dataDir), /specific project folder/);
      await assert.rejects(validateWorkingFolder('/', dataDir), /specific project folder/);
      await assert.rejects(validateWorkingFolder(dataDir, dataDir), /private data/);
      await assert.rejects(validateWorkingFolder('relative/path', dataDir), /full path/);
    } finally {
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('edits are shown as diffs and refuse to overwrite a file that changed afterwards', async () => {
    const root = tempFolder();
    try {
      writeFileSync(path.join(root, 'a.txt'), 'one\ntwo\nthree\n');
      const scope = new FileScope(root, '/nonexistent');
      await assert.rejects(prepareEdit(scope, 'a.txt', { find: 'missing', replace: 'x' }), /wasn't found/);
      writeFileSync(path.join(root, 'b.txt'), 'x x');
      await assert.rejects(prepareEdit(scope, 'b.txt', { find: 'x', replace: 'y' }), /appears 2 times/);
      const proposal = await prepareEdit(scope, 'a.txt', { find: 'two', replace: 'TWO' });
      assert.match(proposal.diff, /-two\n\+TWO/);
      writeFileSync(path.join(root, 'a.txt'), 'changed by someone else');
      await assert.rejects(applyEdit(scope, proposal), /changed after the edit was proposed/);
      await assert.rejects(prepareEdit(scope, '../outside.txt', { newContent: 'x' }), /limited to the working folder/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('tools through the assistant', () => {
  test('tools are only offered when policy, profile, toggles, services, and the model allow it', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const withTools = await addModel(ctx, { supportsTools: true });
      const noTools = await addModel(ctx, { connectionName: 'No tools', apiModelId: 'plain', supportsTools: false });
      const augustine = ctx.workspaces.getBySlug('augustine');
      const general = ctx.profiles.getDefaultGeneral();
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', webSearchEnabled: true, filesEnabled: true });
      let tools = await ctx.tools.forRequest({ conversation: chat, profile: general, model: withTools.model });
      assert.deepEqual(tools.names, [], 'no search key and no working folder → nothing offered');
      const root = tempFolder();
      ctx.workspaces.updateSettings(augustine.id, { workingFolder: root });
      await ctx.webSearch.setKey('tavily', 'tvly-test');
      tools = await ctx.tools.forRequest({ conversation: chat, profile: general, model: withTools.model });
      assert.ok(tools.names.includes('web_search') && tools.names.includes('read_file') && tools.names.includes('propose_file_edit'));
      assert.ok(!tools.names.includes('propose_memory_update'), 'general assistants cannot propose memory');
      tools = await ctx.tools.forRequest({ conversation: chat, profile: general, model: noTools.model });
      assert.deepEqual(tools.names, [], 'models without tool support get no tools');
      rmSync(root, { recursive: true, force: true });
    } finally {
      await env.cleanup();
    }
  });

  test('file edits wait for approval: denied edits write nothing, approved edits apply', async () => {
    const env = createTestEnv();
    const root = tempFolder();
    try {
      const { ctx } = env;
      writeFileSync(path.join(root, 'notes.md'), '# Notes\nold line\n');
      const { model } = await addModel(ctx, { supportsTools: true });
      const augustine = ctx.workspaces.getBySlug('augustine');
      ctx.workspaces.updateSettings(augustine.id, { workingFolder: root });
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id, filesEnabled: true });
      const edit = { name: 'propose_file_edit', arguments: { path: 'notes.md', find: 'old line', replace: 'new line', summary: 'update' } };
      env.setFetch(scriptedChat([{ toolCalls: [edit] }, { text: 'Okay, left it alone.' }, { toolCalls: [edit] }, { text: 'Updated.' }]).handler);

      await ctx.generation.send({ conversationId: chat.id, text: 'Change the line', attachmentIds: [] });
      const first = await waitFor(() => ctx.approvals.list(chat.id).find((a) => a.status === 'pending'), 'approval request');
      assert.equal(first.kind, 'apply_file_edit');
      assert.match(String(first.payload.diff), /\+new line/);
      assert.equal(ctx.conversations.listMessages(chat.id).at(-1)!.status, 'awaiting_approval');
      ctx.approvals.decide(first.id, 'denied');
      await ctx.generation.idle();
      assert.equal(readFileSync(path.join(root, 'notes.md'), 'utf8'), '# Notes\nold line\n');

      await ctx.generation.send({ conversationId: chat.id, text: 'Please do it', attachmentIds: [] });
      const second = await waitFor(() => ctx.approvals.list(chat.id).find((a) => a.status === 'pending'), 'second approval');
      ctx.approvals.decide(second.id, 'approved');
      await ctx.generation.idle();
      assert.equal(readFileSync(path.join(root, 'notes.md'), 'utf8'), '# Notes\nnew line\n');
      const result = ctx.conversations.listMessages(chat.id).at(-1)!.parts.find((p) => p.type === 'tool_result');
      assert.ok(result && result.type === 'tool_result' && result.diff?.includes('+new line'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  test('reading outside the working folder asks first, and can be turned off', async () => {
    const env = createTestEnv();
    const root = tempFolder();
    const outside = tempFolder();
    try {
      const { ctx } = env;
      writeFileSync(path.join(outside, 'other.txt'), 'outside content');
      const { model } = await addModel(ctx, { supportsTools: true });
      const augustine = ctx.workspaces.getBySlug('augustine');
      ctx.workspaces.updateSettings(augustine.id, { workingFolder: root });
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id, filesEnabled: true });
      const read = { name: 'read_file', arguments: { path: path.join(outside, 'other.txt') } };
      env.setFetch(scriptedChat([{ toolCalls: [read] }, { text: 'done' }, { toolCalls: [read] }, { text: 'done' }]).handler);

      await ctx.generation.send({ conversationId: chat.id, text: 'read it', attachmentIds: [] });
      const request = await waitFor(() => ctx.approvals.list(chat.id).find((a) => a.status === 'pending'), 'outside-folder approval');
      assert.equal(request.kind, 'read_outside_folder');
      ctx.approvals.decide(request.id, 'approved');
      await ctx.generation.idle();
      const approvedResult = ctx.conversations.listMessages(chat.id).at(-1)!.parts.find((p) => p.type === 'tool_result');
      assert.ok(approvedResult && approvedResult.type === 'tool_result' && approvedResult.output.includes('outside content'));

      ctx.prefs.set('tools.outsideFolderAccess', 'deny');
      await ctx.generation.send({ conversationId: chat.id, text: 'read it again', attachmentIds: [] });
      await ctx.generation.idle();
      const deniedResult = ctx.conversations.listMessages(chat.id).at(-1)!.parts.find((p) => p.type === 'tool_result');
      assert.ok(deniedResult && deniedResult.type === 'tool_result' && deniedResult.isError && !deniedResult.output.includes('outside content'));
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  test('commands need approval and run sandboxed inside the working folder', { skip: !sandboxAvailable() }, async () => {
    const env = createTestEnv();
    const root = tempFolder();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx, { supportsTools: true });
      const augustine = ctx.workspaces.getBySlug('augustine');
      ctx.workspaces.updateSettings(augustine.id, { workingFolder: root });
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id, filesEnabled: true });
      const cmd = { name: 'run_command', arguments: { command: 'echo built > out.txt && cat out.txt && (echo nope > ../escape.txt || echo blocked)' } };
      env.setFetch(scriptedChat([{ toolCalls: [cmd] }, { text: 'not run' }, { toolCalls: [cmd] }, { text: 'ran' }]).handler);

      await ctx.generation.send({ conversationId: chat.id, text: 'build', attachmentIds: [] });
      const denied = await waitFor(() => ctx.approvals.list(chat.id).find((a) => a.status === 'pending'), 'command approval');
      assert.equal(denied.payload.command, cmd.arguments.command);
      ctx.approvals.decide(denied.id, 'denied');
      await ctx.generation.idle();
      assert.throws(() => readFileSync(path.join(root, 'out.txt')), 'a denied command never runs');

      await ctx.generation.send({ conversationId: chat.id, text: 'build now', attachmentIds: [] });
      const approved = await waitFor(() => ctx.approvals.list(chat.id).find((a) => a.status === 'pending'), 'second command approval');
      ctx.approvals.decide(approved.id, 'approved');
      await ctx.generation.idle();
      const result = ctx.conversations.listMessages(chat.id).at(-1)!.parts.find((p) => p.type === 'tool_result');
      assert.ok(result && result.type === 'tool_result');
      assert.match(result.output, /built/);
      assert.match(result.output, /blocked|Operation not permitted/);
      assert.throws(() => readFileSync(path.join(path.dirname(root), 'escape.txt')), 'writes outside the folder are blocked');
    } finally {
      rmSync(root, { recursive: true, force: true });
      await env.cleanup();
    }
  });

  test('web search returns real results as sources; missing setup is reported honestly', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      await assert.rejects(ctx.webSearch.search('anything'), /isn't set up/);
      await ctx.webSearch.setKey('tavily', 'tvly-test-key');
      ctx.webSearch.setProvider('tavily');
      env.setFetch(async (input, init) => {
        assert.equal(String(input), 'https://api.tavily.com/search');
        assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer tvly-test-key');
        return Response.json({ results: [{ title: 'Augustine <b>sermons</b>', url: 'https://example.org/sermons', content: 'Augustine preached many sermons.' }, { title: 'bad', url: 'javascript:alert(1)' }] });
      });
      const results = await ctx.webSearch.search('Augustine sermons', 5);
      assert.deepEqual(results, [{ title: 'Augustine sermons', url: 'https://example.org/sermons', snippet: 'Augustine preached many sermons.', provider: 'Tavily' }]);

      ctx.webSearch.setProvider('brave');
      await ctx.webSearch.setKey('brave', 'brave-key');
      env.setFetch(async (input, init) => {
        assert.match(String(input), /^https:\/\/api\.search\.brave\.com\/res\/v1\/web\/search\?q=Augustine/);
        assert.equal(new Headers(init?.headers).get('x-subscription-token'), 'brave-key');
        return Response.json({ web: { results: [{ title: 'Sermons', url: 'https://example.com/b', description: 'desc' }] } });
      });
      assert.equal((await ctx.webSearch.search('Augustine', 3))[0]?.provider, 'Brave Search');
    } finally {
      await env.cleanup();
    }
  });

  test('models without tool support get app-run search results as clearly labeled sources', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx, { supportsTools: false });
      await ctx.webSearch.setKey('tavily', 'tvly-key');
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id, webSearchEnabled: true });
      const script = scriptedChat([{ text: 'According to [1], ...' }]);
      env.setFetch(async (input, init) => {
        if (String(input).includes('tavily')) return Response.json({ results: [{ title: 'Source A', url: 'https://a.example/x', content: 'fact' }] });
        return script.handler(input, init);
      });
      await ctx.generation.send({ conversationId: chat.id, text: 'recent Augustine scholarship', attachmentIds: [] });
      await ctx.generation.idle();
      const reply = ctx.conversations.listMessages(chat.id).at(-1)!;
      const result = reply.parts.find((p) => p.type === 'tool_result');
      assert.ok(result && result.type === 'tool_result' && result.sources?.[0]?.url === 'https://a.example/x');
      assert.match(String(chatRequests(env)[0]!.body.messages[0].content), /https:\/\/a\.example\/x/);
    } finally {
      await env.cleanup();
    }
  });
});

describe('attachments', () => {
  test('PDFs keep page references; scans and unsupported types are reported, not faked', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = ctx.workspaces.getBySlug('augustine');
      const pdf = await ctx.attachments.upload({
        workspaceId: augustine.id,
        conversationId: null,
        filename: 'notes.pdf',
        declaredMime: 'application/pdf',
        data: makePdf(['Chapter one introduces Augustine and his era.', 'Chapter two covers grace and free will in depth.']),
      });
      assert.equal(pdf.extractionStatus, 'ok');
      assert.equal(pdf.pageCount, 2);
      const hits = ctx.attachments.search([pdf.id], 'grace');
      assert.equal(hits[0]?.pageStart, 2);

      const scan = await ctx.attachments.upload({ workspaceId: augustine.id, conversationId: null, filename: 'scan.pdf', declaredMime: 'application/pdf', data: makePdf([null]) });
      assert.equal(scan.extractionStatus, 'no_text');
      const binary = await ctx.attachments.upload({ workspaceId: augustine.id, conversationId: null, filename: 'thing.bin', declaredMime: '', data: Buffer.from([0, 1, 2, 3, 255]) });
      assert.equal(binary.kind, 'unsupported');
      const text = await ctx.attachments.upload({ workspaceId: augustine.id, conversationId: null, filename: 'main.py', declaredMime: '', data: Buffer.from('print("hi")\n') });
      assert.equal(text.kind, 'text');

      const { model } = await addModel(ctx, { supportsImages: false, supportsPdfs: false });
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id });
      await assert.rejects(ctx.generation.send({ conversationId: chat.id, text: 'read this', attachmentIds: [scan.id] }), /no extractable text/);
      const png = await ctx.attachments.upload({
        workspaceId: augustine.id,
        conversationId: null,
        filename: 'diagram.png',
        declaredMime: 'image/png',
        data: Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex'),
      });
      await assert.rejects(ctx.generation.send({ conversationId: chat.id, text: 'what is this', attachmentIds: [png.id] }), /isn't set up to read images/);
      assert.equal(ctx.conversations.listMessages(chat.id).length, 0, 'rejected before anything was sent or saved; the draft stays in the composer');

      env.setFetch(scriptedChat([{ text: 'Page 2 covers grace.' }]).handler);
      await ctx.generation.send({ conversationId: chat.id, text: 'What does page 2 cover?', attachmentIds: [pdf.id] });
      await ctx.generation.idle();
      const sent = JSON.stringify(chatRequests(env)[0]!.body.messages);
      assert.match(sent, /\[Page 2\]/);
      assert.match(sent, /grace and free will/);
    } finally {
      await env.cleanup();
    }
  });
});
