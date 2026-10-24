/** Public account state. Credentials never cross the plugin's Remote boundary. */
export type { SessionPolicy, PolicyState, ToolChoice, OutputFormat } from './types.js'
export interface AccountStatus {
  state: 'signed-out' | 'restoring' | 'signing-in' | 'connected' | 'reauth-required' | 'error'
  message: string
  configured: boolean
  busy: boolean
  lastValidatedAt?: number
}

/** Native default selection only. No account or credential fields. */
export interface DefaultModelStatus {
  available: boolean
  selected: boolean
}

/** Recovery metadata only; no credential, prompt or tool argument is exposed. */
export interface OperationStatus {
  operationId?: string
  compactionId?: string
  pending: boolean
  sessionId?: string
  stage?: string
  stopRequested?: boolean
  settled?: boolean
}

export interface SessionStatus {
  sessionId: string
  chatId?: string
  parentId?: number | null
  generation?: number
  needsRebase: boolean
  usage?: { accumulated_token_usage: number; chatId: string; messageId: number; source: 'history'; observedAt: string }
  pending?: { id: string; stage: string; stopRequested: boolean }
}

export interface UsageStatus {
  sessionId: string
  state: 'unknown' | 'new-chat' | 'confirmed' | 'stale'
  count?: number
  budget?: number
  threshold?: number
  percentage?: number
  remainingToThreshold?: number
  modelType?: string
  thinking?: boolean
  countSource?: 'history'
  countObservedAt?: string
  budgetObservedAt?: string
  budgetField?: 'token_limit' | 'token_limit_with_thinking'
  budgetSource?: 'client/settings' | 'default'
  settingsVersion?: number
  chatId?: string
  messageId?: number | null
  lastObservation?: { accumulated_token_usage: number; chatId: string; messageId: number; source: 'history'; observedAt: string }
  compaction?: 'awaiting-checkpoint' | 'failed' | 'needs-new-chat' | 'complete'
  automatic: boolean
  reached: boolean
  backend?: 'ready' | 'missing' | 'incompatible' | 'disabled'
  generation?: { operationId: string; compactionId?: string; purpose: 'compaction' | 'conversation'; count?: number; source?: 'sse' | 'history'; observedAt?: string; chatId?: string; messageId?: number; stage: string }
}
