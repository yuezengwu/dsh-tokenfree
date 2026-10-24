import { TokenFreeError as LlmError, record } from '../core/errors.js'
import type { WebCredential } from '../local/auth.js'
import { parseChallenge, solveChallenge } from './pow.js'
import type { Challenge } from './pow.js'
import { readWebEvents, WebResponseState } from './sse.js'
import { failureCategory } from '../local/diagnostics.js'
import type { LocalDiagnostics } from '../local/diagnostics.js'
import type { WebEvent, WebIdentity, WebMessage, WebTransport, WebSettings } from '../core/types.js'

const ORIGIN = 'https://chat.deepseek.com'
export type Fetch = typeof fetch
export interface ClientDependencies {
  fetch?: Fetch
  solve?: (challenge: Challenge, signal: AbortSignal) => Promise<string>
  diagnostics?: LocalDiagnostics
  operationId?: string
  headers?: Record<string, string>
}
function httpError(status: number): LlmError {
  // A generic 403 may be a WAF/challenge, not proof the account needs another login.
  const code = status === 401 ? 'AUTH' : status === 429 ? 'RATE_LIMIT' : status === 402 ? 'QUOTA' : status === 403 ? 'WEB_CHALLENGE' : 'WEB_HTTP'
  return new LlmError(`DeepSeek Web request failed (HTTP ${status}).`, code, { status })
}
export function webMessage(value: unknown): WebMessage {
  if (!record(value) || !Number.isSafeInteger(value.message_id) || Number(value.message_id) < 0
    || !(value.parent_id === null || Number.isSafeInteger(value.parent_id)) || !['USER', 'ASSISTANT'].includes(String(value.role))
    || typeof value.status !== 'string' || !Array.isArray(value.fragments)) throw new LlmError('Invalid Web history message.', 'WEB_PROTOCOL')
  const fragments = value.fragments.filter(record)
  const text = (type: string) => fragments.filter(f => f.type === type).map(f => typeof f.content === 'string' ? f.content : '').join('')
  const usage = value.accumulated_token_usage
  return { id: Number(value.message_id), parentId: value.parent_id as number | null, role: value.role as 'USER' | 'ASSISTANT',
    ...(typeof value.model_type === 'string' ? { modelType: value.model_type } : {}), content: text(value.role === 'USER' ? 'REQUEST' : 'RESPONSE'), reasoning: text('THINK'), status: value.status,
    ...(typeof usage === 'number' && Number.isSafeInteger(usage) && usage >= 0 ? { usage } : {}) }
}

/** Official transport operations only; no native DSH objects or orchestration decisions. */
export class DeepSeekWebClient implements WebTransport {
  private fetchImpl: Fetch
  private solve: NonNullable<ClientDependencies['solve']>
  constructor(private credential: WebCredential, private dependencies: ClientDependencies = {}) {
    this.fetchImpl = dependencies.fetch ?? fetch
    this.solve = dependencies.solve ?? solveChallenge
    dependencies.diagnostics?.protect(credential)
  }
  bindOperation(id: string): void { this.dependencies.operationId = id }
  private headers(): Record<string, string> {
    return { ...this.dependencies.headers, 'content-type': 'application/json', accept: 'application/json',
      authorization: `Bearer ${this.credential.token}`, origin: ORIGIN, referer: `${ORIGIN}/`,
      'x-client-platform': 'web', 'x-client-version': '2.5.0', 'x-client-locale': 'zh_CN',
      'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
      ...(this.credential.cookie ? { cookie: this.credential.cookie } : {}) }
  }
  private async request(path: string, body: unknown | undefined, signal: AbortSignal, extra: Record<string, string> = {}): Promise<Response> {
    signal.throwIfAborted()
    const startedAt = Date.now()
    const meta = { endpoint: path.split('?')[0], operationId: this.dependencies.operationId }
    this.dependencies.diagnostics?.write('http.started', meta)
    if (body !== undefined && this.dependencies.operationId && !path.endsWith('/create_pow_challenge')) {
      this.dependencies.diagnostics?.content(this.dependencies.operationId, 'web.request', { method: 'POST', endpoint: path, body })
    }
    let response: Response
    try { response = await this.fetchImpl(`${ORIGIN}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { ...this.headers(), ...extra },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal, redirect: 'error' }) }
    catch (error) { this.dependencies.diagnostics?.write('http.failed', { ...meta, elapsedMs: Date.now() - startedAt, ...failureCategory(error) }); if (signal.aborted) throw error; throw new LlmError('Web transport disconnected; acceptance must be verified.', 'TRANSPORT') }
    this.dependencies.diagnostics?.write('http.completed', { ...meta, elapsedMs: Date.now() - startedAt, httpStatus: response.status })
    if (!response.ok) {
      await response.body?.cancel()
      const error = httpError(response.status)
      if (['/api/v0/chat_session/create', '/api/v0/chat/completion', '/api/v0/chat/edit_message'].includes(path) && [401, 402, 429].includes(response.status)) {
        throw new LlmError(error.message, error.code, { ...error.details, accepted: false })
      }
      throw error
    }
    return response
  }
  private async envelope(response: Response): Promise<{ code: number; value: unknown }> {
    if (!response.body) throw new LlmError('Missing Web response body.', 'WEB_PROTOCOL')
    const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true })
    let text = '', bytes = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > 8 * 1024 * 1024) throw new LlmError('Web metadata exceeded the local size limit.', 'WEB_PROTOCOL')
        text += decoder.decode(part.value, { stream: true })
      }
      text += decoder.decode()
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(text) } catch { throw new LlmError('Unexpected Web response; inspect the official login/challenge.', 'WEB_PROTOCOL') }
    if (!record(value) || !record(value.data)) throw new LlmError('Invalid Web response envelope.', 'WEB_PROTOCOL')
    const code = Number(value.code), business = Number(value.data.biz_code)
    if (code !== 0 || (business !== 0 && business !== 22)) {
      const auth = [40003, 40001, 40002].includes(code) || [40003, 40001, 40002].includes(business)
      throw new LlmError('DeepSeek Web rejected the operation.', auth ? 'AUTH' : business === 40029 ? 'WEB_CHALLENGE' : [40300, 40301].includes(business) ? 'POW_FAILED' : 'WEB_REJECTED')
    }
    return { code: business, value: value.data.biz_data }
  }
  private async json(path: string, body: unknown | undefined, signal: AbortSignal): Promise<unknown> {
    const result = await this.envelope(await this.request(path, body, signal))
    if (result.code !== 0) throw new LlmError('Unexpected complete-message code for metadata.', 'WEB_PROTOCOL')
    return result.value
  }
  async identity(signal: AbortSignal): Promise<string> {
    const data = await this.json('/api/v0/users/current', undefined, signal)
    const user = record(data) && record(data.user) ? data.user : data
    if (!record(user) || !['string', 'number'].includes(typeof user.id) || !String(user.id).length) throw new LlmError('Cannot confirm the Web account identity; no chat was adopted.', 'ACCOUNT_ID_UNKNOWN')
    return String(user.id)
  }
  async check(signal: AbortSignal): Promise<void> { this.credential.accountId = await this.identity(signal) }
  async create(signal: AbortSignal): Promise<string> {
    const data = await this.json('/api/v0/chat_session/create', {}, signal)
    const session = record(data) && record(data.chat_session) ? data.chat_session.id : record(data) ? data.id : undefined
    if (typeof session !== 'string' || !session.length) throw new LlmError('Web service did not create a chat session.', 'WEB_PROTOCOL')
    return session
  }
  async *generate(chatId: string, parentId: number | null, prompt: string, thinking: boolean, signal: AbortSignal): AsyncIterable<WebEvent> {
    let proof: string
    try {
      const value = await this.json('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, signal)
      proof = await this.solve(parseChallenge(record(value) ? value.challenge : undefined), signal)
    } catch (error) {
      if (error instanceof LlmError) throw new LlmError(error.message, error.code, { ...error.details, accepted: false })
      throw new LlmError('Preparation failed before completion submission.', 'POW_FAILED', { accepted: false })
    }
    const body = { chat_session_id: chatId, parent_message_id: parentId, prompt, ref_file_ids: [], model_type: null,
      thinking_enabled: thinking, search_enabled: false, action: null, preempt: false }
    const response = await this.request('/api/v0/chat/completion', body, signal, { accept: 'text/event-stream', 'x-ds-pow-response': proof })
    yield* readWebEvents(response, chatId, undefined, signal)
  }
  async *resume(identity: WebIdentity, signal: AbortSignal): AsyncIterable<WebEvent> {
    const response = await this.request('/api/v0/chat/resume_stream', { chat_session_id: identity.chatId, message_id: identity.responseId }, signal, { accept: 'text/event-stream, application/json' })
    if (response.headers.get('content-type')?.includes('text/event-stream')) { yield* readWebEvents(response, identity.chatId, identity, signal); return }
    const result = await this.envelope(response)
    if (result.code !== 22 || !record(result.value)) throw new LlmError('Unexpected resume response.', 'WEB_PROTOCOL')
    yield { type: 'event', name: 'resume.full_message', data: result.value }
    const raw = record(result.value.message) ? result.value.message : record(result.value.response) ? result.value.response : result.value
    const message = webMessage(raw)
    if (message.id !== identity.responseId || message.parentId !== identity.requestId || message.role !== 'ASSISTANT' || message.status !== 'FINISHED') throw new LlmError('Recovered message identity or terminal state differs.', 'WEB_IDENTITY')
    const state = new WebResponseState(identity.chatId, identity)
    state.apply({ v: { response: raw } })
    yield { type: 'snapshot', snapshot: state.snapshot() }
  }
  async history(chatId: string, signal: AbortSignal): Promise<WebMessage[]> {
    const data = await this.json(`/api/v0/chat/history_messages?${new URLSearchParams({ chat_session_id: chatId })}`, undefined, signal)
    if (!record(data) || data.cache_control !== 'REPLACE' || !Array.isArray(data.chat_messages)) throw new LlmError('A fresh complete Web history is required.', 'WEB_PROTOCOL')
    return data.chat_messages.map(value => {
      const message = webMessage(value)
      if (!message.modelType && record(data.chat_session) && typeof data.chat_session.model_type === 'string') message.modelType = data.chat_session.model_type
      return message
    })
  }
  async settings(deviceId: string, signal: AbortSignal): Promise<WebSettings> {
    const data = await this.json(`/api/v0/client/settings?${new URLSearchParams({ did: deviceId, scope: 'model' })}`, undefined, signal)
    if (!record(data) || !Number.isSafeInteger(data.version) || !record(data.settings)) throw new LlmError('Invalid official model settings.', 'WEB_PROTOCOL')
    const entry = data.settings.model_configs
    if (!record(entry) || !Array.isArray(entry.value)) throw new LlmError('Official model budget is unavailable.', 'METRICS_UNKNOWN')
    const positive = (v: unknown) => typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
    return { version: Number(data.version), observedAt: new Date().toISOString(), models: entry.value.filter(record).filter(x => typeof x.model_type === 'string').map(x => ({
      modelType: String(x.model_type), tokenLimit: record(x.file_feature) ? positive(x.file_feature.token_limit) : undefined,
      tokenLimitWithThinking: record(x.file_feature) ? positive(x.file_feature.token_limit_with_thinking) : undefined,
      inputCharacterLimit: positive(x.input_character_limit),
    })) }
  }
  async *editRoot(chatId: string, rootId: number, prompt: string, thinking: boolean, signal: AbortSignal): AsyncIterable<WebEvent> {
    let proof: string
    try {
      const value = await this.json('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, signal)
      proof = await this.solve(parseChallenge(record(value) ? value.challenge : undefined), signal)
    } catch (error) {
      if (error instanceof LlmError) throw new LlmError(error.message, error.code, { ...error.details, accepted: false })
      throw new LlmError('Summary preparation failed before submission.', 'POW_FAILED', { accepted: false })
    }
    const body = { chat_session_id: chatId, message_id: rootId, ref_file_ids: [], prompt, thinking_enabled: thinking, search_enabled: false, action: null }
    yield* readWebEvents(await this.request('/api/v0/chat/edit_message', body, signal, { accept: 'text/event-stream', 'x-ds-pow-response': proof }), chatId, undefined, signal)
  }
  async stop(identity: WebIdentity, signal: AbortSignal): Promise<void> {
    await this.json('/api/v0/chat/stop_stream', { chat_session_id: identity.chatId, message_id: identity.responseId }, signal)
  }
  /** Explicit standalone call; no shared-session association is implied. */
  async complete(prompt: string, signal: AbortSignal): Promise<string> {
    const chatId = await this.create(signal)
    let text = ''
    for await (const event of this.generate(chatId, null, prompt, false, signal)) if (event.type === 'snapshot') text = event.snapshot.text
    if (!text.trim()) throw new LlmError('Web service returned no answer text.', 'EMPTY_RESPONSE')
    return text
  }
}
