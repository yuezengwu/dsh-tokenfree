import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { MessageId } from '@deepseek-ai/dsh-llm'
import { TokenFreeAdapter, PROVIDER, MODEL, apply } from '../lib/dsh/index.js'
import { setup, collect, tool, payload, frame, snapshot, sse } from './helpers/fixture.mjs'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
const base = () => ({ provider: PROVIDER, model: MODEL, messages: [{ role: 'user', content: [{ type: 'text', text: 'Read the marker and answer.' }] }] })
const adapterFor = f => new TokenFreeAdapter({}, { store: f.store, diagnostics: f.log, credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(f.log, c.operationId) })

test('actual DSH LlmRuntime completes two-round tool result exchange through mock official HTTP', async () => {
  const f = await setup(), ctx = new Context(), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
    : { protocol_version: 1, request_id: p.request_id, kind: 'final', text: p.messages.at(-1).content[0].text }
  try {
    await ctx.plugin(LlmRuntime); ctx.llm.registerAdapter([PROVIDER], adapter)
    assert.equal((await ctx.llm.listModels(PROVIDER))[0].id, MODEL)
    const options = { ...base(), tools: [tool] }
    const first = await collect(ctx.llm.stream(options))
    const call = first.find(x => x.type === 'block-end').block
    assert.equal(first.at(-1).reason.kind, 'tool-calls')
    const marker = `marker-${crypto.randomUUID()}`
    options.messages.push({ id: MessageId('a1'), role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: MODEL }, content: [call] },
      { id: MessageId('t1'), role: 'tool', source: { kind: 'tool', callId: call.id }, isError: false, content: [{ type: 'text', text: marker }] })
    const second = await collect(ctx.llm.stream(options))
    assert.equal(second.find(x => x.type === 'block-end').block.text, marker)
    assert.equal(second.at(-1).reason.kind, 'stop')
    assert.equal(second.some(x => x.type === 'usage'), false)
    // Direct LlmRuntime calls without native session identity are explicitly temporary.
    assert.equal(f.web.generations.length, 2)
    assert.equal(f.web.chats.size, 2)
  } finally { adapter.dispose(); await ctx.fiber.dispose(); await f.close() }
})

test('plugin registers and unloads with no listening server', async () => {
  const ctx = new Context(), home = await mkdtemp(join(tmpdir(), 'tokenfree-plugin-'))
  try {
    await ctx.plugin(LlmRuntime)
    const plugin = ctx.plugin({ name: 'dsh-tokenfree', inject: ['llm'], apply: scope => apply(scope, { credentialFile: join(home, 'credentials.json') }) })
    await plugin; assert.ok(ctx.llm.listProviders().some(p => p.id === PROVIDER))
    await plugin.dispose(); assert.equal(ctx.llm.listProviders().some(p => p.id === PROVIDER), false)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

test('independent temporary calls overlap; cancelling one never cancels another', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false)), adapter = adapterFor(f)
  const started = [], finish = new Map()
  f.web.completion = async ({ ready, text, body }, options) => {
    started.push(body.chat_session_id)
    await new Promise((resolve, reject) => {
      finish.set(body.chat_session_id, resolve)
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
    })
    return sse(ready + frame(snapshot(text)))
  }
  const waitStarted = async n => { const until = Date.now() + 3000; while (started.length < n) { if (Date.now() > until) throw new Error('calls were serialized'); await new Promise(r => setTimeout(r, 5)) } }
  const cancelled = new AbortController()
  try {
    const first = collect(adapter.stream(base()))
    await waitStarted(1)
    const second = collect(adapter.stream({ ...base(), signal: cancelled.signal }))
    const rejected = assert.rejects(second, error => error.code === 'ABORTED')
    await waitStarted(2)
    cancelled.abort(); await rejected
    assert.equal(f.web.generations.length, 2)
    finish.get(started[0])(); await first
    assert.equal(f.web.stops.every(x => x.body.chat_session_id === started[1]), true)
    await f.log.flush()
    const failures = (await readFile(f.log.file, 'utf8')).trim().split('\n').map(JSON.parse).filter(x => x.event === 'model.failed')
    assert.equal(failures.at(-1).code, 'ABORTED')
  } finally { for (const resolve of finish.values()) resolve(); await adapter.dispose(); await f.close() }
})

test('malformed JSON, unknown tool, duplicate field or invalid schema never emits executable blocks', async () => {
  for (const candidate of ['broken JSON', '<｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="read_marker"></｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>', '{"kind":"tool","calls":[{"name":"unregistered","arguments":{}}]}', '{"kind":"final","kind":"tool","calls":[]}', '{"kind":"tool","calls":[{"name":"read_marker","arguments":{"unexpected":true}}]}']) {
    const f = await setup(), adapter = adapterFor(f); f.web.answer = () => candidate
    try {
      const chunks = []
      await assert.rejects(async () => { for await (const chunk of adapter.stream({ ...base(), tools: [tool] })) chunks.push(chunk) })
      assert.equal(chunks.some(x => x.blockType === 'tool-call' || x.type === 'tool-call-delta'), false)
      assert.equal(f.web.generations.length, 1)
    } finally { adapter.dispose(); await f.close() }
  }
})

test('only complete existing intent missing protocol wrapper gets one format repair', async () => {
  const f = await setup(), adapter = adapterFor(f)
  f.web.answer = (p, _, n) => n === 1 ? { kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
    : { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
  try {
    const chunks = await collect(adapter.stream({ ...base(), tools: [tool] }))
    assert.equal(f.web.generations.length, 2)
    assert.equal(f.web.generations[1].parent_message_id, 2)
    assert.equal(chunks.find(x => x.type === 'block-end').block.name, tool.name)
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls')
  } finally { adapter.dispose(); await f.close() }
})

test('response protocol identity mismatch is never repaired into tools', async () => {
  const f = await setup(), adapter = adapterFor(f)
  f.web.answer = () => ({ protocol_version: 1, request_id: 'different-operation', kind: 'tool', calls: [{ name: tool.name, arguments: {} }] })
  try { await assert.rejects(collect(adapter.stream({ ...base(), tools: [tool] })), error => error.code === 'WEB_IDENTITY'); assert.equal(f.web.generations.length, 1) }
  finally { adapter.dispose(); await f.close() }
})

test('preflight refuses unsupported routes, native association and pending compaction without Web calls', async () => {
  const f = await setup(), adapter = adapterFor(f)
  try {
    for (const extra of [{ model: 'unknown' }, { temperature: 0.5 }, { purpose: 'compaction' }, { sessionId: 'unassociated' }]) await assert.rejects(collect(adapter.stream({ ...base(), ...extra })))
    assert.equal(f.web.requests.length, 0)
    const model = await adapter.resolveModel(PROVIDER, MODEL)
    assert.equal(model.contextWindow, undefined); assert.equal(model.reasoning.defaultEffort, 'web-on')
    await collect(adapter.stream({ ...base(), tools: [{ ...tool, name: 'web_search' }] }))
    assert.deepEqual(payload(f.web.generations[0].prompt).tools, [])
    assert.equal(f.web.generations[0].thinking_enabled, true); assert.equal(f.web.generations[0].search_enabled, false)
  } finally { adapter.dispose(); await f.close() }
})

test('missing Web credential never uses an existing paid API key', async () => {
  const f = await setup(), adapter = new TokenFreeAdapter({ credentialFile: join(f.home, 'missing.json') }, { store: f.store })
  const oldWeb = process.env.DEEPSEEK_WEB_TOKEN, oldApi = process.env.DEEPSEEK_API_KEY
  delete process.env.DEEPSEEK_WEB_TOKEN; process.env.DEEPSEEK_API_KEY = 'fixture-paid-key'
  try { await assert.rejects(collect(adapter.stream(base())), error => error.code === 'MISSING_CREDENTIAL') }
  finally {
    oldWeb === undefined ? delete process.env.DEEPSEEK_WEB_TOKEN : process.env.DEEPSEEK_WEB_TOKEN = oldWeb
    oldApi === undefined ? delete process.env.DEEPSEEK_API_KEY : process.env.DEEPSEEK_API_KEY = oldApi
    adapter.dispose(); await f.close()
  }
})
