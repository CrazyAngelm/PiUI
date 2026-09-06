#!/usr/bin/env python3
from __future__ import annotations
import argparse,json,os,platform,signal,subprocess,tempfile,uuid
from pathlib import Path
def main():
 p=argparse.ArgumentParser();p.add_argument("--package-root",type=Path,required=True);p.add_argument("--agent-dir",type=Path,required=True);p.add_argument("--report",type=Path,required=True);p.add_argument("--preserve-native-home",action="store_true");p.add_argument("--no-extensions",action="store_true");a=p.parse_args();package=a.package_root.resolve(strict=True);agent=a.agent_dir.resolve(strict=True)
 with tempfile.TemporaryDirectory(prefix="piui-prime-init-diagnostic-") as t:
  workspace=Path(t);(workspace/"sessions").mkdir();home=workspace/"home";home.mkdir();allowed=("PATH","PATHEXT","SYSTEMROOT","WINDIR","COMSPEC","TEMP","TMP","LANG");env={k:os.environ[k] for k in allowed if k in os.environ};
  if a.preserve_native_home:
   for k in ("HOME","USERPROFILE"):
    if k in os.environ: env[k]=os.environ[k]
   env.update({"APPDATA":str(home/"appdata"),"LOCALAPPDATA":str(home/"localappdata"),"XDG_CONFIG_HOME":str(home/".config")})
  else: env.update({"HOME":str(home),"USERPROFILE":str(home),"APPDATA":str(home/"appdata"),"LOCALAPPDATA":str(home/"localappdata"),"XDG_CONFIG_HOME":str(home/".config")})
  env.update({"PRIME_AGENT_TELEMETRY":"0","DO_NOT_TRACK":"1","PRIME_AGENT_INSTALL_UV":"0"})
  guard=(rf"\\.\pipe\piui-prime-sdk-{uuid.uuid4()}" if os.name=="nt" else f"/tmp/piui-prime-sdk-{uuid.uuid4()}.sock");flags=subprocess.CREATE_NEW_PROCESS_GROUP if os.name=="nt" else 0
  proc=subprocess.Popen(["node",str(Path(__file__).with_name("diagnose-init.mjs")),"--package-root",str(package),"--agent-dir",str(agent),"--workspace",str(workspace),"--daemon-socket",guard,"--no-extensions",str(a.no_extensions).lower()],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,env=env,creationflags=flags,start_new_session=os.name!="nt")
  timed_out=False
  try: stdout,_=proc.communicate(timeout=60)
  except subprocess.TimeoutExpired:
   timed_out=True
   if os.name=="nt": subprocess.run(["taskkill","/PID",str(proc.pid),"/T","/F"],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,timeout=15,check=False)
   else: os.killpg(proc.pid,signal.SIGKILL)
   stdout,_=proc.communicate(timeout=10)
  stages=[]
  for raw in stdout.split(b"\n"):
   if not raw.strip():continue
   record=json.loads(raw.decode("utf-8"))
   if set(record)!={"stage","elapsedMs","totalMs","status"}:raise ValueError("unsafe record")
   stages.append(record)
  report={"schemaVersion":1,"package":"prime-agent@0.9.2","platform":platform.system(),"exitCode":proc.returncode,"timedOut":timed_out,"timeoutSeconds":60,"safety":{"authStorage":"in-memory-empty","primeAuthStorageCredentialRead":False,"externalExtensionCredentialBehavior":"not-inspected","userSessionsRead":False,"providerCalls":False,"daemonContact":"none","environment":"allowlisted-sanitized","telemetryDisabled":True},"stages":stages}
  a.report.parent.mkdir(parents=True,exist_ok=True);a.report.write_text(json.dumps(report,indent=2)+"\n",encoding="utf-8");print(json.dumps({"exitCode":proc.returncode,"timedOut":timed_out,"stages":stages}));return 0 if proc.returncode==0 and not timed_out else 1
if __name__=="__main__":raise SystemExit(main())
