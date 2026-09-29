import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

export const IdParams = z.object({ id: z.string().min(1).max(128) });

export function clientIdOf(request: FastifyRequest): string | undefined {
  const value = request.headers['x-theologians-client'];
  const id = Array.isArray(value) ? value[0] : value;
  return id && /^[\w-]{1,64}$/.test(id) ? id : undefined;
}

export function params(request: FastifyRequest): { id: string } {
  return IdParams.parse(request.params);
}
