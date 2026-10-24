import { BasicCompactionEngine, type BasicCompactionConfig } from '@deepseek-ai/dsh-compaction-basic'
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction'
import type { CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import { symbols, type Context, type Fiber } from '@deepseek-ai/cordis'
import type { Entry } from '@deepseek-ai/cordis-plugin-loader'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import { TokenFreeError, record } from '../core/errors.js'
import { PROVIDER, MODEL } from './adapter.js'
import type {} from './gateway.js'
import { runtimeFor } from './binding.js'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Native retainTokens=0 semantics: retain the last node and its entire tool group. */
export function compactablePrefix(session: Session): { start: SessionSeq; end: SessionSeq } | undefined {
  const nodes = session.surface.nodes
  if (!nodes.length) return undefined
  const first = session.snapshotEvents().find(x => x.seq === nodes[0])?.type === 'system/message' ? 1 : 0
  let keep = nodes.length - 1
  while (keep > first && !toolPairingBalancedBefore(session, nodes[keep]!)) keep--
  if (keep <= first) return undefined
  const start = nodes[first]!, end = nodes[keep - 1]!
  if (!toolPairingBalancedBefore(session, start) || !toolPairingBalancedAfter(session, end)) throw new TokenFreeError('No safe balanced compaction boundary.', 'COMPACTION_RANGE')
  return { start, end }
}
const target = (agent: Agent) => agent.session.requestHeader()?.config ?? agent.options
const ours = (agent: Agent) => target(agent).provider === PROVIDER && target(agent).model === MODEL
export function compactionThinking(agent: Agent): boolean {
  const events = agent.session.snapshotEvents()
  const selection = events.findLastIndex(x => String(x.type) === 'model/selection')
  const header = events.findLastIndex(x => x.type === 'request/header')
  const next: unknown = events[selection]?.data
  // Desktop/Web record a pending effort choice before the next request header exists.
  if (selection > header && record(next) && next.provider === PROVIDER && next.model === MODEL) return next.reasoningEffort !== 'off'
  return (agent.session.requestHeader()?.config.reasoningEffort ?? agent.options.reasoningEffort) !== 'off'
}

/** Internal native backend. The main plugin installs it in the existing Basic slot. */
export class TokenFreeCompactionEngine extends BasicCompactionEngine {
  static override inject = [...BasicCompactionEngine.inject, 'tokenfree']
  private readonly otherAuto: boolean
  constructor(ctx: Context, config: BasicCompactionConfig = {}) {
    const { retainRatio: _retainRatio, ...policy } = (config.modelPolicies ?? []).find(x => x.provider === PROVIDER && x.model === MODEL) ?? {}
    super(ctx, { ...config, auto: true, modelPolicies: [...(config.modelPolicies ?? []).filter(x => x.provider !== PROVIDER || x.model !== MODEL),
      { ...policy, provider: PROVIDER, model: MODEL,
        summarizationProvider: PROVIDER, summarizationModel: MODEL, retainTokens: 0, compactionRetries: 0 }] })
    this.otherAuto = config.auto !== false
  }
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger, signal: AbortSignal) {
    if (!ours(agent)) return this.otherAuto ? super.compactIfNeeded(agent, trigger, signal) : null
    const runtime = runtimeFor(this.ctx.tokenfree.bindingId)
    await runtime.reconcile(agent.id)
    const state = await runtime.usage(agent.id)
    if (state.compaction === 'needs-new-chat') return null
    if (state.compaction === 'failed' || state.compaction === 'awaiting-checkpoint') throw new TokenFreeError('Previous native compaction needs verification or manual retry.', 'COMPACTION_PENDING')
    const metrics = await runtime.refreshMetrics(agent.id, compactionThinking(agent), signal, agent.session.deriveMessages())
    if (trigger === 'pressure' && !metrics.reached) return null
    const range = compactablePrefix(agent.session)
    if (!range) throw new TokenFreeError('Official pressure reached the limit but no balanced prefix can be shortened.', 'COMPACTION_RANGE')
    return this.compactRegion(range.start, range.end, agent, signal)
  }
  protected override async summarize(input: Parameters<BasicCompactionEngine['summarize']>[0], agent: Agent, signal?: AbortSignal): ReturnType<BasicCompactionEngine['summarize']> {
    if (!ours(agent)) return super.summarize(input, agent, signal)
    const start = agent.session.snapshotEvents().findLast(x => x.type === 'compaction/start')
    if (!start || start.type !== 'compaction/start') throw new TokenFreeError('Missing native compaction start.', 'NATIVE_CONTEXT')
    return runtimeFor(this.ctx.tokenfree.bindingId).withCompaction({ sessionId: agent.id, compactionId: start.data.compactionId,
      startSeq: start.seq, thinking: compactionThinking(agent) }, effective => super.summarize(input, agent, effective), signal)
  }
  override async compactRegion(start: SessionSeq, end: SessionSeq, agent: Agent, signal?: AbortSignal) {
    try { return await super.compactRegion(start, end, agent, signal) }
    finally { if (ours(agent)) await runtimeFor(this.ctx.tokenfree.bindingId).reconcile(agent.id) }
  }
  override async compactNow(agent: Agent, signal: AbortSignal, sourceCommandId?: Parameters<BasicCompactionEngine['compactNow']>[2]) {
    try { return await super.compactNow(agent, signal, sourceCommandId) }
    finally { if (ours(agent)) await runtimeFor(this.ctx.tokenfree.bindingId).reconcile(agent.id) }
  }
}

const BASIC = '@deepseek-ai/dsh-compaction-basic', INTERNAL = 'dsh-tokenfree/compaction'
const original = <T extends object>(value: T): T => (value as T & { [symbols.original]?: T })[symbols.original] ?? value
export function compactionFor(ctx: Context, agent: Agent) {
  return ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
}

/** Replace only stock Basic instances via public Cordis lifecycle APIs; never patch an engine. */
export function installCompaction(ctx: Context) {
  let disposed = false
  let mounted = ctx.fiber.state === 2
  const installs = new Map<Fiber, Promise<void>>()
  const restoring = new Set<Context>()
  const changed: { entry?: Entry; current: Fiber; parent: Context; callback: typeof BasicCompactionEngine; config: BasicCompactionConfig; name?: string; disabled?: boolean | null }[] = []
  const stock = (fiber: Fiber) => fiber.entry ? fiber.entry.options.name === BASIC && fiber.runtime?.callback.name === 'BasicCompactionEngine'
    : fiber.runtime?.callback === BasicCompactionEngine
  const owner = (service: object): Fiber | undefined => {
    for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) {
      const candidate = fiber.ctx.get('compaction')
      if (stock(fiber) && candidate && original(candidate) === original(service)) return fiber
    }
  }
  const upgrade = (fiber: Fiber): Promise<void> => {
    const existing = installs.get(fiber)
    if (existing) return existing
    const task = (async () => {
      await fiber.await()
      if (disposed || fiber.uid === null || !stock(fiber)) return
      const entry = fiber.ctx.fiber.entry
      const saved = { entry, current: fiber, parent: fiber.parent, callback: fiber.runtime!.callback as typeof BasicCompactionEngine,
        config: fiber.config as BasicCompactionConfig, name: entry?.options.name, disabled: entry?.options.disabled }
      changed.push(saved)
      try {
        // Complete the old provider's teardown before creating the one replacement in its scope.
        if (entry) await entry.update({ disabled: true })
        await fiber.dispose()
        if (entry) { await entry.update({ name: INTERNAL, disabled: saved.disabled }); saved.current = entry.fiber!; await saved.current.await() }
        else saved.current = await saved.parent.plugin(TokenFreeCompactionEngine, saved.config)
        if (!(saved.current.ctx.get('compaction') instanceof TokenFreeCompactionEngine)) throw new TokenFreeError('The native compaction replacement did not load.', 'COMPACTION_UNAVAILABLE')
      } catch (error) {
        restoring.add(saved.parent)
        try {
          if (entry) await entry.update({ disabled: true })
          await saved.current.dispose()
          if (entry) { await entry.update({ name: saved.name!, disabled: saved.disabled }); await entry.fiber?.await() }
          else await saved.parent.plugin(saved.callback, saved.config)
          changed.splice(changed.indexOf(saved), 1)
        } finally { restoring.delete(saved.parent) }
        throw error
      }
    })()
    installs.set(fiber, task)
    return task
  }
  const ensure = async (agent: Agent): Promise<TokenFreeCompactionEngine> => {
    let service = compactionFor(ctx, agent)
    if (service instanceof TokenFreeCompactionEngine) return service
    if (service) {
      const fiber = owner(service)
      if (fiber) { await upgrade(fiber); service = compactionFor(ctx, agent) }
    }
    if (!(service instanceof TokenFreeCompactionEngine)) throw new TokenFreeError('TokenFree native compaction is unavailable in this DSH scope.', 'COMPACTION_UNAVAILABLE')
    return service
  }
  const observe = (fiber: Fiber) => {
    if (!disposed && mounted && !restoring.has(fiber.parent) && stock(fiber)) void upgrade(fiber).catch(error => ctx.logger.warn('TokenFree compaction initialization failed: %s', error instanceof Error ? error.message : String(error)))
  }
  const scan = () => { for (const runtime of ctx.registry.values()) for (const fiber of runtime.fibers) observe(fiber) }
  ctx.on('internal/status', fiber => {
    if (fiber.state !== 2) return
    if (fiber === ctx.fiber) { mounted = true; scan() }
    else observe(fiber)
  })
  if (mounted) scan()
  ctx.on('agent/created', async ({ agent }) => {
    const service = compactionFor(ctx, agent)
    if (ours(agent) && service && owner(service)) await ensure(agent)
  })
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    if (ours(agent)) {
      const previous = compactionFor(ctx, agent)
      const service = await ensure(agent)
      // The first event may have captured the disposed Basic listener before replacement.
      if (!(previous instanceof TokenFreeCompactionEngine)) await service.compactIfNeeded(agent, 'pressure', signal)
    }
    return next()
  }, true)
  ctx.effect(() => async () => {
    disposed = true
    await Promise.allSettled(installs.values())
    for (const saved of changed.reverse()) {
      if (saved.current.uid === null || saved.parent.fiber.state !== 2) continue
      if (saved.entry) await saved.entry.update({ disabled: true })
      await saved.current.dispose()
      if (saved.entry) { await saved.entry.update({ name: saved.name!, disabled: saved.disabled }); await saved.entry.fiber?.await() }
      else await saved.parent.plugin(saved.callback, saved.config)
    }
  })
  return { ensure }
}
export default TokenFreeCompactionEngine
