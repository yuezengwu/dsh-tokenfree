import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { LocalAccount } from '../core/account.js'
import type { TokenFreeAdapter } from './adapter.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { PROVIDER, MODEL } from './adapter.js'
import { bindRuntime } from './binding.js'
import { TokenFreeCompactionEngine } from './compaction.js'
import type { AccountStatus, DefaultModelStatus, OperationStatus, UsageStatus } from '../core/account-types.js'
import type { SessionPolicy, PolicyState } from './policy-types.js'

declare module '@deepseek-ai/cordis' {
  interface Context { tokenfree: TokenFreeGateway }
}
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap { 'tokenfree/owner-required': Record<string, never> }
}

/** Uses DSH's existing authenticated transport; opens no server or callback port. */
export class TokenFreeGateway extends TypertRemoteService {
  readonly bindingId: string = randomUUID()
  constructor(ctx: Context, private readonly account: LocalAccount, private readonly adapter?: TokenFreeAdapter) { super(ctx, 'tokenfree'); if (adapter) { const release = bindRuntime(this.bindingId, adapter); ctx.effect(() => release) } }

  private owner(): void {
    if (this.ctx.invocation && this.ctx.invocation.peer.principal.kind !== 'owner') {
      throw new RemoteError('tokenfree/owner-required', 'Only the local DSH owner may manage this account.', {})
    }
  }

  @Remote
  async operationStatus(sessionId?: string): Promise<OperationStatus> { this.owner(); return await this.adapter?.operationStatus(sessionId) ?? { pending: false } }

  @Remote
  async policy(sessionId: string): Promise<PolicyState> {
    this.owner(); this.policySession(sessionId)
    return this.adapter!.policy(sessionId)
  }

  @Remote
  async setPolicy(sessionId: string, value: SessionPolicy): Promise<PolicyState> {
    this.owner(); this.policySession(sessionId)
    return this.adapter!.setPolicy(sessionId, value)
  }

  private policySession(id: string) {
    if (!id || id.length > 512 || !this.adapter) throw new RemoteError('gateway/internal', 'Invalid session identity.', {})
  }

  @Remote
  async verifyPending(sessionId: string, operationId: string): Promise<OperationStatus> {
    this.owner()
    this.operationIdentity(sessionId, operationId)
    try { return await this.adapter?.verifyPending(sessionId, operationId) ?? { pending: false } }
    catch { throw new RemoteError('gateway/internal', '原请求状态尚不能核实；未重新生成，请检查本地日志。', {}) }
  }

  @Remote
  async stopPending(sessionId: string, operationId: string): Promise<OperationStatus> {
    this.owner()
    this.operationIdentity(sessionId, operationId)
    try { return await this.adapter?.verifyPending(sessionId, operationId, true) ?? { pending: false } }
    catch { throw new RemoteError('gateway/internal', '停止尚未确认；本会话未放行新生成，请检查本地日志。', {}) }
  }

  private operationIdentity(sessionId: string, operationId: string) {
    if (!sessionId || sessionId.length > 512 || !/^[a-f0-9-]{36}$/.test(operationId)) throw new RemoteError('gateway/internal', 'Invalid operation identity.', {})
  }

  @Remote
  async cancelSummary(sessionId: string, operationId: string, compactionId: string): Promise<OperationStatus> {
    this.owner(); this.operationIdentity(sessionId, operationId)
    if (!compactionId || compactionId.length > 512) throw new RemoteError('gateway/internal', 'Invalid compaction identity.', {})
    try { return await this.adapter?.cancelSummary(sessionId, operationId, compactionId) ?? { pending: false } }
    catch { throw new RemoteError('gateway/internal', '摘要状态已变化，请刷新后重试。', {}) }
  }

  @Remote
  async usage(sessionId: string): Promise<UsageStatus> {
    this.owner()
    if (!sessionId || sessionId.length > 512 || !this.adapter) throw new RemoteError('gateway/internal', 'Invalid session identity.', {})
    try {
      const view = await this.adapter.usage(sessionId)
      const agent = this.ctx.get('agents')?.get(SessionId(sessionId))
      const service = agent ? this.ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction') : this.ctx.get('compaction')
      const backend = service instanceof TokenFreeCompactionEngine ? service.config.auto ? 'ready' : 'disabled' : service ? 'incompatible' : 'missing'
      return { ...view, backend, automatic: view.automatic && backend === 'ready' }
    } catch { throw new RemoteError('gateway/internal', 'Unable to inspect official usage.', {}) }
  }

  @Remote
  async inspect(sessionId: string): Promise<import('../core/account-types.js').SessionStatus> {
    this.owner()
    if (!sessionId || sessionId.length > 512) throw new RemoteError('gateway/internal', 'Invalid session identity.', {})
    try { return await this.adapter?.inspect(sessionId) ?? { sessionId, needsRebase: false } }
    catch { throw new RemoteError('gateway/internal', 'Unable to inspect the local session state.', {}) }
  }

  @Remote
  async rebuild(sessionId: string): Promise<void> {
    this.owner()
    if (!sessionId || sessionId.length > 512) throw new RemoteError('gateway/internal', 'Invalid session identity.', {})
    try { await this.adapter?.rebuild(sessionId) }
    catch { throw new RemoteError('gateway/internal', '请先核实待处理请求，再从 DSH 历史重建网页上下文。', {}) }
  }

  @Remote
  async status(): Promise<AccountStatus> { this.owner(); return this.account.refreshLocalStatus() }

  @Remote
  defaultModel(): DefaultModelStatus {
    this.owner()
    const defaults = this.ctx.get('agentDefaultModel')
    const selection = defaults?.currentSelection()
    return { available: defaults !== undefined, selected: selection?.provider === PROVIDER && selection.model === MODEL }
  }

  /** The no-session settings action uses DSH's public default writer. */
  @Remote
  async useDefault(): Promise<DefaultModelStatus> {
    this.owner()
    if ((await this.account.refreshLocalStatus()).state !== 'connected') {
      throw new RemoteError('gateway/internal', '请先登录 DeepSeek。', {})
    }
    const defaults = this.ctx.get('agentDefaultModel')
    if (!defaults) throw new RemoteError('gateway/internal', '当前 DSH 配置未提供默认模型设置。', {})
    const resolved = await this.ctx.llm.resolveCallConfig({ provider: PROVIDER, model: MODEL })
    await defaults.saveSelection({ provider: resolved.provider, model: resolved.model,
      ...(resolved.reasoningEffort === undefined ? {} : { reasoningEffort: resolved.reasoningEffort }) })
    return this.defaultModel()
  }

  @Remote
  login(): AccountStatus { this.owner(); return this.account.login() }

  @Remote
  async restore(): Promise<AccountStatus> { this.owner(); return this.account.restore() }

  @Remote
  async cancel(): Promise<AccountStatus> { this.owner(); return this.account.cancel() }

  @Remote
  async logout(): Promise<AccountStatus> {
    this.owner()
    try { return await this.account.logout() }
    catch { throw new RemoteError('gateway/internal', 'Unable to clear the local TokenFree login.', {}) }
  }
}
