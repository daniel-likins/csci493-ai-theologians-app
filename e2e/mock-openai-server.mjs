// TEST DOUBLE — a tiny OpenAI-compatible endpoint used only by the UI tests to exercise streaming,
// tool calls, and stop. Every reply says it comes from a test double. It is never used by the app itself.
import http from 'node:http';

const port = Number(process.argv[2] ?? 47995);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((p) => p.text ?? '').join(' ');
  return '';
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
    return;
  }
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ data: [{ id: 'test-double', max_model_len: 32000 }] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404).end();
    return;
  }
  let raw = '';
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  const messages = body.messages ?? [];
  const last = messages.at(-1) ?? {};
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  const userText = textOf(lastUser?.content);
  const system = textOf(messages[0]?.content);
  const toolNames = (body.tools ?? []).map((t) => t.function?.name);

  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  let closed = false;
  req.on('close', () => (closed = true));
  const send = (obj) => {
    if (!closed) res.write(`data: ${JSON.stringify(obj)}\n\n`);
  };

  if (last.role !== 'tool' && toolNames.includes('propose_memory_update') && /decided|remember/i.test(userText)) {
    send({
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call_test_1',
                function: {
                  name: 'propose_memory_update',
                  arguments: JSON.stringify({
                    op: 'add',
                    category: 'current_focus',
                    certainty: 'confirmed',
                    text: 'Reading the Confessions this month',
                    importance: 'high',
                    reason: 'You stated this as a decision.',
                    evidence: userText.slice(0, 140),
                  }),
                },
              },
            ],
          },
        },
      ],
    });
    send({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 200, completion_tokens: 40 } });
    res.end('data: [DONE]\n\n');
    return;
  }

  let reply;
  if (system.includes('running summary')) reply = 'Summary written by the test double.';
  else if (last.role === 'tool') reply = "(Test double) I suggested saving that as your current focus. It's waiting for your approval under **Updates**.";
  else {
    reply = [
      '**Test double reply.** This text comes from a local test server used to check the interface — not from a real model.',
      '',
      `You wrote: “${userText.slice(0, 120)}”`,
      '',
      'A few things the interface should render:',
      '',
      '- a short list',
      '- with `inline code`',
      '',
      '```python',
      'passage = "grace and free will"',
      'print(passage)',
      '```',
    ].join('\n');
  }
  const slow = /slow/i.test(userText);
  const pieces = reply.match(/[\s\S]{1,8}/g) ?? [];
  const repeat = slow ? 30 : 1;
  for (let r = 0; r < repeat && !closed; r++) {
    for (const piece of pieces) {
      if (closed) break;
      send({ choices: [{ delta: { content: piece } }] });
      await sleep(slow ? 60 : 8);
    }
  }
  send({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 180, completion_tokens: 90 } });
  if (!closed) res.end('data: [DONE]\n\n');
});

server.listen(port, '127.0.0.1', () => console.log(`test double listening on http://127.0.0.1:${port}`));
