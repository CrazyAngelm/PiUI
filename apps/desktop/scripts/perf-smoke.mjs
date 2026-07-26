import { readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

const assets = resolve(import.meta.dirname, '..', 'dist', 'assets');
const files = await readdir(assets);
let bytes = 0;
for (const file of files) {
  bytes += (await stat(resolve(assets, file))).size;
}

const budget = 200 * 1024;
if (bytes > budget) {
  throw new Error(`Frontend asset smoke budget exceeded: ${bytes} bytes > ${budget} bytes.`);
}
console.log(`PiUI frontend asset smoke: ${bytes} bytes (budget ${budget}).`);
