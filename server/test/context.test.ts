import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { addModel, chatRequests, createTestEnv, systemPromptOf } from './helpers.ts';
import { scriptedChat } from './fixtures/mock-provider.ts';

describe('assistant selection and conversation context', () => {
  test('Augustine Goals selected in an existing chat gets its memory and the conversation, and stays selected', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx, { displayName: 'General Model' });
      const goalsModel = await addModel(ctx, { connectionName: 'Goals endpoint', apiModelId: 'goals-model', displayName: 'Goals Model' });
      const augustine = ctx.workspaces.getBySlug('augustine');
      const goals = ctx.profiles.getGoals(augustine.id);
      ctx.profiles.update(goals.id, { preferredModelId: goalsModel.model.id });
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'long_term_goal', certainty: 'confirmed', text: 'Study Augustine on grace' });
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'feeling', certainty: 'confirmed', text: 'Uncertain about interpreting the Confessions' });

      const script = scriptedChat([{ text: 'The Confessions is a good place to begin.' }, { text: 'It fits your goal.' }, { text: 'Next: read Book VIII.' }]);
      env.setFetch(script.handler);
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id });
      await ctx.generation.send({ conversationId: chat.id, text: 'I want to study Augustine’s account of grace.', attachmentIds: [] });
      await ctx.generation.idle();

      const general = chatRequests(env)[0]!;
      assert.match(systemPromptOf(general), /Augustine of Hippo/, 'general assistant gets the mission description');
      assert.doesNotMatch(systemPromptOf(general), /Uncertain about interpreting the Confessions/, 'general assistant does not get personal memory');
      assert.doesNotMatch(systemPromptOf(general), /Study Augustine on grace/);

      ctx.conversations.update(chat.id, { selectedProfileId: goals.id, selectedModelId: null });
      await ctx.generation.send({ conversationId: chat.id, text: 'Does this project fit my priorities?', attachmentIds: [] });
      await ctx.generation.idle();
      await ctx.generation.send({ conversationId: chat.id, text: 'What should I do next?', attachmentIds: [] });
      await ctx.generation.idle();

      const [, second, third] = chatRequests(env);
      for (const request of [second!, third!]) {
        assert.equal(request.body.model, 'goals-model', 'Goals uses the model configured for it in Settings');
        assert.match(systemPromptOf(request), /speaking in the voice of Augustine/);
        assert.match(systemPromptOf(request), /Study Augustine on grace/);
        assert.ok(JSON.stringify(request.body.messages).includes('account of grace'));
        assert.ok(request.body.tools.some((t: { function: { name: string } }) => t.function.name === 'propose_memory_update'));
      }
      assert.equal(ctx.conversations.get(chat.id).selectedProfileId, goals.id, 'selection persists until changed');

      const replies = ctx.conversations.listMessages(chat.id).filter((m) => m.role === 'assistant');
      assert.deepEqual(
        replies.map((m) => [m.profileName, m.modelLabel]),
        [
          ['Assistant', 'General Model'],
          ['Augustine', 'Goals Model'],
          ['Augustine', 'Goals Model'],
        ],
        'each response is labeled with the assistant and model that produced it, and old labels never change',
      );
    } finally {
      await env.cleanup();
    }
  });

  test('the master assistant sees saved snapshots of all missions (with staleness) but not raw mission chats', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx);
      const augustine = ctx.workspaces.getBySlug('augustine');
      ctx.memory.addItem({ kind: 'user' }, augustine.id, { category: 'current_focus', certainty: 'confirmed', text: 'Reading the Confessions' });
      const augustineChat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat' });
      ctx.conversations.appendMessage({ conversationId: augustineChat.id, role: 'user', content: 'PRIVATE-RAW-CHAT-CONTENT' });
      env.setFetch(scriptedChat([{ text: 'Balanced view.' }]).handler);
      const home = ctx.conversations.create({ workspaceId: null, kind: 'master', selectedModelId: model.id });
      await ctx.generation.send({ conversationId: home.id, text: 'How are my missions balanced?', attachmentIds: [] });
      await ctx.generation.idle();
      const prompt = systemPromptOf(chatRequests(env)[0]!);
      assert.match(prompt, /## Augustine/);
      assert.match(prompt, /Reading the Confessions/);
      assert.match(prompt, /## Aquinas[\s\S]*No study notes have been saved with this theologian yet/);
      assert.match(prompt, /## Luther/);
      assert.doesNotMatch(prompt, /PRIVATE-RAW-CHAT-CONTENT/);
      assert.match(prompt, /Augustine, Aquinas, Luther/, 'mission names are filled in from data');
    } finally {
      await env.cleanup();
    }
  });

  test('long conversations use a bounded summary plus recent turns, and report what was sent', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx, { contextWindow: 4096, maxOutputTokens: 400 });
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id });
      for (let i = 1; i <= 20; i++) {
        ctx.conversations.appendMessage({ conversationId: chat.id, role: 'user', content: `Question ${i}: ${'We discussed matrix factorization details. '.repeat(10)}` });
        ctx.conversations.appendMessage({ conversationId: chat.id, role: 'assistant', content: `Answer ${i}: ${'The decision was to use QR decomposition. '.repeat(10)}` });
      }
      const script = scriptedChat([{ text: 'Final answer.' }], (body) =>
        String(body.messages?.[0]?.content ?? '').includes('running summary') ? { text: 'SUMMARY: chose QR decomposition; open question about stability.' } : undefined,
      );
      env.setFetch(script.handler);
      await ctx.generation.send({ conversationId: chat.id, text: 'Remind me what we decided?', attachmentIds: [] });
      await ctx.generation.idle();

      const reply = ctx.conversations.listMessages(chat.id).at(-1)!;
      assert.equal(reply.status, 'complete', reply.error?.message ?? 'reply did not complete');
      const report = reply.context!;
      assert.ok(report.includedMessages < report.totalMessages, 'not every message fits');
      assert.ok(report.summaryThroughSeq && report.summaryThroughSeq > 0, 'older messages are covered by a summary');
      assert.ok(report.estimatedTokens <= report.budgetTokens);
      const finalRequest = script.bodies.at(-1);
      assert.match(String(finalRequest.messages[0].content), /SUMMARY: chose QR decomposition/);
      assert.equal(finalRequest.messages.at(-1).content, 'Remind me what we decided?', 'the newest message is always included');
      assert.ok(ctx.usage.summary().rows.some((r) => r.purpose === 'summary'), 'summary calls are logged transparently');
    } finally {
      await env.cleanup();
    }
  });

  test('a message too long for the model fails honestly and the message is kept', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx, { contextWindow: 4096, maxOutputTokens: 256 });
      env.setFetch(scriptedChat([{ text: 'never' }]).handler);
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id });
      const huge = 'word '.repeat(4000);
      await ctx.generation.send({ conversationId: chat.id, text: huge, attachmentIds: [] });
      await ctx.generation.idle();
      const [user, reply] = ctx.conversations.listMessages(chat.id);
      assert.equal(user!.content, huge.trimEnd());
      assert.equal(reply!.status, 'error');
      assert.equal(reply!.error?.code, 'message_too_long');
      assert.equal(chatRequests(env).length, 0, 'nothing silently truncated and sent');
    } finally {
      await env.cleanup();
    }
  });

  test('editing an assistant’s tone or switching models changes future replies without rewriting history', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const first = await addModel(ctx, { displayName: 'First Model' });
      const second = await addModel(ctx, { connectionName: 'Second endpoint', apiModelId: 'second', displayName: 'Second Model' });
      const augustine = ctx.workspaces.getBySlug('augustine');
      env.setFetch(scriptedChat([{ text: 'Reply one.' }, { text: 'Reply two.' }]).handler);
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: first.model.id });
      await ctx.generation.send({ conversationId: chat.id, text: 'First question', attachmentIds: [] });
      await ctx.generation.idle();
      const general = ctx.profiles.getDefaultGeneral();
      ctx.profiles.update(general.id, { tone: 'Speak like a patient teacher.' });
      ctx.conversations.update(chat.id, { selectedModelId: second.model.id });
      await ctx.generation.send({ conversationId: chat.id, text: 'Second question', attachmentIds: [] });
      await ctx.generation.idle();

      const [one, two] = chatRequests(env);
      assert.doesNotMatch(systemPromptOf(one!), /patient teacher/);
      assert.match(systemPromptOf(two!), /patient teacher/);
      assert.equal(two!.body.model, 'second');
      assert.ok(JSON.stringify(two!.body.messages).includes('Reply one.'), 'history carries over to the new model');
      const replies = ctx.conversations.listMessages(chat.id).filter((m) => m.role === 'assistant');
      assert.deepEqual(replies.map((r) => [r.modelLabel, r.content]), [['First Model', 'Reply one.'], ['Second Model', 'Reply two.']]);

      ctx.profiles.resetToDefault(general.id);
      assert.doesNotMatch(ctx.profiles.get(general.id).tone, /patient teacher/);
    } finally {
      await env.cleanup();
    }
  });
});
