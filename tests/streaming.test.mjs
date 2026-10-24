import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { FinalDecoder, strictJson, decodeResponse } from '../lib/core/codec.js'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { setup, input, frame, snapshot, sse, collect } from './helpers/fixture.mjs'

const result = events => events.find(x => x.type === 'result')
test('incremental decoder handles split escapes, unicode and protocol order without exposing JSON wrapper', () => {
  const text = '引号"换行\nemoji😀 backslash\\'
  for (const encoded of [JSON.stringify(text), '"\\u4f60\\u597d\\ud83d\\ude00"']) {
    const decoder = new FinalDecoder('op')
    const source = `{"protocol_version":1,"request_id":"op","kind":"final","text":${encoded}}`
    for (const c of source) decoder.append(c)
    assert.equal(decoder.text, JSON.parse(encoded))
  }
  const reversed = new FinalDecoder('op'); reversed.append('{"text":"hidden until validation","kind":"final","request_id":"op","protocol_version":1}')
  assert.equal(reversed.text, '')
  assert.throws(() => strictJson('{"nested":{"x":1,"x":2}}'))
})

test('text reaches consumer before Web finishes; reasoning and resumed text are deduplicated', async () => {
  const f = await setup(); let complete
  try {
    f.web.completion = ({ ready, text }) => new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode(ready + frame(snapshot(text.slice(0, -2), 'WIP', 'real thought'))))
      complete = () => { controller.enqueue(new TextEncoder().encode(frame(snapshot(text, 'FINISHED', 'real thought')))); controller.close() }
    } }), { headers: { 'content-type': 'text/event-stream' } })
    const i = input(); f.native.begin(i.sessionId)
    const iterator = f.engine.run(i, f.accountKey, f.web.client(), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    const first = await iterator.next(), second = await iterator.next()
    assert.equal(first.value.type, 'reasoning'); assert.equal(first.value.text, 'real thought')
    assert.equal(second.value.type, 'text'); assert.equal(second.value.text, 'answer')
    assert.ok((await f.pending()))
    complete()
    const last = await iterator.next(); assert.equal(last.value.type, 'result')
    f.native.save(last.value); await f.engine.reconcile(); await iterator.return()
  } finally { await f.close() }
})

test('non-prefix revision freezes deltas and replaces validated final block instead of concatenation', async () => {
  const f = await setup()
  try {
    f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text.replace('answer', 'old preview'), 'WIP')) + frame(snapshot(text)))
    const events = await f.run()
    assert.equal(events.filter(x => x.type === 'text').map(x => x.text).join(''), 'old preview')
    assert.equal(result(events).blocks[0].text, 'answer')
  } finally { await f.close() }
})

test('clear_response withdraws output and malformed/error SSE is logged before rejection', async () => {
  for (const ending of [frame({ clear_response: true }, 'hint'), 'data: malformed-json\n\n', frame({ privateFixtureError: true }, 'error')]) {
    const f = await setup(home => new LocalDiagnostics(home, false))
    try {
      f.web.completion = ({ ready, text }) => sse(ready + frame(snapshot(text.slice(0, -2), 'WIP')) + ending)
      const events = []
      f.native.begin('session-1')
      await assert.rejects(async () => { for await (const event of f.engine.run(input(), f.accountKey, f.web.client(f.log), AbortSignal.timeout(5000), (text, id) => decodeResponse(text, [], id))) events.push(event) })
      assert.equal(events.some(x => x.type === 'result'), false)
      if (ending.includes('clear_response')) assert.ok(events.some(x => x.type === 'withdraw'))
      await f.log.flush()
      const source = await readFile(join(f.log.contentDirectory, (await readdir(f.log.contentDirectory))[0]), 'utf8')
      assert.ok(source.includes(ending.includes('malformed') ? 'malformed-json' : ending.includes('privateFixtureError') ? 'privateFixtureError' : 'clear_response'))
    } finally { await f.close() }
  }
})

test('cross-process account epoch revocation stops ongoing generation without emitting a success', async () => {
  const f = await setup()
  const cleanup = new AbortController()
  let connection, iterator, streamCancelled = false
  try {
    f.web.completion = ({ ready, text, assistant }) => {
      assistant.status = 'WIP'
      return new Response(new ReadableStream({
        start(c) {
          // A real HTTP connection keeps Node alive; an in-memory stream does not.
          connection = setInterval(() => {}, 1000)
          c.enqueue(new TextEncoder().encode(ready + frame(snapshot(text.slice(0, -2), 'WIP'))))
        },
        cancel() { clearInterval(connection); streamCancelled = true },
      }), { headers: { 'content-type': 'text/event-stream' } })
    }
    const i = input(); const attempt = f.native.begin(i.sessionId)
    iterator = f.engine.run(i, f.accountKey, f.web.client(), AbortSignal.any([cleanup.signal, AbortSignal.timeout(5000)]), (text, id) => decodeResponse(text, [], id))[Symbol.asyncIterator]()
    assert.equal((await iterator.next()).value.type, 'text')
    await f.store.revoke()
    await assert.rejects(iterator.next(), error => error.code === 'ABORTED')
    assert.equal(streamCancelled, true)
    assert.equal(f.web.stops.length, 1)
    f.native.cancel(attempt); await f.engine.reconcile()
    assert.equal((await f.engine.inspect(i.sessionId)).session.needsRebase, true)
  } finally {
    cleanup.abort()
    clearInterval(connection)
    await iterator?.return()
    await f.close()
  }
})
