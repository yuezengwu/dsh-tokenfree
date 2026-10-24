import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Block, NativeAttempt, Tool, WebIdentity, OfficialBudget, CompactionAnchor, PolicyState, SessionPolicy } from '../core/types.js'
import { defaultPolicy, oneShot, parsePolicy } from '../core/policy.js'
import { record, TokenFreeError } from '../core/errors.js'
import { privateDirectory, readJson, writeJson } from './files.js'
import { acquireLock } from './lock.js'
import { readdir, rm } from 'node:fs/promises'
import { readCredential, saveCredential, normalizeCredential, type WebCredential } from './auth.js'

export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export interface ActiveOperation {
  id: string
  kind?: 'compaction'
  compaction?: CompactionAnchor & { rootId: number; oldParentId: number; oldPath: { id: number; parentId: number | null; hash: string }[] }
  accountKey: string
  epoch: number
  sessionKey: string
  sessionId?: string
  storeId: string
  generation: number
  stage: 'prepared' | 'creating' | 'sending' | 'receiving' | 'ready-to-deliver' | 'awaiting-native' | 'stopped' | 'failed' | 'uncertain'
  native?: NativeAttempt
  chatId?: string
  identity?: WebIdentity
  parentId: number | null
  promptHash: string
  inputHashes: string[]
  instructionsHash: string
  toolsHash: string
  tools: Tool[]
  executionTools?: Tool[]
  policy?: PolicyState
  thinking: boolean
  expected?: Block[]
  responseText?: string
  reasoning?: string
  usage?: number
  usageSource?: 'sse' | 'history'
  usageObservedAt?: string
  budget?: OfficialBudget
  finalStatus?: string
  stopRequested?: boolean
  rebase?: boolean
  repair?: { original: WebIdentity; candidateHash: string; parentId: number | null; promptHash: string; path: { id: number; parentId: number | null; hash: string }[] }
  verifiedPath?: { id: number; parentId: number | null; hash: string }[]
  knownRejected?: boolean
  parentPath?: { id: number; parentId: number | null; hash: string }[]
}
export interface AccountState { schemaVersion: 2; epoch: number; deviceId?: string; accountKey?: string; credentialHash?: string | null }
interface SessionFile { schemaVersion: 2; confirmed?: SessionState; active?: ActiveOperation; policy?: PolicyState }
export interface SessionState {
  schemaVersion: 1
  sessionKey: string
  sessionId: string
  storeId: string
  accountKey: string
  generation: number
  chatId?: string
  parentId: number | null
  prefix: string[]
  instructionsHash: string
  toolsHash: string
  tools: Tool[]
  catalogueKnown?: boolean
  executionTools?: Tool[]
  webPath?: { id: number; parentId: number | null; hash: string }[]
  needsRebase?: boolean
  previousChatId?: string
  lastOperationId?: string
  nativeSeq?: number
  modelType?: string
  thinking?: boolean
  budget?: OfficialBudget
  metricsCurrent?: boolean
  metricsEpoch?: number
  compaction?: { compactionId: string; startSeq: number; phase: 'awaiting-checkpoint' | 'failed' | 'needs-new-chat' | 'complete'; operationId: string; checkpointSeq?: number; endSeq?: number; initializingChatId?: string }
  usage?: { accumulated_token_usage: number; chatId: string; messageId: number; source: 'history'; observedAt: string }
}

const hash = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v)
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const text = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 4096
const hashes = (v: unknown) => Array.isArray(v) && v.every(hash)
const tools = (v: unknown) => Array.isArray(v) && v.every(t => record(t) && text(t.name) && typeof t.description === 'string' && record(t.parameters))
const path = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(p => record(p) && integer(p.id) && (p.parentId === null || integer(p.parentId)) && hash(p.hash)))
const budget = (v: unknown) => v === undefined || (record(v) && (v.value === undefined || (integer(v.value) && v.value > 0))
  && (v.modelType === undefined || text(v.modelType)) && typeof v.thinking === 'boolean' && ['token_limit', 'token_limit_with_thinking'].includes(String(v.field))
  && (v.source === 'client/settings' ? text(v.modelType) && integer(v.settingsVersion)
    : v.source === 'default' && integer(v.value) && v.value > 0 && (v.settingsVersion === undefined || integer(v.settingsVersion))) && text(v.observedAt)
  && (v.inputCharacterLimit === undefined || (integer(v.inputCharacterLimit) && v.inputCharacterLimit > 0)))
const anchor = (v: unknown) => record(v) && text(v.compactionId) && integer(v.startSeq)
const policy = (v: unknown) => {
  if (v === undefined) return true
  if (!record(v) || !text(v.revision)) return false
  try { const { revision: _, ...settings } = v; parsePolicy(settings); return true } catch { return false }
}
function validOperation(v: unknown): boolean {
  if (!record(v)) return false
  return text(v.id) && hash(v.accountKey) && integer(v.epoch) && hash(v.sessionKey) && text(v.storeId) && integer(v.generation)
    && ['prepared', 'creating', 'sending', 'receiving', 'ready-to-deliver', 'awaiting-native', 'stopped', 'failed', 'uncertain'].includes(String(v.stage))
    && (v.parentId === null || integer(v.parentId)) && typeof v.promptHash === 'string' && hashes(v.inputHashes)
    && hash(v.instructionsHash) && hash(v.toolsHash) && tools(v.tools) && typeof v.thinking === 'boolean'
    && (v.executionTools === undefined || tools(v.executionTools)) && policy(v.policy)
    && (v.sessionId === undefined || text(v.sessionId)) && (v.chatId === undefined || text(v.chatId))
    && (v.identity === undefined || (record(v.identity) && v.identity.chatId === v.chatId && integer(v.identity.requestId) && integer(v.identity.responseId)))
    && (v.native === undefined || (record(v.native) && v.native.sessionId === v.sessionId && integer(v.native.turn) && integer(v.native.step)
      && integer(v.native.afterSeq) && (v.native.settlementSeq === undefined || integer(v.native.settlementSeq))
      && (v.native.abandoned === undefined || typeof v.native.abandoned === 'boolean') && text(v.native.attemptId) && text(v.native.instance)))
    && path(v.verifiedPath) && path(v.parentPath)
    && budget(v.budget) && (v.usage === undefined || integer(v.usage))
    && (v.kind === undefined ? v.compaction === undefined : v.kind === 'compaction' && anchor(v.compaction)
      && record(v.compaction) && v.compaction.sessionId === v.sessionId && v.compaction.thinking === v.thinking
      && integer(v.compaction.rootId) && integer(v.compaction.oldParentId) && Array.isArray(v.compaction.oldPath) && path(v.compaction.oldPath))
    && (v.expected === undefined || Array.isArray(v.expected))
}

/** Account metadata is shared; each session owns its confirmed association and active operation. */
export class LocalStore {
  constructor(readonly home: string) {}
  private async prepare() {
    await privateDirectory(this.home)
    await privateDirectory(join(this.home, 'locks'))
    await privateDirectory(join(this.home, 'sessions'))
  }
  async sessionLock(key: string, signal: AbortSignal) {
    if (!hash(key)) throw new TokenFreeError('Invalid session key.', 'STATE_STORAGE')
    await this.prepare()
    return acquireLock(join(this.home, 'locks', `session-${key}`), signal, false)
  }
  private async rawAccount(): Promise<AccountState> {
    const value = await readJson<AccountState>(join(this.home, 'account.json'))
    if (!value) return { schemaVersion: 2, epoch: 0 }
    if (!record(value) || value.schemaVersion !== 2 || value.active !== undefined || !integer(value.epoch)
      || (value.deviceId !== undefined && !text(value.deviceId)) || (value.accountKey !== undefined && !hash(value.accountKey))
      || (value.credentialHash !== undefined && value.credentialHash !== null && !hash(value.credentialHash))) {
      throw new TokenFreeError('Unsupported or damaged account state; it was preserved.', 'STATE_STORAGE')
    }
    return value
  }
  async account(): Promise<AccountState> {
    await this.prepare()
    const legacy = await readJson<Record<string, unknown>>(join(this.home, 'account.json'))
    if (legacy?.schemaVersion === 1) await this.upgrade()
    return this.rawAccount()
  }
  /** One-time bridge only. Old binaries reject v2 rather than overwrite concurrent state. */
  async upgrade(): Promise<void> {
    await this.prepare()
    const releaseLegacy = await acquireLock(join(this.home, 'locks', 'generation'), AbortSignal.timeout(10_000))
    try {
      const release = await acquireLock(join(this.home, 'locks', 'state'), AbortSignal.timeout(10_000))
      try {
        const old = await readJson<Record<string, unknown>>(join(this.home, 'account.json'))
        if (!old || old.schemaVersion === 2) return
        if (old.schemaVersion !== 1 || !integer(old.epoch) || (old.active !== undefined && !validOperation(old.active))) throw new TokenFreeError('Legacy state is damaged; migration stopped.', 'STATE_STORAGE')
        if (!(await readJson(join(this.home, 'account.v1.backup.json')))) await writeJson(join(this.home, 'account.v1.backup.json'), old)
        if (old.active) {
          const active = old.active as ActiveOperation
          const session = await this.sessionFile(active.sessionKey)
          if (session.active && session.active.id !== active.id) throw new TokenFreeError('Migration conflicts with another operation.', 'STATE_STORAGE')
          await this.writeSession(active.sessionKey, { ...session, active })
        }
        const { active: _, ...rest } = old
        await writeJson(join(this.home, 'account.json'), { ...rest, schemaVersion: 2 })
      } finally { await release() }
    } finally { await releaseLegacy() }
  }
  private async sessionFile(key: string): Promise<SessionFile> {
    await this.prepare()
    if (!hash(key)) throw new TokenFreeError('Invalid session key.', 'STATE_STORAGE')
    const value = await readJson<SessionFile | SessionState>(join(this.home, 'sessions', `${key}.json`))
    if (!value) return { schemaVersion: 2 }
    if (value.schemaVersion === 1) return { schemaVersion: 2, confirmed: value }
    if (value.schemaVersion !== 2 || !policy(value.policy) || (value.active !== undefined && (!validOperation(value.active) || value.active.sessionKey !== key))
      || (value.confirmed !== undefined && value.confirmed.sessionKey !== key)) throw new TokenFreeError('Damaged session envelope; it was preserved.', 'STATE_STORAGE')
    return value
  }
  private async writeSession(key: string, value: SessionFile) {
    const file = join(this.home, 'sessions', `${key}.json`)
    const previous = await readJson<Record<string, unknown>>(file)
    if (previous?.schemaVersion === 1 && !(await readJson(`${file}.v1.backup`))) await writeJson(`${file}.v1.backup`, previous)
    await writeJson(file, value)
  }
  async pending(key: string) { return (await this.sessionFile(key)).active }
  async policy(key: string): Promise<PolicyState> { return (await this.sessionFile(key)).policy ?? { ...defaultPolicy(), revision: 'default' } }
  async setPolicy(key: string, settings: SessionPolicy): Promise<PolicyState> {
    const next = { ...parsePolicy(settings), revision: randomUUID() }
    const release = await this.sessionLock(key, AbortSignal.timeout(5000))
    try {
      const value = await this.sessionFile(key)
      if (value.active) throw new TokenFreeError('Settle this session operation before changing its policy.', 'PENDING_OPERATION')
      await this.writeSession(key, { ...value, policy: next })
      return next
    } finally { await release() }
  }
  async sessionKeys() { await this.prepare(); return (await readdir(join(this.home, 'sessions'))).filter(x => /^[a-f0-9]{64}\.json$/.test(x)).map(x => x.slice(0, -5)) }
  async session(key: string): Promise<SessionState | undefined> {
    await this.prepare()
    if (!/^[a-f0-9]{64}$/.test(key)) throw new TokenFreeError('Invalid local session key.', 'STATE_STORAGE')
    let value = (await this.sessionFile(key)).confirmed
    // An absent legacy snapshot can be explicitly replaced after branch verification.
    // A present but malformed snapshot is still corruption, never treated as empty.
    if (value && value.tools === undefined) value = { ...value, tools: [], catalogueKnown: false }
    if (value && (value.schemaVersion !== 1 || value.sessionKey !== key || !Array.isArray(value.prefix)
      || !hashes(value.prefix) || !integer(value.generation) || !text(value.sessionId) || !text(value.storeId) || !hash(value.accountKey)
      || !hash(value.instructionsHash) || !hash(value.toolsHash) || !tools(value.tools) || (value.catalogueKnown !== undefined && typeof value.catalogueKnown !== 'boolean')
      || (value.executionTools !== undefined && !tools(value.executionTools)) || !path(value.webPath)
      || (value.parentId !== null && !integer(value.parentId)) || !budget(value.budget)
      || (value.modelType !== undefined && !text(value.modelType)) || (value.thinking !== undefined && typeof value.thinking !== 'boolean')
      || (value.metricsCurrent !== undefined && typeof value.metricsCurrent !== 'boolean')
      || (value.metricsEpoch !== undefined && !integer(value.metricsEpoch))
      || (value.usage !== undefined && (!record(value.usage) || !integer(value.usage.accumulated_token_usage) || value.usage.chatId !== value.chatId
        || value.usage.messageId !== value.parentId || value.usage.source !== 'history' || !text(value.usage.observedAt)))
      || (value.compaction !== undefined && (!anchor(value.compaction) || !text(value.compaction.operationId)
        || !['awaiting-checkpoint', 'failed', 'needs-new-chat', 'complete'].includes(value.compaction.phase))))) {
      throw new TokenFreeError('Unsupported or damaged session state; it was preserved.', 'STATE_STORAGE')
    }
    return value
  }
  /** Short account fence only. Never call session I/O, browser or network from here. */
  private async mutate<T>(change: (account: AccountState) => Promise<T>): Promise<T> {
    await this.account()
    const release = await acquireLock(join(this.home, 'locks', 'state'), AbortSignal.timeout(10_000))
    try { return await change(await this.rawAccount()) } finally { await release() }
  }
  async credential(file: string): Promise<WebCredential | undefined> {
    return this.mutate(async account => {
      const credential = await readCredential(file)
      if (account.credentialHash === null) return undefined
      if (account.credentialHash !== undefined && (!credential || digest(credential) !== account.credentialHash)) throw new TokenFreeError('Credential commit is incomplete; reconnect before use.', 'AUTH_STORAGE')
      return credential ? { ...credential, epoch: account.epoch } : undefined
    })
  }
  async saveLogin(file: string, credential: WebCredential, epoch: number): Promise<number> {
    const { epoch: _snapshotEpoch, ...savedCredential } = credential
    credential = normalizeCredential(savedCredential)
    return this.mutate(async account => {
      if (account.epoch !== epoch) throw new TokenFreeError('连接已被其他入口撤销，请重新登录。 [LOGIN_REVOKED]', 'LOGIN_REVOKED')
      const previous = await readCredential(file), nextHash = digest(credential)
      const nextEpoch = previous && digest(previous) === nextHash && account.credentialHash !== null ? epoch : epoch + 1
      await writeJson(join(this.home, 'account.json'), { ...account, epoch: nextEpoch, credentialHash: nextHash, accountKey: credential.accountId ? digest(['deepseek-web-account', credential.accountId]) : undefined })
      await saveCredential(credential, file)
      return nextEpoch
    })
  }
  async rejectCredential(file: string, rejected: WebCredential): Promise<boolean> {
    return this.mutate(async account => {
      const current = await readCredential(file)
      const { epoch, ...credential } = rejected
      if (epoch !== account.epoch || !current || current.token !== credential.token || current.cookie !== credential.cookie
        || current.accountId !== undefined && current.accountId !== credential.accountId) return false
      await writeJson(join(this.home, 'account.json'), { ...account, epoch: account.epoch + 1, credentialHash: null })
      await rm(file, { force: true })
      return true
    })
  }
  async forgetLogin(file: string): Promise<void> {
    await this.mutate(async account => {
      await writeJson(join(this.home, 'account.json'), { ...account, epoch: account.epoch + 1, credentialHash: null })
      await rm(file, { force: true })
    })
  }
  async deviceId(): Promise<string> {
    return this.mutate(async account => {
      if (account.deviceId) return account.deviceId
      const deviceId = randomUUID()
      await writeJson(join(this.home, 'account.json'), { ...account, deviceId })
      return deviceId
    })
  }
  /** These mutations require the caller's session lease, never an account-wide lease. */
  async amendSession(key: string, change: Partial<SessionState>, activeId?: string): Promise<void> {
    const value = await this.sessionFile(key)
    if (activeId && value.active?.id !== activeId) throw new TokenFreeError('Operation lost session ownership.', 'PENDING_OPERATION')
    if (!value.confirmed) throw new TokenFreeError('No confirmed Web association exists.', 'NATIVE_CONTEXT')
    await this.writeSession(key, { ...value, confirmed: { ...value.confirmed, ...change } })
  }
  async begin(operation: ActiveOperation): Promise<void> {
    const value = await this.sessionFile(operation.sessionKey)
    if (value.active) throw new TokenFreeError('This session has an unverified operation.', 'PENDING_OPERATION')
    const account = await this.account()
    if (account.epoch !== operation.epoch || account.accountKey !== undefined && account.accountKey !== operation.accountKey) throw new TokenFreeError('Account was revoked.', 'ABORTED')
    await this.writeSession(operation.sessionKey, { ...value, active: operation })
  }
  async update(key: string, id: string, change: Partial<ActiveOperation>): Promise<void> {
    const value = await this.sessionFile(key), operation = value.active
    if (operation?.id !== id) throw new TokenFreeError('Operation no longer owns this session.', 'PENDING_OPERATION')
    const next = { ...operation, ...change }
    if (next.id !== id || next.sessionKey !== key || next.accountKey !== operation.accountKey || next.epoch !== operation.epoch) throw new TokenFreeError('Operation identity cannot change.', 'STATE_STORAGE')
    await this.writeSession(key, { ...value, active: next })
  }
  async commit(key: string, id: string, session?: SessionState): Promise<void> {
    const value = await this.sessionFile(key), operation = value.active
    if (operation?.id !== id) return
    if (session && (session.sessionKey !== key || operation.accountKey !== session.accountKey || operation.generation !== session.generation)) throw new TokenFreeError('Session commit identity mismatch.', 'STATE_STORAGE')
    const account = await this.account()
    const confirmed = session ? { ...session, needsRebase: Boolean(session.needsRebase || operation.epoch !== account.epoch) } : value.confirmed
    const consume = session && !confirmed?.needsRebase && !operation.rebase && operation.expected?.some(x => x.type === 'tool-call')
      && operation.policy && oneShot(operation.policy) && value.policy?.revision === operation.policy.revision
    await this.writeSession(key, { ...value, confirmed, active: undefined,
      ...(consume ? { policy: { ...value.policy!, tools: { mode: 'auto' }, revision: randomUUID() } } : {}) })
  }
  async revoke(): Promise<void> {
    await this.mutate(async account => { await writeJson(join(this.home, 'account.json'), { ...account, epoch: account.epoch + 1 }) })
  }
}
