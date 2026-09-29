// Test doubles for provider HTTP APIs. Used only by automated tests — never by the app.

export function sse(events: unknown[], options: { delayMs?: number; signal?: AbortSignal | null; hang?: boolean } = {}): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const abort = (): void => {
        try {
          controller.error(new DOMException('The operation was aborted.', 'AbortError'));
        } catch {
          // already closed
        }
      };
      options.signal?.addEventListener('abort', abort, { once: true });
      for (const event of events) {
        if (options.signal?.aborted) return;
        controller.enqueue(encoder.encode(typeof event === 'string' ? event : `data: ${JSON.stringify(event)}\n\n`));
        if (options.delayMs) await new Promise((r) => setTimeout(r, options.delayMs));
      }
      if (options.hang || options.signal?.aborted) return;
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export interface Turn {
  text?: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  status?: number;
  errorBody?: string;
  delayMs?: number;
  hang?: boolean;
}

/**
 * Scripted OpenAI-compatible Chat Completions endpoint. `route` can answer specific requests
 * (e.g. summaries) before the scripted turns are consumed.
 */
export function scriptedChat(turns: Turn[], route?: (body: any) => Turn | undefined) {
  let index = 0;
  const bodies: any[] = [];
  const handler: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/models')) return Response.json({ data: [{ id: 'mock-model' }, { id: 'other-model' }] });
    const body = JSON.parse(String(init?.body ?? '{}'));
    bodies.push(body);
    let turn = route?.(body);
    if (!turn) {
      turn = turns[Math.min(index, turns.length - 1)]!;
      index++;
    }
    if (turn.status && turn.status >= 400) {
      return new Response(turn.errorBody ?? JSON.stringify({ error: { message: 'mock failure' } }), { status: turn.status });
    }
    const events: unknown[] = [];
    for (const piece of (turn.text ?? '').match(/[\s\S]{1,12}/g) ?? []) events.push({ choices: [{ delta: { content: piece } }] });
    (turn.toolCalls ?? []).forEach((call, i) =>
      events.push({
        choices: [{ delta: { tool_calls: [{ index: i, id: `call_${index}_${i}`, function: { name: call.name, arguments: JSON.stringify(call.arguments) } }] } }],
      }),
    );
    events.push({ choices: [{ delta: {}, finish_reason: turn.toolCalls?.length ? 'tool_calls' : 'stop' }] });
    events.push({ choices: [], usage: { prompt_tokens: 120, completion_tokens: 30 } });
    events.push('data: [DONE]\n\n');
    return sse(events, { delayMs: turn.delayMs, signal: init?.signal, hang: turn.hang });
  };
  return {
    handler,
    bodies,
    get turnsUsed() {
      return index;
    },
  };
}
