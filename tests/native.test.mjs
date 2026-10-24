import { test } from 'node:test'
import assert from 'node:assert/strict'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { DshBoundary } from '../lib/dsh/native.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, payload, frame, snapshot } from './helpers/fixture.mjs'

test('actual DSH AgentLoop persists two turns and reuses Web chat through public native events and flush', { timeout: 15000 }, async () => {
  const f = await setup(), ctx = new Context()
  let adapter, flushes = 0
  const file = join(f.home, 'native-events.json')
  try {
    for (const plugin of [SessionStore, AgentRegistry, LlmRuntime, SessionProjectionRegistry, ToolRuntime, SystemPrompt]) await ctx.plugin(plugin)
    // Test persistence listener: actual public flush must finish before the plugin confirms its cursor.
    ctx.on('session/flush', async session => { await writeFile(file, JSON.stringify(session.snapshotEvents())); flushes++ })
    let native
    await ctx.plugin({ name: 'tokenfree-native-scope', inject: ['llm', 'sessions'], apply(scope) {
      native = new DshBoundary(scope, attempt => adapter?.reconcile(attempt))
      scope.effect(() => async () => { await adapter?.dispose() })
    } })
    adapter = new TokenFreeAdapter({ sessionStoreId: 'native-fixture' }, { store: f.store, native,
      credential: async () => ({ token: 'fixture-secret-token', accountId: 'fixture-owner' }), client: (_, context) => f.web.client(context.diagnostics, context.operationId) })
    ctx.llm.registerAdapter([PROVIDER], adapter)
    await ctx.plugin(AgentLoop, { agents: [] })
    const agent = await ctx.agentLoop.create(SessionId('native-session'), { provider: PROVIDER, model: MODEL })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first native turn' }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile()
    assert.equal((await f.store.pending((await adapter.engine()).key('native-session'))), undefined)
    assert.ok(flushes > 0)
    const persisted = JSON.parse(await readFile(file, 'utf8'))
    assert.ok(persisted.some(x => x.type === 'assistant/message'))
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second native turn' }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile()
    assert.equal(f.web.chats.size, 1)
    assert.equal(f.web.generations.length, 2)
    const delta = payload(f.web.generations[1].prompt)
    assert.equal(delta.mode, 'delta')
    assert.equal(delta.messages.filter(x => x.role === 'user').length, 1)
    assert.equal(delta.messages.find(x => x.role === 'user').content[0].text, 'second native turn')
    assert.equal((await f.store.pending((await adapter.engine()).key('native-session'))), undefined)
    // Actual native cancellation persists the shown prefix without a finish/replayState.
    f.web.completion = ({ ready, text, assistant }) => {
      assistant.status = 'WIP'
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode(ready + frame(snapshot(text.slice(0, -2), 'WIP'))))
      } }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const unlisten = ctx.on('agent/assistant-stream', ({ agent: owner, frame }) => {
      if (frame.type === 'chunk' && frame.chunk.type === 'text-delta') owner.cancel({ kind: 'user' })
    })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'cancel native turn' }], source: { kind: 'user' } }))
    await agent.whenIdle(); await adapter.reconcile(); unlisten()
    const interrupted = agent.session.snapshotEvents().filter(x => x.type === 'assistant/message').at(-1)
    assert.equal(interrupted.data.interrupted, true)
    assert.equal(interrupted.data.message.source.replayState, undefined)
    assert.equal(f.web.stops.length, 1)
    assert.equal((await adapter.inspect('native-session')).needsRebase, true)
    assert.equal((await f.store.pending((await adapter.engine()).key('native-session'))), undefined)
    // A one-shot host exits immediately at idle. Teardown must drain its nonblocking acknowledgement.
    delete f.web.completion
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'last one-shot turn' }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await ctx.fiber.dispose()
    assert.equal((await f.store.pending((await adapter.engine()).key('native-session'))), undefined)
  } finally { await adapter?.dispose(); await ctx.fiber.dispose(); await f.close() }
})

test('native observation refuses no persistence and ambiguous cold attempts; exact persisted end sequence disambiguates', async () => {
  const callbacks = new Map()
  let durable = false, disposed = 0, cold = false
  const attempt = { sessionId: 'native-fixture', turn: 1, step: 0, attemptId: 'attempt-1', instance: 'instance', afterSeq: 1 }
  const events = [{ seq: 2, type: 'assistant/attempt', data: { turn: 1, step: 0, stream: [] } }]
  const live = { snapshotEvents: () => events }
  const ctx = { on: (name, callback) => callbacks.set(name, callback), get: name => name === 'sessions'
    ? { get: () => cold ? undefined : live, flush: async () => durable } : { observeSession: async () => ({ events, [Symbol.dispose]: () => { disposed++ } }) },
    sessions: { flush: async () => durable } }
  const boundary = new DshBoundary(ctx, () => {})
  assert.equal(await boundary.inspect(attempt), undefined)
  durable = true
  assert.equal((await boundary.inspect(attempt)).interrupted, true)
  events.push({ ...events[0], seq: 3 })
  assert.equal(await boundary.inspect(attempt), undefined)
  assert.equal((await boundary.inspect({ ...attempt, settlementSeq: 2 })).seq, 2)
  cold = true
  assert.equal((await boundary.inspect({ ...attempt, settlementSeq: 2 })).seq, 2)
  assert.equal(disposed, 1)
  assert.equal(await boundary.inspect({ ...attempt, abandoned: true }), undefined)
})

test('cold interrupted step requires exact routed header and adjacent durable closure without tool delivery', async () => {
  const attempt = { sessionId: 'cold', turn: 2, step: 1, afterSeq: 3, instance: 'gone', attemptId: 'gone:1' }
  const events = [
    { seq: 0, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 1, type: 'user/message', data: {} },
    { seq: 2, type: 'request/header', data: { header: { config: { provider: PROVIDER, model: MODEL } } } },
    { seq: 3, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } },
  ]
  const boundary = new DshBoundary({ on() {}, get: name => name === 'sessions' ? { get: () => undefined }
    : { observeSession: async () => ({ events, [Symbol.dispose]() {} }) } }, () => {})
  assert.deepEqual(await boundary.inspect(attempt), { seq: 4, interrupted: true, durable: true })
  assert.equal(await boundary.inspect({ ...attempt, settlementSeq: 3 }), undefined)
  assert.equal(await boundary.inspect({ ...attempt, step: 2 }), undefined)
  const ending = events.pop()
  assert.equal(await boundary.inspect(attempt), undefined)
  events.push(ending)
  events[2].data.header.config.provider = 'another-provider'
  assert.equal(await boundary.inspect(attempt), undefined)
  events[2].data.header.config.provider = PROVIDER
  events.splice(3, 0, { seq: 3, type: 'tool/call', data: { turn: 2, step: 1 } })
  assert.equal(await boundary.inspect(attempt), undefined)
  // Subsequent steps can reuse an earlier routed header instead of writing another one.
  events.splice(0, events.length,
    { seq: 0, type: 'request/header', data: { header: { config: { provider: PROVIDER, model: MODEL } } } },
    { seq: 1, type: 'step/start', data: { turn: 2, step: 1 } },
    { seq: 2, type: 'user/message', data: {} },
    { seq: 3, type: 'step/end', data: { turn: 2, step: 1 } },
    { seq: 4, type: 'turn/end', data: { turn: 2, reason: { kind: 'interrupted' } } })
  assert.deepEqual(await boundary.inspect(attempt), { seq: 4, interrupted: true, durable: true })
  events.splice(2, 0, { seq: 2, type: 'tool/call', data: { turn: 2, step: 1 } })
  assert.equal(await boundary.inspect(attempt), undefined)
})
