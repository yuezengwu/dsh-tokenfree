import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { LocalStore, digest } from '../../lib/local/store.js'
import { SessionEngine } from '../../lib/core/session.js'
import { decodeResponse } from '../../lib/core/codec.js'
import { DeepSeekWebClient } from '../../lib/deepseek-web/client.js'

export const tool = { name: 'read_marker', description: 'Read marker.', parameters: { type: 'object', properties: {}, additionalProperties: false } }
export const user = (text, id = randomUUID()) => ({ id, role: 'user', content: [{ type: 'text', text }] })
export const collect = async source => { const values = []; for await (const value of source) values.push(value); return values }
export const input = (messages = [user('question')], sessionId = 'session-1', tools = []) => ({ sessionId, messages, system: 'fixture instructions', instructions: [], tools, thinking: true, stop: [] })
export const payload = prompt => JSON.parse(prompt.split('DSH_INPUT_JSON:\n')[1].split('\n\nDSH_RESPONSE_CONTRACT:\n')[0])
export const envelope = (value, code = 0) => Response.json({ code: 0, data: { biz_code: code, biz_data: value } })
export const frame = (value, name) => `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(value)}\n\n`
export const snapshot = (text, status = 'FINISHED', reasoning = '') => ({ v: { response: { status, fragments: [{ type: 'THINK', content: reasoning }, { type: 'RESPONSE', content: text }] } } })
export const sse = text => new Response(text, { headers: { 'content-type': 'text/event-stream' } })

/** In-memory official HTTP fixture, injected as fetch. It never opens a socket. */
export class WebFixture {
  chats = new Map(); requests = []; generations = []; resumes = []; stops = []
  modelType; models = []; edits = []; settingsResponse; usageValue;
  summary = () => '## Current Work\n- Continue the requested task.\n## Next Step\n- Read the retained user message.'
  next = 1
  answer = p => ({ protocol_version: 1, request_id: p.request_id, kind: 'final', text: 'answer' })
  completion; resumed; stopping; historyHook; preparing
  fetch = async (url, options) => {
    const path = new URL(url).pathname
    const body = options.body ? JSON.parse(options.body) : undefined
    this.requests.push({ url, path, body, options })
    if (path.endsWith('/users/current')) return envelope({ id: 'fixture-owner' })
    if (path.endsWith('/chat_session/create')) { const id = `chat-${this.chats.size + 1}`; this.chats.set(id, []); return envelope({ chat_session: { id } }) }
    if (path.endsWith('/create_pow_challenge')) return this.preparing ? this.preparing() : envelope({ challenge: { algorithm: 'DeepSeekHashV1', challenge: 'fixture', salt: 's', signature: 'sig', difficulty: 1, expire_at: 123 } })
    if (path.endsWith('/client/settings')) return this.settingsResponse ? this.settingsResponse() : envelope({ version: 7, settings: { model_configs: { id: 1, value: this.models } } })
    if (path.endsWith('/chat/completion') || path.endsWith('/chat/edit_message')) {
      const editing = path.endsWith('/chat/edit_message')
      if (editing) this.edits.push(body); else this.generations.push(body)
      const requestId = this.next++, responseId = this.next++
      const p = body.prompt.includes('DSH_INPUT_JSON:\n') ? payload(body.prompt) : { request_id: /FORMAT_REPAIR ([^:]+):/.exec(body.prompt)?.[1] }
      const raw = editing ? this.summary(JSON.parse(body.prompt.split('DSH_COMPACTION_INPUT_JSON:\n')[1]), body) : this.answer(p, body, this.generations.length)
      const text = typeof raw === 'string' ? raw : JSON.stringify(raw)
      const user = { message_id: requestId, parent_id: editing ? this.chats.get(body.chat_session_id).find(x => x.message_id === body.message_id)?.parent_id : body.parent_message_id, role: 'USER', status: 'FINISHED', fragments: [{ type: 'REQUEST', content: body.prompt }] }
      const assistant = { message_id: responseId, parent_id: requestId, role: 'ASSISTANT', status: 'FINISHED', ...(this.modelType ? { model_type: this.modelType } : {}), accumulated_token_usage: this.usageValue ? this.usageValue(body, editing) : 731 * this.generations.length, fragments: [{ type: 'RESPONSE', content: text }] }
      this.chats.get(body.chat_session_id).push(user, assistant)
      const ready = frame({ request_message_id: requestId, response_message_id: responseId, ...(this.modelType ? { model_type: this.modelType } : {}) }, 'ready')
      const context = { body, text, user, assistant, editing, requestId, responseId, ready }
      return this.completion ? this.completion(context, options) : sse(ready + frame(snapshot(text)))
    }
    if (path.endsWith('/history_messages')) {
      const chatId = new URL(url).searchParams.get('chat_session_id')
      if (this.historyHook) await this.historyHook(chatId)
      return envelope({ chat_session: { model_type: this.modelType }, cache_control: 'REPLACE', chat_messages: this.chats.get(chatId) ?? [] })
    }
    if (path.endsWith('/resume_stream')) {
      this.resumes.push(body)
      const message = this.chats.get(body.chat_session_id).find(x => x.message_id === body.message_id)
      return this.resumed ? this.resumed(message, body) : envelope(message, 22)
    }
    if (path.endsWith('/stop_stream')) {
      this.stops.push({ body, aborted: options.signal.aborted })
      if (this.stopping) return this.stopping(body, options)
      this.chats.get(body.chat_session_id).find(x => x.message_id === body.message_id).status = 'INCOMPLETE'
      return envelope({})
    }
    throw new Error(`Unexpected fixture endpoint ${path}`)
  }
  client(log, operationId) { return new DeepSeekWebClient({ token: 'fixture-secret-token', accountId: 'fixture-owner' }, { fetch: this.fetch, solve: async () => 'secret-proof', diagnostics: log, operationId }) }
}
export class NativeFixture {
  attempts = new Map(); saved = new Map(); seq = 0; flushError = false
  begin(sessionId = 'session-1') {
    const attempt = { sessionId, turn: ++this.seq, step: 0, afterSeq: this.seq, attemptId: randomUUID(), instance: 'fixture' }
    this.attempts.set(sessionId, attempt); return attempt
  }
  current = id => this.attempts.get(id)
  inspect = async attempt => { if (this.flushError) throw new Error('fixture flush failed'); return this.saved.get(attempt.attemptId) }
  save(result, interrupted = false) {
    const message = { id: randomUUID(), role: 'assistant', content: result.blocks.filter(x => x.type !== 'reasoning') }
    this.saved.set(result.operation.native.attemptId, { seq: ++this.seq, interrupted, message, operationId: result.operation.id, durable: true })
    return message
  }
  cancel(attempt) { this.saved.set(attempt.attemptId, { seq: ++this.seq, interrupted: true, durable: true }) }
}
export async function setup(logFactory) {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-chain-'))
  const store = new LocalStore(home), native = new NativeFixture(), web = new WebFixture()
  const log = logFactory?.(home)
  const engine = new SessionEngine({ store, storeId: 'fixture-store', native, log, maxPromptChars: 120000 })
  const accountKey = digest(['deepseek-web-account', 'fixture-owner'])
  const run = async (i = input(), signal = AbortSignal.timeout(5000)) => {
    native.begin(i.sessionId)
    return collect(engine.run(i, accountKey, web.client(log), signal, (text, id) => decodeResponse(text, i.tools, id)))
  }
  return { home, store, native, web, engine, log, accountKey, run, pending: (id = 'session-1') => store.pending(engine.key(id)), close: async () => { await log?.flush(); await rm(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 }) } }
}
