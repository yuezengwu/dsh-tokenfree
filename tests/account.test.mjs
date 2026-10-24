import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname as directoryFor } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { TokenFreeError as LlmError } from '../lib/core/errors.js'
import { setup, collect } from './helpers/fixture.mjs'
import { LocalStore } from '../lib/local/store.js'
import { LocalAccount } from '../lib/core/account.js'
import { readCredential, saveCredential } from '../lib/local/auth.js'
import { TokenFreeGateway } from '../lib/dsh/gateway.js'
import { TokenFreeAdapter, PROVIDER, MODEL } from '../lib/dsh/adapter.js'

const signal = () => AbortSignal.timeout(5000)
const settle = async account => { while (account.status().busy) await new Promise(resolve => setImmediate(resolve)) }
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-account-'))
  const file = join(directory, 'credentials.json')
  try { await fn(file, directory) } finally { await rm(directory, { recursive: true, force: true }) }
}

test('login is single flight, validates once, persists 0600, and returns only public status', () => fixture(async file => {
  let finish, opened = 0, checks = 0
  const account = new LocalAccount(file, {
    browser: { obtain: async () => { opened++; return new Promise(resolve => { finish = resolve }) }, close: async () => {} },
    check: async () => { checks++ },
  })
  try {
    assert.equal(account.login().state, 'signing-in')
    account.login(); while (!finish) await new Promise(resolve => setImmediate(resolve)); assert.equal(opened, 1)
    finish({ token: 'fixture-private-token' })
    await settle(account)
    assert.equal(account.status().state, 'connected')
    assert.equal((await readCredential(file)).token, 'fixture-private-token')
    assert.equal((await stat(file)).mode & 0o777, 0o600)
    assert.equal(checks, 1)
    assert.equal(JSON.stringify(account.status()).includes('fixture-private-token'), false)
    assert.equal((await account.credential(signal())).token, 'fixture-private-token')
    assert.equal(checks, 1)
  } finally { await account.dispose() }
}))

test('restart uses the saved login without a browser or token re-entry', () => fixture(async file => {
  await saveCredential({ token: 'existing-login' }, file)
  let checks = 0
  const account = new LocalAccount(file, {
    browser: { obtain: async () => { assert.fail('a valid saved login must not open a browser') }, close: async () => {} },
    check: async () => { checks++ },
  })
  try {
    assert.equal((await account.restore()).state, 'connected')
    assert.equal((await account.credential(signal())).token, 'existing-login')
    assert.equal(checks, 1)
  } finally { await account.dispose() }
}))

test('idle hosts synchronize shared login and logout locally without keepalive or reviving rejected credentials', () => fixture(async file => {
  let checks = 0
  const options = { browser: { obtain: async () => undefined, close: async () => {} }, check: async () => { checks++ } }
  const owner = new LocalAccount(file, options), peer = new LocalAccount(file, options)
  try {
    await saveCredential({ token: 'shared-first', accountId: 'owner' }, file)
    await owner.restore()
    assert.equal((await peer.refreshLocalStatus()).state, 'connected')
    assert.equal(checks, 1)
    const oldSignal = peer.requestSignal()
    await owner.logout()
    assert.equal((await peer.refreshLocalStatus()).state, 'signed-out')
    assert.equal(oldSignal.aborted, true)
    assert.equal(peer.status().configured, false)
    const sharedStore = new LocalStore(directoryFor(file))
    await sharedStore.saveLogin(file, { token: 'shared-second', accountId: 'owner' }, (await sharedStore.account()).epoch)
    assert.equal((await peer.refreshLocalStatus()).state, 'connected')
    assert.equal(checks, 1)
    await peer.credential(signal())
    assert.equal(checks, 2)
    await peer.requireVerification(await peer.credential(signal()))
    assert.equal((await peer.refreshLocalStatus()).state, 'reauth-required')
  } finally { await owner.dispose(); await peer.dispose() }
}))

test('expired credential recovers from the plugin-owned browser profile', () => fixture(async file => {
  await saveCredential({ token: 'expired' }, file)
  let opened = 0
  const account = new LocalAccount(file, {
    browser: { obtain: async request => { opened++; assert.equal(request.interactive, false); return { token: 'restored' } }, close: async () => {} },
    check: async credential => { if (credential.token === 'expired') throw new LlmError('expired', 'AUTH') },
  })
  try {
    assert.equal((await account.credential(signal())).token, 'restored')
    assert.equal((await readCredential(file)).token, 'restored')
    assert.equal(opened, 1)
    assert.equal(account.status().state, 'connected')
  } finally { await account.dispose() }
}))

test('revoked sessions require official verification once and do not loop or expose server errors', () => fixture(async file => {
  await saveCredential({ token: 'revoked' }, file)
  let opened = 0
  const account = new LocalAccount(file, {
    browser: { obtain: async () => { opened++; return undefined }, close: async () => {} },
    check: async () => { throw new LlmError('sensitive upstream body', 'AUTH') },
  })
  try {
    await assert.rejects(account.credential(signal()), error => error.code === 'AUTH')
    await assert.rejects(account.credential(signal()), error => ['AUTH', 'MISSING_CREDENTIAL'].includes(error.code))
    assert.equal(opened, 1)
    assert.equal(account.status().state, 'reauth-required')
    assert.equal(JSON.stringify(account.status()).includes('sensitive'), false)
  } finally { await account.dispose() }
}))

test('cancelling login preserves the current account; logout removes only plugin login and aborts requests', () => fixture(async (file, directory) => {
  await saveCredential({ token: 'keep-current' }, file)
  await mkdir(join(directory, 'browser-profile'))
  await writeFile(join(directory, 'browser-profile', 'fixture'), 'session')
  await writeFile(join(directory, 'unrelated.txt'), 'keep')
  const account = new LocalAccount(file, {
    browser: { obtain: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('sensitive cancel')), { once: true })
    }), close: async () => {} },
    check: async () => {},
  })
  try {
    await account.restore()
    account.login()
    await account.cancel()
    assert.equal(account.status().state, 'connected')
    assert.equal((await readCredential(file)).token, 'keep-current')
    const current = account.requestSignal()
    assert.equal((await account.logout()).state, 'signed-out')
    assert.equal(current.aborted, true)
    assert.equal(await readCredential(file), undefined)
    await assert.rejects(access(join(directory, 'browser-profile')))
    await access(join(directory, 'unrelated.txt'))
  } finally { await account.dispose() }
}))

test('browser errors and network failures never reveal credentials or raw diagnostic text', () => fixture(async file => {
  const account = new LocalAccount(file, {
    browser: { obtain: async () => { throw new Error('fixture-secret-url') }, close: async () => {} },
    check: async () => {},
  })
  try {
    account.login(); await settle(account)
    assert.equal(account.status().state, 'error')
    assert.equal(JSON.stringify(account.status()).includes('fixture-secret-url'), false)
  } finally { await account.dispose() }
}))

test('concurrent first use and settings restore open only one browser', () => fixture(async file => {
  let finish, opened = 0
  const account = new LocalAccount(file, {
    browser: { obtain: async () => { opened++; return new Promise(resolve => { finish = resolve }) }, close: async () => {} },
    check: async () => {},
  })
  try {
    const requests = [account.credential(signal()), account.credential(signal()), account.restore()]
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(opened, 1)
    finish({ token: 'restored-once' })
    await Promise.all(requests)
    assert.equal(opened, 1)
    assert.equal(account.status().state, 'connected')
  } finally { await account.dispose() }
}))

test('a late validation cannot resurrect an account after logout', () => fixture(async file => {
  await saveCredential({ token: 'logging-out' }, file)
  let finish
  const account = new LocalAccount(file, {
    browser: { obtain: async () => undefined, close: async () => {} },
    check: async () => new Promise(resolve => { finish = resolve }),
  })
  try {
    const pending = account.credential(signal())
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    await account.logout()
    finish()
    await assert.rejects(pending, error => error.code === 'ABORTED')
    assert.equal(account.status().state, 'signed-out')
    assert.equal(await readCredential(file), undefined)
  } finally { await account.dispose() }
}))

test('logout in another host fences a pending browser login before its credential commit', () => fixture(async file => {
  let finish
  const account = new LocalAccount(file, {
    browser: { obtain: async () => new Promise(resolve => { finish = resolve }), close: async () => {} },
    check: async () => {},
  })
  const peer = new LocalAccount(file, { browser: { obtain: async () => undefined, close: async () => {} }, check: async () => {} })
  try {
    account.login()
    while (!finish) await new Promise(resolve => setImmediate(resolve))
    await peer.logout()
    finish({ token: 'late-browser-login' })
    await settle(account)
    assert.equal(await readCredential(file), undefined)
    assert.equal(account.status().state, 'error')
    assert.equal(account.status().configured, false)
    assert.equal(account.status().message.includes('LOGIN_REVOKED'), true)
  } finally { await account.dispose(); await peer.dispose() }
}))

test('missing plugin profile cannot restore an account on first use or after explicit logout', () => fixture(async file => {
  const account = new LocalAccount(file, { check: async () => {} })
  try {
    await assert.rejects(account.credential(signal()), error => error.code === 'MISSING_CREDENTIAL')
    await saveCredential({ token: 'saved-browser-account' }, file)
    await account.restore()
    await account.logout()
    await account.restore()
    await assert.rejects(account.credential(signal()), error => error.code === 'MISSING_CREDENTIAL')
    assert.equal(account.status().configured, false)
    assert.equal(await readCredential(file), undefined)
  } finally { await account.dispose() }
}))

test('a replacement login cancels requests using the old account', () => fixture(async file => {
  await saveCredential({ token: 'old-account' }, file)
  const account = new LocalAccount(file, {
    browser: { obtain: async () => ({ token: 'new-account' }), close: async () => {} },
    check: async () => {},
  })
  try {
    await account.restore()
    const original = account.requestSignal()
    account.login(); await settle(account)
    assert.equal(original.aborted, true)
    assert.equal(account.requestSignal().aborted, false)
    assert.equal((await account.credential(signal())).token, 'new-account')
  } finally { await account.dispose() }
}))

test('an explicit HTTP auth rejection requires verification without automatic completion replay', async () => {
  const f = await setup(); let rejected = 0
  const original = f.web.fetch
  f.web.fetch = async (url, options) => url.endsWith('/chat/completion') ? new Response('', { status: 401 }) : original(url, options)
  const adapter = new TokenFreeAdapter({}, { store: f.store, credential: async () => ({ token: 'expired', accountId: 'fixture-owner' }),
    authRejected: () => { rejected++ }, client: () => f.web.client() })
  try {
    await assert.rejects(collect(adapter.stream({ provider: PROVIDER, model: MODEL, messages: [] })), error => error.code === 'AUTH')
    assert.equal(rejected, 1)
    assert.equal((await f.pending()), undefined)
    assert.equal(f.web.resumes.length, 0)
  } finally { adapter.dispose(); await f.close() }
})

test('public Gateway rejects non-owner management and has no credential-returning methods', async () => {
  const ctx = new Context()
  let calls = 0
  const account = { refreshLocalStatus: async () => ({ state: 'signed-out' }), login: () => { calls++ } }
  try {
    const gateway = new TokenFreeGateway(ctx, account)
    assert.equal((await gateway.status()).state, 'signed-out')
    const remoteContext = Object.create(gateway.ctx)
    Object.defineProperty(remoteContext, 'invocation', { value: { peer: { principal: { kind: 'guest' } } } })
    const remote = Object.create(gateway)
    Object.defineProperty(remote, 'ctx', { value: remoteContext })
    for (const method of ['status', 'login', 'restore', 'cancel', 'logout', 'operationStatus', 'verifyPending', 'stopPending', 'cancelSummary', 'rebuild', 'inspect', 'usage']) {
      await assert.rejects(async () => remote[method](), error => error.code === 'tokenfree/owner-required')
    }
    assert.equal(calls, 0)
  } finally { await ctx.fiber.dispose() }
})


test('failed replacement login preserves a usable shared account instead of showing global failure', () => fixture(async file => {
  await saveCredential({ token: 'still-usable', accountId: 'owner' }, file)
  const account = new LocalAccount(file, {
    browser: { obtain: async () => ({ token: 'candidate', accountId: 'owner' }), close: async () => {} },
    check: async credential => { if (credential.token === 'candidate') throw new LlmError('candidate network failure', 'TRANSPORT') },
  })
  try {
    await account.restore()
    account.login(); await settle(account)
    assert.equal(account.status().state, 'connected')
    assert.equal((await account.credential(signal())).token, 'still-usable')
  } finally { await account.dispose() }
}))

test('credential fencing hashes the normalized saved value and ignores object field order', () => fixture(async file => {
  const store = new LocalStore(directoryFor(file))
  const first = await store.saveLogin(file, { accountId: 'owner', token: ' Bearer normalized-token ' }, 0)
  assert.equal((await store.credential(file)).token, 'normalized-token')
  const same = await store.saveLogin(file, { token: 'normalized-token', accountId: 'owner' }, first)
  assert.equal(same, first, 'equivalent credentials must not revoke other sessions')
  assert.equal((await store.credential(file)).epoch, first)
}))
