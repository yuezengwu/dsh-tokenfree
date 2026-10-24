import{test}from'node:test'
import assert from'node:assert/strict'
import{writeFile}from'node:fs/promises'
import{join}from'node:path'
import{Context}from'@deepseek-ai/cordis'
import AgentRegistry from'@deepseek-ai/dsh-agent'
import AgentLoop from'@deepseek-ai/dsh-agent-loop'
import LlmRuntime,{createUserMessage,ToolCallId}from'@deepseek-ai/dsh-llm'
import SessionStore,{SessionId}from'@deepseek-ai/dsh-session'
import SessionProjectionRegistry from'@deepseek-ai/dsh-session-projection'
import SystemPrompt from'@deepseek-ai/dsh-system-prompt'
import ToolRuntime,{defineTool}from'@deepseek-ai/dsh-tools'
import{TokenFreeAdapter,PROVIDER,MODEL}from'../lib/dsh/adapter.js'
import{ToolPolicyBridge}from'../lib/dsh/tool-policy.js'
import{LocalStore}from'../lib/local/store.js'
import{DshBoundary}from'../lib/dsh/native.js'
import{setup,tool,payload}from'./helpers/fixture.mjs'
const definition=(name=tool.name,description='Initial schema')=>defineTool({name,description,parameters:{},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async()=> 'fixture result'})
const message=text=>createUserMessage({content:[{type:'text',text}],source:{kind:'user'}})
async function harness(){
 const f=await setup(),ctx=new Context();let adapter
 for(const p of[SessionStore,AgentRegistry,LlmRuntime,SessionProjectionRegistry,ToolRuntime,SystemPrompt])await ctx.plugin(p)
 ctx.on('session/flush',async session=>writeFile(join(f.home,session.id+'.json'),JSON.stringify(session.snapshotEvents())))
 const native=new DshBoundary(ctx,a=>adapter?.reconcile(a))
 let bridge;let layer
 const load=async()=>{layer=await ctx.plugin(scope=>{bridge=new ToolPolicyBridge(scope,(id,op)=>adapter.toolCatalogueForCall(id,op))})};await load()
 adapter=new TokenFreeAdapter({sessionStoreId:'tool-policy'}, {store:f.store,native,credential:async()=>({token:'fixture-secret-token',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId),toolCatalogue:id=>bridge.catalogue(id),checkTools:(id,blocks,snapshot)=>bridge.check(id,blocks,snapshot)})
 ctx.llm.registerAdapter([PROVIDER],adapter);await ctx.plugin(AgentLoop,{agents:[]})
 const create=id=>ctx.agentLoop.create(SessionId(id),{provider:PROVIDER,model:MODEL})
 const ask=async(a,text)=>{a.followup(message(text));await a.whenIdle();await adapter.reconcile(a.id)}
 return{...f,ctx,adapter,get bridge(){return bridge},native,create,ask,unload:()=>layer.dispose(),reload:load,close:async()=>{await adapter.dispose();await ctx.fiber.dispose();await f.close()}}
}

test('native guard denies a definition replaced while approval waits; another session executes concurrently and one-shot stays consumed', {timeout:15000},async()=>{
 const f=await harness();let approve,waiting,runs=0
 const gate=new Promise(r=>{waiting=r}),approved=new Promise(r=>{approve=r})
 let remove=f.ctx.tools.register({...definition(),execute:async()=>{runs++;return'old result'}})
 try{
  const a=await f.create('guard-A'),b=await f.create('guard-B')
  await f.adapter.setPolicy(a.id,{tools:{mode:'required'},output:{type:'text'}})
  a.ctx.on('tools/pre-execute',async(exec,next)=>{waiting();await approved;return next()})
  f.web.answer=p=>p.messages.some(x=>x.role==='tool')?{protocol_version:1,request_id:p.request_id,kind:'final',text:'Finished after native result'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
  const task=f.ask(a,'A requests its tool');await gate
  assert.equal((await f.adapter.policy(a.id)).tools.mode,'auto')
  remove();remove=f.ctx.tools.register({...definition(tool.name,'Replaced description'),execute:async()=>{runs++;return'new result'}})
  await f.ask(b,'B requests the same current tool');assert.equal(runs,1)
  approve();await task
  assert.equal(runs,1,'A never ran either definition')
  const results=a.session.snapshotEvents().filter(x=>x.type==='tool/result');assert.equal(results.length,1);assert.equal(results[0].data.message.isError,true)
  assert(JSON.stringify(results).includes('工具已变化'))
  assert.equal((await f.adapter.policy(a.id)).tools.mode,'auto')
  assert.equal((await f.adapter.inspect(a.id)).pending,undefined);assert.equal((await f.adapter.inspect(b.id)).pending,undefined)
  assert(f.web.generations.map(x=>payload(x.prompt)).some(x=>x.tool_updates?.upsert.some(t=>t.description==='Replaced description')))
 }finally{approve?.();remove();await f.close()}
})

test('delivery checks reject changed called tools as a whole batch but permit unrelated catalogue additions', {timeout:15000},async()=>{
 const f=await harness();let remove=f.ctx.tools.register(definition());let runs=0
 try{
  const a=await f.create('delivery-A');const captured=f.bridge.catalogue(a.id)
  f.ctx.tools.register(definition('new_tool','New unrelated tool'))
  const calls=[{type:'tool-call',id:'not-executed',name:tool.name,arguments:'{}'}]
  assert.doesNotThrow(()=>f.bridge.check(a.id,calls,captured))
  remove();remove=f.ctx.tools.register({...definition(tool.name,'Changed definition'),execute:async()=>{runs++;return'never'}})
  assert.throws(()=>f.bridge.check(a.id,calls,captured),e=>e.code==='TOOL_CHANGED')
  assert.equal(runs,0)
  // The guard does not take over calls produced by another adapter.
  const result=await f.ctx.tools.execute({callId:ToolCallId('other-provider-call'),name:tool.name,arguments:{},agent:a,signal:new AbortController().signal})
  assert.equal(result.isError,false);assert.equal(runs,1)
 }finally{remove();await f.close()}
})

test('cold native binding is rehydrated from committed state, and nested web_search never bypasses the guard', {timeout:15000},async()=>{
 const f=await harness();let rootId,runs=0,approve,waiting;const gate=new Promise(r=>{waiting=r}),approved=new Promise(r=>{approve=r})
 const remove=f.ctx.tools.register({...definition(),execute:async()=>{runs++;return'bound'}})
 try{
  const a=await f.create('cold-A');a.ctx.on('tools/pre-execute',async(exec,next)=>{waiting();await approved;return next()})
  f.web.answer=p=>p.messages.some(x=>x.role==='tool')?{protocol_version:1,request_id:p.request_id,kind:'final',text:'done'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
  const task=f.ask(a,'Make a bound call');await gate
  const first=a.session.snapshotEvents().find(x=>x.type==='assistant/message'&&x.data.message.content.some(b=>b.type==='tool-call'));const firstId=first.data.message.content.find(b=>b.type==='tool-call').id
  const cold=new TokenFreeAdapter({sessionStoreId:'tool-policy'},{store:new LocalStore(f.home),native:f.native});assert((await cold.toolCatalogueForCall(a.id,firstId.split('_')[1])).some(x=>x.name===tool.name));await cold.dispose();approve();await task;assert.equal(runs,1)
  const source=a.session.snapshotEvents().find(x=>x.type==='assistant/message'&&x.data.message.content.some(b=>b.type==='tool-call'))
  rootId=source.data.message.content.find(b=>b.type==='tool-call').id
  // No latest-request fallback after another operation: old identities are rejected.
  const oldOperation=rootId.split('_')[1]
  await assert.rejects(f.adapter.toolCatalogueForCall(a.id,oldOperation),e=>e.code==='TOOL_BINDING')
  f.ctx.tools.register({...definition('web_search','Fixture only'),execute:async()=>{runs++;return'forbidden'}})
  const blocked=await f.ctx.tools.execute({callId:ToolCallId(rootId+':ptc:1'),rootCallId:ToolCallId(rootId),name:'web_search',arguments:{},agent:a,signal:new AbortController().signal})
  assert.equal(blocked.isError,true);assert.equal(runs,1)
 }finally{approve?.();remove();await f.close()}
})

test('a changed definition during generation is refused before native assistant/tool delivery', {timeout:15000},async()=>{
 const f=await harness();let remove=f.ctx.tools.register(definition()),runs=0
 try{
  const a=await f.create('generation-change')
  f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]})
  f.web.completion=({ready,text})=>{remove();remove=f.ctx.tools.register({...definition(tool.name,'Changed while receiving'),execute:async()=>{runs++;return'forbidden'}});return new Response(ready+`data: ${JSON.stringify({v:{response:{status:'FINISHED',fragments:[{type:'RESPONSE',content:text}]}}})}\n\n`,{headers:{'content-type':'text/event-stream'}})}
  await f.ask(a,'Do not deliver a stale tool');assert.equal(runs,0);assert.equal(f.web.generations.length,1)
  assert.equal(a.session.snapshotEvents().some(x=>x.type==='assistant/message'&&x.data.message.content.some(b=>b.type==='tool-call')),false)
 }finally{remove();await f.close()}
})

for(const change of ['parameters','remove'])test('native approval guard rejects '+change+' changes even when the old tool body was already captured', {timeout:15000},async()=>{
 const f=await harness();let remove=f.ctx.tools.register(definition()),runs=0
 try{
  const a=await f.create('approval-'+change)
  a.ctx.on('tools/pre-execute',async(exec,next)=>{remove();if(change==='parameters')remove=f.ctx.tools.register(defineTool({name:tool.name,description:'Initial schema',parameters:{note:{type:'string'}},output:{schema:{type:'string'},render:(_,v)=>[{type:'text',text:v}]},execute:async()=>{runs++;return'forbidden'}}));return next()})
  f.web.answer=p=>p.messages.some(x=>x.role==='tool')?{protocol_version:1,request_id:p.request_id,kind:'final',text:'Native denial recorded'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
  await f.ask(a,'One old tool');assert.equal(runs,0)
  const result=a.session.snapshotEvents().find(x=>x.type==='tool/result');assert.equal(result.data.message.isError,true);assert(JSON.stringify(result).includes('工具已变化'))
 }finally{remove();await f.close()}
})

test('unload keeps a native denial for saved pending calls and reload does not block new sessions', {timeout:15000},async()=>{
 const f=await harness();let runs=0,approve,waiting
 const gate=new Promise(r=>{waiting=r}),approved=new Promise(r=>{approve=r})
 f.ctx.tools.register({...definition(),execute:async()=>{runs++;return'ok'}})
 try{
  const a=await f.create('unload-A');a.ctx.on('tools/pre-execute',async(exec,next)=>{waiting();await approved;return next()})
  f.web.answer=p=>p.messages.some(x=>x.role==='tool')?{protocol_version:1,request_id:p.request_id,kind:'final',text:'Done'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
  const task=f.ask(a,'Wait for approval');await gate;await f.unload();await f.reload()
  const b=await f.create('reload-B');await f.ask(b,'New session after reload');assert.equal(runs,1)
  approve();await task;assert.equal(runs,1)
  assert(JSON.stringify(a.session.snapshotEvents().filter(x=>x.type==='tool/result')).includes('未执行'))
 }finally{approve?.();await f.close()}
})

test('native outer dispatch cannot bypass changed inner definitions or the search denial using its real parent token', {timeout:15000},async()=>{
 const f=await harness();let innerRuns=0,searchRuns=0,denials=[]
 let remove=f.ctx.tools.register({...definition('inner_tool','Original inner'),execute:async()=>{innerRuns++;return'old'}})
 f.ctx.tools.register({...definition('web_search','Fixture search'),execute:async()=>{searchRuns++;return'forbidden'}})
 f.ctx.tools.register({...definition('outer_tool','Fixture transport'),execute:async(_,exec)=>{
  remove();remove=f.ctx.tools.register({...definition('inner_tool','Changed inner'),execute:async()=>{innerRuns++;return'new'}})
  for(const name of ['inner_tool','web_search']){
   const result=await f.ctx.tools.execute({callId:ToolCallId(exec.rootCallId+':ptc:'+name),rootCallId:exec.rootCallId,parent:exec.token,name,arguments:{},agent:exec.agent,signal:exec.signal})
   assert(JSON.stringify(result).includes(name==='inner_tool'?'工具已变化':'不支持网页搜索'));denials.push(result.isError)
  }
  return'Outer observed the native denials'
 }})
 try{
  const a=await f.create('nested-transport')
  f.web.answer=p=>p.messages.some(x=>x.role==='tool')?{protocol_version:1,request_id:p.request_id,kind:'final',text:'Done'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:'outer_tool',arguments:{}}]}
  await f.ask(a,'Use only the fixture transport');assert.deepEqual(denials,[true,true]);assert.equal(innerRuns,0);assert.equal(searchRuns,0)
 }finally{remove();await f.close()}
})
