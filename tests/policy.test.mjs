import {test} from 'node:test'
import assert from 'node:assert/strict'
import {readFile,writeFile} from 'node:fs/promises'
import {join} from 'node:path'
import {spawnSync} from 'node:child_process'
import {TokenFreeAdapter,PROVIDER,MODEL} from '../lib/dsh/adapter.js'
import {TokenFreeGateway} from '../lib/dsh/gateway.js'
import {defaultPolicy} from '../lib/core/policy.js'
import {setup,collect,tool,user,payload,frame,snapshot,sse} from './helpers/fixture.mjs'
import {Context} from '@deepseek-ai/cordis'

const options=(id,tools=[tool])=>({provider:PROVIDER,model:MODEL,sessionId:id,messages:[user('Synthetic policy check')],tools})
const make=f=>new TokenFreeAdapter({sessionStoreId:'policy-fixture'}, {store:f.store,native:f.native,credential:async()=>({token:'fixture-secret-token',accountId:'fixture-owner'}),client:(_,c)=>f.web.client(f.log,c.operationId)})
const policy=(tools={mode:'auto'},output={type:'text'})=>({tools,output})
async function commit(f,a,id,chunks,interrupted=false){const op=(await a.engine()).key(id);const pending=await f.store.pending(op);f.native.save({blocks:chunks.filter(x=>x.type==='block-end').map(x=>x.block),operation:pending},interrupted);await a.reconcile(id)}

test('session policy is isolated, durable, owner-only, and rejects unsupported schema before Web calls',async()=>{
 const f=await setup(),a=make(f),ctx=new Context()
 try{
  const value=await a.setPolicy('A',policy({mode:'named',name:'read_marker'},{type:'schema',schema:{type:'array',items:{type:'integer'}}}))
  assert.deepEqual((await a.policy('B')).tools,{mode:'auto'})
  const cold=make(f);assert.deepEqual(await cold.policy('A'),value);await cold.dispose()
  for(const schema of [{$ref:'https://example.invalid/schema'},{type:'string',pattern:'x'},{type:'object',anyOf:[]}])await assert.rejects(a.setPolicy('A',policy({mode:'auto'},{type:'schema',schema})),e=>e.code==='UNSUPPORTED_SCHEMA')
  await assert.rejects(a.setPolicy('A',{...policy(),unexpected:true}),e=>e.code==='INVALID_POLICY')
  const gateway=new TokenFreeGateway(ctx,{},a)
  assert.equal((await gateway.policy('A')).revision,value.revision)
  const remote=Object.create(gateway),guest=Object.create(ctx);Object.defineProperty(guest,'invocation',{value:{peer:{principal:{kind:'guest'}}}});Object.defineProperty(remote,'ctx',{value:guest})
  await assert.rejects(remote.setPolicy('A',defaultPolicy()),e=>e.code==='tokenfree/owner-required')
  assert.equal(f.web.requests.length,0)
 }finally{await a.dispose();await ctx.fiber.dispose();await f.close()}
})

test('required is consumed atomically after native durable save, and the final answer can stop calling tools',async()=>{
 const f=await setup(),a=make(f),id='one-shot';let chunks
 f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]})
 try{
  await a.setPolicy(id,policy({mode:'required'}));f.native.begin(id);chunks=await collect(a.stream(options(id)))
  assert.equal((await a.policy(id)).tools.mode,'required')
  f.native.flushError=true;await a.reconcile(id);assert.equal((await a.policy(id)).tools.mode,'required')
  f.native.flushError=false;await commit(f,a,id,chunks);assert.equal((await a.policy(id)).tools.mode,'auto')
  f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text:'Completed'})
  f.native.begin(id);const answer=await collect(a.stream(options(id)));assert.equal(answer.at(-1).reason.kind,'stop');await commit(f,a,id,answer)
 }finally{await a.dispose();await f.close()}
})

test('required failures and cancellation retain policy, named tool is exact and missing names fail before submission',async()=>{
 for(const mode of ['required','named']){
  const f=await setup(),a=make(f),id='fail-'+mode
  try{
   await a.setPolicy(id,policy(mode==='named'?{mode,name:tool.name}:{mode}));f.native.begin(id)
   f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text:'Do not execute'})
   const chunks=[];await assert.rejects(async()=>{for await(const c of a.stream(options(id)))chunks.push(c)},e=>e.code==='TOOL_CHOICE')
   assert.equal(chunks.some(x=>x.type==='text-delta'),false);assert.equal((await a.policy(id)).tools.mode,mode)
   f.native.cancel(f.native.current(id));await a.reconcile(id)
   const c=new AbortController();c.abort();await assert.rejects(collect(a.stream({...options(id),signal:c.signal})),e=>e.code==='ABORTED');assert.equal((await a.policy(id)).tools.mode,mode)
  }finally{await a.dispose();await f.close()}
 }
 const f=await setup(),a=make(f)
 try{await a.setPolicy('missing',policy({mode:'named',name:'absent'}));f.native.begin('missing');await assert.rejects(collect(a.stream(options('missing'))),e=>e.code==='TOOL_UNAVAILABLE');assert.equal(f.web.requests.length,0)}finally{await a.dispose();await f.close()}
})

test('none persists and removes the advertised catalogue, while named advertises only the selected tool',async()=>{
 for(const choice of [{mode:'none'},{mode:'named',name:tool.name}]){
  const f=await setup(),a=make(f),id='choice'
  try{
   await a.setPolicy(id,policy(choice));f.native.begin(id)
   f.web.answer=p=>choice.mode==='none'?{protocol_version:1,request_id:p.request_id,kind:'final',text:'No tools'}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
   const chunks=await collect(a.stream(options(id,[tool,{...tool,name:'other'}])));assert.deepEqual(payload(f.web.generations[0].prompt).tools.map(x=>x.name),choice.mode==='none'?[]:[tool.name]);await commit(f,a,id,chunks)
   assert.equal((await a.policy(id)).tools.mode,choice.mode==='none'?'none':'auto')
  }finally{await a.dispose();await f.close()}
 }
})

test('one repair and same-response resume retain one-shot identity until the single durable commit',async()=>{
 const f=await setup(),a=make(f),id='repair'
 try{
  await a.setPolicy(id,policy({mode:'required'}));f.native.begin(id)
  f.web.answer=(p,_,n)=>n===1?{kind:'tool',calls:[{name:tool.name,arguments:{}}]}:{protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]}
  f.web.completion=({ready,text})=>sse(ready+frame(snapshot(f.web.generations.length===2?text.slice(0,-3):text,f.web.generations.length===2?'WIP':'FINISHED')))
  const chunks=await collect(a.stream(options(id)));assert.equal(f.web.generations.length,2);assert.equal(f.web.resumes.length,1);assert.equal((await a.policy(id)).tools.mode,'required');await commit(f,a,id,chunks);assert.equal((await a.policy(id)).tools.mode,'auto')
 }finally{await a.dispose();await f.close()}
})

for(const text of ['null','[1,true,"x"]','42','""','{"ok":true}'])test('JSON final accepts any root and buffers until history verification: '+text,async()=>{
 const f=await setup(),a=make(f),id='json';let verified=false
 try{
  await a.setPolicy(id,policy({mode:'none'},{type:'json'}));f.native.begin(id)
  f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text})
  f.web.historyHook=()=>{verified=true};f.web.completion=({ready,text:raw})=>sse(ready+frame(snapshot(raw.slice(0,-3),'WIP'))+frame(snapshot(raw)))
  const chunks=[];for await(const c of a.stream(options(id))){if(c.type==='text-delta')assert.equal(verified,true);chunks.push(c)}
  assert.equal(chunks.find(x=>x.type==='block-end'&&x.block.type==='text').block.text,text);await commit(f,a,id,chunks)
 }finally{await a.dispose();await f.close()}
})

test('malformed, duplicate, multiple, fenced or schema-invalid final values never deliver body or trigger repair',async()=>{
 for(const [text,output,extra]of [
  ['{"a":1,"a":2}',{type:'json'}],['{} {}',{type:'json'}],['```json\n{}\n```',{type:'json'}],
  ['[1,"2"]',{type:'schema',schema:{type:'array',items:{type:'integer'}}}],
  ['{"n":1,"extra":2}',{type:'schema',schema:{type:'object',properties:{n:{type:'integer'}},required:['n'],additionalProperties:false}}],
  ['{"n":1}',{type:'json'},{stop:['1']}]
 ]){
  const f=await setup(),a=make(f),id='invalid'
  try{
   await a.setPolicy(id,policy({mode:'none'},output));f.native.begin(id);f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text})
   const chunks=[];await assert.rejects(async()=>{for await(const c of a.stream({...options(id),...extra}))chunks.push(c)},e=>['OUTPUT_FORMAT','OUTPUT_SCHEMA'].includes(e.code))
   assert.equal(chunks.some(x=>['text-delta','block-end','tool-call-delta'].includes(x.type)),false);assert.equal(f.web.generations.length,1)
  }finally{await a.dispose();await f.close()}
 }
})

test('CLI policy reads and writes local settings without touching an account or opening a listener',async()=>{
 const f=await setup()
 try{
  const file=join(f.home,'policy.json');await writeFile(file,JSON.stringify(policy({mode:'none'},{type:'json'})))
  const env={...process.env,DSH_TOKENFREE_HOME:f.home,DSH_HOME:join(f.home,'dsh')}
  const args=['lib/cli.js','policy','cli-session',file]
  const first=spawnSync(process.execPath,args,{env,encoding:'utf8'});assert.equal(first.status,0,first.stderr)
  const second=spawnSync(process.execPath,args.slice(0,-1),{env,encoding:'utf8'});assert.equal(second.status,0,second.stderr);assert.equal(JSON.parse(second.stdout).output.type,'json')
  await assert.rejects(readFile(join(f.home,'credentials.json')),e=>e.code==='ENOENT')
 }finally{await f.close()}
})

test('native pending commit is reconciled before reading next-step policy',async()=>{
 const f=await setup(),a=make(f),id='commit-order'
 try{
  await a.setPolicy(id,policy({mode:'required'}));f.native.begin(id)
  f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}}]})
  const chunks=await collect(a.stream(options(id))),pending=await f.store.pending((await a.engine()).key(id))
  f.native.save({blocks:chunks.filter(x=>x.type==='block-end').map(x=>x.block),operation:pending})
  assert.equal((await a.policy(id)).tools.mode,'required')
  f.native.begin(id);f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text:'No second forced call'})
  const next=await collect(a.stream(options(id)));assert.equal(next.at(-1).reason.kind,'stop');assert.equal((await a.policy(id)).tools.mode,'auto');await commit(f,a,id,next)
 }finally{await a.dispose();await f.close()}
})

test('schema final supports scalar const, object constraints and oneOf without coercion',async()=>{
 for(const [schema,text]of [[{type:'null'},'null'],[{type:'integer',const:3},'3'],[{oneOf:[{type:'string'},{type:'array',items:{type:'boolean'}}]},'[true,false]'],[{type:'object',properties:{x:{type:'integer',enum:[1,2]}},required:['x'],additionalProperties:false},'{"x":2}']]){
  const f=await setup(),a=make(f),id='schema-success'
  try{await a.setPolicy(id,policy({mode:'none'},{type:'schema',schema}));f.native.begin(id);f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'final',text});const chunks=await collect(a.stream(options(id)));assert.equal(chunks.find(x=>x.type==='block-end').block.text,text);await commit(f,a,id,chunks)}finally{await a.dispose();await f.close()}
 }
})

test('disabled tools and a mixed named-tool batch never deliver executable calls',async()=>{
 for(const choice of [{mode:'none'},{mode:'named',name:tool.name}]){
  const f=await setup(),a=make(f),id='batch'
  try{await a.setPolicy(id,policy(choice));f.native.begin(id);f.web.answer=p=>({protocol_version:1,request_id:p.request_id,kind:'tool',calls:[{name:tool.name,arguments:{}},{name:'other',arguments:{}}]});const chunks=[];await assert.rejects(async()=>{for await(const c of a.stream(options(id,[tool,{...tool,name:'other'}])))chunks.push(c)});assert.equal(chunks.some(x=>x.type==='tool-call-delta'),false);assert.equal(f.web.generations.length,1)}finally{await a.dispose();await f.close()}
 }
})

test('an absent legacy catalogue is explicitly replaced in the verified chat without replaying history',async()=>{
 const f=await setup(),a=make(f),id='legacy-catalogue',first=options('legacy-catalogue')
 try{
  f.native.begin(id);const chunks=await collect(a.stream(first)),key=(await a.engine()).key(id),operation=await f.store.pending(key)
  const saved=f.native.save({blocks:chunks.filter(x=>x.type==='block-end').map(x=>x.block),operation});await a.reconcile(id)
  const path=join(f.home,'sessions',key+'.json'),file=JSON.parse(await readFile(path,'utf8'));delete file.confirmed.tools;await writeFile(path,JSON.stringify(file))
  f.native.begin(id);const next=await collect(a.stream({...first,messages:[...first.messages,saved,user('next delta')]}))
  const body=payload(f.web.generations[1].prompt);assert.equal(body.mode,'delta');assert.deepEqual(body.tool_updates.replace,[tool]);assert.equal(body.tool_catalogue.fromVersion,null)
  assert.equal(body.messages.length,1);assert.equal(f.web.chats.size,1);assert.equal(f.web.generations.length,2);await commit(f,a,id,next)
  assert.equal((await f.store.session(key)).catalogueKnown,undefined)
 }finally{await a.dispose();await f.close()}
})

test('published Remote policy descriptors expose a JSON schema and validate nested JSON without opaque recursive types',async()=>{
 const {default:remote}=await import('dsh-tokenfree/remote')
 const descriptor=remote.descriptors.find(x=>x.method==='setPolicy'),codec=descriptor.parameters.find(x=>x.wire==='value').codec
 assert.equal(codec.jsonSchemaError,undefined);assert(codec.jsonSchema)
 const schema=codec.create(remote.zod)
 const value=policy({mode:'named',name:tool.name},{type:'schema',schema:{type:'object',properties:{rows:{type:'array',items:{oneOf:[{type:'string'},{type:'null'}]}}},required:['rows'],additionalProperties:false}})
 assert.equal(schema.safeParse(value).success,true)
 assert.equal(schema.safeParse({...value,output:{type:'schema',schema:{invalid:()=>1}}}).success,false)
 assert.equal(schema.safeParse({...value,tools:{mode:'invented'}}).success,false)
})
