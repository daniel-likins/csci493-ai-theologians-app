import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.ts';
import { badRequest } from '../lib/errors.ts';
import { params } from './helpers.ts';

export function registerDataRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/backups', async () => ({ settings: ctx.backups.settings(), backups: await ctx.backups.list(), exportsDirectory: ctx.transfer.exportsDirectory() }));

  app.patch('/api/backups/settings', async (request) => {
    const body = z.object({ directory: z.string().max(4096).nullable().optional(), automatic: z.boolean().optional() }).parse(request.body);
    if (body.directory !== undefined) await ctx.backups.setDirectory(body.directory);
    if (body.automatic !== undefined) ctx.backups.setAutomatic(body.automatic);
    return ctx.backups.settings();
  });

  app.post('/api/backups', async () => ctx.backups.create('manual'));

  app.post('/api/backups/:id/restore', async (request) => ctx.backups.restore(params(request).id));

  app.post('/api/export', async () => ctx.transfer.export());

  app.post('/api/import/preview', async (request) => {
    const body = request.body;
    if (!Buffer.isBuffer(body)) throw badRequest('Upload the export .zip file as the request body.');
    return ctx.transfer.preview(body);
  });

  app.post('/api/import/preview-path', async (request) => {
    const { filePath } = z.object({ filePath: z.string().min(1).max(4096) }).parse(request.body);
    if (!path.isAbsolute(filePath) || !filePath.toLowerCase().endsWith('.zip')) throw badRequest('Choose a .zip export file.');
    const info = await stat(filePath).catch(() => null);
    if (!info?.isFile()) throw badRequest("That file doesn't exist.");
    return ctx.transfer.preview(await readFile(filePath));
  });

  app.post('/api/import/:id/apply', async (request) => {
    const { mode } = z.object({ mode: z.enum(['merge', 'replace']) }).parse(request.body);
    return ctx.transfer.apply(params(request).id, mode);
  });

  app.delete('/api/import/:id', async (request) => {
    await ctx.transfer.discard(params(request).id);
    return { ok: true };
  });
}
