import path from 'node:path';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppEventEnvelope, BootstrapDto, DraftDto } from '../../../shared/types.ts';
import { appInfo, type AppContext } from '../context.ts';
import { badRequest, forbidden } from '../lib/errors.ts';
import { nowIso } from '../lib/ids.ts';
import { SECURITY_HEADERS } from '../security/http-guard.ts';
import { runHelper } from '../system/lifecycle.ts';
import { clientIdOf } from './helpers.ts';

const PREFERENCE_KEY = /^(ui|nav|selection)\.[\w.:-]{1,100}$/;
const DRAFT_KEY = /^new\.(home|[\w-]{1,64})$/;

function osascriptString(text: string): string {
  return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function powershell(): string {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    : 'powershell.exe';
}

function encodedPowerShellString(text: string): string {
  return `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(text, 'utf8').toString('base64')}'))`;
}

async function openBrowser(url: string): Promise<boolean> {
  if (process.platform === 'darwin') return (await runHelper('/usr/bin/open', [url], 10_000)).code === 0;
  if (process.platform === 'win32') return (await runHelper('explorer.exe', [url], 10_000)).code === 0;
  return (await runHelper('xdg-open', [url], 10_000)).code === 0;
}

async function chooseFolder(prompt: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose folder with prompt ${osascriptString(prompt)})`;
    const result = await runHelper('/usr/bin/osascript', ['-e', script]);
    return result.code === 0 ? result.stdout.trim().replace(/\/$/, '') || null : null;
  }
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.FolderBrowserDialog;$d.Description=${encodedPowerShellString(prompt)};if($d.ShowDialog()-eq 'OK'){[Console]::Out.Write($d.SelectedPath)}`;
    const result = await runHelper(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  let result = await runHelper('zenity', ['--file-selection', '--directory', `--title=${prompt}`]);
  if (result.code === -1) result = await runHelper('kdialog', ['--getexistingdirectory', '.', '--title', prompt]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function chooseFile(prompt: string): Promise<string | null> {
  if (process.platform === 'darwin') {
    const script = `POSIX path of (choose file with prompt ${osascriptString(prompt)} of type {"zip", "public.zip-archive"})`;
    const result = await runHelper('/usr/bin/osascript', ['-e', script]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  if (process.platform === 'win32') {
    const script = `Add-Type -AssemblyName System.Windows.Forms;$d=New-Object System.Windows.Forms.OpenFileDialog;$d.Title=${encodedPowerShellString(prompt)};$d.Filter='ZIP archives (*.zip)|*.zip';if($d.ShowDialog()-eq 'OK'){[Console]::Out.Write($d.FileName)}`;
    const result = await runHelper(powershell(), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Sta', '-Command', script]);
    return result.code === 0 ? result.stdout.trim() || null : null;
  }
  let result = await runHelper('zenity', ['--file-selection', '--file-filter=ZIP archives | *.zip', `--title=${prompt}`]);
  if (result.code === -1) result = await runHelper('kdialog', ['--getopenfilename', '.', '*.zip', '--title', prompt]);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function revealInFileManager(target: string): Promise<boolean> {
  if (process.platform === 'darwin') return (await runHelper('/usr/bin/open', ['-R', target], 10_000)).code === 0;
  if (process.platform === 'win32') return (await runHelper('explorer.exe', [`/select,${target}`], 10_000)).code === 0;
  const isDirectory = (await stat(target).catch(() => null))?.isDirectory() ?? false;
  return (await runHelper('xdg-open', [isDirectory ? target : path.dirname(target)], 10_000)).code === 0;
}

export function registerCoreRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get('/api/health', async () => ({ ok: true, app: 'theologians', version: ctx.config.version, bootId: ctx.bootId }));

  app.get('/api/session', async () => ({ csrfToken: ctx.tokens.csrf }));

  app.get('/api/bootstrap', async (): Promise<BootstrapDto> => ({
    app: appInfo(ctx),
    sections: ctx.workspaces.listSections(),
    workspaces: ctx.workspaces.list(),
    preferences: ctx.prefs.getAll(),
  }));

  // Live updates for every open view. Also how the service knows a view is open (idle shutdown).
  app.get('/api/events', (request, reply) => {
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store, no-transform',
      connection: 'keep-alive',
      ...SECURITY_HEADERS,
    });
    const send = (event: AppEventEnvelope): void => {
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'hello', bootId: ctx.bootId });
    const unsubscribe = ctx.bus.subscribe(send);
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    ctx.sseClients.add(res);
    ctx.lifecycle.viewOpened();
    request.raw.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      ctx.sseClients.delete(res);
      ctx.lifecycle.viewClosed();
    });
  });

  app.put('/api/preferences/:key', async (request) => {
    const { key } = z.object({ key: z.string() }).parse(request.params);
    if (!PREFERENCE_KEY.test(key)) throw badRequest('Unknown preference.');
    const { value } = z.object({ value: z.unknown() }).parse(request.body);
    if (JSON.stringify(value ?? null).length > 64_000) throw badRequest('Preference value is too large.');
    ctx.prefs.set(key, value ?? null, clientIdOf(request));
    return { ok: true };
  });

  app.get('/api/drafts/:key', async (request): Promise<DraftDto> => {
    const { key } = z.object({ key: z.string().regex(DRAFT_KEY) }).parse(request.params);
    return ctx.prefs.get<DraftDto>(`draft.${key}`, { text: '', attachmentIds: [], updatedAt: null });
  });

  app.put('/api/drafts/:key', async (request): Promise<DraftDto> => {
    const { key } = z.object({ key: z.string().regex(DRAFT_KEY) }).parse(request.params);
    const body = z.object({ text: z.string().max(200_000), attachmentIds: z.array(z.string().max(128)).max(20) }).parse(request.body);
    const draft: DraftDto = { text: body.text, attachmentIds: body.attachmentIds, updatedAt: nowIso() };
    ctx.prefs.set(`draft.${key}`, draft, undefined, false);
    ctx.bus.publish({ type: 'draft.updated', key, conversationId: null, draft: draft.text, attachmentIds: draft.attachmentIds, updatedAt: draft.updatedAt! }, clientIdOf(request));
    return draft;
  });

  app.get('/api/system/info', async () => ({ ...appInfo(ctx), openViews: ctx.lifecycle.openViews, backupDirectory: ctx.backups.directory() }));

  app.post('/api/system/open-browser', async () => {
    const url = `http://127.0.0.1:${ctx.config.port}/`;
    return { ok: await openBrowser(url), url };
  });

  app.post('/api/system/choose-folder', async (request) => {
    const { prompt } = z.object({ prompt: z.string().max(200).optional() }).parse(request.body ?? {});
    return { path: await chooseFolder(prompt ?? 'Choose a folder') };
  });

  app.post('/api/system/choose-file', async (request) => {
    const { prompt } = z.object({ prompt: z.string().max(200).optional() }).parse(request.body ?? {});
    return { path: await chooseFile(prompt ?? 'Choose a Theologians export') };
  });

  app.post('/api/system/reveal', async (request) => {
    const { target } = z.object({ target: z.string().min(1).max(4096) }).parse(request.body);
    const resolved = path.resolve(target);
    const allowed = [ctx.config.dataDir, ctx.backups.directory()].some((root) => resolved === root || resolved.startsWith(root + path.sep));
    if (!allowed) throw forbidden('Only Theologians data, backup, and export locations can be revealed.');
    return { ok: await revealInFileManager(resolved) };
  });

  app.post('/api/system/shutdown', async () => {
    setTimeout(() => ctx.requestShutdown('requested'), 150);
    return { ok: true };
  });

  app.get('/api/weather', async () => ctx.weather.current());
  app.get('/api/weather/settings', async () => ctx.weather.settings());
  app.patch('/api/weather/settings', async (request) => {
    const body = z
      .object({
        enabled: z.boolean().optional(),
        locationName: z.string().max(120).nullable().optional(),
        latitude: z.number().nullable().optional(),
        longitude: z.number().nullable().optional(),
        units: z.enum(['celsius', 'fahrenheit']).optional(),
      })
      .parse(request.body);
    return ctx.weather.update(body);
  });
  app.get('/api/weather/geocode', async (request) => {
    const { q } = z.object({ q: z.string().max(100) }).parse(request.query);
    return ctx.weather.geocode(q);
  });

  app.get('/api/usage', async () => ctx.usage.summary(30));
}
