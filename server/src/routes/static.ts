import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { AppContext } from '../context.ts';
import { CONTENT_SECURITY_POLICY } from '../security/http-guard.ts';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Serves the built web UI. index.html gets the per-boot session token and the saved theme. */
export function registerStatic(app: FastifyInstance, ctx: AppContext): void {
  const dist = path.resolve(ctx.config.webDistDir);

  const renderIndex = (): string | null => {
    const file = path.join(dist, 'index.html');
    if (!existsSync(file)) return null;
    let html = readFileSync(file, 'utf8').replace('__THEO_CSRF__', ctx.tokens.csrf);
    const theme = ctx.prefs.get<string>('ui.theme', 'system');
    if (theme === 'light' || theme === 'dark') html = html.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);
    return html;
  };

  app.get('/*', async (request, reply) => {
    const pathname = decodeURIComponent(request.url.split('?')[0] ?? '/');
    if (pathname.startsWith('/api/')) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'Unknown API endpoint.' } });
    }
    const file = path.resolve(dist, `.${path.posix.normalize(pathname)}`);
    if (file.startsWith(dist + path.sep) && path.basename(file) !== 'index.html' && existsSync(file) && statSync(file).isFile()) {
      reply.header('content-type', TYPES[path.extname(file)] ?? 'application/octet-stream');
      reply.header('cache-control', pathname.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
      return reply.send(createReadStream(file));
    }
    const html = renderIndex();
    reply.header('cache-control', 'no-store');
    if (!html) {
      return reply
        .code(503)
        .type('text/html; charset=utf-8')
        .send('<!doctype html><title>Theologians</title><p>The interface has not been built yet. Run <code>npm run build</code>, then reload.</p>');
    }
    reply.header('content-security-policy', CONTENT_SECURITY_POLICY);
    return reply.type('text/html; charset=utf-8').send(html);
  });
}
