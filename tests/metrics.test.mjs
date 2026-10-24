import { test } from 'node:test'
import assert from 'node:assert/strict'
import { budgetFor, pressure, threshold, DEFAULT_BUDGET } from '../lib/core/metrics.js'
import { setup, input } from './helpers/fixture.mjs'

const model = { model_type: 'default', file_feature: { token_limit: 1000, token_limit_with_thinking: 2000 }, input_character_limit: 100000 }
test('official mode budgets take priority; exact 50 percent boundary and explicit default never estimate the count', () => {
  assert.equal(threshold(1000), 500)
  assert.equal(threshold(1001), 501)
  assert.equal(threshold(DEFAULT_BUDGET), 445440)
  assert.equal(threshold(Number.MAX_SAFE_INTEGER), Number((BigInt(Number.MAX_SAFE_INTEGER) + 1n) / 2n))
  const settings = { version: 1, observedAt: 'fixture-time', models: [{ modelType: 'default', tokenLimit: 1000, tokenLimitWithThinking: 2000 }] }
  assert.equal(budgetFor(settings, 'default', true).value, 2000)
  assert.equal(budgetFor(settings, 'default', false).value, 1000)
  assert.equal(budgetFor(settings, 'default', false).source, 'client/settings')
  for (const [config, type] of [[undefined, undefined], [settings, undefined], [settings, 'other'],
    [{ ...settings, models: [...settings.models, ...settings.models] }, 'default']]) {
    const budget = budgetFor(config, type, true)
    assert.equal(budget.value, DEFAULT_BUDGET); assert.equal(budget.source, 'default')
    assert.equal(budget.modelType, type)
    if (!config) assert.equal(budget.settingsVersion, undefined)
  }
  for (const value of [undefined, 0, -1, 1.5, NaN, Infinity]) {
    assert.equal(budgetFor({ ...settings, models: [{ modelType: 'default', tokenLimit: value, tokenLimitWithThinking: 2000 }] }, 'default', false).source, 'default')
  }
  assert.equal(budgetFor({ ...settings, models: [{ modelType: 'default', tokenLimitWithThinking: 2000 }] }, 'default', false).value, DEFAULT_BUDGET, 'do not borrow the other mode budget')
})

test('verified official C/B refreshes per branch and mode, exposes zero, unknown, sources and no additive billing', async () => {
  const f = await setup(); f.web.modelType = 'default'; f.web.models = [model]; f.web.usageValue = () => 499
  try {
    const a = (await f.run()).find(x => x.type === 'result'); f.native.save(a); await f.engine.reconcile()
    let value = await f.engine.usage('session-1')
    assert.equal(value.count, 499); assert.equal(value.budget, 2000); assert.equal(value.threshold, 1000); assert.equal(value.reached, false)
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    assert.equal(value.budget, 1000); assert.equal(value.threshold, 500); assert.equal(value.reached, false)
    f.web.chats.get('chat-1')[1].accumulated_token_usage = 500
    assert.equal((await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))).reached, true)
    f.web.chats.get('chat-1')[1].accumulated_token_usage = 0
    assert.equal((await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))).count, 0)
    delete f.web.chats.get('chat-1')[1].accumulated_token_usage
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    assert.equal(value.count, undefined); assert.equal(value.automatic, false)
    f.web.chats.get('chat-1')[1].accumulated_token_usage = 900
    f.web.models = [{ ...model, file_feature: {} }]
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    assert.equal(value.count, 900); assert.equal(value.budget, DEFAULT_BUDGET); assert.equal(value.threshold, 445440)
    assert.equal(value.automatic, true); assert.equal(value.reached, false); assert.equal(value.budgetSource, 'default')
    assert.equal(value.percentage, 900 / DEFAULT_BUDGET * 100)
    assert.equal(value.countSource, 'history')
    assert.equal((await f.store.session(f.engine.key('session-1'))).budget.inputCharacterLimit, 100000)
    const calls = f.web.requests.length
    value = await f.engine.refreshMetrics('session-1', 'another-account', f.web.client(), false, AbortSignal.timeout(5000))
    assert.equal(value.reached, false); assert.equal(value.count, undefined); assert.equal(f.web.requests.length, calls)
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000), ['changed-native-prefix'])
    assert.equal(value.state, 'stale'); assert.equal(value.reached, false); assert.equal(f.web.requests.length, calls)
    await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    f.web.historyHook = () => { throw new Error('fixture disconnected') }
    await assert.rejects(f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000)))
    assert.equal((await f.engine.usage('session-1')).count, undefined)
    assert.equal((await f.engine.usage('session-1')).lastObservation.accumulated_token_usage, 900)
    f.web.historyHook = undefined
    await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    await f.store.revoke()
    value = await f.engine.usage('session-1')
    assert.equal(value.state, 'stale'); assert.equal(value.automatic, false)
  } finally { await f.close() }
})

test('unreadable settings use a persisted labelled default; missing official C, auth and cancellation never become estimates', async () => {
  const f = await setup(); f.web.modelType = 'default'; f.web.models = [model]; f.web.usageValue = () => 445439
  try {
    const a = (await f.run()).find(x => x.type === 'result'); f.native.save(a); await f.engine.reconcile()
    f.web.settingsResponse = () => new Response('temporarily unavailable', { status: 503 })
    let value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), true, AbortSignal.timeout(5000))
    assert.equal(value.budget, DEFAULT_BUDGET); assert.equal(value.budgetSource, 'default')
    assert.equal(value.settingsVersion, undefined); assert.equal(value.threshold, 445440); assert.equal(value.reached, false)
    const stored = await f.store.session(f.engine.key('session-1'))
    assert.equal(stored.budget.source, 'default'); assert.equal(stored.budget.value, DEFAULT_BUDGET)
    f.web.chats.get('chat-1')[1].accumulated_token_usage = 445440
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), true, AbortSignal.timeout(5000))
    assert.equal(value.reached, true); assert.equal(pressure(await f.store.session(f.engine.key('session-1'))), true)
    delete f.web.chats.get('chat-1')[1].accumulated_token_usage
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), true, AbortSignal.timeout(5000))
    assert.equal(value.count, undefined); assert.equal(value.reached, false); assert.equal(value.automatic, false)
    f.web.settingsResponse = () => new Response('{}', { status: 401 })
    await assert.rejects(f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), true, AbortSignal.timeout(5000)), e => e.code === 'AUTH')
    assert.equal((await f.engine.usage('session-1')).automatic, false)
    await assert.rejects(f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), true, AbortSignal.abort()))
    f.web.settingsResponse = undefined
    f.web.chats.get('chat-1')[1].accumulated_token_usage = 500
    value = await f.engine.refreshMetrics('session-1', f.accountKey, f.web.client(), false, AbortSignal.timeout(5000))
    assert.equal(value.budgetSource, 'client/settings'); assert.equal(value.budget, 1000); assert.equal(value.reached, true)
  } finally { await f.close() }
})
