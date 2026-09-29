import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import type { AppContext } from '../src/context.ts';
import { addModel, chatRequests, createTestEnv, systemPromptOf } from './helpers.ts';
import { scriptedChat } from './fixtures/mock-provider.ts';

function missionChat(ctx: AppContext, slug = 'augustine', userText = 'I have decided to focus on patristic literature this semester') {
  const ws = ctx.workspaces.getBySlug(slug);
  const conversation = ctx.conversations.create({ workspaceId: ws.id, kind: 'chat' });
  const message = ctx.conversations.appendMessage({ conversationId: conversation.id, role: 'user', content: userText });
  const goals = ctx.profiles.getGoals(ws.id);
  return { ws, conversation, message, goals, actor: { kind: 'goals_assistant' as const, profileId: goals.id, conversationId: conversation.id } };
}

describe('memory approval and autosave', () => {
  test('with autosave off, nothing changes until the user approves', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { ws, actor } = missionChat(ctx);
      const proposal = ctx.memory.propose(actor, ws.id, {
        op: 'add',
        category: 'current_focus',
        certainty: 'confirmed',
        text: 'Focusing on patristic literature this semester',
        importance: 'high',
        reason: 'User stated a decision',
        evidence: 'I have decided to focus on patristic literature this semester',
      });
      assert.equal(proposal.status, 'pending');
      assert.equal(proposal.sourceTitle, 'New chat');
      assert.ok(proposal.sourceConversationId && proposal.createdAt);
      assert.equal(ctx.memory.listItems(ws.id).length, 0, 'pending proposals are not memory');

      const rejected = ctx.memory.propose(actor, ws.id, { op: 'add', category: 'idea', certainty: 'tentative', text: 'Maybe read more early church history', importance: 'medium', reason: 'idea' });
      ctx.memory.reject({ kind: 'user' }, rejected.id);
      assert.equal(ctx.memory.listItems(ws.id).length, 0);

      const approved = ctx.memory.approve({ kind: 'user' }, proposal.id, { text: 'Focusing on patristics this semester' });
      assert.equal(approved.status, 'approved');
      const items = ctx.memory.listItems(ws.id);
      assert.deepEqual(items.map((i) => [i.text, i.origin, i.certainty]), [['Focusing on patristics this semester', 'approved', 'confirmed']]);
      const history = ctx.memory.listChanges(ws.id);
      assert.equal(history[0]?.origin, 'proposal_approved');
      assert.equal(history[0]?.proposalId, proposal.id);
    } finally {
      await env.cleanup();
    }
  });

  test('with autosave on, important updates apply with visible history and can be undone', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { ws, actor } = missionChat(ctx);
      ctx.workspaces.updateSettings(ws.id, { memoryAutosave: true });

      const saved = ctx.memory.propose(actor, ws.id, {
        op: 'add',
        category: 'current_focus',
        certainty: 'confirmed',
        text: 'Focusing on patristic literature',
        importance: 'high',
        reason: 'decision',
        evidence: 'decided to focus on patristic literature this semester',
      });
      assert.equal(saved.status, 'auto_applied');
      const [item] = ctx.memory.listItems(ws.id);
      assert.equal(item?.origin, 'autosave');
      const [change] = ctx.memory.listChanges(ws.id);
      assert.equal(change?.origin, 'autosave');

      ctx.memory.undo({ kind: 'user' }, change!.id);
      assert.equal(ctx.memory.listItems(ws.id).length, 0, 'undo removes the autosaved item');
      assert.equal(ctx.memory.listChanges(ws.id)[0]?.origin, 'undo');
      assert.throws(() => ctx.memory.undo({ kind: 'user' }, change!.id), /already undone/);
    } finally {
      await env.cleanup();
    }
  });

  test('autosave still requires approval for removals, low importance, and unsupported "confirmed" claims', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { ws, actor } = missionChat(ctx, 'augustine', 'I am thinking about theology');
      ctx.workspaces.updateSettings(ws.id, { memoryAutosave: true });
      const existing = ctx.memory.addItem({ kind: 'user' }, ws.id, { category: 'constraint', certainty: 'confirmed', text: 'Only 5 hours per week available' });

      const removal = ctx.memory.propose(actor, ws.id, { op: 'remove', targetItemId: existing.id, reason: 'seems outdated', importance: 'high' });
      assert.equal(removal.status, 'pending');
      assert.match(removal.statusDetail ?? '', /Removals always need your approval/);

      const minor = ctx.memory.propose(actor, ws.id, { op: 'add', category: 'note', certainty: 'tentative', text: 'Likes dark mode', importance: 'low', reason: 'minor' });
      assert.equal(minor.status, 'pending');

      const unsupported = ctx.memory.propose(actor, ws.id, {
        op: 'add',
        category: 'long_term_goal',
        certainty: 'confirmed',
        text: 'Will write a theology textbook',
        importance: 'high',
        reason: 'assistant inferred it',
        evidence: 'I will write a theology textbook',
      });
      assert.equal(unsupported.status, 'pending', 'an assistant cannot promote its own idea to a confirmed goal');
      assert.match(unsupported.statusDetail ?? '', /no matching statement from you/);
      assert.equal(ctx.memory.listItems(ws.id).length, 1);
    } finally {
      await env.cleanup();
    }
  });

  test('duplicates are skipped and close variants become updates instead of contradictions', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { ws, actor } = missionChat(ctx);
      const item = ctx.memory.addItem({ kind: 'user' }, ws.id, { category: 'current_focus', certainty: 'confirmed', text: 'Studying the Confessions with a reading guide' });
      const dupe = ctx.memory.propose(actor, ws.id, { op: 'add', category: 'current_focus', certainty: 'confirmed', text: 'Studying the Confessions with a reading guide.', importance: 'high', reason: 'x' });
      assert.equal(dupe.status, 'duplicate');
      const variant = ctx.memory.propose(actor, ws.id, {
        op: 'add',
        category: 'current_focus',
        certainty: 'confirmed',
        text: 'Studying the Confessions with a reading guide and daily notes',
        importance: 'medium',
        reason: 'more detail',
      });
      assert.equal(variant.op, 'update');
      assert.equal(variant.targetItemId, item.id);
      const again = ctx.memory.propose(actor, ws.id, {
        op: 'add',
        category: 'current_focus',
        certainty: 'confirmed',
        text: 'Studying the Confessions with a reading guide and daily notes',
        importance: 'medium',
        reason: 'repeat',
      });
      assert.equal(again.status, 'duplicate', 'the same suggestion is not queued twice');
    } finally {
      await env.cleanup();
    }
  });

  test('user edits are versioned; undo refuses to clobber a later edit', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const ws = ctx.workspaces.getBySlug('aquinas');
      const item = ctx.memory.addItem({ kind: 'user' }, ws.id, { category: 'progress', certainty: 'confirmed', text: 'Read Genesis' });
      ctx.memory.updateItem({ kind: 'user' }, item.id, { text: 'Read Genesis and Exodus' });
      const [edit] = ctx.memory.listChanges(ws.id);
      ctx.memory.updateItem({ kind: 'user' }, item.id, { text: 'Read Genesis through Leviticus' });
      assert.throws(() => ctx.memory.undo({ kind: 'user' }, edit!.id), /changed since this edit/);
      const [latest] = ctx.memory.listChanges(ws.id);
      ctx.memory.undo({ kind: 'user' }, latest!.id);
      assert.equal(ctx.memory.listItems(ws.id)[0]?.text, 'Read Genesis and Exodus');
      ctx.memory.deleteItem({ kind: 'user' }, item.id);
      assert.equal(ctx.memory.listItems(ws.id).length, 0);
      ctx.memory.undo({ kind: 'user' }, ctx.memory.listChanges(ws.id)[0]!.id);
      assert.equal(ctx.memory.listItems(ws.id).length, 1, 'deleted items can be restored with undo');
      assert.throws(() => ctx.memory.updateItem({ kind: 'user' }, item.id, { text: 'x' }, 1), /another window/);
    } finally {
      await env.cleanup();
    }
  });

  test('proposals must come from a conversation in the same mission, by that mission’s Goals assistant', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const augustine = missionChat(ctx, 'augustine');
      const luther = ctx.workspaces.getBySlug('luther');
      assert.throws(
        () => ctx.memory.propose(augustine.actor, luther.id, { op: 'add', category: 'idea', certainty: 'tentative', text: 'x y z', reason: 'r' }),
        /Only this mission/,
      );
      const lutherGoals = ctx.profiles.getGoals(luther.id);
      assert.throws(
        () => ctx.memory.propose({ kind: 'goals_assistant', profileId: lutherGoals.id, conversationId: augustine.conversation.id }, luther.id, { op: 'add', category: 'idea', certainty: 'tentative', text: 'x y z', reason: 'r' }),
        /same mission/,
      );
      const general = ctx.profiles.getDefaultGeneral();
      assert.throws(
        () => ctx.memory.propose({ kind: 'goals_assistant', profileId: general.id, conversationId: augustine.conversation.id }, augustine.ws.id, { op: 'add', category: 'idea', certainty: 'tentative', text: 'x y z', reason: 'r' }),
        /Only this mission/,
      );
      assert.throws(() => ctx.memory.addItem(augustine.actor, augustine.ws.id, { category: 'idea', certainty: 'tentative', text: 'direct write' }), /only suggest/);
    } finally {
      await env.cleanup();
    }
  });

  test('selecting a Goals assistant in a chat reads context but saves nothing on its own', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const { model } = await addModel(ctx);
      const { ws, conversation, goals } = missionChat(ctx, 'augustine', 'I want to study Augustine’s account of grace');
      ctx.memory.addItem({ kind: 'user' }, ws.id, { category: 'long_term_goal', certainty: 'confirmed', text: 'Study Augustine on grace' });
      ctx.profiles.update(goals.id, { preferredModelId: model.id });
      ctx.workspaces.updateSettings(ws.id, { memoryAutosave: true });
      const script = scriptedChat([{ text: 'This reading fits your long-term goal of studying Augustine on grace.' }]);
      env.setFetch(script.handler);
      ctx.conversations.update(conversation.id, { selectedProfileId: goals.id, selectedModelId: null });
      await ctx.generation.send({ conversationId: conversation.id, text: 'Does this fit my priorities?', attachmentIds: [] });
      await ctx.generation.idle();

      const [request] = chatRequests(env);
      assert.match(systemPromptOf(request!), /Study Augustine on grace/);
      assert.ok(JSON.stringify(request!.body.messages).includes('account of grace'), 'recent conversation is included as context');
      assert.equal(ctx.memory.listItems(ws.id).length, 1, 'memory unchanged');
      assert.equal(ctx.memory.listProposals(ws.id, 'recent').length, 0, 'no proposals from merely reading');
    } finally {
      await env.cleanup();
    }
  });
});
