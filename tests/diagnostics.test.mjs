import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LocalDiagnostics, failureCategory } from '../lib/local/diagnostics.js'

test('diagnostics preserve host stdout for CLI JSON output', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-diagnostics-'))
  const stdout = t.mock.method(console, 'info', () => {})
  const stderr = t.mock.method(console, 'error', () => {})
  try {
    const log = new LocalDiagnostics(directory, true)
    log.write('plugin.started')
    await log.flush()
    assert.equal(stdout.mock.callCount(), 0)
    assert.equal(stderr.mock.callCount(), 1)
    assert.match(stderr.mock.calls[0].arguments[0], /^\[dsh-tokenfree\] /)
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('local diagnostic records are ordered, private, and exclude unexpected or sensitive fields', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-diagnostics-'))
  const log = new LocalDiagnostics(directory, false)
  try {
    log.write('login.started', { phase: 'launch', token: 'private-fixture', message: 'private-fixture' })
    log.write('login.failed', { phase: 'verify', code: 'private-fixture', errorName: 'private-fixture', errorKind: 'private-fixture', endpoint: 'https://private-fixture.test/', elapsedMs: 42.4 })
    await log.flush()
    const source = await readFile(log.file, 'utf8')
    assert.equal(source.includes('private-fixture'), false)
    const records = source.trim().split('\n').map(JSON.parse)
    assert.deepEqual(records.map(record => record.sequence), [1, 2])
    assert.equal(records[1].code, 'UNKNOWN')
    assert.equal(records[1].elapsedMs, 42)
    assert.equal((await stat(log.file)).mode & 0o777, 0o600)
    const network = failureCategory(new TypeError('fetch failed private-fixture', { cause: Object.assign(new Error('private-fixture'), { code: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY' }) }))
    assert.equal(network.errorKind, 'tls')
    assert.equal(JSON.stringify(network).includes('private-fixture'), false)
    const format = failureCategory(Object.assign(new Error('private-fixture'), { code: 'WEB_TOOL_FORMAT' }))
    assert.equal(format.code, 'WEB_TOOL_FORMAT')
    log.write('model.response', { responseShape: 'plain-text', responseChars: 42, formatStage: 'initial', response: 'private-fixture' })
    await log.flush()
    const responseLog = await readFile(log.file, 'utf8')
    assert.equal(responseLog.includes('private-fixture'), false)
    assert.equal(JSON.parse(responseLog.trim().split('\n').at(-1)).responseShape, 'plain-text')
  } finally { await rm(directory, { recursive: true, force: true }) }
})
