import { record, TokenFreeError as LlmError } from '../core/errors.js'
import type { WebEvent, WebIdentity, WebSnapshot } from '../core/types.js'

const MAX_BYTES = 4 * 1024 * 1024
export class WebResponseState {
  private root: Record<string, unknown> = {}
  private path = ''
  private operation = 'SET'
  private identity?: WebIdentity
  private cleared = false
  done = false
  constructor(private readonly chatId = '', identity?: WebIdentity) { this.identity = identity }
  ready(value: unknown): WebIdentity {
    if (!record(value) || !Number.isSafeInteger(value.request_message_id) || Number(value.request_message_id) < 0
      || !Number.isSafeInteger(value.response_message_id) || Number(value.response_message_id) < 0) throw new LlmError('Invalid Web ready identity.', 'WEB_PROTOCOL')
    const identity: WebIdentity = { chatId: this.chatId, requestId: Number(value.request_message_id), responseId: Number(value.response_message_id),
      ...(typeof value.model_type === 'string' ? { modelType: value.model_type } : this.identity?.modelType ? { modelType: this.identity.modelType } : {}) }
    if (this.identity && (this.identity.requestId !== identity.requestId || this.identity.responseId !== identity.responseId
      || this.identity.modelType && identity.modelType && this.identity.modelType !== identity.modelType)) throw new LlmError('Web response identity changed.', 'WEB_IDENTITY')
    this.identity = identity
    return identity
  }
  clear() { this.cleared = true }
  apply(frame: unknown, depth = 0): void {
    if (depth > 16 || !record(frame)) throw new LlmError('Invalid Web patch nesting or event.', 'WEB_PROTOCOL')
    if (frame.error || (typeof frame.code === 'number' && frame.code !== 0)) throw new LlmError('Web service refused the request.', 'WEB_REJECTED')
    if (typeof frame.p === 'string') this.path = frame.p
    if (typeof frame.o === 'string') this.operation = frame.o
    if (!('v' in frame)) return
    if (this.operation === 'BATCH') {
      if (!Array.isArray(frame.v)) throw new LlmError('Invalid Web batch event.', 'WEB_PROTOCOL')
      const parentPath = this.path
      let path = '', operation = 'SET'
      for (const child of frame.v) {
        if (!record(child)) throw new LlmError('Invalid Web batch child.', 'WEB_PROTOCOL')
        if (typeof child.p === 'string') path = child.p
        if (typeof child.o === 'string') operation = child.o
        this.apply({ p: [parentPath, path].filter(Boolean).join('/'), o: operation, v: child.v }, depth + 1)
      }
      this.path = parentPath; this.operation = 'BATCH'
      return
    }
    if (!['SET', 'APPEND'].includes(this.operation)) throw new LlmError('Unsupported Web patch operation.', 'WEB_PROTOCOL')
    if (!this.path) {
      if (!record(frame.v)) throw new LlmError('Invalid Web stream snapshot.', 'WEB_PROTOCOL')
      this.root = frame.v
    } else {
      const keys = this.path.split('/').filter(Boolean)
      if (keys.some(k => ['__proto__', 'prototype', 'constructor'].includes(k))) throw new LlmError('Invalid Web patch path.', 'WEB_PROTOCOL')
      let node: Record<string, unknown> | unknown[] = this.root
      const keyOf = (key: string, target: typeof node): string => {
        if (!Array.isArray(target)) return key
        const index = key === '-1' ? target.length - 1 : Number(key)
        if (!Number.isSafeInteger(index) || index < 0 || index >= 10000 || index > target.length) throw new LlmError('Invalid Web fragment index.', 'WEB_PROTOCOL')
        return String(index)
      }
      for (const key of keys.slice(0, -1)) {
        const child: unknown = (node as Record<string, unknown>)[keyOf(key, node)]
        if (!record(child) && !Array.isArray(child)) throw new LlmError('Missing Web patch parent.', 'WEB_PROTOCOL')
        node = child
      }
      const index = keyOf(keys.at(-1)!, node)
      const target = node as Record<string, unknown>
      const previous = target[index]
      if (this.operation === 'APPEND') {
        if (typeof previous === 'string' && typeof frame.v === 'string') target[index] = previous + frame.v
        else if (Array.isArray(previous) && Array.isArray(frame.v) && previous.length + frame.v.length <= 10000) previous.push(...frame.v)
        else throw new LlmError('Invalid Web append event.', 'WEB_PROTOCOL')
      } else target[index] = frame.v
    }
    const snapshot = this.snapshot()
    this.done = snapshot.status === 'FINISHED'
    if (['CONTENT_FILTER', 'CONTEXT_LENGTH_EXCEEDED', 'INCOMPLETE', 'TIMEOUT', 'FAILED'].includes(snapshot.status ?? '')) {
      throw new LlmError(`Web response did not complete (${snapshot.status}).`, snapshot.status === 'CONTENT_FILTER' ? 'CONTENT_RETRACTED' : snapshot.status === 'CONTEXT_LENGTH_EXCEEDED' ? 'CONTEXT_WINDOW_EXCEEDED' : 'WEB_INCOMPLETE')
    }
  }
  snapshot(): WebSnapshot {
    const response = this.root.response
    if (!record(response)) return { identity: this.identity, text: '', reasoning: '', cleared: this.cleared }
    if (this.identity && response.message_id !== undefined && response.message_id !== this.identity.responseId) throw new LlmError('Web snapshot belongs to another response.', 'WEB_IDENTITY')
    const fragments = Array.isArray(response.fragments) ? response.fragments.filter(record) : []
    const content = (kind: string) => fragments.filter(f => f.type === kind).map(f => typeof f.content === 'string' ? f.content : '').join('')
    const usage = response.accumulated_token_usage
    return { identity: this.identity, text: content('RESPONSE'), reasoning: content('THINK'),
      status: typeof response.status === 'string' ? response.status : undefined, cleared: this.cleared,
      ...(typeof usage === 'number' && Number.isSafeInteger(usage) && usage >= 0 ? { usage } : {}) }
  }
  text(): string { return this.snapshot().text }
}

/** Logical SSE events, including a split CRLF and split UTF-8. A finish marker never invents a terminal state. */
export async function* readWebEvents(response: Response, chatId: string, identity?: WebIdentity, signal?: AbortSignal): AsyncIterable<WebEvent> {
  if (!response.body || !response.headers.get('content-type')?.includes('text/event-stream')) throw new LlmError('Expected a Web event stream.', 'WEB_PROTOCOL')
  const state = new WebResponseState(chatId, identity)
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let buffer = '', bytes = 0
  function* parse(text: string): Generator<WebEvent> {
    let name = 'message'
    const data: string[] = []
    for (const line of text.split('\n')) {
      if (line.startsWith('event:')) name = line.slice(6).trim()
      if (line.startsWith('data:')) data.push(line.slice(5).trimStart())
    }
    const payload = data.join('\n').trim()
    if (!payload && name === 'message') return
    let value: unknown = null
    if (payload && payload !== '[DONE]') {
      try { value = JSON.parse(payload) } catch { yield { type: 'event', name, data: payload }; throw new LlmError('Invalid JSON in Web stream.', 'WEB_PROTOCOL') }
    }
    yield { type: 'event', name, data: value }
    if (name === 'error') throw new LlmError('Web stream reported an error.', 'WEB_REJECTED')
    if (name === 'ready') { yield { type: 'ready', identity: state.ready(value) }; return }
    if (name === 'hint' && record(value) && value.clear_response === true) { state.clear(); yield { type: 'snapshot', snapshot: state.snapshot() }; return }
    if (['finish', 'close', 'title', 'hint', 'toast'].includes(name) || payload === '[DONE]' || value === null) return
    if (record(value) && Object.keys(value).length) { state.apply(value); yield { type: 'snapshot', snapshot: state.snapshot() }; return }
    return
  }
  const abort = () => { void reader.cancel().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      signal?.throwIfAborted()
      let part: ReadableStreamReadResult<Uint8Array>
      try { part = await reader.read() }
      catch { signal?.throwIfAborted(); throw new LlmError('Web response disconnected while reading.', 'WEB_DISCONNECTED') }
      signal?.throwIfAborted()
      if (part.done) break
      bytes += part.value.byteLength
      if (bytes > MAX_BYTES) throw new LlmError('Web response exceeded the local byte limit.', 'RESPONSE_TOO_LARGE')
      try { buffer += decoder.decode(part.value, { stream: true }) }
      catch { throw new LlmError('Invalid UTF-8 in Web stream.', 'WEB_PROTOCOL') }
      buffer = buffer.replace(/\r\n/g, '\n')
      let split: number
      while ((split = buffer.indexOf('\n\n')) >= 0) {
        for (const event of parse(buffer.slice(0, split))) yield event
        buffer = buffer.slice(split + 2)
      }
    }
    buffer += decoder.decode()
    if (buffer.trim()) for (const event of parse(buffer)) yield event
    if (!state.done) throw new LlmError('Web stream disconnected before a verified FINISHED state.', 'WEB_DISCONNECTED')
    if (state.snapshot().cleared) throw new LlmError('Web response was withdrawn.', 'CONTENT_RETRACTED')
  } finally {
    signal?.removeEventListener('abort', abort)
    await reader.cancel().catch(() => {}); reader.releaseLock()
  }
}

export async function readWebResponse(response: Response): Promise<string> {
  let text = ''
  for await (const event of readWebEvents(response, '')) if (event.type === 'snapshot') text = event.snapshot.text
  if (!text.trim()) throw new LlmError('Web service returned no answer text.', 'EMPTY_RESPONSE')
  return text
}
