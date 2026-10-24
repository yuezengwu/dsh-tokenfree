import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { setup, input, tool } from './helpers/fixture.mjs'
import { DeepSeekWebClient } from '../lib/deepseek-web/client.js'

test('request content is complete, private, correlated, and redacts known login credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-content-'))
  const log = new LocalDiagnostics(directory, false)
  const id = randomUUID()
  try {
    log.protect({ token: 'secret-web-token', cookie: 'session=secret-cookie-value' })
    log.content(id, 'dsh.request', { system: 'full system', messages: [{ role: 'user', content: 'full conversation content' }], tools: [{ name: 'fixture-tool', parameters: { type: 'object' } }] })
    log.content(id, 'web.response', { text: 'answer with secret-web-token and secret-cookie-value' })
    await log.flush()
    const file = join(log.contentDirectory, `${id}.jsonl`)
    const source = await readFile(file, 'utf8')
    const rows = source.trim().split('\n').map(JSON.parse)
    assert.equal(rows[0].payload.messages[0].content, 'full conversation content')
    assert.equal(rows[0].payload.tools[0].name, 'fixture-tool')
    assert.ok(rows.every(row => row.operationId === id))
    assert.ok(source.includes('full system'))
    assert.equal(source.includes('secret-web-token'), false)
    assert.equal(source.includes('secret-cookie-value'), false)
    assert.ok(rows[1].payload.text.includes('[REDACTED]'))
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal((await stat(log.contentDirectory)).mode & 0o777, 0o700)
    const events = await readFile(log.file, 'utf8')
    assert.equal(events.includes('full conversation content'), false)
    log.protect({ token: 'true' })
    log.content(id, 'web.response', { enabled: true, text: 'true' })
    await log.flush()
    const last = JSON.parse((await readFile(file, 'utf8')).trim().split('\n').at(-1))
    assert.equal(last.payload.enabled, true)
    assert.equal(last.payload.text, '[REDACTED]')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('actual wire bodies, logical SSE, rejected intent, repair and native commits are correlated without credentials', async () => {
  const f = await setup(home => new LocalDiagnostics(home, false))
  f.web.answer = (p, _, n) => n === 1 ? { kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
    : { protocol_version: 1, request_id: p.request_id, kind: 'tool', calls: [{ name: tool.name, arguments: {} }] }
  try {
    const events = await f.run(input(undefined, 'session-1', [tool]))
    f.native.save(events.find(x => x.type === 'result')); await f.engine.reconcile(); await f.log.flush()
    const files = await readdir(f.log.contentDirectory)
    assert.equal(files.length, 1)
    const source = await readFile(join(f.log.contentDirectory, files[0]), 'utf8')
    const rows = source.trim().split('\n').map(JSON.parse)
    assert.ok(rows.some(x => x.event === 'web.event' && x.payload.name === 'ready'))
    assert.ok(rows.some(x => x.event === 'web.response' && x.payload.formatStage === 'initial'))
    assert.ok(rows.some(x => x.event === 'web.response' && x.payload.formatStage === 'repair'))
    assert.ok(rows.some(x => x.event === 'native.commit'))
    assert.deepEqual(rows.filter(x => x.event === 'web.request' && x.payload.endpoint.endsWith('/completion')).map(x => x.payload.body), f.web.generations)
    for (const secret of ['fixture-secret-token', 'secret-proof', 'authorization', 'x-ds-pow-response']) assert.equal(source.includes(secret), false)
    assert.equal(new Set(rows.map(x => x.operationId)).size, 1)
  } finally { await f.close() }
})

test('content logging can be disabled without disabling lifecycle/error diagnostics', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-content-off-'))
  const log = new LocalDiagnostics(directory, false, false)
  try {
    log.content(randomUUID(), 'dsh.request', { messages: ['not recorded'] })
    log.write('model.failed', { code: 'WEB_TOOL_FORMAT' })
    await log.flush()
    await assert.rejects(stat(log.contentDirectory), error => error.code === 'ENOENT')
    assert.ok((await readFile(log.file, 'utf8')).includes('WEB_TOOL_FORMAT'))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
