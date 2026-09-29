import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MEMORY_CATEGORY_IDS, MEMORY_CERTAINTY_IDS } from '../../../shared/constants.ts';
import type { MemoryCategory, MemoryCertainty, MissionMemoryDto } from '../../../shared/types.ts';
import type { AppContext } from '../context.ts';
import { nowIso } from '../lib/ids.ts';
import { checkinPrompt, checkinStatus, SNOOZE_DAYS } from '../memory/checkins.ts';
import type { MemoryActor } from '../memory/memory-service.ts';
import { params } from './helpers.ts';

const Category = z.enum(MEMORY_CATEGORY_IDS as [MemoryCategory, ...MemoryCategory[]]);
const Certainty = z.enum(MEMORY_CERTAINTY_IDS as [MemoryCertainty, ...MemoryCertainty[]]);

/**
 * Direct memory edits made by the user from a mission's Goals panel. These routes identify memory by
 * workspace or item id and never accept a conversation, so nothing from a master (home) conversation
 * can reach them.
 */
export function registerMemoryRoutes(app: FastifyInstance, ctx: AppContext): void {
  const user: MemoryActor = { kind: 'user' };
  const { memory, workspaces } = ctx;

  app.get('/api/workspaces/:id/memory', async (request): Promise<MissionMemoryDto> => {
    const { id } = params(request);
    const view = memory.view(id);
    const settings = workspaces.getSettings(id);
    return {
      workspaceId: id,
      items: view.items,
      lastChangedAt: view.lastChangedAt,
      pendingCount: view.pendingCount,
      autosave: settings.memoryAutosave,
      checkin: checkinStatus(settings),
    };
  });

  app.post('/api/workspaces/:id/memory/items', async (request) => {
    const body = z.object({ category: Category, certainty: Certainty, text: z.string().max(2000) }).parse(request.body);
    return memory.addItem(user, params(request).id, body);
  });

  app.patch('/api/memory/items/:id', async (request) => {
    const body = z
      .object({ category: Category.optional(), certainty: Certainty.optional(), text: z.string().max(2000).optional(), expectedVersion: z.number().int().optional() })
      .parse(request.body);
    const { expectedVersion, ...patch } = body;
    return memory.updateItem(user, params(request).id, patch, expectedVersion);
  });

  app.delete('/api/memory/items/:id', async (request) => {
    memory.deleteItem(user, params(request).id);
    return { ok: true };
  });

  app.get('/api/workspaces/:id/memory/proposals', async (request) => {
    const { filter } = z.object({ filter: z.enum(['pending', 'recent']).default('pending') }).parse(request.query);
    return memory.listProposals(params(request).id, filter);
  });

  app.post('/api/memory/proposals/:id/approve', async (request) => {
    const edits = z
      .object({ text: z.string().max(2000).optional(), category: Category.optional(), certainty: Certainty.optional() })
      .parse(request.body ?? {});
    return memory.approve(user, params(request).id, edits);
  });

  app.post('/api/memory/proposals/:id/reject', async (request) => memory.reject(user, params(request).id));

  app.get('/api/workspaces/:id/memory/changes', async (request) => memory.listChanges(params(request).id));

  app.post('/api/memory/changes/:id/undo', async (request) => memory.undo(user, params(request).id));

  app.get('/api/workspaces/:id/checkin', async (request) => checkinStatus(workspaces.getSettings(params(request).id)));

  app.post('/api/workspaces/:id/checkin/start', async (request) => {
    const { id } = params(request);
    const workspace = workspaces.get(id);
    workspaces.updateSettings(id, { lastCheckinAt: nowIso(), checkinSnoozedUntil: null });
    return { prompt: checkinPrompt(workspace.name) };
  });

  app.post('/api/workspaces/:id/checkin/snooze', async (request) => {
    const { id } = params(request);
    workspaces.updateSettings(id, { checkinSnoozedUntil: new Date(Date.now() + SNOOZE_DAYS * 86_400_000).toISOString() });
    return checkinStatus(workspaces.getSettings(id));
  });
}
