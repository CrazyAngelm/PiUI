import { mkdtempSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createPrimeAdapter } from '../crates/piui-runtime/bridge/prime.mjs';
const socketIndex = process.argv.indexOf('--daemon-socket');
const daemonSocket = socketIndex >= 2 ? process.argv[socketIndex + 1] : undefined;
if (!daemonSocket?.includes('piui') || daemonSocket.startsWith('--')) throw new Error('Supply an explicit non-default --daemon-socket');
const root = mkdtempSync(resolve('target/prime-lifecycle-'));
for (const name of ['project','sessions','agent']) mkdirSync(join(root,name));
const config = {harness:'prime-agent',cwd:join(root,'project'),sessionDir:join(root,'sessions'),agentDir:join(root,'agent'),packageRoot:join(process.env.APPDATA,'npm/node_modules/prime-agent'),permissionMode:'native',daemonSocket,allowedTools:[],nativeSubagents:false};
const adapter = await createPrimeAdapter(config,()=>{});
try { const state = await adapter.snapshot(); console.log(JSON.stringify({status:state.status,toolPolicy:state.capabilities.toolPolicy,nativeSubagents:state.capabilities.nativeSubagents})); }
finally {await adapter.dispose();}
