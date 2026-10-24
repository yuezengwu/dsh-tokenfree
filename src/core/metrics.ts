import type { OfficialBudget, WebSettings } from './types.js'
import type { UsageStatus } from './account-types.js'
import type { SessionState } from '../local/store.js'

export const DEFAULT_BUDGET = 890_880
/** Round 50% upward using integers; never estimate the observed count. */
export function threshold(budget: number): number { return Number((BigInt(budget) + 1n) / 2n) }
export function budgetFor(settings: WebSettings | undefined, modelType: string | undefined, thinking: boolean): OfficialBudget {
  const candidates = modelType ? settings?.models.filter(x => x.modelType === modelType) : undefined
  const model = candidates?.length === 1 ? candidates[0] : undefined
  const value = thinking ? model?.tokenLimitWithThinking : model?.tokenLimit
  const official = value !== undefined && Number.isSafeInteger(value) && value > 0
  return { value: official ? value : DEFAULT_BUDGET, modelType, thinking, field: thinking ? 'token_limit_with_thinking' : 'token_limit',
    source: official ? 'client/settings' : 'default', settingsVersion: settings?.version,
    observedAt: official ? settings!.observedAt : new Date().toISOString(), inputCharacterLimit: model?.inputCharacterLimit }
}
export function pressure(session: SessionState | undefined): boolean {
  return Boolean(session && !session.needsRebase && session.metricsCurrent && session.usage && session.budget?.value !== undefined
    && session.usage.chatId === session.chatId && session.usage.messageId === session.parentId
    && session.budget.modelType === session.modelType && session.budget.thinking === session.thinking
    && session.usage.accumulated_token_usage >= threshold(session.budget.value))
}
export function metricView(session: SessionState | undefined): Omit<UsageStatus, 'sessionId'> {
  const current = Boolean(session && !session.needsRebase && session.metricsCurrent)
  const count = current && session?.usage?.chatId === session?.chatId && session?.usage?.messageId === session?.parentId ? session?.usage?.accumulated_token_usage : undefined
  const budget = current && session && session.budget?.modelType === session.modelType && session.budget?.thinking === session.thinking ? session.budget : undefined
  const limit = budget?.value !== undefined ? threshold(budget.value) : undefined
  return { state: !session ? 'unknown' : session.compaction?.phase === 'needs-new-chat' ? 'new-chat' : current ? 'confirmed' : 'stale',
    count, budget: budget?.value, threshold: limit, percentage: count !== undefined && budget?.value !== undefined ? count / budget.value * 100 : undefined,
    remainingToThreshold: count !== undefined && limit !== undefined ? Math.max(0, limit - count) : undefined,
    modelType: session?.modelType, thinking: session?.thinking, countSource: count !== undefined ? session?.usage?.source : undefined,
    countObservedAt: session?.usage?.observedAt, budgetObservedAt: budget?.observedAt, budgetField: budget?.field,
    budgetSource: budget?.source, settingsVersion: budget?.settingsVersion, chatId: session?.chatId, messageId: session?.parentId,
    lastObservation: session?.usage, compaction: session?.compaction?.phase, automatic: current && count !== undefined && budget?.value !== undefined
      && (!session?.compaction || session.compaction.phase === 'complete'),
    reached: current && pressure(session) }
}
