import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Tests consume exactly the published bytes. No Vite transforms or environment shim.
const files = new Map([
  ['/tests/host.html', ['text/html', new URL('./host.html', import.meta.url)]],
  ['/dist/nano-graph.js', ['text/javascript', new URL('../dist/nano-graph.js', import.meta.url)]],
  ['/dist/nano-graph.css', ['text/css', new URL('../dist/nano-graph.css', import.meta.url)]],
]);
createServer(async (request, response) => {
  const entry = files.get(new URL(request.url ?? '/', 'http://localhost').pathname);
  if (!entry || request.method !== 'GET') { response.writeHead(404); response.end(); return; }
  try { response.writeHead(200, { 'Content-Type': entry[0], 'Cache-Control': 'no-store' }); response.end(await readFile(entry[1])); }
  catch { response.writeHead(500); response.end(); }
}).listen(Number(process.argv[2]), '127.0.0.1');
