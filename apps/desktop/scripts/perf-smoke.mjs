import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = resolve(import.meta.dirname, '..', 'dist', 'assets');
const files = await readdir(assets);
let bytes = 0;
for (const file of files) {
  bytes += (await stat(resolve(assets, file))).size;
}

// Protocol v9 surfaces plus the accessible themed model picker consume a
// measured ~38 KiB raw asset delta; retain about 6 KiB of headroom.
const budget = 244 * 1024;
if (bytes > budget) {
  throw new Error(`Frontend asset smoke budget exceeded: ${bytes} bytes > ${budget} bytes.`);
}
console.log(`PiUI frontend asset smoke: ${bytes} bytes (budget ${budget}).`);
