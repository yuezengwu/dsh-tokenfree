import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setup, input, user, payload, frame, snapshot, sse, collect, tool } from './helpers/fixture.mjs'
import { decodeResponse } from '../lib/core/codec.js'
import { SessionEngine } from '../lib/core/session.js'
import { LocalStore } from '../lib/local/store.js'

const result = events => events.find(x => x.type === 'result')

test('native commit gates cursor; same session and restart reuse chat and send only increments', async () => {
  const f = await setup()
  try {
    const firstInput = input()
    const first = result(await f.run(firstInput))
    assert.equal((await f.engine.inspect('session-1')).session, undefined)
    assert.equal((await f.pending()).stage, 'awaiting-native')
    const assistant = f.native.save(first)
    await f.engine.reconcile()
    const saved = (await f.engine.inspect('session-1')).session
    assert.equal(saved.parentId, 2)
    assert.equal(saved.usage.accumulated_token_usage, 731)
    const restarted = new SessionEngine({ store: new LocalStore(f.home), storeId: 'fixture-store', native: f.native, maxPromptChars: 120000 })
    const nextUser = user('second question')
    const i = input([...firstInput.messages, assistant, nextUser])
    f.native.begin(i.sessionId)
    const second = result(await collect(restarted.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))))
    assert.equal(f.web.chats.size, 1)
    assert.equal(f.web.generations[1].parent_message_id, 2)
    assert.deepEqual(payload(f.web.generations[1].prompt).messages, [nextUser])
    assert.equal(payload(f.web.generations[1].prompt).mode, 'delta')
    assert.equal(payload(f.web.generations[1].prompt).system, undefined)
    f.native.save(second); await restarted.reconcile()
    assert.equal((await f.pending()), undefined)
  } finally { await f.close() }
})

test('edits and forks start independent chat using effective history; old chats retained', async () => {
  const f = await setup()
  try {
    const i = input(); const a = result(await f.run(i)); f.native.save(a); await f.engine.reconcile()
    const edited = input([user('edited question', i.messages[0].id)])
    const b = result(await f.run(edited)); f.native.save(b); await f.engine.reconcile()
    const c = result(await f.run(input(edited.messages, 'fork-id'))); f.native.save(c); await f.engine.reconcile()
    assert.equal(f.web.chats.size, 3)
    assert.ok(f.web.generations.every(x => x.parent_message_id === null))
  } finally { await f.close() }
})

test('tool results and catalogue changes travel as delta with real callId and isError', async () => {
  const f = await setup()
  try {
    f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] })
    const i = input(undefined, 'session-1', [tool]); const a = result(await f.run(i)); const saved = f.native.save(a); await f.engine.reconcile()
    const toolResult = { id: 'tool-result', role: 'tool', callId: a.blocks[0].id, isError: true, content: [{ type: 'text', text: 'actual failure' }] }
    const changed = { ...tool, description: 'Updated definition.' }
    const b = result(await f.run(input([...i.messages, saved, toolResult], 'session-1', [changed]))); f.native.save(b); await f.engine.reconcile()
    const delta = payload(f.web.generations[1].prompt)
    assert.deepEqual(delta.messages, [toolResult]); assert.deepEqual(delta.tool_updates.upsert, [changed])
    assert.equal(f.web.chats.size, 1)
  } finally { await f.close() }
})

for (const resume of ['json22', 'sse']) test(`disconnect resumes original response through ${resume}, deduplicates text, never repeats completion`, async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text.slice(0, -3), 'WIP')))
    if (resume === 'sse') f.web.resumed = message => sse(frame(snapshot(message.fragments[0].content)))
    const events = await f.run()
    assert.equal(events.filter(x => x.type === 'text').map(x => x.text).join(''), 'answer')
    assert.equal(f.web.generations.length, 1); assert.equal(f.web.resumes.length, 1)
    assert.equal(f.web.resumes[0].message_id, 2)
    f.native.save(result(events)); await f.engine.reconcile()
  } finally { await f.close() }
})

test('ready lost discovers unique accepted prompt; ambiguous acceptance stays pending without replay', async () => {
  for (const ambiguous of [false, true]) {
    const f = await setup()
    try {
      f.web.completion = ({ text, user: u, assistant: a }) => {
        if (ambiguous) f.web.chats.get('chat-1').push({ ...u, message_id: 3 }, { ...a, message_id: 4, parent_id: 3 })
        return sse(frame(snapshot(text, 'WIP')))
      }
      if (ambiguous) {
        await assert.rejects(f.run(), error => error.code === 'PENDING_OPERATION')
        await assert.rejects(f.run(), error => error.code === 'PENDING_OPERATION')
        assert.ok((await f.pending()))
      } else { const a = result(await f.run()); f.native.save(a); await f.engine.reconcile() }
      assert.equal(f.web.generations.length, 1)
    } finally { await f.close() }
  }
})

test('full HTTP stream and finish marker alone cannot confirm WIP response', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => { assistant.status = 'WIP'; return sse(ready + frame(snapshot(text, 'WIP')) + frame({}, 'finish')) }
    f.web.resumed = message => sse(frame(snapshot(message.fragments[0].content, 'WIP')))
    await assert.rejects(f.run(), error => error.code === 'WEB_DISCONNECTED')
    assert.equal(f.web.generations.length, 1); assert.equal(f.web.resumes.length, 2)
    assert.equal(f.web.stops.length, 1)
  } finally { await f.close() }
})

test('consumer cancellation stops original response with independent signal, native interrupted record rebases next chat', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => { assistant.status = 'WIP'; return sse(ready + frame(snapshot(text.slice(0, -2), 'WIP'))) }
    const i = input(); const attempt = f.native.begin(i.sessionId)
    const controller = new AbortController()
    const stream = f.engine.run(i, f.accountKey, f.web.client(), controller.signal, (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    assert.equal((await stream.next()).value.type, 'text')
    controller.abort(); await stream.return()
    assert.equal(f.web.stops.length, 1); assert.equal(f.web.stops[0].aborted, false)
    assert.equal((await f.pending()).stage, 'stopped')
    f.native.cancel(attempt); await f.engine.reconcile()
    assert.equal((await f.engine.inspect(i.sessionId)).session.needsRebase, true)
    f.web.completion = undefined
    const a = result(await f.run(input([...i.messages, user('continue after stop')]))); f.native.save(a); await f.engine.reconcile()
    assert.equal(f.web.chats.size, 2); assert.equal(f.web.generations[1].parent_message_id, null)
  } finally { await f.close() }
})

test('uncertain stop blocks new generation and explicit verification resolves only original response', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text, assistant }) => { assistant.status = 'WIP'; return sse(ready + frame(snapshot(text.slice(0, -2), 'WIP'))) }
    f.web.stopping = () => { throw new TypeError('fixture unavailable') }
    const i = input(); const attempt = f.native.begin(i.sessionId)
    const stream = f.engine.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    await stream.next(); await stream.return(); f.native.cancel(attempt)
    assert.equal((await f.pending()).stage, 'uncertain')
    await assert.rejects(f.run(), error => error.code === 'PENDING_OPERATION')
    assert.equal(f.web.generations.length, 1)
    f.web.stopping = undefined
    assert.equal(await f.engine.verifyPending(f.accountKey, f.web.client(), AbortSignal.timeout(5000), 'session-1', (await f.pending()).id, true), true)
    assert.equal((await f.pending()), undefined)
  } finally { await f.close() }
})

test('flush failure and mismatched native results preserve pending; retry commits once after durable match', async () => {
  const f = await setup()
  try {
    const a = result(await f.run()); const saved = f.native.save(a)
    f.native.flushError = true; await assert.rejects(f.engine.reconcile()); assert.ok((await f.pending()))
    f.native.flushError = false
    saved.content[0].text = 'different'; await assert.rejects(f.engine.reconcile(), error => error.code === 'PENDING_OPERATION')
    saved.content[0].text = 'answer'; await f.engine.reconcile(); assert.equal((await f.pending()), undefined)
    await f.engine.reconcile(); assert.equal((await f.engine.inspect('session-1')).session.parentId, 2)
  } finally { await f.close() }
})

test('format repair stays in original operation and native saved repair response becomes next parent', async () => {
  const f = await setup()
  try {
    f.web.answer = (p, _, n) => n === 1 ? { kind: 'final', text: 'answer' } : { protocol_version: 1, request_id: p.request_id, kind: 'final', text: 'answer' }
    const i = input(); const a = result(await f.run(i)); const saved = f.native.save(a); await f.engine.reconcile()
    assert.equal(f.web.generations.length, 2); assert.equal(f.web.chats.size, 1)
    assert.equal(f.web.generations[1].parent_message_id, 2)
    assert.equal(f.web.generations[1].thinking_enabled, false)
    const b = result(await f.run(input([...i.messages, saved, user('next')]))); f.native.save(b); await f.engine.reconcile()
    assert.equal(f.web.generations[2].parent_message_id, 4)
  } finally { await f.close() }
})

test('external ancestor change requires explicit local rebuild; never silently appends', async () => {
  const f = await setup()
  try {
    const i = input(); const a = result(await f.run(i)); const saved = f.native.save(a); await f.engine.reconcile()
    f.web.chats.get('chat-1')[0].fragments[0].content = 'edited externally'
    const next = input([...i.messages, saved, user('next')])
    await assert.rejects(f.run(next), error => error.code === 'WEB_CONTEXT_CHANGED')
    assert.equal(f.web.generations.length, 1)
    await f.engine.rebuild('session-1')
    const b = result(await f.run(next)); f.native.save(b); await f.engine.reconcile()
    assert.equal(f.web.chats.size, 2)
  } finally { await f.close() }
})

for (const crash of ['before', 'after']) test(`session envelope commit is atomic when crashing ${crash} replacement`, async () => {
  const f = await setup()
  try {
    const a = result(await f.run()); f.native.save(a)
    const original = f.store.commit.bind(f.store); let injected = false
    f.store.commit = async (key, id, session) => {
      if (!injected) {
        injected = true
        if (crash === 'after') await original(key, id, session)
        throw new Error('fixture crash at atomic replacement')
      }
      return original(key, id, session)
    }
    await assert.rejects(f.engine.reconcile())
    if (crash === 'before') { assert.ok(await f.pending()); assert.equal((await f.engine.inspect('session-1')).session, undefined) }
    else { assert.equal(await f.pending(), undefined); assert.equal((await f.engine.inspect('session-1')).session.lastOperationId, a.operation.id) }
    await f.engine.reconcile()
    assert.equal(await f.pending(), undefined)
    assert.equal((await f.engine.inspect('session-1')).session.lastOperationId, a.operation.id)
    assert.equal(f.web.generations.length, 1)
  } finally { await f.close() }
})

test('revocation racing a native commit fences the cursor for rebase', async () => {
  const f = await setup()
  try {
    const a = result(await f.run()); f.native.save(a)
    const original = f.store.commit.bind(f.store)
    f.store.commit = async (key, id, session) => { await f.store.revoke(); await original(key, id, session) }
    await f.engine.reconcile()
    assert.equal((await f.engine.inspect('session-1')).session.needsRebase, true)
  } finally { await f.close() }
})

test('proven pre-submit failure clears admission without inventing a native message or advancing cursor', async () => {
  const f = await setup()
  const original = f.web.fetch
  f.web.fetch = async (url, options) => url.endsWith('/create_pow_challenge') ? new Response('', { status: 401 }) : original(url, options)
  try {
    await assert.rejects(f.run(), error => error.code === 'AUTH')
    assert.equal(f.web.generations.length, 0)
    assert.equal(await f.engine.reconcile(), true)
    assert.equal((await f.pending()), undefined)
    assert.equal((await f.engine.inspect('session-1')).session, undefined)
  } finally { await f.close() }
})

test('repair preparation rejection retains original verified response and rebases after native settlement', async () => {
  const f = await setup(); let challenges = 0
  const original = f.web.fetch
  f.web.answer = () => ({ kind: 'final', text: 'answer' })
  f.web.fetch = async (url, options) => url.endsWith('/create_pow_challenge') && ++challenges === 2 ? new Response('', { status: 401 }) : original(url, options)
  try {
    await assert.rejects(f.run(), error => error.code === 'AUTH')
    const pending = (await f.pending())
    assert.equal(pending.knownRejected, undefined)
    assert.equal(pending.identity.responseId, 2)
    assert.equal(pending.finalStatus, 'FINISHED')
    f.native.cancel(pending.native); await f.engine.reconcile()
    assert.equal((await f.engine.inspect('session-1')).session.needsRebase, true)
    assert.equal(f.web.generations.length, 1)
  } finally { await f.close() }
})
