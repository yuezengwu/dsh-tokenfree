import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, stat, chmod, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { saveCredential, readCredential, normalizeCredential } from '../lib/local/auth.js'
import { WebResponseState, readWebResponse } from '../lib/deepseek-web/sse.js'
import { encodeRequest, decodeResponse, encodeFormatRepair, responseShape, WebResponseFormatError } from '../lib/core/codec.js'
import { DeepSeekWebClient } from '../lib/deepseek-web/client.js'

const tool = { name: 'read_marker', description: 'Read a local marker.', parameters: { type: 'object', properties: {}, additionalProperties: false } }
const snapshot = (text, status = 'FINISHED') => ({ v: { response: { status, fragments: [{ type: 'THINK', content: 'private thought' }, { type: 'RESPONSE', content: text }] } } })
const sse = frames => new Response(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
const envelope = data => Response.json({ code: 0, data: { biz_code: 0, biz_data: data } })

test('single account file is private, replaceable, and refuses public permissions', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'tokenfree-auth-'))
  const file = join(dir, 'credentials.json')
  try {
    assert.equal(await readCredential(file), undefined)
    await saveCredential({ token: 'Bearer web-one' }, file)
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await readCredential(file)).token, 'web-one')
    await saveCredential({ token: 'web-two' }, file)
    assert.equal((await readCredential(file)).token, 'web-two')
    assert.equal((await readFile(file, 'utf8')).includes('web-one'), false)
    await chmod(file, 0o644)
    await assert.rejects(readCredential(file), /permissions/)
    assert.throws(() => normalizeCredential([{ token: 'not-a-pool' }]), /single/)
    assert.throws(() => normalizeCredential({ token: 'secret\nheader' }), error => !error.message.includes('secret'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Web SSE decodes snapshots, compressed appends, and relative batches without leaking thinking', async () => {
  const frames = [snapshot('你', 'WIP'), { p: 'response', o: 'BATCH', v: [
    { p: 'fragments/-1/content', o: 'APPEND', v: '好' }, { v: '！' }, { p: 'status', o: 'SET', v: 'FINISHED' },
  ] }]
  const bytes = new TextEncoder().encode(frames.map(f => `data: ${JSON.stringify(f)}\r\n\r\n`).join(''))
  let offset = 0
  const response = new Response(new ReadableStream({ pull(controller) {
    if (offset === bytes.length) return controller.close()
    controller.enqueue(bytes.slice(offset, ++offset))
  } }), { headers: { 'content-type': 'text/event-stream' } })
  assert.equal(await readWebResponse(response), '你好！')
})

test('disconnect, invalid JSON, failed completion and forbidden patch paths fail closed', async () => {
  await assert.rejects(readWebResponse(sse([snapshot('{"kind":"tool"}', 'WIP')])), /disconnected/)
  await assert.rejects(readWebResponse(sse([snapshot('filtered', 'CONTENT_FILTER')])), /did not complete/)
  await assert.rejects(readWebResponse(new Response('data: bad-json\n\n', { headers: { 'content-type': 'text/event-stream' } })), /Invalid JSON/)
  const state = new WebResponseState()
  assert.throws(() => state.apply({ p: '__proto__/polluted', v: true }), /patch path/)
  assert.equal({}.polluted, undefined)
})

test('prompt retains system, ordered tool history and real call IDs; never truncates', () => {
  const options = { provider: 'p', model: 'm', system: 'system-exact', tools: [tool], messages: [
    { role: 'user', content: [{ type: 'text', text: 'question' }] },
    { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'read_marker', arguments: '{}' }] },
    { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, content: [{ type: 'text', text: 'actual-marker' }] },
  ] }
  const encoded = encodeRequest(options, 20000)
  const payload = JSON.parse(encoded.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:\n')[0])
  assert.equal(payload.system, 'system-exact')
  assert.equal(payload.messages[2].callId, 'call-1')
  assert.equal(payload.messages[2].content[0].text, 'actual-marker')
  assert.deepEqual(payload.tools, [tool])
  assert.equal(payload.protocol_version, 1)
  assert.equal(payload.mode, 'bootstrap')
  assert.throws(() => encodeRequest(options, 20), /exceeds/)
})

test('format correction preserves full request context, treats candidate as data and refuses oversize input', () => {
  const options = { provider: 'p', model: 'm', system: 'exact-system', tools: [tool], messages: [{ role: 'user', content: [{ type: 'text', text: 'exact-question' }] }] }
  const candidate = '{"kind":"final","text":"exact answer"}'
  const prompt = encodeFormatRepair(options, candidate, 20000, 'fixture-id')
  assert.match(prompt, /FORMAT_REPAIR fixture-id/)
  assert.equal(prompt.split('CANDIDATE_JSON:\n')[1], candidate)
  assert.throws(() => encodeFormatRepair(options, candidate, 10), error => error.code === 'WEB_TOOL_FORMAT')
  assert.equal(responseShape('```json\n{}\n```'), 'fenced')
  assert.equal(responseShape('<tool_call>fixture</tool_call>'), 'tagged')
  assert.equal(responseShape('hello'), 'plain-text')
  assert.equal(responseShape('{}'), 'json-object')
  assert.throws(() => decodeResponse('hello', [tool]), error => error instanceof WebResponseFormatError && !error.repairable)
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"unregistered","arguments":{}}]}', [tool]), error => error instanceof WebResponseFormatError && !error.repairable)
})

test('only complete valid batches of declared tool calls become executable', () => {
  const blocks = decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":{}}]}', [tool])
  assert.equal(blocks[0].type, 'tool-call')
  assert.equal(blocks[0].name, 'read_marker')
  assert.equal(blocks[0].arguments, '{}')
  assert.match(blocks[0].id, /^tokenfree_/)
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":{}},{"name":"shell","arguments":{}}]}', [tool]), /Unknown tool/)
  assert.throws(() => decodeResponse('example: {"kind":"tool"}', [tool]), error => error.code === 'WEB_TOOL_FORMAT')
  assert.throws(() => decodeResponse('{"kind":"tool","calls":[{"name":"read_marker","arguments":"bad"}]}', [tool]), /arguments/)
  assert.deepEqual(decodeResponse('{"kind":"final","text":"A quoted tool call is only text."}', [tool]), [{ type: 'text', text: 'A quoted tool call is only text.' }])
})

test('client sends only Web credential to official Web origin, with DSH attribution and no redirects', async () => {
  const requests = []
  const client = new DeepSeekWebClient({ token: 'fixture-web-token' }, {
    headers: { 'user-agent': 'fixture-attribution' }, fetch: async (url, options) => {
      requests.push({ url, options })
      if (url.endsWith('/chat_session/create')) return envelope({ chat_session: { id: 'owned-session' } })
      if (url.endsWith('/create_pow_challenge')) return envelope({ challenge: { algorithm: 'DeepSeekHashV1', challenge: 'fixture', salt: 'salt', signature: 'signature', difficulty: 1, expire_at: 123 } })
      if (url.endsWith('/chat/completion')) return sse([snapshot('answer')])
      throw new Error('Unexpected endpoint')
    }, solve: async () => 'fixture-proof',
  })
  assert.equal(await client.complete('prompt-exact', AbortSignal.timeout(1000)), 'answer')
  assert.equal(requests.length, 3)
  for (const { url, options } of requests) {
    assert.equal(new URL(url).origin, 'https://chat.deepseek.com')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.authorization, 'Bearer fixture-web-token')
      assert.equal(options.headers['user-agent'], 'fixture-attribution')
    assert.equal(options.headers['x-api-key'], undefined)
    assert.equal(options.headers['x-dsh-auth-token'], undefined)
  }
  const payload = JSON.parse(requests[2].options.body)
  assert.equal(payload.prompt, 'prompt-exact')
  assert.equal(payload.parent_message_id, null)
  assert.equal(payload.model_type, null)
  assert.equal(payload.thinking_enabled, false)
  assert.equal(payload.search_enabled, false)
})

test('authentication, rate limits, redirects, and raw upstream errors never trigger another account or API', async () => {
  for (const status of [401, 403, 429, 402]) {
    let calls = 0
    const client = new DeepSeekWebClient({ token: 'fixture-secret' }, { fetch: async () => { calls++; return new Response('fixture-secret', { status }) } })
    await assert.rejects(client.complete('hello', AbortSignal.timeout(1000)), error => !error.message.includes('fixture-secret'))
    assert.equal(calls, 1)
  }
})
