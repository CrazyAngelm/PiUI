// Isolated synthetic Responses service. The first request remains open until
// the native WebView has edited/promoted its queued messages.
import { createServer } from 'node:http';
export async function startComposerProvider() {
  const requests = [];
  let release;
  let hold = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    if (!request.url.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
    const payload = JSON.parse(body);
    requests.push(payload);
    const finish = () => {
      if (response.destroyed) return;
      const id = `synthetic-${requests.length}`;
      const text = 'PIUI_COMPOSER_RESULT';
      const item = { id: `msg-${id}`, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const event of [
        { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
        { type: 'response.content_part.added', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: item.id, output_index: 0, content_index: 0, delta: text },
        { type: 'response.output_text.done', item_id: item.id, output_index: 0, content_index: 0, text },
        { type: 'response.output_item.done', output_index: 0, item },
        { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
      ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      response.end();
    };
    if (hold) { hold = false; release = finish; } else finish();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, requests,
    holdNext() { hold = true; release = undefined; },
    release() { if (!release) throw new Error('Synthetic request has not arrived'); release(); release = undefined; },
    ready() { return Boolean(release); },
    close() { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)); },
  };
}
