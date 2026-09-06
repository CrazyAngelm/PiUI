#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.includes("--grandchild")) {
  setInterval(() => {}, 1000);
} else {
  const index = args.indexOf("--pid-file");
  if (index < 0 || !args[index + 1]) process.exit(2);
  const grandchild = spawn(process.execPath, [fileURLToPath(import.meta.url), "--grandchild"], {
    stdio: "ignore",
    windowsHide: true,
  });
  writeFileSync(args[index + 1], JSON.stringify({ parent: process.pid, grandchild: grandchild.pid }), "utf8");
  setInterval(() => {}, 1000);
}
