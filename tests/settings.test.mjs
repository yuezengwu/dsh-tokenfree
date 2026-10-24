import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

test('settings UI handles login, automatic completion and logout without token entry', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.test/' })
  globalThis.window = dom.window; globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react')
  const { render, fireEvent, waitFor, cleanup } = await import('@testing-library/react')
  await mkdir('.local', { recursive: true })
  const directory = await mkdtemp(resolve('.local', 'ui-test-'))
  const file = join(directory, 'settings.mjs')
  await build({ entryPoints: ['src/dsh/client/AccountSettings.tsx'], outfile: file, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] })
  const { AccountSettings } = await import(pathToFileURL(file).href)
  let state = { state: 'signed-out', message: 'fixture-signed-out', configured: false, busy: false }
  let logins = 0, logouts = 0, enables = 0, selected = false
  const actions = {
    sessionId: () => 'fixture-session',
    selection: async id => ({ sessionId: id, selected, defaultSelected: false, available: true }),
    enable: async id => { assert.equal(id, 'fixture-session'); enables++; selected = true },
    status: async () => state,
    restore: async () => state,
    login: async () => { logins++; state = { state: 'signing-in', message: 'fixture-signing-in', configured: false, busy: true }; return state },
    cancel: async () => { state = { state: 'signed-out', message: 'fixture-cancelled', configured: false, busy: false }; return state },
    logout: async () => { logouts++; state = { state: 'signed-out', message: 'fixture-logged-out', configured: false, busy: false }; return state },
  }
  try {
    const ui = render(React.createElement(AccountSettings, { actions }))
    await waitFor(() => assert.ok(ui.getByRole('button', { name: '登录' })))
    assert.equal(ui.container.querySelectorAll('input,textarea,details').length, 0)
    assert.equal(ui.container.querySelectorAll('.dsh-tokenfree-card').length, 1)
    assert.equal(ui.container.querySelectorAll('.dsh-tokenfree-status .dsh-tokenfree-item').length, 3)
    assert.equal(ui.container.querySelectorAll('.dsh-tokenfree-status button').length, 0)
    assert.equal(ui.getByRole('link', { name: 'chat.deepseek.com' }).href, 'https://chat.deepseek.com/')
    assert.equal(Boolean(ui.queryByRole('button', { name: '设置 Chrome 连接组件' })), false)
    fireEvent.click(ui.getByRole('button', { name: '登录' }))
    await waitFor(() => assert.ok(ui.getByRole('button', { name: '取消' })))
    assert.equal(logins, 1)
    state = { state: 'connected', message: 'fixture-connected', configured: true, busy: false, lastValidatedAt: Date.now() }
    await waitFor(() => assert.ok(ui.getByText('已连接')), { timeout: 2500 })
    fireEvent.click(ui.getByRole('button', { name: '使用' }))
    await waitFor(() => assert.equal(ui.getByTestId('tokenfree-state').textContent, '已启用'))
    assert.equal(enables, 1)
    fireEvent.click(ui.getByRole('button', { name: '退出' }))
    await waitFor(() => assert.ok(ui.getByText('未连接')))
    assert.equal(logouts, 1)
    assert.equal(ui.container.textContent.includes('fixture-private-token'), false)
  } finally { cleanup(); dom.window.close(); await rm(directory, { recursive: true, force: true }) }
})

test('built DSH client bundle mounts its Remote namespace and contributes a disposable native settings section', async () => {
  const source = await readFile('lib/client.js', 'utf8')
  let client, mounted = 0, unmounted = 0, registered = 0, nativeActions, currentId = 'fixture-session', defaults = false, defaultWrites = 0
  const selections = [], projection = { next: null }
  const services = { uiSession: { adapter: { current: { getSnapshot: () => ({ key: currentId }) } } }, sessions: {
    binding: () => ({ session: { projections: { faceOf: () => ({ getSnapshot: () => projection }) }, getSnapshot: () => ({ running: false }) } }),
    subagentAddress: () => undefined,
  } }
  const require = createRequire(import.meta.url)
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load({ id, factory }) { assert.equal(id, 'dsh-tokenfree'); client = factory(require) } } } })
  const handlers = []
  const remote = Object.fromEntries(['status', 'login', 'restore', 'cancel', 'logout'].map(method => [method, async () => ({ ok: true, value: { state: 'signed-out', message: '', configured: false, busy: false } })]))
  remote.defaultModel = async () => ({ ok: true, value: { available: true, selected: defaults } })
  remote.useDefault = async () => { defaults = true; defaultWrites++; return { ok: true, value: { available: true, selected: true } } }
  const ctx = {
    get: name => services[name],
    remote: { tokenfree: remote, session: { selectModel: async request => { selections.push(request); projection.next = request; return { ok: true, value: { selected: request } } } }, $mount: async info => {
      mounted++; assert.equal(info.package, 'dsh-tokenfree')
      assert.deepEqual(Array.from(info.descriptors, method => method.method).sort(), ['cancel', 'cancelSummary', 'defaultModel', 'inspect', 'login', 'logout', 'operationStatus', 'policy', 'rebuild', 'restore', 'setPolicy', 'status', 'stopPending', 'usage', 'useDefault', 'verifyPending'])
      return async () => { unmounted++ }
    } },
    slots: {
      inject: (name, callback) => { assert.equal(name, 'settings.section'); handlers.push(callback()) },
      register: (entry, component) => { registered++; assert.equal(entry.id, 'dsh-tokenfree:account'); nativeActions = entry.inject().actions; assert.equal(typeof component, 'function'); return () => {} },
    },
    inject: (services, callback) => { callback(ctx); return { await: async () => {}, dispose: async () => { for (const dispose of handlers) dispose() } } },
  }
  const dispose = await client.apply(ctx)
  assert.equal(mounted, 1); assert.equal(registered, 1)
  assert.equal(nativeActions.sessionId(), 'fixture-session')
  await nativeActions.enable('fixture-session')
  assert.deepEqual(JSON.parse(JSON.stringify(selections)), [{ sessionId: 'fixture-session', provider: 'tokenfree-deepseek-web', model: 'web-default' }])
  assert.equal(defaultWrites, 0, 'native selection owns its existing default save')
  assert.equal((await nativeActions.selection('fixture-session')).selected, true)
  assert.equal((await nativeActions.selection('fixture-session')).defaultSelected, false)
  currentId = undefined
  await nativeActions.enable()
  assert.equal(defaultWrites, 1)
  assert.equal((await nativeActions.selection()).defaultSelected, true)
  await dispose(); assert.equal(unmounted, 1)
})
