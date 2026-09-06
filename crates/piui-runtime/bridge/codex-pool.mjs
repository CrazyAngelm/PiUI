// One native Rust app-server per managed workspace. Each adapter retains its
// own thread, approvals and coordinator identity. This is transport multiplexing,
// not another model/tool loop.
export async function createCodexPool(config, emit) {
  const { spawn } = await import('node:child_process');
  const { EventEmitter } = await import('node:events');
  const { PassThrough } = await import('node:stream');
  const clients = new Map(), threads = new Map(), sessions = new Map();
  const queue = [];
  let native, active, serial = 0, initResult, buffer = Buffer.alloc(0), stopped = false, retiring = false, opening = 0;
  const openingModels = new Map();
  const fail = () => Object.assign(new Error('Codex pool closed'), {bridgeCode:'native-closed',safeMessage:'The shared Codex runtime stopped.'});
  const write = value => native.stdin.write(JSON.stringify(value)+'\n');
  function drain() {
    if (active || !queue.length || stopped) return;
    active = queue.shift();
    const modelKey = JSON.stringify(active.message.params);
    if (active.message.method === 'model/list' && openingModels.has(modelKey)) {
      const current = active; active = undefined;
      current.client.stdout.write(JSON.stringify({id:current.originalId,result:openingModels.get(modelKey)})+'\n');
      drain(); return;
    }
    if (active.message.method === 'initialize' && initResult) {
      const current = active; active = undefined;
      current.client.stdout.write(JSON.stringify({id:current.originalId,result:initResult})+'\n');
      drain(); return;
    }
    write(active.message);
  }
  function route(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw fail();
    const hasResult = 'result' in message, hasError = 'error' in message;
    const response = message.method === undefined && message.id !== undefined && hasResult !== hasError;
    if (!response && !(typeof message.method === 'string' && !hasResult && !hasError)) throw fail();
    if (active && message.id === active.message.id && !message.method) {
      const current = active; active = undefined;
      if (current.message.method === 'initialize' && message.result) initResult = message.result;
      if (opening && current.message.method === 'model/list' && message.result) openingModels.set(JSON.stringify(current.message.params),message.result);
      if (message.result?.thread?.id) { current.client.threadId = message.result.thread.id; threads.set(current.client.threadId,current.client); }
      if (current.complete) current.complete(message);
      else current.client.stdout.write(JSON.stringify({...message,id:current.originalId})+'\n');
      drain(); return;
    }
    const threadId = message.params?.threadId ?? message.params?.conversationId ?? message.params?.thread?.id;
    let owner = threadId ? threads.get(threadId) : undefined;
    if (!owner && message.method === 'thread/started' && active?.message.method === 'thread/start') {
      owner = active.client; owner.threadId = threadId; threads.set(threadId,owner);
    }
    if (owner) {
      if (message.method === 'turn/started') owner.turnId = message.params.turn.id;
      owner.stdout.write(JSON.stringify(message)+'\n');
      if (message.method === 'turn/completed') { owner.turnId = undefined; owner.emit('turnFinished'); }
    } else if (message.id !== undefined && message.method) {
      write({id:message.id,error:{code:-32601,message:'No owning PiUI session'}});
    }
  }
  function closeAll() {
    if (stopped) return; stopped = true;
    for (const client of clients.values()) client.emit('close');
    clients.clear(); threads.clear(); queue.length = 0;
    // The host retires the failed transport so a subsequent launch can create
    // a fresh pool even while failed sessions remain visible in the catalog.
    if (!retiring) emit({type:'error',message:'The shared Codex runtime stopped.'});
  }
  function openChild(program,args,options) {
    if (stopped) throw fail();
    if (!native) {
      native=spawn(program,args,options);
      native.stderr.on('data',()=>{});
      native.on('error',closeAll); native.on('close',closeAll);
      native.stdout.on('data',chunk=>{
        buffer=Buffer.concat([buffer,chunk]); let n;
        while((n=buffer.indexOf(10))>=0) {
          const frame=buffer.subarray(0,n);buffer=buffer.subarray(n+1);
          // Same maximum native frame size as the standalone Codex adapter.
          if(frame.length>32*1024*1024){native.kill();closeAll();return;}
          if(!frame.length)continue;
          try{route(JSON.parse(frame.toString('utf8')));}catch{native.kill();closeAll();return;}
        }
        if(buffer.length>32*1024*1024){native.kill();closeAll();}
      });
    }
    const client = new EventEmitter();
    client.stdout = new PassThrough(); client.stderr = new PassThrough();
    const id = ++serial; clients.set(id,client);
    const stdin = new EventEmitter(); stdin.writable = true;
    stdin.write = (frame, callback) => {
      try {
        const message = JSON.parse(frame);
        if (!message.method) write(message);
        else if (message.method === 'initialized') { if (!native.initialized) { native.initialized = true; write(message); } }
        else { queue.push({client,originalId:message.id,message:{...message,id:`pool-${id}-${message.id}`}}); drain(); }
        callback?.(); return true;
      } catch(error) {callback?.(error); return false;}
    };
    stdin.end = () => {
      if (!stdin.writable) return;
      stdin.writable = false;
      const finish = () => {
        clients.delete(id); threads.delete(client.threadId);
        client.emit('close'); client.stdout.end(); client.stderr.end();
      };
      const unsubscribe = () => {
        if (!client.threadId) { finish(); return; }
        queue.push({client,message:{id:`unsubscribe-${id}`,method:'thread/unsubscribe',params:{threadId:client.threadId}},complete(response) {
          if (!['unsubscribed','notLoaded','notSubscribed'].includes(response.result?.status)) { native.kill(); closeAll(); }
          else finish();
        }}); drain();
      };
      if (client.turnId) {
        client.once('turnFinished',unsubscribe);
        queue.push({client,originalId:'pool-retire',message:{id:`retire-${id}`,method:'turn/interrupt',params:{threadId:client.threadId,turnId:client.turnId}}});drain();
      } else unsubscribe();
    };
    stdin.destroy = () => {stdin.writable=false;};
    client.stdin = stdin;
    client.kill = () => { native.kill(); closeAll(); };
    return client;
  }
  return {
    async openSession({sessionId,config:sessionConfig}) {
      if (sessions.has(sessionId)) throw fail();
      if (sessionConfig.cwd !== config.cwd || sessionConfig.harness !== 'codex' || sessionConfig.coordination !== true) throw fail();
      if (sessionConfig.runtimeProgram !== config.runtimeProgram || JSON.stringify(sessionConfig.runtimeArgs) !== JSON.stringify(config.runtimeArgs)) throw fail();
      const input = new PassThrough(); const waiting = new Map(); let requestId=0;
      const output = {write(frame) {
        const value=JSON.parse(frame);
        if(value.event)emit({type:'pooledEvent',sessionId,event:value.event});
        else { const slot=waiting.get(value.id);waiting.delete(value.id);if(slot)value.ok?slot.resolve(value.result):slot.reject(Object.assign(fail(),{bridgeCode:value.error?.code})); }
      }};
      const runner=runBridge((c,e,r)=>createCodexAdapter(c,e,r,openChild),input,output);
      const request=(method,params)=>new Promise((resolve,reject)=>{const id=`session-${++requestId}`;waiting.set(id,{resolve,reject});input.write(JSON.stringify({id,method,params})+'\n');});
      sessions.set(sessionId,{request,runner,input});
      opening++;
      try {await request('initialize',sessionConfig);return {opened:true};}
      catch(error){sessions.delete(sessionId);input.end();throw error;}
      finally {opening--;if(!opening)openingModels.clear();}
    },
    async sessionRequest({sessionId,method,params}) {
      const session=sessions.get(sessionId);if(!session)throw fail();
      try {return await session.request(method,params);}
      finally {if(method==='dispose'){sessions.delete(sessionId);session.input.end();}}
    },
    async dispose() {
      retiring = true;
      await Promise.allSettled([...sessions.values()].map(s=>s.runner.dispose()));
      sessions.clear();if(native){native.stdin.end();}return {disposed:true};
    },
  };
}
