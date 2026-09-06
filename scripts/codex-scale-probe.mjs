// Synthetic local provider: no credentials, paid requests, or user projects.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
const count = Number(process.argv[2]);
if (!Number.isSafeInteger(count) || count < 1) throw new Error('Supply the number of agents to measure');
const root = mkdtempSync(resolve('target/codex-scale-'));
let requests = 0;
let releaseRequests;
const allRequestsArrived = new Promise(resolve => { releaseRequests = resolve; });
const server = createServer(async (req, res) => {
 let body = ''; for await (const chunk of req) body += chunk;
 const input = JSON.parse(body); requests++;
 if (requests === count) releaseRequests();
 await allRequestsArrived;
 const marker = JSON.stringify(input.input).match(/PIUI_SCALE_\d+/)?.[0] ?? 'missing-marker';
 const item = {id:`message-${requests}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:marker,annotations:[]}]};
 res.writeHead(200, {'Content-Type':'text/event-stream'});
 for (const event of [{type:'response.output_item.done',output_index:0,item}, {type:'response.completed',response:{id:`response-${requests}`,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}]) res.write(`data: ${JSON.stringify(event)}\n\n`);
 res.end();
});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
writeFileSync(join(root,'config.toml'),`model = "probe-model"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local synthetic provider"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`);
const binary = process.env.PIUI_CODEX_BINARY ?? join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe');
const child = spawn(binary,['app-server','--stdio','--disable','multi_agent','--disable','multi_agent_v2','--disable','apps','--disable','plugins','--disable','shell_snapshot','-c','analytics.enabled=false'],{cwd:root,env:{...process.env,CODEX_HOME:root},windowsHide:true,stdio:['pipe','pipe','pipe']});
const pending = new Map(), done = new Map(), results = new Map();
let serial = 0, buffer = '', fatal;
const exited = new Promise(resolve => child.once('close',resolve));
child.stderr.on('data',()=>{});
child.stdout.on('data',chunk=>{
 buffer += chunk.toString('utf8'); let n;
 while((n=buffer.indexOf('\n'))>=0){
  const line=buffer.slice(0,n);buffer=buffer.slice(n+1);if(!line.trim())continue;
  const msg=JSON.parse(line);
  if(msg.id!==undefined && pending.has(msg.id)){const p=pending.get(msg.id);pending.delete(msg.id);msg.error?p.reject(new Error(`${p.method}: ${JSON.stringify(msg.error)}`)):p.resolve(msg.result);}
  else if(msg.method==='item/completed' && msg.params.item?.type==='agentMessage')results.set(msg.params.threadId,msg.params.item.text);
  else if(msg.method==='turn/completed'){if(msg.params.turn.status!=='completed')fatal='turn-failed';done.get(msg.params.threadId)?.();}
  else if(msg.id!==undefined)child.stdin.write(JSON.stringify({id:msg.id,error:{code:-32601,message:'Synthetic probe has no interactive tools'}})+'\n');
 }
});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=++serial;pending.set(id,{resolve,reject,method});child.stdin.write(JSON.stringify({id,method,params})+'\n');});
const rss=()=>process.platform==='win32'?Number(execFileSync('powershell',['-NoProfile','-Command',`(Get-Process -Id ${child.pid}).WorkingSet64`],{windowsHide:true,encoding:'utf8'}).trim()):null;
try {
 const init=await call('initialize',{clientInfo:{name:'piui_scale_probe',version:'0.1.1'},capabilities:{experimentalApi:true}});
 child.stdin.write('{"method":"initialized"}\n');
 const baselineRss=rss(), started=performance.now();
 const threads=[];
 for(let i=0;i<count;i++) threads.push(await call('thread/start',{baseInstructions:'Return the supplied synthetic marker.',developerInstructions:'',ephemeral:true}));
 const startMs=performance.now()-started, loadedRss=rss(), turnsStart=performance.now();
 const completions=[];
 for (const [i,{thread}] of threads.entries()) {
  const finished=new Promise(resolve=>done.set(thread.id,resolve));
  await call('turn/start',{threadId:thread.id,input:[{type:'text',text:`PIUI_SCALE_${i}`,text_elements:[]}]});
  completions.push(finished);
 }
 await Promise.all(completions);
 const report={nativeVersion:init.userAgent,agents:count,nativeProcesses:1,baselineRss,loadedRss,afterTurnsRss:rss(),startMs,turnsMs:performance.now()-turnsStart,requests,correctResults:threads.filter(({thread},i)=>results.get(thread.id)===`PIUI_SCALE_${i}`).length,fatal};
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence:join(root,'report.json')}));
 if(fatal || report.correctResults!==count)throw new Error('Synthetic result isolation failed');
} finally {child.stdin.end();await exited;server.closeAllConnections();server.close();}
