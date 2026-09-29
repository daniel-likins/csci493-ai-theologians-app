import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { CatalogModelDto, ToolSettingsDto } from '../../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { sandboxAvailable } from '../tools/exec.ts';
import { params } from './helpers.ts';

const Protocol = z.enum(['openai_responses', 'openai_chat', 'anthropic_messages', 'gemini_generate_content']);
const AccessType = z.enum(['paid_api', 'institutional', 'local', 'other']);
const AuthType = z.enum(['api_key', 'bearer_token', 'token_command', 'none']);
const ToolGroupSchema = z.enum(['web_search', 'attachments', 'files', 'run_command', 'mission_history', 'memory_proposals']);

const ConnectionFields = z.object({
  name: z.string().max(200),
  preset: z.string().max(40).optional(),
  protocol: Protocol,
  accessType: AccessType,
  baseUrl: z.string().max(2048),
  authType: AuthType,
  tokenCommand: z.array(z.string().max(1024)).max(20).nullable().optional(),
  extraHeaders: z.record(z.string(), z.string().max(1024)).optional(),
});

const ModelFields = z.object({
  apiModelId: z.string().max(200),
  displayName: z.string().max(200).optional(),
  contextWindow: z.number().int().optional(),
  maxOutputTokens: z.number().int().optional(),
  supportsStreaming: z.boolean().optional(),
  supportsTools: z.boolean().optional(),
  supportsImages: z.boolean().optional(),
  supportsPdfs: z.boolean().optional(),
  params: z
    .object({ temperature: z.number().min(0).max(2).optional(), reasoningEffort: z.enum(['low', 'medium', 'high']).optional() })
    .optional(),
  enabled: z.boolean().optional(),
});

const ProfileFields = z.object({
  name: z.string().max(80).optional(),
  description: z.string().max(500).optional(),
  instructions: z.string().max(20_000).optional(),
  personality: z.string().max(4000).optional(),
  tone: z.string().max(4000).optional(),
  verbosity: z.string().max(4000).optional(),
  responseStructure: z.string().max(4000).optional(),
  preferredModelId: z.string().max(128).nullable().optional(),
  tools: z.array(ToolGroupSchema).optional(),
});

export function registerSettingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  // ── Connections ───────────────────────────────────────────────────────────
  app.get('/api/provider-presets', async () => ctx.connections.presets());
  app.get('/api/connections', async () => ctx.connections.list());

  app.post('/api/connections', async (request) => {
    const body = ConnectionFields.extend({ secret: z.string().max(16_384).optional() }).parse(request.body);
    const { secret, ...input } = body;
    return ctx.connections.create(input, secret?.trim() || undefined);
  });

  app.patch('/api/connections/:id', async (request) => ctx.connections.update(params(request).id, ConnectionFields.partial().parse(request.body)));

  app.put('/api/connections/:id/secret', async (request) => {
    const { secret } = z.object({ secret: z.string().min(1).max(16_384) }).parse(request.body);
    return ctx.connections.setSecret(params(request).id, secret);
  });

  app.delete('/api/connections/:id/secret', async (request) => ctx.connections.clearSecret(params(request).id));

  app.delete('/api/connections/:id', async (request) => {
    await ctx.connections.delete(params(request).id);
    return { ok: true };
  });

  app.post('/api/connections/:id/test', async (request) => ctx.connections.test(params(request).id));

  // ── Models ────────────────────────────────────────────────────────────────
  app.get('/api/models', async (): Promise<CatalogModelDto[]> => {
    const connections = new Map((await ctx.connections.list()).map((c) => [c.id, c]));
    return ctx.models.list().flatMap((m) => {
      const c = connections.get(m.connectionId);
      return c ? [{ ...m, connectionName: c.name, connectionStatus: c.status, accessType: c.accessType, protocol: c.protocol }] : [];
    });
  });

  app.post('/api/connections/:id/models', async (request) => ctx.models.create(params(request).id, ModelFields.parse(request.body)));
  app.patch('/api/models/:id', async (request) => ctx.models.update(params(request).id, ModelFields.partial().parse(request.body)));
  app.delete('/api/models/:id', async (request) => {
    ctx.models.delete(params(request).id);
    return { ok: true };
  });
  app.post('/api/models/:id/test', async (request) => ctx.connections.testModel(params(request).id));

  // ── Assistant profiles ────────────────────────────────────────────────────
  app.get('/api/profiles', async () => ctx.profiles.list());
  app.patch('/api/profiles/:id', async (request) => ctx.profiles.update(params(request).id, ProfileFields.parse(request.body)));
  app.post('/api/profiles/:id/reset', async (request) => ctx.profiles.resetToDefault(params(request).id));
  app.get('/api/profiles/:id/defaults', async (request) => ctx.profiles.defaultsFor(params(request).id));
  app.post('/api/profiles', async (request) => {
    const body = ProfileFields.extend({ name: z.string().min(1).max(80) }).parse(request.body);
    return ctx.profiles.createGeneral(body);
  });
  app.delete('/api/profiles/:id', async (request) => {
    ctx.profiles.deleteCustom(params(request).id);
    return { ok: true };
  });

  // ── Tools ─────────────────────────────────────────────────────────────────
  const toolSettings = async (): Promise<ToolSettingsDto> => {
    const s = ctx.tools.settings();
    return {
      webSearchProvider: ctx.webSearch.provider(),
      webSearchHasKey: await ctx.webSearch.hasKey(),
      commandNetwork: s.commandNetwork,
      commandTimeoutSeconds: s.commandTimeoutSeconds,
      outsideFolderAccess: s.outsideFolderAccess,
      sandboxAvailable: sandboxAvailable(),
    };
  };

  app.get('/api/tools/settings', toolSettings);

  app.patch('/api/tools/settings', async (request) => {
    const body = z
      .object({
        webSearchProvider: z.enum(['tavily', 'brave']).nullable().optional(),
        commandNetwork: z.boolean().optional(),
        commandTimeoutSeconds: z.number().int().min(5).max(600).optional(),
        outsideFolderAccess: z.enum(['ask', 'deny']).optional(),
      })
      .parse(request.body);
    if (body.webSearchProvider !== undefined) ctx.webSearch.setProvider(body.webSearchProvider);
    if (body.commandNetwork !== undefined) ctx.prefs.set('tools.commandNetwork', body.commandNetwork);
    if (body.commandTimeoutSeconds !== undefined) ctx.prefs.set('tools.commandTimeoutSeconds', body.commandTimeoutSeconds);
    if (body.outsideFolderAccess !== undefined) ctx.prefs.set('tools.outsideFolderAccess', body.outsideFolderAccess);
    ctx.bus.publish({ type: 'settings.changed', area: 'tools' });
    return toolSettings();
  });

  app.put('/api/tools/web-search/key', async (request) => {
    const { provider, key } = z.object({ provider: z.enum(['tavily', 'brave']), key: z.string().min(1).max(4096) }).parse(request.body);
    await ctx.webSearch.setKey(provider, key);
    if (!ctx.webSearch.provider()) ctx.webSearch.setProvider(provider);
    ctx.bus.publish({ type: 'settings.changed', area: 'tools' });
    return toolSettings();
  });

  app.delete('/api/tools/web-search/key', async (request) => {
    const { provider } = z.object({ provider: z.enum(['tavily', 'brave']) }).parse(request.query);
    await ctx.webSearch.clearKey(provider);
    ctx.bus.publish({ type: 'settings.changed', area: 'tools' });
    return toolSettings();
  });

  app.post('/api/tools/web-search/test', async () => ctx.webSearch.test());
}
