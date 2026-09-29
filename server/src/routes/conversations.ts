import { createReadStream, existsSync } from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ConversationDetailDto, ConversationOptionsDto } from '../../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { badRequest, notFound } from '../lib/errors.ts';
import { sandboxAvailable } from '../tools/exec.ts';
import { validateWorkingFolder } from '../tools/files.ts';
import { clientIdOf, params } from './helpers.ts';

const SearchQuery = z.object({ q: z.string().max(200).default('') });

export function registerConversationRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { conversations, workspaces, generation } = ctx;

  const options = async (conversationId: string): Promise<ConversationOptionsDto> => {
    const conversation = conversations.get(conversationId);
    const selection = generation.resolveSelection(conversationId);
    const settings = conversation.workspaceId ? workspaces.getSettings(conversation.workspaceId) : null;
    return {
      profiles: ctx.profiles.listUsableIn(conversation),
      resolvedProfileId: selection.profile.id,
      resolvedModelId: selection.modelId,
      webSearchReady: await ctx.webSearch.isReady(),
      sandboxAvailable: sandboxAvailable(),
      workingFolder: settings?.workingFolder ?? null,
      generating: generation.isActive(conversationId),
    };
  };

  const rememberSelection = (conversationId: string): void => {
    const c = conversations.get(conversationId);
    if (c.kind !== 'chat') return;
    ctx.prefs.set(`selection.last.${c.workspaceId}`, { profileId: c.selectedProfileId, modelId: c.selectedModelId }, undefined, false);
  };

  // ── Workspaces ────────────────────────────────────────────────────────────
  app.get('/api/workspaces', async () => ({ sections: workspaces.listSections(), workspaces: workspaces.list() }));

  app.patch('/api/workspaces/:id', async (request) => {
    const body = z.object({ name: z.string().max(80).optional(), description: z.string().max(1000).optional() }).parse(request.body);
    return workspaces.update(params(request).id, body);
  });

  app.get('/api/workspaces/:id/settings', async (request) => workspaces.getSettings(params(request).id));

  app.patch('/api/workspaces/:id/settings', async (request) => {
    const { id } = params(request);
    const body = z
      .object({
        memoryAutosave: z.boolean().optional(),
        memorySuggestions: z.boolean().optional(),
        historyAccess: z.enum(['none', 'search']).optional(),
        generalContext: z.enum(['none', 'description', 'description_and_focus']).optional(),
        checkinFrequency: z.enum(['off', 'weekly', 'biweekly', 'monthly']).optional(),
        workingFolder: z.string().max(4096).nullable().optional(),
      })
      .parse(request.body);
    workspaces.get(id);
    const patch = { ...body };
    if (body.workingFolder) patch.workingFolder = await validateWorkingFolder(body.workingFolder, ctx.config.dataDir);
    return workspaces.updateSettings(id, patch);
  });

  // ── Folders ───────────────────────────────────────────────────────────────
  app.get('/api/workspaces/:id/folders', async (request) => conversations.listFolders(params(request).id));
  app.post('/api/workspaces/:id/folders', async (request) => {
    const { name } = z.object({ name: z.string().max(200) }).parse(request.body);
    return conversations.createFolder(params(request).id, name);
  });
  app.patch('/api/folders/:id', async (request) => {
    const { name } = z.object({ name: z.string().max(200) }).parse(request.body);
    return conversations.renameFolder(params(request).id, name);
  });
  app.delete('/api/folders/:id', async (request) => {
    conversations.deleteFolder(params(request).id);
    return { ok: true };
  });

  // ── Conversations ─────────────────────────────────────────────────────────
  app.get('/api/workspaces/:id/conversations', async (request) => {
    const { id } = params(request);
    workspaces.get(id);
    return conversations.list(id, 'chat');
  });
  app.get('/api/workspaces/:id/goals-conversation', async (request) => {
    const { id } = params(request);
    const workspace = workspaces.get(id);
    if (!workspace.hasGoals) throw notFound('Goals conversation');
    return conversations.getOrCreateGoals(id);
  });
  app.get('/api/workspaces/:id/search', async (request) => {
    const { q } = SearchQuery.parse(request.query);
    return conversations.search(params(request).id, ['chat'], q);
  });
  app.get('/api/home/conversations', async () => conversations.list(null, 'master'));
  app.get('/api/home/search', async (request) => {
    const { q } = SearchQuery.parse(request.query);
    return conversations.search(null, ['master'], q);
  });

  app.post('/api/conversations', async (request) => {
    const body = z
      .object({
        workspaceId: z.string().max(128).nullable(),
        kind: z.enum(['chat', 'master']),
        folderId: z.string().max(128).nullable().optional(),
        title: z.string().max(200).optional(),
        selectedProfileId: z.string().max(128).nullable().optional(),
        selectedModelId: z.string().max(128).nullable().optional(),
        webSearchEnabled: z.boolean().optional(),
        filesEnabled: z.boolean().optional(),
      })
      .parse(request.body);
    if (body.kind === 'master' && body.workspaceId !== null) throw badRequest('Master conversations belong to Home.');
    let { selectedProfileId, selectedModelId } = body;
    if (selectedProfileId === undefined && selectedModelId === undefined) {
      const last = ctx.prefs.get<{ profileId?: string | null; modelId?: string | null } | null>(`selection.last.${body.workspaceId ?? 'home'}`, null);
      if (last) {
        selectedProfileId = last.profileId ?? undefined;
        selectedModelId = last.modelId ?? undefined;
      }
    }
    try {
      return conversations.create({ ...body, selectedProfileId, selectedModelId });
    } catch (err) {
      if (selectedProfileId === body.selectedProfileId && selectedModelId === body.selectedModelId) throw err;
      return conversations.create({ ...body, selectedProfileId: undefined, selectedModelId: undefined });
    }
  });

  app.get('/api/conversations/:id', async (request): Promise<ConversationDetailDto> => {
    const { id } = params(request);
    return {
      conversation: conversations.get(id),
      messages: conversations.listMessages(id),
      approvals: ctx.approvals.list(id).filter((a) => a.status === 'pending'),
      options: await options(id),
    };
  });

  app.get('/api/conversations/:id/options', async (request) => options(params(request).id));

  app.patch('/api/conversations/:id', async (request) => {
    const { id } = params(request);
    const body = z
      .object({
        title: z.string().max(200).optional(),
        folderId: z.string().max(128).nullable().optional(),
        selectedProfileId: z.string().max(128).optional(),
        selectedModelId: z.string().max(128).nullable().optional(),
        webSearchEnabled: z.boolean().optional(),
        filesEnabled: z.boolean().optional(),
        expectedVersion: z.number().int().optional(),
      })
      .parse(request.body);
    const { expectedVersion, ...patch } = body;
    const updated = conversations.update(id, patch, expectedVersion, clientIdOf(request));
    if (patch.selectedProfileId !== undefined || patch.selectedModelId !== undefined) rememberSelection(id);
    return updated;
  });

  app.delete('/api/conversations/:id', async (request) => {
    const { id } = params(request);
    generation.cancelConversation(id);
    await generation.idle();
    conversations.delete(id);
    return { ok: true };
  });

  app.put('/api/conversations/:id/draft', async (request) => {
    const body = z.object({ draft: z.string().max(200_000), attachmentIds: z.array(z.string().max(128)).max(20) }).parse(request.body);
    return conversations.saveDraft(params(request).id, body.draft, body.attachmentIds, clientIdOf(request));
  });

  // ── Messages ──────────────────────────────────────────────────────────────
  app.get('/api/conversations/:id/messages', async (request) => conversations.listMessages(params(request).id));

  app.post('/api/conversations/:id/messages', async (request) => {
    const body = z.object({ text: z.string().max(200_000), attachmentIds: z.array(z.string().max(128)).max(20).default([]) }).parse(request.body);
    return generation.send({ conversationId: params(request).id, text: body.text, attachmentIds: body.attachmentIds, originClientId: clientIdOf(request) });
  });

  app.post('/api/messages/:id/cancel', async (request) => ({ cancelled: generation.cancel(params(request).id) }));
  app.post('/api/messages/:id/retry', async (request) => generation.retry(params(request).id));

  app.post('/api/conversations/:id/suggest-memory', async (request) => ctx.suggestions.scan(params(request).id, { manual: true }));

  // ── Attachments ───────────────────────────────────────────────────────────
  app.post('/api/attachments', async (request) => {
    const query = z
      .object({
        workspaceId: z.string().max(128).optional(),
        conversationId: z.string().max(128).optional(),
        filename: z.string().max(400),
      })
      .parse(request.query);
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw badRequest('Send the file as the request body (application/octet-stream).');
    const declared = request.headers['x-file-type'];
    return ctx.attachments.upload({
      workspaceId: query.workspaceId ?? null,
      conversationId: query.conversationId ?? null,
      filename: query.filename,
      declaredMime: typeof declared === 'string' ? declared.slice(0, 100) : '',
      data: body,
    });
  });

  app.get('/api/attachments/:id', async (request) => ctx.attachments.get(params(request).id));

  app.get('/api/attachments/:id/content', async (request, reply) => {
    const info = ctx.attachments.fileInfo(params(request).id);
    if (!existsSync(info.path)) throw notFound('Attachment file');
    const inline = info.kind === 'image' || info.kind === 'pdf';
    reply.header('content-type', info.kind === 'text' ? 'text/plain; charset=utf-8' : info.mimeType);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(info.filename)}`);
    reply.header('content-security-policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
    reply.header('cache-control', 'private, max-age=3600');
    return reply.send(createReadStream(info.path));
  });

  app.delete('/api/attachments/:id', async (request) => {
    ctx.attachments.deleteUnsent(params(request).id);
    return { ok: true };
  });

  // ── Approvals ─────────────────────────────────────────────────────────────
  app.get('/api/conversations/:id/approvals', async (request) => ctx.approvals.list(params(request).id));
  app.post('/api/approvals/:id', async (request) => {
    const { decision } = z.object({ decision: z.enum(['approved', 'denied']) }).parse(request.body);
    return ctx.approvals.decide(params(request).id, decision);
  });
}
