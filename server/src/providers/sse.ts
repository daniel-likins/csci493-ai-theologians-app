import { ProviderError } from './errors.ts';

export interface SseMessage {
  event: string | null;
  data: string;
}

function parseBlock(block: string): SseMessage | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  if (data.length === 0) return null;
  return { event, data: data.join('\n') };
}

/**
 * Parse a Server-Sent Events body. Aborts with a timeout if the provider goes silent for too long,
 * and always releases the connection when the consumer stops early (e.g. the user presses Stop).
 */
export async function* readSse(
  body: ReadableStream<Uint8Array> | null,
  options: { signal: AbortSignal; idleTimeoutMs?: number; providerName: string },
): AsyncGenerator<SseMessage> {
  if (!body) throw new ProviderError('bad_response', `${options.providerName} returned an empty response.`);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const idleMs = options.idleTimeoutMs ?? 180_000;
  let buffer = '';
  let pendingCr = false;

  type ReadResult = { done: true; value?: undefined } | { done: false; value: Uint8Array };
  const readChunk = (): Promise<ReadResult> =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ProviderError('timeout', `${options.providerName} stopped sending data.`));
      }, idleMs);
      reader.read().then(
        (result) => {
          clearTimeout(timer);
          resolve(result as ReadResult);
        },
        (err: unknown) => {
          clearTimeout(timer);
          if (options.signal.aborted) reject(new ProviderError('cancelled', 'Stopped.'));
          else reject(new ProviderError('network', `The connection to ${options.providerName} was interrupted.`));
          void err;
        },
      );
    });

  const append = (text: string): void => {
    let chunk = (pendingCr ? '\r' : '') + text;
    pendingCr = chunk.endsWith('\r');
    if (pendingCr) chunk = chunk.slice(0, -1);
    buffer += chunk.replace(/\r\n?/g, '\n');
  };

  try {
    for (;;) {
      if (options.signal.aborted) throw new ProviderError('cancelled', 'Stopped.');
      const { done, value } = await readChunk();
      if (done) break;
      append(decoder.decode(value, { stream: true }));
      let sep: number;
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 2);
        const message = parseBlock(block);
        if (message) yield message;
      }
    }
    append(decoder.decode());
    if (pendingCr) buffer += '\n';
    const tail = parseBlock(buffer);
    if (tail) yield tail;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
