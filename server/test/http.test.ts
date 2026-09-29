import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, test } from 'node:test';
import type { AppEventEnvelope } from '../../shared/types.ts';
import { buildApp } from '../src/app.ts';
import { addModel, createTestEnv, TEST_PORT, waitFor } from './helpers.ts';
import { scriptedChat } from './fixtures/mock-provider.ts';

const host = `127.0.0.1:${TEST_PORT}`;

describe('local service over HTTP', () => {
  test('guards against other websites, DNS rebinding, and missing session tokens', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const app = await buildApp(ctx);
      const ok = { host, 'x-theologians-csrf': ctx.tokens.csrf };
      assert.equal((await app.inject({ url: '/api/health', headers: { host } })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/workspaces', headers: ok })).statusCode, 200);
      assert.equal((await app.inject({ url: '/api/workspaces', headers: { host } })).statusCode, 403, 'token required');
      assert.equal((await app.inject({ url: '/api/workspaces', headers: { ...ok, host: 'attacker.example:47950' } })).statusCode, 421, 'rebinding blocked');
      assert.equal((await app.inject({ url: '/api/workspaces', headers: { ...ok, origin: 'https://attacker.example' } })).statusCode, 403);
      assert.equal((await app.inject({ url: '/api/session', headers: { host, 'sec-fetch-site': 'cross-site' } })).statusCode, 403);
      assert.equal((await app.inject({ url: '/api/workspaces', headers: { ...ok, 'x-theologians-csrf': 'wrong' } })).statusCode, 403);
      assert.equal((await app.inject({ url: '/api/workspaces', headers: { host, 'x-theologians-control': ctx.tokens.control } })).statusCode, 200);
      const unknown = await app.inject({ method: 'POST', url: '/api/nope', headers: ok });
      assert.equal(unknown.statusCode, 404);
      const response = await app.inject({ url: '/api/workspaces', headers: ok });
      assert.equal(response.headers['x-frame-options'], 'DENY');
      assert.equal(response.headers['cache-control'], 'no-store');
      await app.close();
    } finally {
      await env.cleanup();
    }
  });

  test('serves the UI with the session token and saved theme injected', async () => {
    const env = createTestEnv();
    try {
      const dist = path.join(env.dir, 'web-dist');
      mkdirSync(dist, { recursive: true });
      writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html lang="en"><head><meta name="theologians-csrf" content="__THEO_CSRF__"></head></html>');
      env.ctx.config.webDistDir = dist;
      env.ctx.prefs.set('ui.theme', 'dark');
      const app = await buildApp(env.ctx);
      const page = await app.inject({ url: '/m/augustine', headers: { host } });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, new RegExp(`content="${env.ctx.tokens.csrf}"`));
      assert.match(page.body, /data-theme="dark"/);
      assert.match(String(page.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.equal((await app.inject({ url: '/../../etc/passwd', headers: { host } })).statusCode, 200, 'path traversal falls back to the app page');
      await app.close();
    } finally {
      await env.cleanup();
    }
  });

  test('streams to every view, supports stop, keeps partial text and the user message', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const app = await buildApp(ctx);
      const headers = { host, 'x-theologians-csrf': ctx.tokens.csrf, 'content-type': 'application/json', 'x-theologians-client': 'view-a' };
      const { model } = await addModel(ctx);
      const augustine = ctx.workspaces.getBySlug('augustine');
      env.setFetch(scriptedChat([{ text: 'This is a long streaming answer that keeps going and going.', delayMs: 40, hang: true }]).handler);
      const events: AppEventEnvelope[] = [];
      ctx.bus.subscribe((e) => events.push(e));

      const created = await app.inject({ method: 'POST', url: '/api/conversations', headers, payload: { workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id } });
      const chat = created.json();
      const sent = await app.inject({ method: 'POST', url: `/api/conversations/${chat.id}/messages`, headers, payload: { text: 'Tell me a story', attachmentIds: [] } });
      assert.equal(sent.statusCode, 200);
      const { assistantMessage } = sent.json();
      await waitFor(() => events.filter((e) => e.type === 'message.delta').length >= 2, 'streamed deltas');

      const busy = await app.inject({ method: 'POST', url: `/api/conversations/${chat.id}/messages`, headers, payload: { text: 'another' } });
      assert.equal(busy.statusCode, 409, 'one response at a time per chat');

      const stop = await app.inject({ method: 'POST', url: `/api/messages/${assistantMessage.id}/cancel`, headers, payload: {} });
      assert.equal(stop.json().cancelled, true);
      await ctx.generation.idle();
      const detail = (await app.inject({ url: `/api/conversations/${chat.id}`, headers })).json();
      assert.equal(detail.messages[0].content, 'Tell me a story');
      assert.equal(detail.messages[1].status, 'cancelled');
      assert.ok(detail.messages[1].content.length > 0, 'partial text is kept');
      await app.close();
    } finally {
      await env.cleanup();
    }
  });

  test('provider failures keep the input, surface a reconnect action, and retry works', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const app = await buildApp(ctx);
      const headers = { host, 'x-theologians-csrf': ctx.tokens.csrf, 'content-type': 'application/json' };
      const { model, connection } = await addModel(ctx, { authType: 'bearer_token', secret: 'old-token-value', baseUrl: 'https://gateway.example/v1' });
      const augustine = ctx.workspaces.getBySlug('augustine');
      env.setFetch(scriptedChat([{ status: 401, errorBody: '{"error":{"message":"Token expired"}}' }, { text: 'Works now.' }]).handler);
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat', selectedModelId: model.id });
      await app.inject({ method: 'POST', url: `/api/conversations/${chat.id}/messages`, headers, payload: { text: 'Important question' } });
      await ctx.generation.idle();
      const failed = ctx.conversations.listMessages(chat.id);
      assert.equal(failed[0]!.content, 'Important question');
      assert.equal(failed[1]!.error?.code, 'expired');
      assert.equal(failed[1]!.error?.action, 'reconnect');
      assert.equal((await ctx.connections.get(connection.id)).status, 'expired');

      await app.inject({ method: 'PUT', url: `/api/connections/${connection.id}/secret`, headers, payload: { secret: 'new-token-value' } });
      const retry = await app.inject({ method: 'POST', url: `/api/messages/${failed[1]!.id}/retry`, headers, payload: {} });
      assert.equal(retry.statusCode, 200);
      await ctx.generation.idle();
      const after = ctx.conversations.listMessages(chat.id);
      assert.equal(after.length, 3);
      assert.equal(after[1]!.superseded, true);
      assert.equal(after[2]!.content, 'Works now.');
      assert.equal(env.requests.at(-1)!.headers.authorization, 'Bearer new-token-value');
      const connections = (await app.inject({ url: '/api/connections', headers })).body;
      assert.doesNotMatch(connections, /new-token-value|old-token-value/, 'secrets never leave the service');
      await app.close();
    } finally {
      await env.cleanup();
    }
  });

  test('drafts sync to other views with the originating view identified', async () => {
    const env = createTestEnv();
    try {
      const { ctx } = env;
      const app = await buildApp(ctx);
      const augustine = ctx.workspaces.getBySlug('augustine');
      const chat = ctx.conversations.create({ workspaceId: augustine.id, kind: 'chat' });
      const events: AppEventEnvelope[] = [];
      ctx.bus.subscribe((e) => events.push(e));
      const headers = { host, 'x-theologians-csrf': ctx.tokens.csrf, 'content-type': 'application/json', 'x-theologians-client': 'desktop-window' };
      await app.inject({ method: 'PUT', url: `/api/conversations/${chat.id}/draft`, headers, payload: { draft: 'half-written', attachmentIds: [] } });
      const event = events.find((e) => e.type === 'draft.updated');
      assert.ok(event && event.type === 'draft.updated' && event.draft === 'half-written' && event.originClientId === 'desktop-window');
      await app.inject({ method: 'PUT', url: `/api/drafts/new.${augustine.id}`, headers, payload: { text: 'new chat draft', attachmentIds: [] } });
      assert.equal((await app.inject({ url: `/api/drafts/new.${augustine.id}`, headers })).json().text, 'new chat draft');
      await app.close();
    } finally {
      await env.cleanup();
    }
  });
});

describe('per-account ports', () => {
  test('each Mac account gets its own default port, and the first account keeps 47831', async () => {
    const { defaultPortForUid } = await import('../src/config.ts');
    assert.equal(defaultPortForUid(501), 47831);
    assert.equal(defaultPortForUid(502), 47841);
    const ports = new Set(Array.from({ length: 1000 }, (_, i) => defaultPortForUid(501 + i)));
    assert.equal(ports.size, 1000, 'no two of the first 1000 accounts share a port');
    for (const p of ports) assert.ok(p > 1024 && p < 65536);
    assert.ok(!ports.has(47832) && !ports.has(47970) && !ports.has(47995), 'never the dev or test ports');
  });
});
