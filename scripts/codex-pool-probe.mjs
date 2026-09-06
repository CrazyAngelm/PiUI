import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { resolve, join } from 'node:path';
const count=Number(process.argv[2]);
if(!Number.isSafeInteger(count)||count<1)throw new Error('Supply the agent count');
const root=mkdtempSync(resolve('target/codex-pool-'));
process.env.CODEX_HOME=root;
let arrived=0,release;
const barrier=new Promise(resolve=>release=resolve);
const server=createServer(async(req,res)=>{
 let body='';for await(const chunk of req)body+=chunk;
 const payload=JSON.parse(body),marker=JSON.stringify(payload.input).match(/PIUI_POOL_\d+/)?.[0];
 arrived++;if(arrived===count)release();await barrier;
 const item={id:marker,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:marker,annotations:[]}]};
 res.writeHead(200,{'Content-Type':'text/event-stream'});
 for(const event of [{type:'response.output_item.done',output_index:0,item},{type:'response.completed',response:{id:marker,status:'completed',output:[item],usage:{input_tokens:1,output_tokens:1,total_tokens:2}}}])res.write(`data: ${JSON.stringify(event)}\n\n`);
 res.end();
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
writeFileSync(join(root,'config.toml'),`model = "probe-model"\nmodel_provider = "probe"\n[model_providers.probe]\nname = "Local test"\nbase_url = "http://127.0.0.1:${server.address().port}/v1"\nwire_api = "responses"\n`);
const source=['codex.mjs','codex-pool.mjs','runner.mjs'].map(f=>readFileSync(`crates/piui-runtime/bridge/${f}`,'utf8')).join('\n');
const {createCodexPool}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
const config={harness:'codex',cwd:root,sessionDir:root,permissionMode:'native',coordination:true,baseInstructions:'Return the supplied marker.',runtimeProgram:process.env.PIUI_CODEX_BINARY ?? join(process.env.APPDATA,'npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe'),runtimeArgs:[]};
const finished=new Map(),messages=new Map();
const pool=await createCodexPool(config,({sessionId,event})=>{
 if(event.type==='block'&&event.block.kind==='assistant')messages.set(sessionId,event.block.text);
 if(event.type==='turnCompleted')finished.get(sessionId)?.();
});
const started=performance.now();
try{
 await Promise.all(Array.from({length:count},(_,i)=>pool.openSession({sessionId:String(i),config})));
 const loadMs=performance.now()-started, completions=[];
 for(let i=0;i<count;i++){
  completions.push(new Promise(resolve=>finished.set(String(i),resolve)));
  await pool.sessionRequest({sessionId:String(i),method:'prompt',params:{text:`PIUI_POOL_${i}`,mode:'prompt'}});
 }
 await Promise.all(completions);
 const correct=Array.from({length:count},(_,i)=>messages.get(String(i))===`PIUI_POOL_${i}`).filter(Boolean).length;
 await pool.sessionRequest({sessionId:'0',method:'dispose',params:{}});
 if(count>1){const live=await pool.sessionRequest({sessionId:'1',method:'snapshot',params:{}});if(live.status!=='idle')throw new Error('Closing one agent affected another');}
 const report={agents:count,requests:arrived,correct,loadMs,totalMs:performance.now()-started,independentClose:true};
 writeFileSync(join(root,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({...report,evidence:join(root,'report.json')}));
 if(correct!==count)throw new Error('Thread isolation failed');
}finally{await pool.dispose();server.closeAllConnections();server.close();}
