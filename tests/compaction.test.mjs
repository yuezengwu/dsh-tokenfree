import { installNativeToolExecutor } from './helpers/native-plugins.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import Loader, { Group } from '@deepseek-ai/cordis-plugin-loader'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { DshBoundary } from '../lib/dsh/native.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { TokenFreeGateway } from '../lib/dsh/gateway.js'
import Compaction, { compactablePrefix, compactionThinking, installCompaction } from '../lib/dsh/compaction.js'
import { setup, payload, frame, snapshot, sse, envelope } from './helpers/fixture.mjs'

test('candidate ranges preserve complete native tool groups and surface order after checkpoints', () => {
  const row = (seq, type, calls = 0) => ({ seq, type, data: { message: { content: Array.from({ length: calls }, () => ({ type: 'tool-call' })) } } })
  const range = events => compactablePrefix({ surface: { nodes: events.map(x => x.seq), replaceGeneration: 0 }, snapshotEvents: () => events, eventAt: seq => events.find(x => x.seq === seq) })
  const system = row(0, 'system/message'), user = row(4, 'user/message'), answer = row(7, 'assistant/message'), last = row(10, 'user/message')
  assert.equal(range([system]), undefined)
  assert.deepEqual(range([system, user, answer, last]), { start: 4, end: 7 })
  const tools = [row(20, 'assistant/message', 2), row(21, 'tool/result'), row(22, 'tool/result')]
  assert.deepEqual(range([system, user, ...tools]), { start: 4, end: 4 })
  assert.deepEqual(range([system, user, ...tools, last]), { start: 4, end: 22 })
  assert.deepEqual(range([system, row(40, 'user/message'), answer, last]), { start: 40, end: 7 })
  assert.deepEqual(range([user, answer, last]), { start: 4, end: 7 })
  assert.equal(range([system, ...tools]), undefined)
  assert.deepEqual(range([system, user, tools[0]]), { start: 4, end: 4 })
  assert.throws(() => range([system, user, tools[1]]), /corrupt surface/)
})

test('compaction respects pending native thinking selection before the next header, including restoring the default', () => {
  const events = [{ type: 'request/header' }], config = { provider: PROVIDER, model: MODEL, reasoningEffort: 'web-on' }
  const agent = { options: {}, session: { snapshotEvents: () => events, requestHeader: () => ({ config }) } }
  assert.equal(compactionThinking(agent), true)
  events.push({ type: 'model/selection', data: { provider: PROVIDER, model: MODEL, reasoningEffort: 'off' } })
  assert.equal(compactionThinking(agent), false)
  config.reasoningEffort = 'off'; events.push({ type: 'request/header' })
  assert.equal(compactionThinking(agent), false)
  events.push({ type: 'model/selection', data: { provider: PROVIDER, model: MODEL } })
  assert.equal(compactionThinking(agent), true)
})

async function harness({ auto = true, count = 500, shrinkFailure = false, preset = false, basic = {} } = {}) {
  const f = await setup(), ctx = new Context()
  let adapter
  f.web.modelType = 'default'
  f.web.models = [{ model_type: 'default', file_feature: { token_limit: 1000, token_limit_with_thinking: 1000 }, input_character_limit: 100000 }]
  f.web.usageValue = (body, editing) => editing ? 234 : body.chat_session_id === 'chat-1' ? count : 73
  f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'final', text: 'Recorded OLD_FACT. ' + 'historical detail '.repeat(180) })
  f.web.summary = () => shrinkFailure ? 'not smaller '.repeat(10000) : '## Current Work\n- Preserve OLD_FACT.\n## Next Step\n- Answer the retained request.'
  for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SessionProjectionRegistry, ToolRuntime, SystemPrompt, TokenMeter]) await ctx.plugin(plugin)
  await installNativeToolExecutor(ctx)
  const disk = { fail: false }
  ctx.on('session/flush', async session => { if (disk.fail) throw new Error('fixture disk failure'); await writeFile(join(f.home, 'native.json'), JSON.stringify(session.snapshotEvents())) })
  const native = new DshBoundary(ctx, attempt => { void adapter?.reconcile(attempt) })
  adapter = new TokenFreeAdapter({ sessionStoreId: 'native-compaction' }, { store: f.store, native,
    credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }), client: (_, context) => f.web.client(context.diagnostics, context.operationId) })
  new TokenFreeGateway(ctx, { status: () => ({ state: 'connected' }) }, adapter)
  ctx.llm.registerAdapter([PROVIDER], adapter)
  if (preset) {
    await ctx.plugin(Loader, { baseUrl: new URL('../package.json', import.meta.url).href })
    ctx.loader.builtins.group = Group
    await ctx.plugin(Presets, { default: 'standard' })
    await ctx.agentPresets.register({ id: 'standard', plugins: [{ id: 'compaction', name: 'cordis:group', group: true,
      isolate: { compaction: true }, config: [{ id: 'compaction-basic', name: '@deepseek-ai/dsh-compaction-basic', config: { ...basic, auto } }] }] })
  } else await ctx.plugin(BasicCompaction, { ...basic, auto })
  let compaction
  const main = await ctx.plugin(scope => { compaction = installCompaction(scope) })
  await ctx.plugin(AgentLoop, { agents: [] })
  const create = async id => preset ? (await ctx.agents.create({ sessionId: SessionId(id), agentOptions: { provider: PROVIDER, model: MODEL },
    setup: async scope => { await ctx.agentPresets.mount(scope, 'standard') } })).agent
    : ctx.agentLoop.create(SessionId(id), { provider: PROVIDER, model: MODEL })
  const agent = await create('native-compaction')
  const ask = async text => {
    agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile()
  }
  return { ...f, ctx, adapter, agent, ask, disk, native, main, compaction, create, pending: async () => f.store.pending((await adapter.engine()).key(agent.id)), close: async () => { adapter.dispose(); await ctx.fiber.dispose(); await f.close() } }
}

test('real standard preset Loader slot gains 50 percent compaction without editing its declaration or enabling another backend', { timeout: 20000 }, async () => {
  const f = await harness({ preset: true, auto: false })
  try {
    const native = await f.compaction.ensure(f.agent)
    assert(native instanceof Compaction)
    assert.equal((await f.ctx.tokenfree.usage(f.agent.id)).backend, 'ready')
    await f.ask('Remember OLD_FACT. ' + 'original context '.repeat(180))
    await f.ask('Continue through automatic standard-mode compaction')
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.chats.size, 2)
    assert.equal(f.agent.session.snapshotEvents().filter(x => x.type === 'compaction/summary').length, 1)
    assert.equal(f.agent.session.snapshotEvents().filter(x => x.type === 'user/message' && x.data.source.kind === 'compact-checkpoint').length, 1)
    const document = await f.ctx.agentPresets.readDocument('standard')
    assert(JSON.stringify(document).includes('@deepseek-ai/dsh-compaction-basic'))
    await f.main.dispose()
    const restored = f.ctx.agentPresets.serviceFor(f.agent, 'compaction')
    assert(restored instanceof BasicCompaction); assert(!(restored instanceof Compaction)); assert.equal(restored.config.auto, false)
  } finally { await f.close() }
})

test('main-plugin wiring upgrades stock Basic once and restores it on unload with other-model auto policy intact', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200, basic: { modelPolicies: [
    { provider: PROVIDER, model: MODEL, retainRatio: .2 }, { provider: 'other', model: 'other', retainTokens: 1234 }] } })
  try {
    assert(f.ctx.compaction instanceof Compaction)
    const a = await f.ctx.agentLoop.create(SessionId('parallel-wiring'), { provider: PROVIDER, model: MODEL })
    const [one, two] = await Promise.all([f.compaction.ensure(f.agent), f.compaction.ensure(a)])
    assert(one instanceof Compaction); assert(two instanceof Compaction)
    assert.equal(one.config.modelPolicies.find(x => x.provider === PROVIDER).retainTokens, 0)
    assert.equal(one.config.modelPolicies.find(x => x.provider === PROVIDER).retainRatio, undefined)
    assert.equal(one.config.modelPolicies.find(x => x.provider === 'other').retainTokens, 1234)
    assert.equal(await one.compactIfNeeded({ options: { provider: 'other', model: 'other' }, session: { requestHeader: () => undefined } }, 'pressure', AbortSignal.timeout(5000)), null)
    await f.main.dispose()
    assert(f.ctx.compaction instanceof BasicCompaction)
    assert(!(f.ctx.compaction instanceof Compaction))
    assert.equal(f.ctx.compaction.config.auto, false)
    assert.equal(f.ctx.compaction.config.modelPolicies.find(x => x.provider === PROVIDER).retainRatio, .2)
  } finally { await f.close() }
})

test('official 50 percent triggers real native checkpoint, summarizes precise prefix in original chat, then bootstraps new chat', { timeout: 20000 }, async () => {
  const f = await harness()
  try {
    await f.ask('Remember OLD_FACT. ' + 'original context '.repeat(180))
    assert.equal(f.web.edits.length, 0)
    await f.ask('RETAINED_TAIL_ONLY: continue the work')
    const events = f.agent.session.snapshotEvents()
    assert.equal(f.web.edits.length, 1)
    assert.equal(f.web.edits[0].chat_session_id, 'chat-1')
    assert.equal(f.web.edits[0].message_id, 1)
    assert.equal(f.web.chats.size, 2)
    assert.equal(f.web.generations.length, 2)
    const exact = JSON.parse(f.web.edits[0].prompt.split('DSH_COMPACTION_INPUT_JSON:\n')[1])
    assert.equal(JSON.stringify(exact).includes('RETAINED_TAIL_ONLY'), false)
    assert.ok(JSON.stringify(exact).includes('OLD_FACT'))
    assert.match(exact.messages.at(-1).content[0].text, /compaction engine/)
    const summaries = events.filter(x => x.type === 'compaction/summary')
    assert.equal(summaries.length, 1)
    const checkpoint = events.find(x => x.type === 'user/message' && x.data.source.kind === 'compact-checkpoint')
    assert.ok(checkpoint)
    assert.equal(checkpoint.data.source.compactionId, summaries[0].data.compactionId)
    const bootstrap = payload(f.web.generations[1].prompt)
    assert.equal(bootstrap.mode, 'bootstrap')
    assert.ok(JSON.stringify(bootstrap).includes('<compacted-summary>'))
    assert.ok(JSON.stringify(bootstrap).includes('RETAINED_TAIL_ONLY'))
    assert.equal(bootstrap.messages.some(x => x.content.some(b => b.type === 'text' && b.text.includes('original context original context'))), false)
    // Native pre-step can compact before the next user is ingested; its retained assistant must survive.
    assert.ok(bootstrap.messages.some(x => x.role === 'assistant'))
    assert.equal(f.web.generations[1].parent_message_id, null)
    assert.ok(f.web.chats.get('chat-1').some(x => x.message_id === 1))
    const view = await f.adapter.usage(f.agent.id)
    assert.equal(view.count, 73)
    assert.equal(view.compaction, 'complete')
    assert.equal(view.reached, false)
    assert.equal((await f.ctx.tokenfree.usage(f.agent.id)).backend, 'ready')
    assert.equal((await f.pending()), undefined)
  } finally { await f.close() }
})

test('default B with official C at 50 percent still runs native checkpoint and new-chat continuation', { timeout: 20000 }, async () => {
  const f = await harness({ count: 445440 })
  f.web.settingsResponse = () => new Response('settings unavailable', { status: 503 })
  try {
    await f.ask('Remember OLD_FACT. ' + 'original context '.repeat(180))
    const before = await f.adapter.usage(f.agent.id)
    assert.equal(before.count, 445440); assert.equal(before.budget, 890880)
    assert.equal(before.budgetSource, 'default'); assert.equal(before.threshold, 445440); assert.equal(before.reached, true)
    await f.ask('Continue with the retained task after default-budget pressure')
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.chats.size, 2)
    const events = f.agent.session.snapshotEvents()
    assert.equal(events.filter(x => x.type === 'compaction/summary').length, 1)
    assert.equal(events.filter(x => x.type === 'user/message' && x.data.source.kind === 'compact-checkpoint').length, 1)
    assert.equal(payload(f.web.generations[1].prompt).mode, 'bootstrap')
    assert.equal(f.web.generations[1].parent_message_id, null)
    assert.equal((await f.adapter.usage(f.agent.id)).count, 73)
    assert.equal((await f.pending()), undefined)
  } finally { await f.close() }
})

test('below effective threshold and default budgets do not use native estimated pressure to trigger summaries', { timeout: 20000 }, async () => {
  const f = await harness({ count: 499 })
  try {
    await f.ask('Large source ' + 'very long '.repeat(1000))
    await f.ask('Keep going')
    assert.equal(f.web.edits.length, 0); assert.equal(f.web.chats.size, 1)
    f.web.models = []
    await f.ask('Continue with budget unknown')
    assert.equal(f.web.edits.length, 0)
    const view = await f.adapter.usage(f.agent.id)
    assert.equal(view.budget, 890880); assert.equal(view.budgetSource, 'default'); assert.equal(view.reached, false)
  } finally { await f.close() }
})

test('native manual compaction below 50 percent still owns shrink checks, checkpoint framing and idle maintenance', { timeout: 20000 }, async () => {
  const f = await harness({ count: 200 })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    const result = await f.ctx.compaction.compactNow(f.agent, AbortSignal.timeout(5000))
    assert.ok(result)
    assert.equal((await f.adapter.usage(f.agent.id)).state, 'new-chat')
    assert.equal(f.web.chats.size, 1)
    await f.ask('Continue after manual summary')
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.chats.size, 2)
  } finally { await f.close() }
})

test('native shrink rejection keeps its original surface and prevents automatic re-summary or ordinary generation', { timeout: 20000 }, async () => {
  const f = await harness({ shrinkFailure: true })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    await f.ask('Continue after failed shrink')
    const checkpoints = () => f.agent.session.snapshotEvents().filter(x => x.type === 'user/message' && x.data.source.kind === 'compact-checkpoint')
    assert.equal(checkpoints().length, 0)
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.generations.length, 1)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'failed')
    assert.equal((await f.pending()), undefined)
    await f.ask('Automatic retry must stay blocked')
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.generations.length, 1)
    f.web.summary = () => '## Current Work\n- Preserve the original facts.\n## Next Step\n- Continue.'
    await f.ctx.compaction.compactNow(f.agent, AbortSignal.timeout(5000))
    assert.equal(checkpoints().length, 1); assert.equal(f.web.edits.length, 2)
  } finally { await f.close() }
})

test('summary disconnect resumes exactly its original response without editing the root twice', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200 })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    f.web.completion = x => sse(x.ready + frame(snapshot(x.text.slice(0, 10), 'WIP')))
    await f.ctx.compaction.compactNow(f.agent, AbortSignal.timeout(5000))
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.resumes.length, 1)
    assert.equal(f.web.resumes[0].message_id, f.web.chats.get('chat-1').at(-1).message_id)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'needs-new-chat')
  } finally { await f.close() }
})

test('failed checkpoint flush and failed new-chat preparation recover without a second summary or another empty chat', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200 })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    f.disk.fail = true
    await assert.rejects(f.ctx.compaction.compactNow(f.agent, AbortSignal.timeout(5000)))
    const active = (await f.pending())
    assert.equal(active.kind, 'compaction')
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'awaiting-checkpoint')
    assert.equal(f.web.chats.size, 1)
    // New process objects, same persisted association and public native evidence.
    const { SessionEngine } = await import('../lib/core/session.js')
    const restored = new SessionEngine({ store: f.store, storeId: active.storeId, native: f.native, maxPromptChars: 120000 })
    f.disk.fail = false
    assert.equal(await restored.reconcile(), true)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'needs-new-chat')
    f.web.preparing = () => envelope({}, 40300)
    await f.ask('Initialization must not submit')
    assert.equal(f.web.chats.size, 2); assert.equal(f.web.generations.length, 1)
    assert.equal((await f.pending()), undefined)
    f.web.preparing = undefined
    await f.ask('Retry only new-chat initialization')
    assert.equal(f.web.chats.size, 2); assert.equal(f.web.edits.length, 1); assert.equal(f.web.generations.length, 2)
    assert.equal((await f.adapter.usage(f.agent.id)).count, 73)
  } finally { f.disk.fail = false; await f.close() }
})

test('loss of the preserved original Web branch rejects the summary before a native checkpoint', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200 })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    f.web.completion = x => { f.web.chats.set('chat-1', [x.user, x.assistant]); return sse(x.ready + frame(snapshot(x.text))) }
    await assert.rejects(f.ctx.compaction.compactNow(f.agent, AbortSignal.timeout(5000)))
    assert.equal(f.web.edits.length, 1)
    assert.equal(f.agent.session.snapshotEvents().some(x => x.type === 'compaction/summary'), false)
    assert.equal(f.web.chats.size, 1)
    assert.equal((await f.pending()).stage, 'uncertain')
  } finally { await f.close() }
})

test('cancelling a native summary stops its original response independently and creates no checkpoint', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200 }), cancel = new AbortController()
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    f.web.completion = x => {
      x.assistant.status = 'WIP'
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(x.ready + frame(snapshot(x.text.slice(0, 10), 'WIP'))))
        setTimeout(() => cancel.abort(), 100)
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    await assert.rejects(f.ctx.compaction.compactNow(f.agent, cancel.signal))
    assert.equal(f.web.edits.length, 1); assert.equal(f.web.stops.length, 1)
    assert.equal(f.web.stops[0].aborted, false)
    assert.equal(f.agent.session.snapshotEvents().some(x => x.type === 'compaction/summary'), false)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'failed')
    assert.equal((await f.ctx.tokenfree.usage(f.agent.id)).backend, 'ready')
    assert.equal((await f.pending()), undefined)
  } finally { await f.close() }
})

test('summary cancellation stops the ready response before waiting for lagging complete history', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200 }), cancel = new AbortController()
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    const fetch = f.web.fetch
    let pendingReads = 0
    f.web.fetch = async (url, options) => {
      if (new URL(url).pathname.endsWith('/history_messages') && f.web.edits.length) {
        assert.equal(f.web.stops.length, 1, 'ready identifies the accepted response before history is replicated')
        if (++pendingReads === 1) return envelope({ cache_control: 'APPEND', chat_messages: [] })
        if (pendingReads === 2) return envelope({ cache_control: 'REPLACE', chat_messages: [] })
      }
      return fetch(url, options)
    }
    f.web.completion = x => {
      x.assistant.status = 'WIP'
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(x.ready))
        setTimeout(() => cancel.abort(), 100)
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    await assert.rejects(f.ctx.compaction.compactNow(f.agent, cancel.signal))
    assert.equal(f.web.stops.length, 1)
    assert.equal(f.web.stops[0].aborted, false)
    assert.equal(pendingReads, 3)
    assert.equal(f.web.edits.length, 1)
    assert.equal(f.agent.session.snapshotEvents().some(x => x.type === 'compaction/summary'), false)
    assert.equal((await f.pending()), undefined)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'failed')
  } finally { await f.close() }
})

test('real Web context-limit status uses native overflow recovery without inventing a window or estimated trigger', { timeout: 20000 }, async () => {
  const f = await harness({ count: 200 })
  try {
    await f.ask('Original source ' + 'facts '.repeat(600))
    let rejected = false
    f.web.completion = x => {
      if (!x.editing && !rejected) { rejected = true; x.assistant.status = 'CONTEXT_LENGTH_EXCEEDED'; return sse(x.ready + frame(snapshot('', x.assistant.status))) }
      return sse(x.ready + frame(snapshot(x.text)))
    }
    await f.ask('Large retained new input')
    assert.equal(f.web.edits.length, 1)
    assert.equal(f.web.chats.size, 2)
    assert.equal(f.web.generations.length, 3)
    assert.equal((await f.adapter.usage(f.agent.id)).compaction, 'complete')
    assert.equal(f.agent.session.snapshotEvents().filter(x => x.type === 'compaction/summary').length, 1)
  } finally { await f.close() }
})

test('other provider manual compaction keeps the native summarizer and never enters the Web bridge', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false })
  const calls = []
  class Other extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: 'Other fixture', contextWindow: 100000 } }
    async *stream(options) {
      calls.push(options)
      const text = options.purpose === 'compaction' ? 'Preserve the other provider facts.' : 'An ordinary other-provider reply.'
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'text-delta', index: 0, text }
      yield { type: 'block-end', index: 0, block: { type: 'text', text } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
  }
  try {
    f.ctx.llm.registerAdapter(['fixture-other'], new Other())
    const agent = await f.ctx.agentLoop.create(SessionId('other-session'), { provider: 'fixture-other', model: 'other' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Original context '.repeat(600) }], source: { kind: 'user' } }))
    await agent.whenIdle()
    const result = await f.ctx.compaction.compactNow(agent, AbortSignal.timeout(5000))
    assert.ok(result)
    assert.equal(calls.filter(x => x.purpose === 'compaction').length, 1)
    assert.equal(calls.at(-1).provider, 'fixture-other')
    assert.equal(f.web.requests.length, 0)
    assert.equal(agent.session.snapshotEvents().filter(x => x.type === 'compaction/summary').length, 1)
  } finally { await f.close() }
})

test('standard-preset A summary overlaps B generation; exact summary stop never cancels B or a replacement operation', { timeout: 20000 }, async () => {
  const f = await harness({ auto: false, count: 200, preset: true })
  let summary
  try {
    await f.ask('A source ' + 'facts '.repeat(600))
    f.web.completion = x => {
      if (!x.editing) return sse(x.ready + frame(snapshot(x.text)))
      x.assistant.status = 'WIP'
      return new Response(new ReadableStream({ start(controller) {
        controller.enqueue(new TextEncoder().encode(x.ready + frame(snapshot(x.text.slice(0, -3), 'WIP'))))
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    summary = (await f.compaction.ensure(f.agent)).compactNow(f.agent, AbortSignal.timeout(10000))
    const rejected = assert.rejects(summary)
    const deadline = Date.now() + 3000
    while ((await f.adapter.operationStatus(f.agent.id)).stage !== 'receiving') {
      if (Date.now() > deadline) throw new Error('summary never started')
      await new Promise(r => setTimeout(r, 5))
    }
    const pending = await f.adapter.operationStatus(f.agent.id)
    await assert.rejects(f.adapter.cancelSummary(f.agent.id, 'old-operation', pending.compactionId), e => e.code === 'OPERATION_CHANGED')
    assert.equal(f.web.stops.length, 0)
    const b = await f.create('parallel-B')
    b.followup(createUserMessage({ content: [{ type: 'text', text: 'B finishes while A summarizes' }], source: { kind: 'user' } }))
    await b.whenIdle(); await f.adapter.reconcile(b.id)
    assert.ok(b.session.snapshotEvents().some(x => x.type === 'assistant/message'))
    assert.equal((await f.adapter.operationStatus(f.agent.id)).operationId, pending.operationId)
    assert.equal((await f.adapter.usage(b.id)).count, 73)
    await f.adapter.cancelSummary(f.agent.id, pending.operationId, pending.compactionId); await rejected
    assert.equal(f.agent.session.snapshotEvents().some(x => x.type === 'compaction/summary'), false)
    assert.equal(f.web.stops.length, 1)
    assert.equal(f.web.stops[0].body.chat_session_id, 'chat-1')
    assert.equal((await f.adapter.inspect(b.id)).needsRebase, false)
    assert.equal((await f.adapter.usage(b.id)).count, 73)
  } finally { await Promise.allSettled([summary]); await f.close() }
})

test('native compaction ignores normal JSON output and preserves the pending one-shot tool requirement', {timeout:15000},async()=>{
 const f=await harness({count:10})
 try{
  await f.ask('Remember OLD_FACT. '+ 'historical detail '.repeat(180))
  const state=await f.adapter.setPolicy(f.agent.id,{tools:{mode:'required'},output:{type:'schema',schema:{type:'integer'}}})
  await f.ctx.compaction.compactNow(f.agent,new AbortController().signal)
  assert.equal(f.web.edits.length,1)
  assert.equal(f.agent.session.snapshotEvents().filter(x=>x.type==='compaction/summary').length,1)
  assert.deepEqual(await f.adapter.policy(f.agent.id),state)
 }finally{await f.close()}
})
