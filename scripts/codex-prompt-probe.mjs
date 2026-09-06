import { createServer } from 'node:http';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { createCodexAdapter } from '../crates/piui-runtime/bridge/codex.mjs';
const root = resolve('target/video-research/prompt-probe');
mkdirSync(root, {recursive:true});
process.env.CODEX_HOME = root;
let resolveRequest;
const received = new Promise(resolve => { resolveRequest = resolve; });
const server = createServer(async (req,res) => {
 let body=''; for await (const chunk of req) body+=chunk;
 const payload=JSON.parse(body);
 resolveRequest(payload);
 res.writeHead(200, {'Content-Type':'text/event-stream'});
 res.end('data: '+JSON.stringify({type:'response.completed', response:{id:'probe-response',status:'completed',output:[],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}})+'\n\n');
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
writeFileSync(join(root,'config.toml'), `model = "probe-model"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local synthetic provider"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`);
const skillSetting = process.argv.includes('--skill-enabled') ? true : process.argv.includes('--skill-disabled') ? false : undefined;
const skillPath = join(root, 'skills', 'piui-probe', 'SKILL.md');
if (skillSetting !== undefined) { mkdirSync(join(root, 'skills', 'piui-probe'), {recursive:true}); writeFileSync(skillPath, '---\nname: piui-probe\ndescription: PIUI_SYNTHETIC_SKILL_MARKER\n---\nSynthetic skill.'); }
const verifySettings = process.argv.includes('--settings');
const baseText = process.argv.includes('--empty') ? '' : 'PIUI_SYNTHETIC_BASE_ONLY';
let adapter;
try {
 adapter=await createCodexAdapter({harness:'codex',cwd:root,sessionDir:root,permissionMode:'native',...(verifySettings ? { thinkingLevel:'low', serviceTier:'standard' } : {}),...(skillSetting !== undefined ? { resourceRules:[{kind:'skill',id:skillPath,enabled:skillSetting}] } : {}),baseInstructions:baseText,runtimeProgram:process.execPath,runtimeArgs:[join(process.env.APPDATA,'npm/node_modules/@openai/codex/bin/codex.js')]},()=>{});
 await adapter.prompt({text:'Synthetic local request. No tools.',mode:'prompt'});
 const payload=await received;
 const skillVisible = JSON.stringify(payload.input).includes('PIUI_SYNTHETIC_SKILL_MARKER');
 const report={...(skillSetting !== undefined ? {skillEnabled:skillSetting,skillVisible} : {}),...(verifySettings ? {reasoning:payload.reasoning?.effort,serviceTier:payload.service_tier ?? 'default'} : {}),baseReplaced:(payload.instructions ?? '')===baseText, instructionsCharacters:(payload.instructions ?? '').length,inputRoles:payload.input?.map(x=>x.role??x.type),toolNames:payload.tools?.map(x=>x.name??x.type)};
 writeFileSync(join(root,'report.json'), JSON.stringify(report,null,2));
 console.log(JSON.stringify(report));
 if (skillSetting !== undefined && skillVisible !== skillSetting) throw new Error('Native skill setting did not affect skill visibility');
 if (verifySettings && (report.reasoning !== 'low' || report.serviceTier !== 'default')) throw new Error('Native settings did not reach provider');
 if (!report.baseReplaced) throw new Error('Codex did not replace the base instructions');
} finally { if(adapter)await adapter.dispose();server.closeAllConnections();server.close(); }
