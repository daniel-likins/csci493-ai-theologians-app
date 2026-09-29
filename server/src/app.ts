import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { AppContext } from './context.ts';
import { AppError } from './lib/errors.ts';
import { ProviderError } from './providers/errors.ts';
import { registerConversationRoutes } from './routes/conversations.ts';
import { registerCoreRoutes } from './routes/core.ts';
import { registerDataRoutes } from './routes/data.ts';
import { registerMemoryRoutes } from './routes/memory.ts';
import { registerSettingsRoutes } from './routes/settings.ts';
import { registerStatic } from './routes/static.ts';
import { createGuard, SECURITY_HEADERS } from './security/http-guard.ts';

export async function buildApp(ctx: AppContext): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024, forceCloseConnections: true });
  const guard = createGuard({ port: ctx.config.port, extraAllowedOrigins: ctx.config.extraAllowedOrigins }, ctx.tokens);

  app.addContentTypeParser(['application/octet-stream', 'application/zip'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 * 1024 }, (_request, body, done) => {
    done(null, body);
  });

  app.addHook('onRequest', async (request, reply) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) reply.header(name, value);
    if (request.url.startsWith('/api/')) reply.header('cache-control', 'no-store');
    const decision = guard({ method: request.method, url: request.url, headers: request.headers });
    if (!decision.ok) {
      ctx.log(`blocked ${request.method} ${request.url.split('?')[0]}: ${decision.code}`);
      return reply.code(decision.status).send({ error: { code: decision.code, message: decision.message } });
    }
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      return reply.code(error.status).send({ error: { code: error.code, message: error.message, details: error.details } });
    }
    if (error instanceof ProviderError) {
      return reply.code(502).send({ error: { code: error.kind, message: error.message } });
    }
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: 'invalid_request',
          message: 'The request was invalid.',
          details: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        },
      });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode && statusCode >= 400 && statusCode < 500) {
      return reply
        .code(statusCode)
        .send({ error: { code: (error as { code?: string }).code ?? 'bad_request', message: (error as Error).message } });
    }
    ctx.log(`error ${request.method} ${request.url.split('?')[0]}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    return reply.code(500).send({ error: { code: 'internal', message: 'Something went wrong inside Theologians. Your saved data is safe; please try again.' } });
  });

  app.setNotFoundHandler((request, reply) =>
    reply.code(404).send({ error: { code: 'not_found', message: `No such endpoint: ${request.method} ${request.url.split('?')[0]}` } }),
  );

  registerCoreRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerMemoryRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);
  registerDataRoutes(app, ctx);
  registerStatic(app, ctx);
  return app;
}
