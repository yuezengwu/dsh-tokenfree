import { LlmAdapter, LlmError, ReasoningEffortId, ToolCallId, attributionHeaders, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk, ContentBlock } from '@deepseek-ai/dsh-llm'
import { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { dirname, resolve, basename, join } from 'node:path'
import { realpath } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { defaultCredentialFile, resolveCredential } from '../local/auth.js'
import type { WebCredential } from '../local/auth.js'
import { DeepSeekWebClient } from '../deepseek-web/client.js'
import { decodeResponse, modelInput, messageHash } from '../core/codec.js'
import { allowedTools, defaultPolicy, parsePolicy, validatePolicyResult } from '../core/policy.js'
import { SessionEngine } from '../core/session.js'
import { TokenFreeError } from '../core/errors.js'
import type { NativeBoundary, NativeAttempt, CompactionAnchor, WebTransport, Block, Tool, SessionPolicy } from '../core/types.js'
import { digest, LocalStore } from '../local/store.js'
import { failureCategory } from '../local/diagnostics.js'
import type { LocalDiagnostics } from '../local/diagnostics.js'

export const PROVIDER = 'tokenfree-deepseek-web'
export const MODEL = 'web-default'
export interface Config { credentialFile?: string; timeoutMs?: number; maxPromptChars?: number; logContent?: boolean; sessionStoreId?: string }
export interface AdapterDependencies {
  credential?: (signal: AbortSignal) => Promise<WebCredential>
  signal?: () => AbortSignal
  authRejected?: (credential: WebCredential) => Promise<void>
  client?: (credential: WebCredential, context: { diagnostics?: LocalDiagnostics; operationId: string }) => WebTransport
  diagnostics?: LocalDiagnostics
  store?: LocalStore
  native?: NativeBoundary
  compactionReady?: (sessionId: string) => Promise<void>
  toolCatalogue?: (sessionId: string, declared: readonly Tool[]) => Tool[]
  checkTools?: (sessionId: string, blocks: Block[], snapshot: Tool[]) => void
}
async function canonicalPath(path: string): Promise<string> {
  try { return await realpath(path) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    const parent = dirname(path)
    return parent === path ? resolve(path) : join(await canonicalPath(parent), basename(path))
  }
}
function nativeBlock(block: Block): ContentBlock {
  return block.type === 'tool-call' ? { ...block, id: ToolCallId(block.id) } : block
}
export class TokenFreeAdapter extends LlmAdapter {
  private readonly lifetime = new AbortController()
  private readonly store: LocalStore
  private readonly summaries = new Map<string, { anchor: CompactionAnchor; controller: AbortController; operationId?: string }>()
  private enginePromise?: Promise<SessionEngine>
  private readonly settling = new Map<string, Promise<void>>()
  private readonly timeoutMs: number
  private readonly maxPromptChars: number
  constructor(private readonly config: Config = {}, private readonly dependencies: AdapterDependencies = {}) {
    super()
    this.timeoutMs = config.timeoutMs ?? 120_000
    this.maxPromptChars = config.maxPromptChars ?? 120_000
    this.store = dependencies.store ?? new LocalStore(dirname(config.credentialFile ?? defaultCredentialFile()))
    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1000 || this.timeoutMs > 600_000) throw new Error('dsh-tokenfree: timeoutMs must be between 1000 and 600000')
    if (!Number.isInteger(this.maxPromptChars) || this.maxPromptChars < 1000 || this.maxPromptChars > 500_000) throw new Error('dsh-tokenfree: maxPromptChars must be between 1000 and 500000')
  }
  engine(): Promise<SessionEngine> {
    return this.enginePromise ??= (async () => new SessionEngine({ store: this.store,
      storeId: digest(this.config.sessionStoreId ? ['custom', this.config.sessionStoreId] : ['jsonl', await canonicalPath(dshHomePath('sessions'))]),
      native: this.dependencies.native, log: this.dependencies.diagnostics, maxPromptChars: this.maxPromptChars }))()
  }
  override providerInfo(provider: string) { return { id: provider, name: 'TokenFree · DeepSeek Web' } }
  override providerRetryPolicy() { return resolveRetryPolicy({ mode: 'normal', maxRetries: 0 }, 'dsh-tokenfree.retryPolicy') }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return [{ provider, id: MODEL, name: 'DeepSeek Web · 默认（实验）', description: '本人网页账号；持久会话与恢复；官方额度未知。', inputModalities: ['text'] }]
  }
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    if (model !== MODEL) throw new LlmError('TokenFree supports web-default only.', 'MODEL_UNSUPPORTED')
    return { provider, id: model, name: 'DeepSeek Web · 默认（实验）', inputModalities: ['text'], reasoning: {
      efforts: [{ id: ReasoningEffortId('off'), name: '关闭' }, { id: ReasoningEffortId('web-on'), name: '官网思考' }], defaultEffort: ReasoningEffortId('web-on'),
    } }
  }
  async dispose(): Promise<void> {
    this.lifetime.abort()
    await Promise.allSettled(this.settling.values())
    if (this.enginePromise) await this.reconcile()
  }
  async reconcile(attempt?: NativeAttempt | string): Promise<void> {
    const sessionId = typeof attempt === 'string' ? attempt : attempt?.sessionId
    if (!sessionId) {
      await Promise.allSettled(this.settling.values())
      try { await (await this.engine()).reconcile() }
      catch (error) { this.dependencies.diagnostics?.write('operation.pending', { ...failureCategory(error) }) }
      return
    }
    const task = (this.settling.get(sessionId) ?? Promise.resolve()).then(async () => {
      try { await (await this.engine()).reconcile(sessionId, typeof attempt === 'string' ? undefined : attempt) }
      catch (error) { this.dependencies.diagnostics?.write('operation.pending', { ...failureCategory(error), code: 'PENDING_OPERATION' }) }
    })
    this.settling.set(sessionId, task)
    try { await task } finally { if (this.settling.get(sessionId) === task) this.settling.delete(sessionId) }
  }
  async inspect(sessionId: string) {
    const result = await (await this.engine()).inspect(sessionId)
    return { sessionId, chatId: result.session?.chatId, parentId: result.session?.parentId, generation: result.session?.generation,
      needsRebase: result.session?.needsRebase ?? false, usage: result.session?.usage,
      pending: result.pending ? { id: result.pending.id, stage: result.pending.stage, stopRequested: Boolean(result.pending.stopRequested) } : undefined }
  }
  async operationStatus(sessionId?: string) {
    const active = sessionId ? await this.store.pending((await this.engine()).key(sessionId)) : undefined
    return { pending: Boolean(active), sessionId: active?.sessionId, operationId: active?.id, compactionId: active?.compaction?.compactionId,
      stage: active?.stage, stopRequested: active?.stopRequested }
  }
  async policy(sessionId: string) { return this.store.policy((await this.engine()).key(sessionId)) }
  async setPolicy(sessionId: string, value: SessionPolicy) {
    const policy = parsePolicy(value, schema => {
      try { assertSupportedJsonSchema(schema) }
      catch (error) { throw new TokenFreeError(error instanceof Error ? error.message : 'Unsupported output schema.', 'UNSUPPORTED_SCHEMA') }
    })
    const state = await this.store.setPolicy((await this.engine()).key(sessionId), policy)
    this.dependencies.diagnostics?.write('policy.updated', { operationId: state.revision })
    return state
  }
  async toolCatalogueForCall(sessionId: string, operationId: string): Promise<Tool[]> {
    await this.reconcile(sessionId)
    const { session, pending } = await (await this.engine()).inspect(sessionId)
    if (pending || session?.lastOperationId !== operationId || session.needsRebase || !session.executionTools) throw new TokenFreeError('The saved TokenFree tool binding is unavailable.', 'TOOL_BINDING')
    return session.executionTools
  }
  async verifyPending(sessionId: string, operationId: string, requestStop = false) {
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(15_000)])
    const engine = await this.engine(), pending = await this.store.pending(engine.key(sessionId))
    if (pending?.id !== operationId) throw new TokenFreeError('The operation has changed.', 'OPERATION_CHANGED')
    const credential = await (this.dependencies.credential?.(signal) ?? resolveCredential(this.config.credentialFile))
    if (!credential.accountId) {
      if (this.dependencies.client) throw new TokenFreeError('Credentials need an explicit identity.', 'ACCOUNT_ID_UNKNOWN')
      await new DeepSeekWebClient(credential).check(signal)
    }
    const client = this.dependencies.client?.(credential, { diagnostics: this.dependencies.diagnostics, operationId })
      ?? new DeepSeekWebClient(credential, { diagnostics: this.dependencies.diagnostics, headers: attributionHeaders() })
    const settled = await engine.verifyPending(digest(['deepseek-web-account', credential.accountId]), client, signal, sessionId, operationId, requestStop)
    return { ...await this.operationStatus(sessionId), settled }
  }
  async cancelSummary(sessionId: string, operationId: string, compactionId: string) {
    const summary = this.summaries.get(sessionId)
    if (!summary || summary.operationId !== operationId || summary.anchor.compactionId !== compactionId) throw new TokenFreeError('The summary has changed.', 'OPERATION_CHANGED')
    summary.controller.abort()
    return this.operationStatus(sessionId)
  }
  async usage(sessionId: string) { return (await this.engine()).usage(sessionId) }
  async refreshMetrics(sessionId: string, thinking: boolean, signal: AbortSignal, messages?: readonly unknown[]) {
    const accountSignal = this.dependencies.signal?.()
    signal = AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(accountSignal ? [accountSignal] : [])])
    const credential = await (this.dependencies.credential?.(signal) ?? resolveCredential(this.config.credentialFile))
    this.dependencies.diagnostics?.protect(credential)
    if (!credential.accountId) {
      if (this.dependencies.client) throw new TokenFreeError('Injected credentials require an explicit account identity.', 'ACCOUNT_ID_UNKNOWN')
      await new DeepSeekWebClient(credential).check(signal)
    }
    const client = this.dependencies.client?.(credential, { diagnostics: this.dependencies.diagnostics, operationId: randomUUID() })
      ?? new DeepSeekWebClient(credential, { diagnostics: this.dependencies.diagnostics, headers: attributionHeaders() })
    return (await this.engine()).refreshMetrics(sessionId, digest(['deepseek-web-account', credential.accountId]), client, thinking, signal,
      messages ? modelInput({ messages }).messages.map(messageHash) : undefined, credential.epoch)
  }
  async withCompaction<T>(anchor: CompactionAnchor, operation: (signal: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.summaries.has(anchor.sessionId)) throw new TokenFreeError('A native summary is already bound.', 'COMPACTION_PENDING')
    const controller = new AbortController()
    this.summaries.set(anchor.sessionId, { anchor, controller })
    try { return await operation(AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])) }
    finally { this.summaries.delete(anchor.sessionId) }
  }
  async rebuild(sessionId: string) { await (await this.engine()).rebuild(sessionId); return this.inspect(sessionId) }
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const operationId = randomUUID()
    const started = Date.now()
    const log = this.dependencies.diagnostics
    let credential: WebCredential | undefined
    const accountSignal = this.dependencies.signal?.()
    const signal = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(this.timeoutMs), ...(accountSignal ? [accountSignal] : []), ...(options.signal ? [options.signal] : [])])
    try {
      if (options.provider !== PROVIDER || options.model !== MODEL) throw new TokenFreeError('Unknown TokenFree route.', 'MODEL_UNSUPPORTED')
      if (options.purpose && options.purpose !== 'compaction') throw new TokenFreeError('TokenFree keeps the native local title.', 'LOCAL_TITLE')
      const binding = options.purpose === 'compaction' && options.sessionId ? this.summaries.get(options.sessionId) : undefined
      const summary = binding?.anchor
      if (binding) binding.operationId = operationId
      if (options.purpose === 'compaction' && !summary) throw new TokenFreeError('A native TokenFree compaction binding is required.', 'COMPACTION_UNAVAILABLE')
      if (options.temperature !== undefined || (options.reasoningEffort !== undefined && !['off', 'web-on'].includes(options.reasoningEffort))) throw new TokenFreeError('Unsupported sampling or reasoning option.', 'UNSUPPORTED_OPTION')
      if (options.stop?.some(x => !x || x.length > 1024) || (options.stop?.length ?? 0) > 8) throw new TokenFreeError('Stop sequences must be 1–1024 characters, at most 8.', 'UNSUPPORTED_OPTION')
      signal.throwIfAborted()
      if (options.sessionId && !summary) await this.reconcile(options.sessionId)
      const policy = options.sessionId && !summary ? await this.policy(options.sessionId) : undefined
      if (policy) {
        const { revision: _, ...settings } = policy
        parsePolicy(settings, schema => {
          try { assertSupportedJsonSchema(schema) }
          catch (error) { throw new TokenFreeError(error instanceof Error ? error.message : 'Unsupported output schema.', 'UNSUPPORTED_SCHEMA') }
        })
      }
      const selected = allowedTools([...(options.tools ?? [])].filter(x => x.name !== 'web_search'), policy ?? defaultPolicy())
      for (const tool of selected) {
        try { assertSupportedJsonSchema(tool.parameters) }
        catch (error) { throw new TokenFreeError(error instanceof Error ? error.message : 'Unsupported tool schema.', 'UNSUPPORTED_SCHEMA') }
      }
      const input = modelInput({ ...options, tools: selected, thinking: summary?.thinking ?? options.reasoningEffort !== 'off' })
      if (input.sessionId && !summary) await this.dependencies.compactionReady?.(input.sessionId)
      if (!summary) {
        input.policy = policy
        if (input.sessionId && this.dependencies.toolCatalogue) input.executionTools = structuredClone(this.dependencies.toolCatalogue(input.sessionId, input.tools))
      }
      const engine = await this.engine()
      if (input.sessionId) await this.settling.get(input.sessionId)
      if (input.sessionId && !summary && !this.dependencies.native?.current(input.sessionId)) throw new TokenFreeError('Native request association is missing; no Web call was made.', 'NATIVE_CONTEXT')
      signal.throwIfAborted()
      credential = await (this.dependencies.credential?.(signal) ?? resolveCredential(this.config.credentialFile))
      credential.epoch ??= (await this.store.account()).epoch
      log?.protect(credential)
      if (!credential.accountId) {
        // Existing MVP credentials are upgraded by read-only official account verification, not by guessing from a token.
        if (this.dependencies.client) throw new TokenFreeError('Injected credentials require an explicit account identity.', 'ACCOUNT_ID_UNKNOWN')
        await new DeepSeekWebClient(credential).check(signal)
      }
      const accountKey = digest(['deepseek-web-account', credential.accountId])
      const client = this.dependencies.client?.(credential, { diagnostics: log, operationId })
        ?? new DeepSeekWebClient(credential, { diagnostics: log, operationId, headers: attributionHeaders() })
      const indexes = new Map<'text' | 'reasoning', number>()
      let index = 0
      log?.write('model.started', { operationId })
      for await (const event of engine.run(input, accountKey, client, signal, (text, id) => {
        if (summary) {
          if (!text.trim()) throw new TokenFreeError('Summary was empty.', 'EMPTY_RESPONSE')
          return [{ type: 'text', text }]
        }
        const blocks = decodeResponse(text, input.tools, id, (tool, value) => {
        assertSupportedJsonSchema(tool.parameters)
        const issues = validateJsonSchemaValue(tool.parameters, value)
        if (issues.length) throw new TokenFreeError(`Tool ${tool.name} arguments failed schema validation: ${issues[0]}`, 'INVALID_TOOL_CALL')
        })
        if (input.policy) validatePolicyResult(blocks, input.policy, input.stop, (schema, value) => {
          assertSupportedJsonSchema(schema)
          const issues = validateJsonSchemaValue(schema, value)
          if (issues.length) throw new TokenFreeError(`Final JSON failed schema validation: ${issues[0]}`, 'OUTPUT_SCHEMA')
        })
        if (input.sessionId && input.executionTools) this.dependencies.checkTools?.(input.sessionId, blocks, input.executionTools)
        return blocks
      }, operationId, summary, credential.epoch)) {
        signal.throwIfAborted()
        const state = await this.store.account()
        if (state.epoch !== credential.epoch) throw new TokenFreeError('Account was revoked.', 'ABORTED')
        if (event.type === 'text' || event.type === 'reasoning') {
          let slot = indexes.get(event.type)
          if (slot === undefined) { slot = index++; indexes.set(event.type, slot); yield { type: 'block-start', index: slot, blockType: event.type } }
          yield event.type === 'text' ? { type: 'text-delta', index: slot, text: event.text } : { type: 'reasoning-delta', index: slot, text: event.text }
        } else if (event.type === 'withdraw') {
          for (const [type, slot] of indexes) yield { type: 'block-end', index: slot, block: type === 'text' ? { type, text: '' } : { type, text: '' } }
        } else {
          log?.content(operationId, 'dsh.response', { blocks: event.blocks })
          for (const block of event.blocks) {
            const converted = nativeBlock(block)
            const slot = block.type !== 'tool-call' ? indexes.get(block.type) : undefined
            const current = slot ?? index++
            if (slot === undefined) {
              yield { type: 'block-start', index: current, blockType: converted.type }
              if (converted.type === 'text') yield { type: 'text-delta', index: current, text: converted.text }
              if (converted.type === 'reasoning') yield { type: 'reasoning-delta', index: current, text: converted.text }
              if (converted.type === 'tool-call') yield { type: 'tool-call-delta', index: current, id: converted.id, name: converted.name, argumentsDelta: converted.arguments }
            }
            yield { type: 'block-end', index: current, block: converted }
          }
          yield { type: 'finish', reason: { kind: event.blocks.some(x => x.type === 'tool-call') ? 'tool-calls' : 'stop' }, replayState: { response: {
            schemaVersion: 1, operationId: event.operation.id, accountKey, sessionId: options.sessionId ?? null,
            sessionKey: event.operation.sessionKey, generation: event.operation.generation, ...event.operation.identity,
          } } }
          log?.write('model.completed', { operationId, elapsedMs: Date.now() - started })
        }
      }
    } catch (error) {
      if (signal.aborted) {
        const cancelled = options.signal?.aborted || accountSignal?.aborted || this.lifetime.signal.aborted
        const failure = new LlmError(cancelled ? 'Web request cancelled.' : 'Web request timed out.', cancelled ? 'ABORTED' : 'TIMEOUT')
        log?.write('model.failed', { operationId, ...failureCategory(failure), elapsedMs: Date.now() - started })
        throw failure
      }
      log?.write('model.failed', { operationId, ...failureCategory(error), elapsedMs: Date.now() - started })
      if (error instanceof TokenFreeError) {
        if (error.code === 'AUTH' && credential) await this.dependencies.authRejected?.(credential)
        throw new LlmError(error.message, error.code, error.details)
      }
      if (error instanceof LlmError) throw error
      throw new LlmError('DeepSeek Web operation failed. Inspect the local operation log; it was not replayed.', 'TRANSPORT')
    } finally { await log?.flush(operationId) }
  }
}
