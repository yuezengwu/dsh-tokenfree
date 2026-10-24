import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, rm, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { setup, input, user, payload, frame, snapshot, collect, tool } from './helpers/fixture.mjs'
import { LocalStore, digest } from '../lib/local/store.js'
import { SessionEngine } from '../lib/core/session.js'
import { TokenFreeError } from '../lib/core/errors.js'
import { decodeResponse } from '../lib/core/codec.js'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'
import { LocalAccount } from '../lib/core/account.js'
import { writeJson, writePrivateFile } from '../lib/local/files.js'

const waitFor = async fn => {
  const deadline = Date.now() + 4000
  while (!(await fn())) { if (Date.now() > deadline) throw new Error('expected independent progress did not occur'); await new Promise(r => setTimeout(r, 5)) }
}
const result = events => events.find(x => x.type === 'result')
function controlled(web) {
  const streams = new Map()
  web.completion = ({ ready, text, body, assistant }) => {
    assistant.status = 'WIP'
    let connection
    return new Response(new ReadableStream({ start(controller) {
      // A live HTTP socket keeps Node alive; this in-memory fixture must do the same.
      connection = setInterval(() => {}, 1000)
      controller.enqueue(new TextEncoder().encode(ready + frame(snapshot('', 'WIP'))))
      streams.set(body.chat_session_id, () => {
        clearInterval(connection)
        assistant.status = 'FINISHED'
        try { controller.enqueue(new TextEncoder().encode(frame(snapshot(text)))); controller.close() } catch {}
      })
    }, cancel() { clearInterval(connection) } }), { headers: { 'content-type': 'text/event-stream' } })
  }
  return streams
}

test('same engine runs distinct sessions concurrently and preserves tools, usage, parent chains and deltas', { timeout: 15000 }, async () => {
  const f = await setup(), streams = controlled(f.web)
  f.web.answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'final', text: p.messages.at(-1).content[0].text })
  let a, b, aDone = false
  try {
    const ia = input([user('alpha-only')], 'A', [{ ...tool, name: 'alpha_tool' }])
    const ib = input([user('beta-only')], 'B', [{ ...tool, name: 'beta_tool' }])
    a = f.run(ia).then(x => { aDone = true; return x }); b = f.run(ib)
    await waitFor(async () => (await f.pending('A'))?.stage === 'receiving' && (await f.pending('B'))?.stage === 'receiving')
    assert.equal(f.web.chats.size, 2)
    const pa = await f.pending('A'), pb = await f.pending('B')
    streams.get(pb.chatId)(); const rb = result(await b)
    assert.equal(aDone, false, 'B must complete while A remains in progress')
    const savedB = f.native.save(rb); await f.engine.reconcile('B')
    assert.equal((await f.engine.usage('B')).count, rb.operation.usage)
    assert.equal((await f.engine.usage('A')).count, undefined)
    streams.get(pa.chatId)(); const ra = result(await a)
    const savedA = f.native.save(ra); await f.engine.reconcile('A')
    assert.notEqual(pa.chatId, pb.chatId)
    assert.notEqual(pa.id, pb.id)
    assert.equal(ra.blocks[0].text, 'alpha-only'); assert.equal(rb.blocks[0].text, 'beta-only')
    for (const [chat, name, other] of [[pa.chatId, 'alpha_tool', 'beta-only'], [pb.chatId, 'beta_tool', 'alpha-only']]) {
      const p = payload(f.web.generations.find(g => g.chat_session_id === chat).prompt)
      assert.equal(p.tools[0].name, name); assert.equal(JSON.stringify(p).includes(other), false)
    }
    f.web.completion = undefined
    const nextA = user('alpha-next'), nextB = user('beta-next')
    const second = await Promise.all([f.run(input([...ia.messages, savedA, nextA], 'A', ia.tools)), f.run(input([...ib.messages, savedB, nextB], 'B', ib.tools))])
    for (const r of second.map(result)) { f.native.save(r); await f.engine.reconcile(r.operation.sessionId) }
    for (const r of f.web.generations.slice(2)) {
      const p = payload(r.prompt)
      assert.equal(p.mode, 'delta'); assert.equal(p.messages.length, 1)
      assert.equal(r.parent_message_id, r.chat_session_id === pa.chatId ? pa.identity.responseId : pb.identity.responseId)
    }
  } finally { for (const finish of streams.values()) finish(); await Promise.allSettled([a, b]); await f.close() }
})

test('cancelling A stops only its response while B completes and commits', { timeout: 15000 }, async () => {
  const f = await setup(), streams = controlled(f.web), cancel = new AbortController()
  let a, b
  try {
    a = f.run(input(undefined, 'A'), cancel.signal)
    const rejected = assert.rejects(a)
    b = f.run(input(undefined, 'B'))
    await waitFor(async () => (await f.pending('A'))?.stage === 'receiving' && (await f.pending('B'))?.stage === 'receiving')
    const pa = await f.pending('A'), pb = await f.pending('B')
    cancel.abort(); await rejected
    assert.deepEqual(f.web.stops.map(x => x.body.chat_session_id), [pa.chatId])
    assert.equal((await f.pending('B')).stage, 'receiving')
    streams.get(pb.chatId)(); const rb = result(await b); f.native.save(rb); await f.engine.reconcile('B')
    assert.equal(await f.pending('B'), undefined)
    assert.equal((await f.engine.inspect('B')).session.needsRebase, false)
    f.native.cancel(pa.native); await f.engine.reconcile('A')
    assert.equal((await f.engine.inspect('A')).session.needsRebase, true)
  } finally { for (const finish of streams.values()) finish(); await Promise.allSettled([a, b]); await f.close() }
})

test('unverified A and failed A native flush do not block B or allow stale control actions', async () => {
  const f = await setup()
  try {
    const ra = result(await f.run(input(undefined, 'A'))); f.native.save(ra)
    const original = f.native.inspect
    f.native.inspect = async attempt => { if (attempt.sessionId === 'A') throw new Error('A-only flush failure'); return original(attempt) }
    await assert.rejects(f.engine.reconcile('A'))
    const rb = result(await f.run(input(undefined, 'B'))); f.native.save(rb); await f.engine.reconcile('B')
    assert.ok(await f.pending('A')); assert.equal(await f.pending('B'), undefined)
    const requests = f.web.requests.length
    await assert.rejects(f.engine.verifyPending(f.accountKey, f.web.client(), AbortSignal.timeout(2000), 'A', randomUUID(), true), e => e.code === 'OPERATION_CHANGED')
    assert.equal(f.web.requests.length, requests)
    f.native.inspect = original; await f.engine.reconcile('A')
    const file = join(f.home, 'sessions', `${f.engine.key('A')}.json`)
    await writeFile(file, '{broken', { mode: 0o600 })
    await assert.rejects(f.engine.inspect('A'), e => e.code === 'STATE_STORAGE')
    const nextB = result(await f.run(input([user('B still works')], 'B')))
    f.native.save(nextB); await f.engine.reconcile('B')
    assert.equal(await readFile(file, 'utf8'), '{broken')
  } finally { await f.close() }
})

test('ambiguous accepted response in A remains pending while B progresses', { timeout: 15000 }, async () => {
  const f = await setup()
  try {
    const fetch = f.web.fetch
    f.web.fetch = (url, options) => new URL(url).searchParams.get('chat_session_id') === 'chat-1' ? new Response('', { status: 401 }) : fetch(url, options)
    await assert.rejects(f.run(input(undefined, 'A')), e => e.code === 'AUTH')
    assert.equal((await f.pending('A')).stage, 'uncertain')
    const rb = result(await f.run(input(undefined, 'B'))); f.native.save(rb); await f.engine.reconcile('B')
    assert.equal((await f.engine.inspect('B')).session.chatId, 'chat-2')
    assert.equal((await f.pending('A')).stage, 'uncertain')
    assert.equal(f.web.generations.length, 2)
  } finally { await f.close() }
})

test('legacy active migrates with backup and resumes after interrupted migration without replay', async () => {
  const f = await setup()
  try {
    const r = result(await f.run()), active = r.operation
    await writeJson(join(f.home, 'account.json'), { schemaVersion: 1, epoch: 0, accountKey: f.accountKey, active })
    await rm(join(f.home, 'sessions', `${active.sessionKey}.json`))
    const migrated = new LocalStore(f.home), original = migrated.writeSession.bind(migrated)
    migrated.writeSession = async (...args) => { await original(...args); throw new Error('migration crash after writing session') }
    await assert.rejects(migrated.account())
    assert.equal(JSON.parse(await readFile(join(f.home, 'account.json'), 'utf8')).schemaVersion, 1)
    const restarted = new LocalStore(f.home)
    assert.equal((await restarted.account()).schemaVersion, 2)
    assert.equal((await restarted.pending(active.sessionKey)).id, active.id)
    assert.equal(JSON.parse(await readFile(join(f.home, 'account.v1.backup.json'), 'utf8')).active.id, active.id)
    f.native.save(r)
    const engine = new SessionEngine({ store: restarted, storeId: 'fixture-store', native: f.native, maxPromptChars: 120000 })
    await engine.reconcile('session-1')
    assert.equal(await restarted.pending(active.sessionKey), undefined)
    assert.equal((await engine.inspect('session-1')).session.lastOperationId, active.id)
    assert.equal(f.web.generations.length, 1)
  } finally { await f.close() }
})

test('cross-process leases admit distinct sessions and immediately reject a duplicate writer', { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-parallel-lock-')), url = new URL('../lib/local/store.js', import.meta.url).href
  const child = key => spawn(process.execPath, ['--input-type=module', '-e', `import {LocalStore} from ${JSON.stringify(url)};try{const release=await new LocalStore(process.argv[1]).sessionLock(process.argv[2],AbortSignal.timeout(3000));process.send('acquired');process.once('message',async()=>{await release();process.disconnect()})}catch(e){process.send(e.code);process.disconnect()}`, home, key], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const children = []
  try {
    const a = child(digest('A')); children.push(a); assert.equal((await once(a, 'message'))[0], 'acquired')
    const b = child(digest('B')); children.push(b); assert.equal((await once(b, 'message'))[0], 'acquired')
    const duplicate = child(digest('A')); children.push(duplicate); assert.equal((await once(duplicate, 'message'))[0], 'SESSION_BUSY')
    const exits = [once(a, 'exit'), once(b, 'exit')]; a.send('release'); b.send('release'); await Promise.all(exits)
  } finally { for (const p of children) if (p.exitCode === null) p.kill(); await rm(home, { recursive: true, force: true }) }
})

test('login window and old AUTH cannot block or revoke a newer usable credential', async () => {
  const f = await setup(), file = join(f.home, 'credentials.json')
  let opened, finish
  const account = new LocalAccount(file, { check: async () => {}, browser: { obtain: async ({ signal }) => {
    opened = true
    return new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(signal.reason), { once: true }) })
  }, close: async () => {} } })
  try {
    await f.store.saveLogin(file, { token: 'old', accountId: 'fixture-owner' }, 0)
    const old = await account.credential(AbortSignal.timeout(2000))
    account.login(); await waitFor(() => opened)
    assert.equal((await account.credential(AbortSignal.timeout(1000))).token, 'old')
    const originalSignal = account.requestSignal(); await account.cancel()
    assert.equal(originalSignal.aborted, false)
    await f.store.saveLogin(file, { token: 'new', accountId: 'fixture-owner' }, (await f.store.account()).epoch)
    await account.requireVerification(old)
    assert.equal((await account.credential(AbortSignal.timeout(2000))).token, 'new')
    const current = await account.credential(AbortSignal.timeout(2000)), liveSignal = account.requestSignal()
    await account.requireVerification(current)
    assert.equal(liveSignal.aborted, true)
    assert.equal(await f.store.credential(file), undefined)
  } finally { finish?.(undefined); await account.dispose(); await f.close() }
})

test('A log backpressure and failure never delay B completion and atomic resource publication has no partial readers', { timeout: 15000 }, async () => {
  const f = await setup(home => new LocalDiagnostics(home, false)), log = f.log
  let unblock, blocked = false, firstFile
  const append = log.append.bind(log)
  log.append = async (file, line) => {
    if (file.includes('/requests/') && !firstFile) { firstFile = file; blocked = true; await new Promise(r => { unblock = r }); throw new Error('A-only diagnostic failure') }
    return append(file, line)
  }
  const adapter = new TokenFreeAdapter({}, { store: f.store, diagnostics: log, credential: async () => ({ token: 'fixture', accountId: 'fixture-owner' }), client: (_, c) => f.web.client(log, c.operationId) })
  const options = { provider: PROVIDER, model: MODEL, messages: [] }
  let a
  try {
    a = collect(adapter.stream(options)); await waitFor(() => blocked)
    const b = await collect(adapter.stream({ ...options, signal: AbortSignal.timeout(2000) }))
    assert.equal(b.at(-1).type, 'finish')
    unblock(); await a
    const file = join(f.home, 'asset.bin'), bytes = Buffer.alloc(1024 * 1024, 7)
    await writePrivateFile(file, bytes)
    const writers = Array.from({ length: 4 }, (_, i) => writePrivateFile(file, Buffer.alloc(bytes.length, i)))
    for (let i = 0; i < 12; i++) {
      const data = await readFile(file)
      assert.equal(data.length, bytes.length); assert.equal(data.every(x => x === data[0]), true)
    }
    await Promise.all(writers)
  } finally { unblock?.(); await Promise.allSettled([a]); await adapter.dispose(); await f.close() }
})

test('revocation cancels all captured account generations but host disposal only cancels its own', { timeout: 15000 }, async () => {
  for (const action of ['dispose', 'revoke']) {
    const f = await setup(), streams = controlled(f.web), file = join(f.home, 'credentials.json')
    await f.store.saveLogin(file, { token: 'fixture', accountId: 'fixture-owner' }, 0)
    const dependencies = { store: f.store, credential: () => f.store.credential(file), client: () => f.web.client() }
    let twoId
    const one = new TokenFreeAdapter({}, dependencies), two = new TokenFreeAdapter({}, { ...dependencies, client: (_, context) => { twoId = context.operationId; return f.web.client() } })
    const opts = { provider: PROVIDER, model: MODEL, messages: [] }
    let a, b
    try {
      a = collect(one.stream(opts)); const aRejected = assert.rejects(a, e => e.code === 'ABORTED')
      b = collect(two.stream(opts)); const bResult = action === 'revoke' ? assert.rejects(b, e => e.code === 'ABORTED') : b
      await waitFor(() => f.web.generations.length === 2)
      if (action === 'dispose') {
        await one.dispose(); await aRejected
        assert.equal((await f.store.credential(file)).token, 'fixture')
        streams.get(f.web.generations.find(g => payload(g.prompt).request_id === twoId).chat_session_id)(); assert.equal((await bResult).at(-1).type, 'finish')
        assert.equal(f.web.stops.length, 1)
      } else {
        await f.store.revoke(); await Promise.all([aRejected, bResult])
        assert.equal(f.web.stops.length, 2)
        assert.equal(new Set(f.web.stops.map(x => x.body.chat_session_id)).size, 2)
      }
    } finally { for (const finish of streams.values()) finish(); await Promise.allSettled([a, b]); await one.dispose(); await two.dispose(); await f.close() }
  }
})

test('A resumes its original response while another storage with the same sessionId completes independently', { timeout: 15000 }, async () => {
  const f = await setup()
  let releaseResume, a
  try {
    f.web.completion = ({ ready, text, body }) => body.chat_session_id === 'chat-1'
      ? new Response(ready + frame(snapshot(text.slice(0, -3), 'WIP')), { headers: { 'content-type': 'text/event-stream' } })
      : new Response(ready + frame(snapshot(text)), { headers: { 'content-type': 'text/event-stream' } })
    f.web.resumed = async message => {
      await new Promise(r => { releaseResume = r })
      return Response.json({ code: 0, data: { biz_code: 22, biz_data: message } })
    }
    a = f.run(input(undefined, 'same-id')); await waitFor(() => releaseResume)
    const peer = new SessionEngine({ store: new LocalStore(f.home), storeId: 'different-storage', native: f.native, maxPromptChars: 120000 })
    f.native.begin('same-id')
    const rb = result(await collect(peer.run(input([user('different storage')], 'same-id'), f.accountKey, f.web.client(), AbortSignal.timeout(2000), (text, id) => decodeResponse(text, [], id))))
    f.native.save(rb); await peer.reconcile('same-id')
    assert.notEqual(peer.key('same-id'), f.engine.key('same-id'))
    assert.ok(await f.pending('same-id'))
    releaseResume(); const ra = result(await a); f.native.save(ra); await f.engine.reconcile('same-id')
    assert.equal(f.web.generations.length, 2); assert.equal(f.web.resumes.length, 1)
    assert.equal(f.web.resumes[0].chat_session_id, 'chat-1')
    assert.equal((await peer.inspect('same-id')).session.chatId, 'chat-2')
    assert.equal((await f.engine.inspect('same-id')).session.chatId, 'chat-1')
  } finally { releaseResume?.(); await Promise.allSettled([a]); await f.close() }
})

test('independent processes append complete shared diagnostic rows without a generation lock', { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-parallel-log-'))
  const url = new URL('../lib/local/diagnostics.js', import.meta.url).href
  const children = []
  try {
    for (let i = 0; i < 3; i++) children.push(spawn(process.execPath, ['--input-type=module', '-e', `import {LocalDiagnostics} from ${JSON.stringify(url)};const log=new LocalDiagnostics(process.argv[1],false);process.send('ready');process.once('message',async()=>{for(let i=0;i<40;i++)log.write('model.started');await log.flush();process.disconnect()})`, home], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }))
    await Promise.all(children.map(p => once(p, 'message')))
    const exits = children.map(p => once(p, 'exit')); for (const p of children) p.send('run'); await Promise.all(exits)
    const rows = (await readFile(join(home, 'logs', 'events.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.equal(rows.length, 120)
    assert.equal(new Set(rows.map(x => x.instance)).size, 3)
    for (const instance of new Set(rows.map(x => x.instance))) assert.deepEqual(rows.filter(x => x.instance === instance).map(x => x.sequence), Array.from({ length: 40 }, (_, i) => i + 1))
  } finally { for (const p of children) if (p.exitCode === null) p.kill(); await rm(home, { recursive: true, force: true }) }
})
