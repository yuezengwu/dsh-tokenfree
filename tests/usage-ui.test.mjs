import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { JSDOM } from 'jsdom'

test('single card preserves official zero, rejects stale session values and cancels summaries through DSH', async () => {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://dsh.test/' })
  globalThis.window = dom.window; globalThis.document = dom.window.document
  globalThis.HTMLElement = dom.window.HTMLElement; globalThis.IS_REACT_ACT_ENVIRONMENT = true
  const React = await import('react'), { render, waitFor, cleanup, fireEvent } = await import('@testing-library/react')
  await mkdir(resolve('.local'), { recursive: true })
  const dir = await mkdtemp(resolve('.local', 'usage-ui-')), file = join(dir, 'usage.mjs')
  await build({ entryPoints: ['src/dsh/client/AccountSettings.tsx'], outfile: file, bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', external: ['react', 'react/jsx-runtime'] })
  const { AccountSettings } = await import(pathToFileURL(file).href)
  let current = 'one', oldResolve, error = false
  let reply = { state: 'confirmed', count: 0, budget: 1000, threshold: 500, percentage: 0, remainingToThreshold: 500, budgetSource: 'client/settings',
    automatic: true, reached: false, countSource: 'history', countObservedAt: 'official-time', budgetObservedAt: 'config-time',
    modelType: 'default', thinking: true, budgetField: 'token_limit_with_thinking', settingsVersion: 7,
    lastObservation: { accumulated_token_usage: 0, source: 'history', chatId: 'chat-1', messageId: 2, observedAt: 'official-time' } }
  const cancelled = [], verified = [], operations = {}
  let finishOldVerification
  const account = { state: 'connected', message: '', configured: true, busy: false }
  const actions = {
    sessionId: () => current, status: async () => account, restore: async () => account,
    login: async () => account, cancel: async () => account, logout: async () => account,
    selection: async id => ({ sessionId: id, selected: true, defaultSelected: true, available: true }),
    usage: async id => {
      if (error) throw new Error('fixture host offline')
      if (id === 'old-pending') return new Promise(resolve => { oldResolve = resolve })
      return { ...reply, sessionId: id }
    },
    cancelSummary: async (...args) => { cancelled.push(args) },
    operationStatus: async id => operations[id] ?? { pending: false },
    verifyPending: async (id, operationId) => {
      verified.push([id, operationId])
      if (id === 'three') return new Promise(resolve => { finishOldVerification = resolve })
      return { pending: false }
    },
  }
  try {
    const ui = render(React.createElement(AccountSettings, { actions }))
    await waitFor(() => assert.equal(ui.getByTestId('tokenfree-usage').textContent, '0 tokens'))
    const details = ui.getByTestId('tokenfree-usage').title
    assert.match(details, /计数来源：history；时间：official-time/)
    assert.match(details, /预算字段：token_limit_with_thinking/)
    assert.match(details, /官网文件功能预算：1,000 tokens/)
    assert.match(details, /50% 压缩门槛：500/)
    assert.match(details, /预算使用比例：0.0%/)
    assert.match(details, /预算来源：官网 client\/settings/)
    assert.equal(details.includes('旧观测：'), false, 'confirmed current usage must not be labelled as an old observation')
    assert.ok(ui.getByText('用量', { selector: '.dsh-tokenfree-label' }))
    reply = { ...reply, budget: 890880, threshold: 445440, remainingToThreshold: 445440, budgetSource: 'default', settingsVersion: undefined }
    await waitFor(() => assert.match(ui.getByTestId('tokenfree-usage').title, /默认预算：890,880 tokens/), { timeout: 2500 })
    assert.match(ui.getByTestId('tokenfree-usage').title, /预算来源：默认值（官网预算不可用）/)
    assert.match(ui.getByTestId('tokenfree-usage').title, /50% 压缩门槛：445,440/)
    assert.equal(ui.getByTestId('tokenfree-usage').title.includes('官网文件功能预算：890,880'), false)
    error = true
    await waitFor(() => assert.equal(ui.getByTestId('tokenfree-usage').textContent, '—'), { timeout: 2500 })
    assert.match(ui.getByTestId('tokenfree-usage').title, /旧观测，不用于自动压缩判断/)
    error = false
    reply = { state: 'stale', automatic: false, reached: false, generation: { operationId: 'summary-operation', compactionId: 'summary-1', purpose: 'compaction', count: 23, source: 'sse', stage: 'receiving' },
      lastObservation: { accumulated_token_usage: 800, source: 'history', chatId: 'chat-1', messageId: 2, observedAt: 'old-time' } }
    current = 'two'
    await waitFor(() => assert.equal(ui.getByTestId('tokenfree-state').textContent, '压缩中'), { timeout: 2500 })
    assert.equal(ui.getByTestId('tokenfree-usage').textContent, '—')
    assert.match(ui.getByTestId('tokenfree-usage').title, /网页会话用量：未知 tokens/)
    assert.match(ui.getByTestId('tokenfree-usage').title, /生成中观测（尚未结算）：23/)
    assert.match(ui.getByTestId('tokenfree-usage').title, /旧观测：800/)
    fireEvent.click(ui.getByRole('button', { name: '停止摘要' }))
    await waitFor(() => assert.deepEqual(cancelled, [['two', 'summary-operation', 'summary-1']]))
    reply = { state: 'stale', automatic: false, reached: false, compaction: 'failed' }
    await waitFor(() => assert.equal(Boolean(ui.queryByRole('button', { name: '停止摘要' })), false), { timeout: 2500 })
    assert.equal(ui.getByTestId('tokenfree-state').textContent, '待处理')
    assert.equal(ui.getByTestId('tokenfree-usage').textContent, '—')
    reply = { state: 'confirmed', count: 73, automatic: false, reached: false }
    current = 'old-pending'
    await waitFor(() => assert.ok(oldResolve), { timeout: 2500 })
    current = 'three'
    await React.act(async () => { oldResolve({ state: 'confirmed', count: 9999 }) })
    assert.equal(ui.getByTestId('tokenfree-usage').textContent.includes('9999'), false)
    await waitFor(() => assert.equal(ui.getByTestId('tokenfree-usage').textContent, '73 tokens'), { timeout: 2500 })
    operations.three = { pending: true, sessionId: 'three', operationId: 'three-op', stage: 'uncertain' }
    await waitFor(() => assert.ok(ui.getByRole('button', { name: '核实' })), { timeout: 2500 })
    fireEvent.click(ui.getByRole('button', { name: '核实' }))
    await waitFor(() => assert.ok(finishOldVerification))
    current = 'four'; reply = { state: 'confirmed', count: 44, automatic: false, reached: false }
    operations.four = { pending: true, sessionId: 'four', operationId: 'four-op', stage: 'uncertain' }
    await waitFor(() => assert.equal(ui.getByRole('button', { name: '核实' }).disabled, false), { timeout: 2500 })
    fireEvent.click(ui.getByRole('button', { name: '核实' }))
    await waitFor(() => assert.deepEqual(verified, [['three', 'three-op'], ['four', 'four-op']]))
    await React.act(async () => { finishOldVerification({ pending: true, sessionId: 'three', operationId: 'three-op', stage: 'uncertain' }) })
    assert.match(ui.getByTestId('tokenfree-usage').title, /网页会话用量：44 tokens|原请求状态未确认/)

  } finally { cleanup(); dom.window.close(); await rm(dir, { recursive: true, force: true }) }
})
