import { mkdir, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { defaultHome } from './auth.js'

type DiagnosticEvent =
  | 'plugin.started' | 'plugin.stopped'
  | 'login.started' | 'login.waiting' | 'login.transition' | 'login.authorized' | 'login.failed' | 'login.closed' | 'login.timed-out' | 'login.cancelled'
  | 'account.login' | 'account.validating' | 'account.persisting' | 'account.connected' | 'account.failed' | 'account.cancelled' | 'account.logout' | 'account.recovering'
  | 'model.queued' | 'model.started' | 'model.recovering' | 'model.completed' | 'model.failed' | 'model.response' | 'model.format-repair'
  | 'content.queued' | 'policy.updated'
  | 'metrics.observed' | 'metrics.unavailable' | 'compaction.started' | 'compaction.failed'
  | 'http.started' | 'http.completed' | 'http.failed'
  | 'operation.state' | 'operation.pending' | 'operation.committed' | 'stream.resuming' | 'stream.stopping' | 'stream.revised' | 'stream.withdrawn'
  | 'stream.stop-request-failed' | 'stream.stop-history-pending'
export interface DiagnosticFields {
  operationId?: string
  phase?: 'launch' | 'navigate' | 'read' | 'verify' | 'persist'
  code?: string
  elapsedMs?: number
  httpStatus?: number
  endpoint?: string
  interactive?: boolean
  toolsEnabled?: boolean
  errorKind?: string
  errorName?: string
  responseShape?: 'empty' | 'json-object' | 'json-array' | 'json-scalar' | 'fenced' | 'tagged' | 'plain-text'
  responseChars?: number
  formatStage?: 'initial' | 'repair'
  stage?: string
  attempt?: number
}

const endpoints = new Set(['/api/v0/users/current', '/api/v0/chat_session/create', '/api/v0/chat/create_pow_challenge', '/api/v0/chat/completion', '/api/v0/chat/history_messages', '/api/v0/chat/resume_stream', '/api/v0/chat/stop_stream', '/api/v0/chat/edit_message', '/api/v0/client/settings'])
const codes = new Set(['AUTH', 'AUTH_STORAGE', 'ABORTED', 'TIMEOUT', 'TRANSPORT', 'RATE_LIMIT', 'QUOTA', 'WEB_HTTP', 'WEB_PROTOCOL', 'WEB_REJECTED', 'WEB_TOOL_FORMAT', 'WEB_INCOMPLETE', 'INCOMPLETE', 'EMPTY_RESPONSE', 'RESPONSE_TOO_LARGE', 'CONTEXT_WINDOW_EXCEEDED', 'UNSUPPORTED_CONTENT', 'MISSING_CREDENTIAL', 'INVALID_CREDENTIAL', 'INVALID_TOOL_CALL', 'MODEL_UNSUPPORTED', 'UNSUPPORTED_OPTION', 'LOGIN_REVOKED', 'LOGIN_BROWSER', 'LOGIN_PROFILE_BUSY', 'LOGIN_CHROME_MISSING', 'LOGIN_VERIFY_NETWORK', 'LOGIN_PAGE_NETWORK', 'LOGIN_RESULT_READ', 'UNKNOWN', 'STATE_STORAGE', 'PENDING_OPERATION', 'SESSION_BUSY', 'OPERATION_CHANGED', 'WEB_DISCONNECTED', 'WEB_IDENTITY', 'WEB_CONTEXT_CHANGED', 'WEB_CHALLENGE', 'ACCOUNT_ID_UNKNOWN', 'INPUT_TOO_LARGE', 'NATIVE_CONTEXT', 'FEATURE_PENDING', 'CONTENT_RETRACTED', 'LOCAL_TITLE', 'POW_FAILED', 'METRICS_UNKNOWN', 'COMPACTION_REQUIRED', 'COMPACTION_PENDING', 'COMPACTION_UNAVAILABLE', 'COMPACTION_RANGE', 'INVALID_POLICY', 'UNSUPPORTED_SCHEMA', 'TOOL_UNAVAILABLE', 'TOOL_CHOICE', 'TOOL_CHANGED', 'TOOL_BINDING', 'OUTPUT_FORMAT', 'OUTPUT_SCHEMA'])
const kinds = new Set(['navigation', 'profile-busy', 'missing-browser', 'dns', 'tls', 'network', 'timeout', 'closed', 'runtime-helper', 'runtime-reference', 'unknown'])
const names = new Set(['Error', 'TypeError', 'ReferenceError', 'TimeoutError', 'AbortError', 'LlmError', 'TokenFreeError', 'unknown'])

/** Inspect error categories in memory; never return raw messages, stacks, URLs, or causes. */
export function failureCategory(error: unknown): Pick<DiagnosticFields, 'code' | 'errorKind' | 'errorName'> {
  const value = error instanceof Error ? error : undefined
  const message = value?.message ?? ''
  let kind = 'unknown'
  if (/execution context|navigation|frame was detached|ERR_ABORTED/i.test(message)) kind = 'navigation'
  else if (/singleton|profile.*in use/i.test(message)) kind = 'profile-busy'
  else if (/executable.*doesn.t exist|distribution.*not found/i.test(message)) kind = 'missing-browser'
  else if (/__name is not defined|__awaiter is not defined/i.test(message)) kind = 'runtime-helper'
  else if (value?.name === 'ReferenceError') kind = 'runtime-reference'
  else if (/timeout|timed out/i.test(message)) kind = 'timeout'
  else if (/closed|disposed/i.test(message)) kind = 'closed'
  let current: unknown = error
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const cause = current as { code?: unknown; cause?: unknown }
    if (typeof cause.code === 'string') {
      if (['ENOTFOUND', 'EAI_AGAIN'].includes(cause.code)) kind = 'dns'
      if (['CERT_HAS_EXPIRED', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(cause.code)) kind = 'tls'
      if (['ECONNRESET', 'ECONNREFUSED', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(cause.code)) kind = 'network'
    }
    current = cause.cause
  }
  const code = error && typeof error === 'object' && 'code' in error && typeof error.code === 'string' && codes.has(error.code) ? error.code : 'UNKNOWN'
  return { code, errorKind: kind, errorName: value && names.has(value.name) ? value.name : 'unknown' }
}

/** Append-only local diagnostics. Explicit projection prevents accidental secret logging. */
export class LocalDiagnostics {
  readonly file: string
  readonly contentDirectory: string
  private readonly tails = new Map<string, Promise<void>>()
  private readonly instance = randomUUID()
  private sequence = 0
  private readonly secrets = new Set<string>()
  constructor(home = defaultHome(), private readonly print = true, private readonly logContent = true) {
    this.file = join(home, 'logs', 'events.jsonl')
    this.contentDirectory = join(home, 'logs', 'requests')
  }

  /** Credentials are used only to redact known authentication values from content. */
  protect(credential: { token: string; cookie?: string }): void {
    if (credential.token) this.secrets.add(credential.token)
    if (credential.cookie) {
      this.secrets.add(credential.cookie)
      for (const item of credential.cookie.split(';')) {
        const value = item.slice(item.indexOf('=') + 1).trim()
        if (value.length >= 8) this.secrets.add(value)
      }
    }
  }

  /** Explicit model/transport bodies only. Callers never supply headers or login responses. */
  content(operationId: string, event: 'dsh.request' | 'web.request' | 'web.response' | 'dsh.response' | 'web.event' | 'operation.state' | 'native.commit' | 'validation' | 'preview' | 'metrics.observed', payload: object): void {
    if (!this.logContent || !/^[a-f0-9-]{36}$/.test(operationId)) return
    let line: string
    try {
      const needles = [...new Set([...this.secrets].flatMap(secret => [secret, JSON.stringify(secret).slice(1, -1)]))].sort((a, b) => b.length - a.length)
      line = JSON.stringify({ at: new Date().toISOString(), instance: this.instance, sequence: ++this.sequence, operationId, event, payload }, (_key, value: unknown) => {
        if (typeof value !== 'string') return value
        for (const needle of needles) value = (value as string).split(needle).join('[REDACTED]')
        return value
      })
    } catch { return }
    const file = join(this.contentDirectory, `${operationId}.jsonl`)
    this.enqueue(file, line).catch(() => {
      if (this.print) console.warn('[dsh-tokenfree] Unable to write local request content.')
    })
    this.write('content.queued', { operationId })
  }

  private async append(file: string, line: string): Promise<void> {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    const handle = await open(file, constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await handle.chmod(0o600); await handle.writeFile(line + '\n') } finally { await handle.close() }
  }

  write(event: DiagnosticEvent, fields: DiagnosticFields = {}): void {
    const safe: Record<string, unknown> = { at: new Date().toISOString(), instance: this.instance, sequence: ++this.sequence, event }
    if (fields.operationId && /^[a-f0-9-]{36}$/.test(fields.operationId)) safe.operationId = fields.operationId
    if (fields.phase && ['launch', 'navigate', 'read', 'verify', 'persist'].includes(fields.phase)) safe.phase = fields.phase
    if (fields.code) safe.code = codes.has(fields.code) ? fields.code : 'UNKNOWN'
    if (fields.errorKind) safe.errorKind = kinds.has(fields.errorKind) ? fields.errorKind : 'unknown'
    if (fields.errorName) safe.errorName = names.has(fields.errorName) ? fields.errorName : 'unknown'
    if (fields.endpoint && endpoints.has(fields.endpoint)) safe.endpoint = fields.endpoint
    if (fields.responseShape && ['empty', 'json-object', 'json-array', 'json-scalar', 'fenced', 'tagged', 'plain-text'].includes(fields.responseShape)) safe.responseShape = fields.responseShape
    if (fields.formatStage && ['initial', 'repair'].includes(fields.formatStage)) safe.formatStage = fields.formatStage
    if (fields.stage && /^[a-z-]{1,32}$/.test(fields.stage)) safe.stage = fields.stage
    if (Number.isSafeInteger(fields.attempt) && fields.attempt! >= 0) safe.attempt = fields.attempt
    for (const key of ['elapsedMs', 'httpStatus', 'responseChars'] as const) if (typeof fields[key] === 'number' && Number.isFinite(fields[key]) && fields[key]! >= 0) safe[key] = Math.round(fields[key]!)
    for (const key of ['interactive', 'toolsEnabled'] as const) if (typeof fields[key] === 'boolean') safe[key] = fields[key]
    const line = JSON.stringify(safe)
    // stdout belongs to the host (including headless --json).
    if (this.print) console.error(`[dsh-tokenfree] ${line}`)
    void this.enqueue(this.file, line).catch(() => { if (this.print) console.warn('[dsh-tokenfree] Unable to write local diagnostics.') })
  }

  private enqueue(file: string, line: string): Promise<void> {
    const task = (this.tails.get(file) ?? Promise.resolve()).catch(() => {}).then(() => this.append(file, line))
    this.tails.set(file, task)
    void task.then(() => { if (this.tails.get(file) === task) this.tails.delete(file) }, () => { if (this.tails.get(file) === task) this.tails.delete(file) })
    return task
  }
  async flush(operationId?: string): Promise<void> {
    if (operationId) await this.tails.get(join(this.contentDirectory, `${operationId}.jsonl`))?.catch(() => {})
    else await Promise.allSettled(this.tails.values())
  }
}
