import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, stat, readFile, mkdir, writeFile, access } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { ManagedBrowserLogin, isNavigationTransition } from '../lib/deepseek-web/browser-login.js'
import { LocalAccount } from '../lib/core/account.js'
import { LocalDiagnostics } from '../lib/local/diagnostics.js'

// Temporary test-owned profile; every website request is intercepted. No user account is read.
test('real Chrome persists the plugin login across launches using a pipe and no listening socket', { timeout: 60_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-browser-'))
  const profile = join(directory, 'browser-profile')
  let launches = 0
  const browser = new ManagedBrowserLogin(profile, {
    diagnostics: new LocalDiagnostics(directory, false),
    launch: async (path, options) => {
      launches++
      assert.equal(path, profile); assert.equal(options.chromiumSandbox, true)
      assert.equal(options.headless, launches !== 1)
      const context = await chromium.launchPersistentContext(path, { ...options, headless: true })
      await context.route('**/*', async route => {
        assert.equal(new URL(route.request().url()).origin, 'https://chat.deepseek.com')
        await route.fulfill({ contentType: 'text/html', body: launches === 1
          ? '<!doctype html><script>localStorage.setItem("userToken", JSON.stringify({value:"test-owned-session",__version:"0"}))</script><p>Fixture login</p>'
          : '<!doctype html><p>Fixture restore</p>' })
      })
      const processes = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).split('\n').filter(line => line.includes(profile) && line.includes('Google Chrome'))
      assert.ok(processes.some(line => line.includes('--remote-debugging-pipe')))
      assert.equal(processes.some(line => line.includes('--remote-debugging-port')), false)
      try {
        const sockets = execFileSync('lsof', ['-nP', '-a', '-p', processes.map(line => line.trim().split(/\s/)[0]).join(','), '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
        assert.equal(sockets.trim(), '')
      } catch (error) { if (error.status !== 1) throw error }
      return context
    },
    check: async credential => { assert.equal(credential.token, 'test-owned-session') },
  })
  try {
    const first = await browser.obtain({ interactive: true, signal: AbortSignal.timeout(25_000) })
    assert.equal(first.token, 'test-owned-session')
    assert.equal((await stat(profile)).mode & 0o777, 0o700)
    const restored = await browser.obtain({ interactive: false, signal: AbortSignal.timeout(25_000) })
    assert.equal(restored.token, first.token); assert.equal(launches, 2)
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }) }
})

test('normal login redirects can destroy the execution context without losing a completed login', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-redirect-'))
  let reads = 0, closes = 0
  const page = { isClosed: () => false, url: () => 'https://chat.deepseek.com/', goto: async () => {}, bringToFront: async () => {},
    evaluate: async () => { if (++reads === 1) throw new Error('Execution context was destroyed, most likely because of a navigation.'); return 'fixture-after-redirect' } }
  const browser = new ManagedBrowserLogin(join(directory, 'browser-profile'), {
    diagnostics: new LocalDiagnostics(directory, false),
    launch: async () => ({ pages: () => [page], cookies: async () => [], close: async () => { closes++ } }),
    check: async credential => assert.equal(credential.token, 'fixture-after-redirect'),
  })
  try {
    const credential = await browser.obtain({ interactive: true, signal: AbortSignal.timeout(5000) })
    assert.equal(credential.token, 'fixture-after-redirect'); assert.equal(reads, 2); assert.equal(closes, 1)
    const diagnostic = await readFile(join(directory, 'login-status.json'), 'utf8')
    assert.equal(JSON.parse(diagnostic).event, 'authorized'); assert.equal(diagnostic.includes(credential.token), false)
    assert.equal(isNavigationTransition(new Error('sensitive random error')), false)
  } finally { await browser.close(); await rm(directory, { recursive: true, force: true }) }
})

test('managed login failures identify the phase without revealing raw browser or network data', async () => {
  for (const mode of ['launch', 'verify']) {
    const directory = await mkdtemp(join(tmpdir(), 'tokenfree-login-failure-'))
    const page = { isClosed: () => false, url: () => 'https://chat.deepseek.com/', goto: async () => {}, bringToFront: async () => {}, evaluate: async () => 'fixture-private-token' }
    const browser = new ManagedBrowserLogin(join(directory, 'browser-profile'), {
      diagnostics: new LocalDiagnostics(directory, false),
      launch: async () => { if (mode === 'launch') throw new Error('ProcessSingleton profile is in use fixture-private-token'); return { pages: () => [page], cookies: async () => [], close: async () => {} } },
      check: async () => { throw new TypeError('fetch failed fixture-private-token') },
    })
    try {
      await assert.rejects(browser.obtain({ interactive: true, signal: AbortSignal.timeout(5000) }), error => {
        assert.equal(error.code, mode === 'launch' ? 'LOGIN_PROFILE_BUSY' : 'LOGIN_VERIFY_NETWORK')
        assert.equal(error.message.includes('fixture-private-token'), false); return true
      })
      const diagnostic = await readFile(join(directory, 'login-status.json'), 'utf8')
      assert.equal(diagnostic.includes('fixture-private-token'), false)
    } finally { await browser.close(); await rm(directory, { recursive: true, force: true }) }
  }
})

test('another entry logout waits for the dedicated browser close before removing its profile', { timeout: 8000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tokenfree-profile-exit-'))
  const profile = join(directory, 'browser-profile'), file = join(directory, 'credentials.json')
  const diagnostics = new LocalDiagnostics(directory, false)
  let ready, closed = false, closes = 0
  const opened = new Promise(resolve => { ready = resolve })
  const page = { isClosed: () => closed, url: () => 'https://chat.deepseek.com/', goto: async () => { ready() }, bringToFront: async () => {}, evaluate: async () => null }
  const browser = new ManagedBrowserLogin(profile, { diagnostics, launch: async () => ({ pages: () => [page], cookies: async () => [], close: async () => {
    closed = true; closes++
    // Model Chrome's final profile flush. Logout must delete the profile after this write.
    await mkdir(profile, { recursive: true }); await writeFile(join(profile, 'last-flush'), 'synthetic')
  } }) })
  const owner = new LocalAccount(file, { browser, diagnostics, check: async () => {} })
  const peer = new LocalAccount(file, { diagnostics, check: async () => {} })
  try {
    owner.login(); await opened
    await peer.logout()
    assert.equal(closes, 1)
    assert.equal(owner.status().busy, false)
    assert.equal(owner.status().message.includes('LOGIN_REVOKED'), true)
    await assert.rejects(access(profile))
    assert.equal((await peer.restore()).configured, false)
    await assert.rejects(access(file))
  } finally { await owner.dispose(); await peer.dispose(); await rm(directory, { recursive: true, force: true }) }
})
