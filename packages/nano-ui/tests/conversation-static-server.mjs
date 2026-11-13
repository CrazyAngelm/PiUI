import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/tests/conversation-host.html', ['text/html', new URL('./conversation-host.html', import.meta.url)]],
  ['/dist-conversation/nano-conversation.js', ['text/javascript', new URL('../dist-conversation/nano-conversation.js', import.meta.url)]],
  ['/dist-conversation/nano-conversation.css', ['text/css', new URL('../dist-conversation/nano-conversation.css', import.meta.url)]],
]);
createServer(async (request, response) => {
  const file = files.get(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (!file || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': file[0], 'Cache-Control': 'no-store' }); response.end(await readFile(file[1])); }
  catch { response.writeHead(500); response.end(); }
}).listen(Number(process.argv[2]), '127.0.0.1');
