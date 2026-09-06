#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
const values={}; for(let i=2;i<process.argv.length;i+=2) values[process.argv[i]?.slice(2)]=process.argv[i+1];
if(!["package-root","agent-dir","workspace","daemon-socket"].every(k=>typeof values[k]==="string")||!values["daemon-socket"].includes("piui-prime-sdk-"))process.exit(2);
const packageRoot=realpathSync(resolve(values["package-root"])),agentDir=realpathSync(resolve(values["agent-dir"])),workspace=realpathSync(resolve(values.workspace));
if(![packageRoot,agentDir,workspace].every(isAbsolute))process.exit(2);
const started=performance.now(); const emit=(stage,elapsedMs,status="pass")=>process.stdout.write(`${JSON.stringify({stage,elapsedMs:Math.round(elapsedMs*1000)/1000,totalMs:Math.round((performance.now()-started)*1000)/1000,status})}\n`);
const timed=async(stage,op)=>{const before=performance.now();try{const result=await op();emit(stage,performance.now()-before);return result}catch{emit(stage,performance.now()-before,"fail");throw new Error(stage)}};
let connection;
try{
 const manifest=await timed("manifest",async()=>JSON.parse(await readFile(join(packageRoot,"package.json"),"utf8"))); if(manifest.name!=="prime-agent"||manifest.version!=="0.9.2")throw new Error("identity");
 const sdk=await timed("sdk_import",()=>import(pathToFileURL(join(packageRoot,"dist","index.js")).href));
 const authStorage=sdk.AuthStorage.inMemory({},{usePrimeCliConfig:false});
 const sessionManager=sdk.SessionManager.create(workspace,join(workspace,"sessions")); let build=0;
 const createRuntime=async({cwd,sessionManager:manager,sessionStartEvent})=>{build++;
  const settingsManager=await timed(`settings_native_${build}`,async()=>sdk.SettingsManager.create(cwd,agentDir));
  const modelRegistry=await timed(`model_metadata_native_${build}`,async()=>sdk.ModelRegistry.create(authStorage,join(agentDir,"models.json")));
  const services=await timed(`resources_native_${build}`,()=>sdk.createAgentSessionServices({cwd,agentDir,authStorage,settingsManager,modelRegistry,telemetryDisabled:true,resourceLoaderOptions:{noExtensions:values["no-extensions"]==="true"}}));
  const created=await timed(`session_create_${build}`,()=>sdk.createAgentSessionFromServices({services,sessionManager:manager,sessionStartEvent,noTools:"all",includeGoals:false,prewarmIpythonKernel:false,telemetryDisabled:true,executionMode:"sdk"}));
  return {...created,services,diagnostics:services.diagnostics};};
 const runtime=await timed("runtime_create",()=>sdk.createAgentSessionRuntime(createRuntime,{cwd:workspace,agentDir,sessionManager})); connection=new sdk.InProcessAgentConnection(runtime);
 await timed("extensions_bind",()=>connection.bindHeadlessExtensions()); await timed("state_snapshot",()=>connection.getState()); await timed("model_catalog_no_credentials",()=>connection.getAvailableModels()); await timed("dispose",()=>connection.dispose()); connection=undefined; emit("complete",0);
}catch{if(connection)await connection.dispose().catch(()=>undefined);process.exitCode=1;}
