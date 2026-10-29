import assert from 'node:assert/strict';
import z from '@deepseek-ai/schemastery';
import test from 'node:test';
import AgentRegistry from '@deepseek-ai/dsh-agent';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import Projection from '@deepseek-ai/dsh-session-projection';
import TokenMeter from '@deepseek-ai/dsh-token-meter';
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic';
import { createUserMessage, CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import { PERSONA_PREFIX_SECTION, renderPrompt } from '@deepseek-ai/dsh-system-prompt';
import { maintenanceWindow } from '../src/schedule.mjs';
import { compactionBatches } from '../src/compaction.mjs';
import { DshMemoryRuntime } from '../src/runtime.mjs';
import { Config, resolveConfig } from '../src/config.mjs';
import * as plugin from '../src/index.mjs';
import { host, config, session, user, assistant, textChunks, eventCandidate, enableConversation } from './helpers.mjs';

test('processing windows honor boundaries, weekends, overnight windows and the selected time zone', () => {
  const settings = resolveConfig({ offPeakOnly: true });
  for (const [time, allowed] of [['2026-10-29T00:59Z',true],['2026-10-29T01:00Z',false],
    ['2026-10-29T04:00Z',true],['2026-10-29T06:00Z',false],['2026-10-29T10:00Z',true],['2026-10-31T02:00Z',true]]) {
    assert.equal(maintenanceWindow(settings, new Date(time)).allowed, allowed, time);
  }
  const overnight = resolveConfig({ offPeakOnly: true, offPeakSchedule: { timeZone:'UTC',weekends:false,windows:[{start:'22:00',end:'08:00'}] } });
  assert.equal(maintenanceWindow(overnight,new Date('2026-10-29T07:59Z')).allowed,true);
  assert.equal(maintenanceWindow(overnight,new Date('2026-10-29T08:00Z')).allowed,false);
  assert.throws(()=>resolveConfig({offPeakSchedule:{timeZone:'invalid-zone'}}));
  assert.throws(()=>resolveConfig({offPeakSchedule:{windows:[]}}));
  assert.throws(()=>resolveConfig({offPeakSchedule:{windows:[{start:'09:00',end:'09:00'}]}}));
});

test('peak hours save dialogue locally and the next allowed window drains the deferred short tail', async t => {
  const {ctx,adapter}=await host(t);
  const runtime=new DshMemoryRuntime(ctx,config(t,{automaticMaintenance:true}), () => true);t.after(()=>runtime.close());
  let allowed=false;
  t.mock.method(runtime,'window',()=>({enabled:true,automatic:true,offPeakOnly:true,allowed}));
  const value=session();user(value,'昨天我去过灯塔博物馆。');assistant(value,'记住了。');
  runtime.scheduleArchive(value,{flush:true});
  const entry=runtime.sessions.get(value.id);
  assert.equal(entry.deferred,true);assert.equal(adapter.calls.length,0);
  assert.equal(entry.memory.listInputEvents({statuses:[]}).total,2);
  allowed=true;runtime.tick();await entry.running;
  assert.ok(adapter.calls.length>0);assert.equal(entry.pendingEvents,0);
  const count=adapter.calls.length;runtime.tick();await Promise.resolve();assert.equal(adapter.calls.length,count);
});

test('a window closing aborts automatic processing and resumes without quarantining its dialogue', async t => {
  let started;const start=new Promise(resolve=>{started=resolve;});let hold=true;
  const {ctx,adapter}=await host(t,async options=>{
    if(hold){started();await new Promise((resolve,reject)=>{if(options.signal.aborted)reject(options.signal.reason);else options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});}
    return textChunks('{"memories":[]}');
  });
  t.mock.method(globalThis,'fetch',async(_url,options)=>{
    options.signal.throwIfAborted();
    return Response.json({data:[{index:0,embedding:[1,0]}]});
  });
  const runtime=new DshMemoryRuntime(ctx,config(t,{automaticMaintenance:true,
    embedding:{baseUrl:'https://embedding.invalid/v1',model:'test-vector',dimensions:2,apiKey:'fixture-key'}}), () => true);t.after(()=>runtime.close());
  let allowed=true;t.mock.method(runtime,'window',()=>({enabled:true,automatic:true,offPeakOnly:true,allowed}));
  const value=session();user(value,'约好下周日去看展览。');assistant(value,'好的。');
  const work=runtime.maintain(value,{force:true,automatic:true});await start;
  allowed=false;runtime.tick();
  const recalled=await runtime.sessions.get(value.id).memory.providers.embedding('recall during peak');
  assert.deepEqual([...recalled.vector],[1,0]);
  assert.equal((await work).status,'paused');
  const calls=adapter.calls.length;runtime.tick();assert.equal(adapter.calls.length,calls);
  hold=false;allowed=true;runtime.tick();await runtime.sessions.get(value.id).running;
  const events=runtime.sessions.get(value.id).memory.listInputEvents({statuses:[]}).items;
  assert.equal(events.length,2);assert.ok(events.every(event=>event.processing_disposition!=='quarantined'));
  assert.equal(runtime.sessions.get(value.id).pendingEvents,0);
});

test('explicit processing remains available outside automatic windows', async t => {
  const {ctx,adapter}=await host(t);const runtime=new DshMemoryRuntime(ctx,config(t), () => true);t.after(()=>runtime.close());
  t.mock.method(runtime,'window',()=>({enabled:true,automatic:true,offPeakOnly:true,allowed:false}));
  const value=session();user(value,'上周去看了海。');assistant(value,'听起来不错。');
  await runtime.maintain(value,{force:true});assert.ok(adapter.calls.length>0);
});

test('process now joins active automatic work and continues across the window boundary', async t => {
  let started, release, held = false;
  const start = new Promise(resolve => { started = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const { ctx, adapter } = await host(t, async () => {
    if (!held) { held = true; started(); await gate; }
    return textChunks('{"memories":[]}');
  });
  const runtime = new DshMemoryRuntime(ctx, config(t, { automaticMaintenance: true }), () => true);
  t.after(() => runtime.close());
  let allowed = true;
  t.mock.method(runtime, 'window', () => ({ enabled: true, automatic: true, offPeakOnly: true, allowed }));
  const value = session(); user(value, '周末准备去看新展。'); assistant(value, '周末见。');
  const automatic = runtime.maintain(value, { force: true, automatic: true });
  await start;
  const manual = runtime.maintain(value, { force: true });
  assert.equal(manual, automatic);
  allowed = false; runtime.tick();
  assert.equal(adapter.calls[0].signal.aborted, false);
  release();
  assert.equal((await manual).status, 'completed');
});

test('session opt-in scopes the tool and the master switch restores native prompts', async t => {
  const {ctx,adapter}=await host(t);let enabled=true;
  await ctx.plugin(Projection);await ctx.plugin(AgentRegistry);await ctx.plugin(AgentLoop,{agents:[]});
  await ctx.plugin({inject:plugin.inject,apply(child){plugin.apply(child,{...config(t),enabled:{get:()=>enabled}});}});
  const first=await ctx.agentLoop.createAgent(ctx,{sessionId:SessionId('switch-chat'),agentOptions:{provider:'test',model:'deepseek-test'}});
  const second=await ctx.agentLoop.createAgent(ctx,{sessionId:SessionId('switch-work'),agentOptions:{provider:'test',model:'deepseek-test'}});
  t.after(()=>Promise.all([first.dispose(),second.dispose()]));
  const agent=first.agent;
  agent.ctx.systemPrompt.section({name:PERSONA_PREFIX_SECTION,order:0,text:'Original persona'});
  const assembly=()=>agent.ctx.systemPrompt.assemble({agent,scope:agent}).then(renderPrompt);
  assert.equal(agent.ctx.tools.schemas(agent).some(tool=>tool.name==='suzu_memory_search'),false);
  await ctx.suzuMemorySettings.save(agent.id,{memoryEnabled:true,personaMode:'custom',persona:'Custom persona',compactionMode:'dsh',compactionPrompt:''},0);
  assert.match(await assembly(),/Custom persona/);
  assert.ok(agent.ctx.tools.schemas(agent).some(tool=>tool.name==='suzu_memory_search'));
  assert.ok(!second.agent.ctx.tools.schemas(second.agent).some(tool=>tool.name==='suzu_memory_search'));
  assert.ok(!ctx.tools.schemas().some(tool=>tool.name==='suzu_memory_search'));
  enabled=false;ctx.emit('loader/volatile-update');
  assert.ok(!agent.ctx.tools.schemas(agent).some(tool=>tool.name==='suzu_memory_search'));
  assert.match(await assembly(),/Original persona/);
  const pausedStatus=JSON.parse((await ctx.commands.execute(agent,'/suzu-memory-status',[],new AbortController().signal)).result.text);
  assert.equal(pausedStatus.enabled,false);
  assert.equal((await fetch(new URL('/console/',pausedStatus.consoleUrl))).status,200);
  assert.equal(adapter.calls.length,0);
  enabled=true;ctx.emit('loader/volatile-update');
  assert.ok(agent.ctx.tools.schemas(agent).some(tool=>tool.name==='suzu_memory_search'));
});

test('settings schema survives repeated host projection and browser rehydration', () => {
  let schema=Config;
  for(let pass=0;pass<3;pass++) {
    schema=new z(JSON.parse(JSON.stringify(schema)));
    assert.doesNotThrow(()=>schema({}), 'schema round trip '+pass);
    for(const windows of [[],[{start:'25:00',end:'09:00'}],[{start:'00:00',end:'24:01'}]]) {
      assert.throws(()=>schema({offPeakSchedule:{windows}}));
    }
  }
});

test('disabling one conversation aborts its work and re-enabling retains all pending history', async t => {
  let active=true,hold=true,started;
  const start=new Promise(resolve=>{started=resolve;});
  const {ctx,adapter}=await host(t,async options=>{
    if(hold){started();await new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));}
    return textChunks('{"memories":[]}');
  });
  const runtime=new DshMemoryRuntime(ctx,config(t),()=>active);t.after(()=>runtime.close());
  const value=session();user(value,'上周去了海边。');assistant(value,'记住了。');
  const work=runtime.maintain(value,{force:true});await start;
  active=false;await runtime.refreshSession(value.id);assert.equal((await work).status,'paused');
  const count=adapter.calls.length;user(value,'关闭期间的新对话。',2);assistant(value,'新的回复。',2);runtime.observe(value);runtime.tick();
  assert.equal(adapter.calls.length,count);assert.throws(()=>runtime.maintain(value,{force:true}),/启用当前会话/);
  hold=false;active=true;await runtime.refreshSession(value.id);await runtime.maintain(value,{force:true});
  const entry=runtime.sessions.get(value.id);const events=entry.memory.listInputEvents({statuses:[]}).items;
  assert.equal(events.length,4);assert.equal(entry.pendingEvents,0);assert.ok(events.every(event=>event.processing_disposition!=='quarantined'));
});

async function loop(t, script, overrides={}, enabled=true) {
  const result=await host(t,script);
  await result.ctx.plugin(Projection);await result.ctx.plugin(AgentRegistry);await result.ctx.plugin(AgentLoop,{agents:[]});await result.ctx.plugin(TokenMeter);
  await result.ctx.plugin(plugin,config(t,overrides));
  const handle=await result.ctx.agentLoop.createAgent(result.ctx,{sessionId:SessionId('batched-'+t.name),agentOptions:{provider:'test',model:'deepseek-test'}});
  t.after(()=>handle.dispose());if(enabled)await enableConversation(result.ctx,handle.agent);return {...result,handle,agent:handle.agent};
}

test('long native compaction batches the entire source and lands one merged checkpoint', async t => {
  const {ctx,adapter,agent}=await loop(t,options=>options.purpose==='compaction'?textChunks('保留展览计划与同行人的约定。'):textChunks('收到。'),{compactionBatchCharacters:4000});
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:100000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000,maxTokens:731});
  agent.followup(createUserMessage({content:[{type:'text',text:'一起去看展览，周日出发。'.repeat(1200)}],source:{kind:'user'}}));await agent.whenIdle();
  const result=await ctx.compaction.compactNow(agent,new AbortController().signal);assert.ok(result);
  const calls=adapter.calls.filter(call=>call.purpose==='compaction');assert.ok(calls.length>2);
  assert.ok(calls.every(call=>call.maxTokens===731));
  assert.ok(calls.every(call=>call.messages.filter(message=>message.role!=='system').slice(0,-1).reduce((n,m)=>n+m.content.filter(b=>b.type==='text').reduce((s,b)=>s+b.text.length,0),0)<=4000));
  assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length,1);
});

test('automatic compaction fits an overflowing 1M context in model-sized parallel batches and merges in source order', async t => {
  let active=0,maximumActive=0,mergeInput='';
  const {ctx,adapter,agent}=await loop(t,async options=>{
    if(options.purpose!=='compaction')return textChunks('收到。');
    const material=options.messages.at(-2).content.filter(block=>block.type==='text').map(block=>block.text).join('');
    if(options.messages.at(-1).content[0].text.includes('合并这些摘要')){mergeInput=material;return textChunks('最终摘要。');}
    active++;maximumActive=Math.max(maximumActive,active);
    try{await new Promise(resolve=>setTimeout(resolve,material.includes('FIRST')?20:1));return textChunks(material.includes('FIRST')?'先发生的事情。':'后发生的事情。');}
    finally{active--;}
  });
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:1000000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000,maxTokens:1000});
  agent.followup(createUserMessage({content:[{type:'text',text:'FIRST\n'+'event '.repeat(700000)+'\nLAST'}],source:{kind:'user'}}));await agent.whenIdle();
  assert.ok(ctx.tokenMeter.measure(agent.session).totalTokens>1000000);
  await ctx.compaction.compactNow(agent,new AbortController().signal);
  const calls=adapter.calls.filter(call=>call.purpose==='compaction');
  assert.equal(calls.length,3,'two large source batches and one merge, rather than dozens of fixed 48k chunks');
  assert.equal(maximumActive,2);
  assert.ok(calls.every(call=>call.messages.reduce((sum,message)=>sum+ctx.tokenMeter.estimateMessage(message),call.maxTokens)<=900000));
  assert.ok(mergeInput.indexOf('先发生的事情')<mergeInput.indexOf('后发生的事情'));
  assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length,1);
});

test('provider-confirmed context overflow subdivides failed material without repeating successful source ranges', async t => {
  const successful=[],attemptedSizes=[];let overflows=0;
  const {ctx,adapter,agent}=await loop(t,options=>{
    if(options.purpose!=='compaction')return textChunks('收到。');
    const material=options.messages.slice(0,-1).flatMap(message=>message.content).filter(block=>block.type==='text').map(block=>block.text).join('');
    if(!options.messages.at(-1).content[0].text.includes('合并这些摘要'))attemptedSizes.push(material.length);
    if(material.length>5000){overflows++;return[{type:'finish',reason:{kind:'error',failure:{code:CONTEXT_WINDOW_EXCEEDED_CODE,message:'Simulated provider tokenization exceeds the declared estimate.'}}}];}
    if(options.messages.at(-1).content[0].text.includes('合并这些摘要'))return textChunks('最终摘要。');
    successful.push(...material.matchAll(/row-\d{4}/gu));
    return textChunks('本段已概括。');
  });
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:100000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000,maxTokens:1000});
  const rows=Array.from({length:1000},(_,index)=>'row-'+String(index).padStart(4,'0')+': a fictional event.\n');
  agent.followup(createUserMessage({content:[{type:'text',text:rows.join('')}],source:{kind:'user'}}));await agent.whenIdle();
  await ctx.compaction.compactNow(agent,new AbortController().signal);
  assert.ok(overflows>0);
  assert.ok(attemptedSizes[1]<attemptedSizes[0],'the rejected full request must not be sent again before subdivision');
  const ids=successful.map(match=>match[0]);
  assert.equal(ids.length,1000);assert.equal(new Set(ids).size,1000);
  assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length,1);
});

test('a truncated middle batch preserves the native conversation surface', async t => {
  let calls=0,active=0,cancelled=0;
  const {ctx,adapter,agent}=await loop(t,async options=>{
    if(options.purpose!=='compaction')return textChunks('收到。');
    if(++calls===2)return[{type:'text-delta',index:0,text:'不完整'},{type:'finish',reason:{kind:'max-tokens'}}];
    active++;
    try{
      await new Promise((resolve,reject)=>{
        const abort=()=>{cancelled++;clearTimeout(timer);reject(options.signal.reason);};
        const timer=setTimeout(()=>{options.signal.removeEventListener('abort',abort);resolve();},100);
        options.signal.addEventListener('abort',abort,{once:true});
        if(options.signal.aborted)abort();
      });
      return textChunks('摘要。');
    }finally{active--;}
  },{compactionBatchCharacters:4000});
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:100000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000});
  agent.followup(createUserMessage({content:[{type:'text',text:'保留完整原话。'.repeat(1600)}],source:{kind:'user'}}));await agent.whenIdle();
  const generation=agent.session.surface.replaceGeneration;
  await assert.rejects(ctx.compaction.compactNow(agent,new AbortController().signal));
  assert.equal(agent.session.surface.replaceGeneration,generation);
  assert.equal(active,0);assert.ok(cancelled>0);
  assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length,0);
});

test('disabling the owning conversation cancels and drains its compaction without affecting other sessions', async t => {
  let active=0,cancelled=0,started;
  const ready=new Promise(resolve=>{started=resolve;});
  const {ctx,adapter,agent}=await loop(t,async options=>{
    if(options.purpose!=='compaction')return textChunks('收到。');
    active++;started();
    try{
      await new Promise((resolve,reject)=>{
        const abort=()=>{cancelled++;reject(options.signal.reason);};
        options.signal.addEventListener('abort',abort,{once:true});
        if(options.signal.aborted)abort();
      });
      return textChunks('摘要。');
    }finally{active--;}
  },{compactionBatchCharacters:4000});
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:100000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000,maxTokens:1000});
  const second=await ctx.agentLoop.createAgent(ctx,{sessionId:SessionId('unrelated-compaction-session'),agentOptions:{provider:'test',model:'deepseek-test'}});t.after(()=>second.dispose());
  await enableConversation(ctx,second.agent);
  agent.followup(createUserMessage({content:[{type:'text',text:'需要完整保留的交流。'.repeat(1600)}],source:{kind:'user'}}));await agent.whenIdle();
  const generation=agent.session.surface.replaceGeneration;
  const outcome=ctx.compaction.compactNow(agent,new AbortController().signal).then(()=>({ok:true}),error=>({ok:false,error}));
  await ready;
  await ctx.suzuMemorySettings.setMemoryEnabled(second.agent.id,false,ctx.suzuMemorySettings.read(second.agent.id).revision);
  assert.equal(cancelled,0);assert.ok(active>0);
  await ctx.suzuMemorySettings.setMemoryEnabled(agent.id,false,ctx.suzuMemorySettings.read(agent.id).revision);
  assert.equal((await outcome).ok,false);
  assert.ok(cancelled>0);assert.equal(active,0);
  assert.equal(agent.session.surface.replaceGeneration,generation);
  assert.equal(agent.session.snapshotEvents().filter(event=>event.type==='compaction/summary').length,0);
});

test('a fitting original compaction request is not blocked by the extra instructions needed only for batching', async t => {
  const {ctx,adapter,agent}=await loop(t,()=>textChunks('已保留当前交流。'));
  adapter.resolveModel=async(provider,model)=>({provider,id:model,name:model,context:{contextWindow:10000}});
  await ctx.plugin(BasicCompaction,{auto:false,retainTokens:0,headroomTokens:1000,maxTokens:1000});
  const material={role:'user',content:[{type:'text',text:'A brief exchange.'}]};
  const price=length=>ctx.tokenMeter.estimateMessage(material)+ctx.tokenMeter.estimateMessage({role:'user',content:[{type:'text',text:'x'.repeat(length)}]});
  let low=0,high=32000;
  while(low<high){const middle=Math.ceil((low+high)/2);if(price(middle)<8000)low=middle;else high=middle-1;}
  const instruction='x'.repeat(low);
  const saved=ctx.suzuMemorySettings.read(agent.id);
  await ctx.suzuMemorySettings.save(agent.id,{memoryEnabled:saved.memoryEnabled,personaMode:saved.personaMode,persona:saved.persona,
    compactionMode:'custom',compactionPrompt:instruction},saved.revision);
  await ctx.compaction.summarize({messages:[material]},agent,new AbortController().signal);
  const calls=adapter.calls.filter(call=>call.purpose==='compaction');
  assert.equal(calls.length,1);
  assert.equal(calls[0].messages.at(-1).content[0].text,instruction);
});

test('native prompt viewing exposes actual scoped text without applying the saved override', async t => {
  const {ctx,agent}=await loop(t,()=>textChunks('收到。'));
  agent.ctx.systemPrompt.section({name:PERSONA_PREFIX_SECTION,order:0,text:'Original scoped persona'});
  await ctx.suzuMemorySettings.save(agent.session.id,{personaMode:'custom',persona:'Replacement persona',compactionMode:'dsh',compactionPrompt:''},ctx.suzuMemorySettings.read(agent.id).revision);
  const native=await ctx.suzuMemorySettings.nativeView(agent);
  assert.match(native.persona,/Original scoped persona/);assert.ok(!native.persona.includes('Replacement persona'));
  assert.match(native.compaction,/Primary Request and Intent/);
  const read=await ctx.commands.execute(agent,'/suzu-memory-prompts',[],new AbortController().signal);
  assert.equal(JSON.parse(read.result.text).native.persona,native.persona);
});

test('graph and review share one page and HTTP data stays scoped to its conversation', async t => {
  const entries=new Map(),requireSession=DshMemoryRuntime.prototype.require;
  t.mock.method(DshMemoryRuntime.prototype,'require',function(value){const entry=requireSession.call(this,value);entries.set(value.id,entry);return entry;});
  const {ctx,adapter,agent}=await loop(t,()=>textChunks(JSON.stringify({memories:[eventCandidate()]})));
  agent.session.append('request/header',{reason:'initial',header:{config:{provider:'test',model:'deepseek-test'}}});
  user(agent.session,'今天去了灯塔博物馆。');
  const entry=entries.get(agent.id);await entry.memory.processPendingEvents({generator:entry.generator,runMaintenance:false});
  const status=await ctx.commands.execute(agent,'/suzu-memory-status',[],new AbortController().signal);
  const url=new URL(JSON.parse(status.result.text).consoleUrl),calls=adapter.calls.length;
  const reads=t.mock.method(entry.memory,'brainSnapshot',entry.memory.brainSnapshot.bind(entry.memory));
  const page=await fetch(url);const html=await page.text();assert.match(html,/graph-tab/);assert.match(html,/review-tab/);
  assert.equal(reads.mock.callCount(),0);
  const graph=(await(await fetch(url.origin+'/v1/brain')).json()).data;
  const node=graph.nodes.find(item=>item.title==='参观灯塔博物馆');assert.ok(node);
  assert.match(await(await fetch(url.origin+'/console/')).text(),/Suzu Memory/);
  const other=await ctx.agentLoop.createAgent(ctx,{sessionId:SessionId('separate-graph'),agentOptions:{provider:'test',model:'deepseek-test'}});t.after(()=>other.dispose());
  await enableConversation(ctx,other.agent);
  const otherStatus=await ctx.commands.execute(other.agent,'/suzu-memory-status',[],new AbortController().signal);
  const otherUrl=new URL(JSON.parse(otherStatus.result.text).consoleUrl);
  assert.equal((await fetch(otherUrl.origin+'/v1/memories/'+node.id)).status,404);
  const disabled=await ctx.commands.execute(agent,'/suzu-memory-enable '+JSON.stringify({enabled:false,revision:ctx.suzuMemorySettings.read(agent.id).revision}),[],new AbortController().signal);
  assert.equal(disabled.result.kind,'success');
  const paused=JSON.parse((await ctx.commands.execute(agent,'/suzu-memory-status',[],new AbortController().signal)).result.text);
  assert.equal(paused.enabled,false);
  assert.equal(paused.consoleUrl,url.href);
  const reviewPage=await(await fetch(url.origin+'/console/')).text();
  assert.ok(reviewPage.includes('/memory/review.css'));
  assert.ok(reviewPage.includes('/console/app.js'));
  assert.equal((await fetch(url.origin+'/memory/base.css')).status,200);
  assert.equal((await fetch(url.origin+'/v1/memories/'+node.id)).status,200);
  assert.equal(adapter.calls.length,calls);
});

test('paused libraries reopen after restart without importing conversation history or calling models', async t => {
  const {ctx,adapter}=await host(t,()=>textChunks(JSON.stringify({memories:[eventCandidate()]})));
  const settings=config(t);
  const value=session();user(value,'今天去了灯塔博物馆。');assistant(value,'记下了。');
  const active=new DshMemoryRuntime(ctx,settings,()=>true);
  const {entry}=active.consume(value);
  await entry.memory.processPendingEvents({generator:entry.generator,runMaintenance:false});
  const saved=entry.memory.brainSnapshot().nodes.find(node=>node.title==='参观灯塔博物馆');assert.ok(saved);
  const captured=entry.memory.listInputEvents({statuses:[]}).total;
  await active.close();
  user(value,'关闭后积累的聊天不应在查看时补录。',2);
  const history=t.mock.method(value,'snapshotEvents',value.snapshotEvents.bind(value));
  const paused=new DshMemoryRuntime(ctx,{...settings,enabled:false},()=>false);t.after(()=>paused.close());
  const calls=adapter.calls.length;
  const reopened=paused.view(value);
  assert.equal(reopened.memory.listInputEvents({statuses:[]}).total,captured);
  assert.equal(history.mock.callCount(),0);
  const url=new URL(await paused.consoleUrl(reopened));
  const review=await(await fetch(url.origin+'/v1/review-console')).json();
  assert.equal(review.status,'success');
  assert.equal((await fetch(url.origin+'/v1/memories/'+saved.id)).status,200);
  const run=await fetch(url.origin+'/v1/maintenance/run',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  assert.ok(!run.ok);
  assert.throws(()=>paused.consume(value),{code:'MEMORY_DISABLED'});
  assert.equal(adapter.calls.length,calls);
  assert.equal(history.mock.callCount(),0);
});

test('opening a long existing conversation stays free until that conversation is enabled', async t => {
  const entries=new Map(),requireSession=DshMemoryRuntime.prototype.require;
  t.mock.method(DshMemoryRuntime.prototype,'require',function(value){const entry=requireSession.call(this,value);entries.set(value.id,entry);return entry;});
  const {ctx,adapter,agent}=await loop(t,()=>textChunks('{"memories":[]}'),{consoleEnabled:false},false);
  agent.session.append('request/header',{reason:'initial',header:{config:{provider:'test',model:'deepseek-test'}}});
  user(agent.session,'安装前已经聊过的旧历史。'.repeat(1000));assistant(agent.session,'旧回复。');
  const before=adapter.calls.length;
  const status=await ctx.commands.execute(agent,'/suzu-memory-status',[],new AbortController().signal);
  assert.equal(JSON.parse(status.result.text).sessionEnabled,false);assert.equal(entries.size,0);assert.equal(adapter.calls.length,before);
  await enableConversation(ctx,agent);
  assert.equal(entries.get(agent.id).memory.listInputEvents({statuses:[]}).total,2);
  const processed=await ctx.commands.execute(agent,'/suzu-memory-maintain',[],new AbortController().signal);
  assert.equal(processed.result.kind,'success',JSON.stringify(processed));
  assert.ok(adapter.calls.length>before);
});

test('batch quoting retains text and tool arguments without orphaned executable tool messages', () => {
  assert.throws(() => compactionBatches([{role:'user',content:[{type:'text',text:'🙂🙂'}]}],9));
  const text='长段内容🙂'.repeat(100);
  const image={type:'image',source:{type:'url',url:'https://example.com/image.png'}};
  const batches=compactionBatches([{role:'user',content:[{type:'text',text}]},
    {role:'assistant',content:[{type:'tool-call',id:'call-read',name:'read',arguments:'{"path":"plan.md"}'}]},
    {role:'tool',toolCallId:'call-read',content:[{type:'text',text:'完整工具结果'}]},
    {role:'developer',content:[{type:'tool-addition',toolName:'read'},{type:'tool-removal',toolName:'old-tool'}]},
    {role:'user',content:[image]}],120);
  const joined=batches.flat().filter(block=>block.type==='text').map(block=>block.text).join('');
  assert.ok(joined.replace(/\n\[(?:user|assistant|tool)\]\n/gu,'').includes(text));assert.ok(joined.includes('plan.md'));assert.ok(joined.includes('完整工具结果'));
  assert.match(joined,/tool call-read/);assert.match(joined,/tool-addition: read/);assert.match(joined,/tool-removal: old-tool/);
  assert.ok(batches.flat().every(block=>['text','image'].includes(block.type)));
  assert.equal(batches.flat().find(block=>block.type==='image'),image);
  assert.ok(batches.every(batch=>batch.filter(block=>block.type==='text').reduce((n,block)=>n+block.text.length,0)<=120));
});
