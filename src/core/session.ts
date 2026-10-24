import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { TokenFreeError, record } from './errors.js'
import type { Block, ModelInput, NativeAttempt, NativeBoundary, CompactionAnchor, OfficialBudget, WebIdentity, WebMessage, WebSnapshot, WebTransport } from './types.js'
import { canonical, catalogueHash, decodeResponse, encodeFormatRepair, encodeInput, encodeSummary, FinalDecoder, messageHash, WebResponseFormatError } from './codec.js'
import { streamsFinal } from './policy.js'
import type { UsageStatus } from './account-types.js'
import { budgetFor, metricView, pressure } from './metrics.js'
import { digest, LocalStore } from '../local/store.js'
import type { ActiveOperation, SessionState } from '../local/store.js'
import type { LocalDiagnostics } from '../local/diagnostics.js'

export type ModelEvent = { type: 'text'; text: string } | { type: 'reasoning'; text: string } | { type: 'result'; blocks: Block[]; operation: ActiveOperation } | { type: 'withdraw' }
export interface SessionDependencies { store: LocalStore; storeId: string; native?: NativeBoundary; log?: LocalDiagnostics; maxPromptChars: number }
const terminal = (status: string) => ['FINISHED', 'INCOMPLETE', 'CONTENT_FILTER', 'CONTEXT_LENGTH_EXCEEDED', 'TIMEOUT', 'FAILED'].includes(status)
const pathOf = (messages: WebMessage[], responseId: number) => {
  const map = new Map(messages.map(x => [x.id, x]))
  const path: { id: number; parentId: number | null; hash: string }[] = []
  let id: number | null = responseId
  while (id !== null) {
    const message = map.get(id)
    if (!message || path.some(x => x.id === id)) throw new TokenFreeError('Web ancestor path is missing or cyclic.', 'WEB_CONTEXT_CHANGED')
    path.unshift({ id, parentId: message.parentId, hash: digest([message.role, message.content]) })
    id = message.parentId
  }
  return path
}
function visible(text: string, stops: string[], final = false): string {
  let end = text.length
  for (const stop of stops) {
    const match = text.indexOf(stop)
    if (match >= 0) end = Math.min(end, match)
    else if (!final) for (let size = 1; size < stop.length && size <= end; size++) if (text.endsWith(stop.slice(0, size))) end = Math.min(end, text.length - size)
  }
  if (!final && end && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
  return text.slice(0, end)
}

/** The only generation state machine. Native commits and Web acceptance are kept separate. */
export class SessionEngine {
  constructor(private readonly dependencies: SessionDependencies) {}
  get store() { return this.dependencies.store }
  key(sessionId: string) { return digest([this.dependencies.storeId, sessionId]) }
  private async update(operation: ActiveOperation, change: Partial<ActiveOperation>) {
    Object.assign(operation, change)
    await this.store.update(operation.sessionKey, operation.id, change)
    this.dependencies.log?.write('operation.state', { operationId: operation.id, stage: operation.stage })
    this.dependencies.log?.content(operation.id, 'operation.state', { stage: operation.stage, identity: operation.identity, native: operation.native })
  }
  private verify(operation: ActiveOperation, messages: WebMessage[]): WebMessage {
    const identity = operation.identity
    const response = messages.find(x => x.id === identity?.responseId)
    const request = messages.find(x => x.id === identity?.requestId)
    if (!identity || !response || !request || response.role !== 'ASSISTANT' || request.role !== 'USER'
      || response.parentId !== request.id || request.parentId !== operation.parentId || digest(request.content) !== operation.promptHash) {
      throw new TokenFreeError('Web response or submitted input does not match this operation.', 'WEB_IDENTITY')
    }
    if (operation.parentId !== null && operation.parentPath && canonical(pathOf(messages, operation.parentId)) !== canonical(operation.parentPath)) {
      throw new TokenFreeError('Web ancestry changed during generation.', 'WEB_CONTEXT_CHANGED')
    }
    if (operation.compaction) {
      if (request.id === operation.compaction.rootId || request.parentId !== null
        || canonical(pathOf(messages, operation.compaction.oldParentId)) !== canonical(operation.compaction.oldPath)) {
        throw new TokenFreeError('Summary is not an independent root or old branch was changed.', 'WEB_IDENTITY')
      }
    }
    return response
  }
  private async discover(operation: ActiveOperation, client: WebTransport, signal: AbortSignal): Promise<void> {
    if (!operation.chatId) throw new TokenFreeError('Chat creation outcome is unknown. It was not repeated.', 'PENDING_OPERATION')
    const messages = await client.history(operation.chatId, signal)
    const requests = messages.filter(x => x.role === 'USER' && x.parentId === operation.parentId && digest(x.content) === operation.promptHash)
    if (requests.length !== 1) throw new TokenFreeError('Request acceptance is not uniquely provable. No completion was repeated.', 'PENDING_OPERATION')
    const responses = messages.filter(x => x.role === 'ASSISTANT' && x.parentId === requests[0]!.id)
    if (responses.length !== 1) throw new TokenFreeError('Response identity is not uniquely provable.', 'PENDING_OPERATION')
    await this.update(operation, { identity: { chatId: operation.chatId, requestId: requests[0]!.id, responseId: responses[0]!.id } })
  }
  private async stop(operation: ActiveOperation, client: WebTransport): Promise<void> {
    await this.update(operation, { stopRequested: true, rebase: true })
    const cleanup = AbortSignal.timeout(5_000)
    this.dependencies.log?.write('stream.stopping', { operationId: operation.id })
    try {
      if (!operation.identity) await this.discover(operation, client, cleanup)
      // ready belongs to this accepted stream. Stop it before waiting for the history replica.
      // A stop error does not establish its outcome; only a fully verified terminal history can.
      try { await client.stop(operation.identity!, cleanup) }
      catch (error) {
        this.dependencies.log?.write('stream.stop-request-failed', { operationId: operation.id,
          code: error instanceof TokenFreeError ? error.code : 'TRANSPORT' })
      }
      for (;;) {
        try {
          const messages = await client.history(operation.chatId!, cleanup)
          const response = this.verify(operation, messages)
          if (terminal(response.status)) {
            await this.update(operation, { stage: 'stopped', finalStatus: response.status, verifiedPath: pathOf(messages, response.id), usage: response.usage, usageSource: 'history', usageObservedAt: new Date().toISOString() })
            return
          }
        } catch (error) {
          this.dependencies.log?.write('stream.stop-history-pending', { operationId: operation.id,
            code: error instanceof TokenFreeError ? error.code : 'TRANSPORT' })
          if (cleanup.aborted || error instanceof TokenFreeError && ['AUTH', 'WEB_CHALLENGE', 'RATE_LIMIT', 'QUOTA'].includes(error.code)) throw error
        }
        await delay(100, undefined, { signal: cleanup })
      }
    } catch {
      await this.update(operation, { stage: 'uncertain' })
      this.dependencies.log?.write('operation.pending', { operationId: operation.id, code: 'PENDING_OPERATION',
        errorKind: cleanup.aborted ? 'timeout' : 'unknown' })
    }
  }
  private async settingsBudget(client: WebTransport, modelType: string | undefined, thinking: boolean, signal: AbortSignal): Promise<OfficialBudget | undefined> {
    if (!client.settings) return budgetFor(undefined, modelType, thinking)
    try { return budgetFor(await client.settings(await this.store.deviceId(), signal), modelType, thinking) }
    catch (error) {
      signal.throwIfAborted()
      if (error instanceof TokenFreeError && ['AUTH', 'ABORTED', 'WEB_CHALLENGE'].includes(error.code)) throw error
      this.dependencies.log?.write('metrics.unavailable', { code: error instanceof TokenFreeError ? error.code : 'METRICS_UNKNOWN' })
      return budgetFor(undefined, modelType, thinking)
    }
  }
  async refreshMetrics(sessionId: string, accountKey: string, client: WebTransport, thinking: boolean, signal: AbortSignal, inputHashes?: string[], expectedEpoch?: number) {
    const release = await this.store.sessionLock(this.key(sessionId), signal)
    try {
      if (!(await this.settle(await this.store.pending(this.key(sessionId))))) throw new TokenFreeError('Settle the previous operation before reading current pressure.', 'PENDING_OPERATION')
      const session = await this.store.session(this.key(sessionId))
      if (!session || session.needsRebase) return metricView(session)
      if (session.accountKey !== accountKey) return metricView({ ...session, metricsCurrent: false })
      if (inputHashes && (session.prefix.length > inputHashes.length || session.prefix.some((x, i) => x !== inputHashes[i]))) {
        // Edited/projected native history will bootstrap another chat; old branch pressure cannot trigger it.
        await this.store.amendSession(session.sessionKey, { metricsCurrent: false })
        return metricView({ ...session, metricsCurrent: false })
      }
      await this.refresh(session, client, thinking, signal, false, expectedEpoch)
      return metricView(await this.store.session(session.sessionKey))
    } finally { await release() }
  }
  private async refresh(session: SessionState, client: WebTransport, thinking: boolean, signal: AbortSignal, summary = false, expectedEpoch?: number) {
    const account = await this.store.account(), metricsEpoch = expectedEpoch ?? account.epoch
    if (account.epoch !== metricsEpoch || account.accountKey !== undefined && account.accountKey !== session.accountKey) throw new TokenFreeError('Account changed before observing pressure.', 'ABORTED')
    await this.store.amendSession(session.sessionKey, { metricsCurrent: false })
    const messages = await client.history(session.chatId!, signal)
    if (canonical(pathOf(messages, session.parentId!)) !== canonical(session.webPath)) throw new TokenFreeError('Web branch changed before pressure verification.', 'WEB_CONTEXT_CHANGED')
    const response = messages.find(x => x.id === session.parentId)!
    if (response.role !== 'ASSISTANT' || !(summary ? terminal(response.status) : response.status === 'FINISHED')
      || messages.find(x => x.id === session.webPath?.[0]?.id)?.role !== 'USER') throw new TokenFreeError('The confirmed Web branch is no longer complete.', 'WEB_CONTEXT_CHANGED')
    const modelType = response.modelType ?? session.modelType
    const budget = await this.settingsBudget(client, modelType, thinking, signal)
    const usage = response.usage === undefined ? undefined : { accumulated_token_usage: response.usage, chatId: session.chatId!, messageId: response.id, source: 'history' as const, observedAt: new Date().toISOString() }
    if ((await this.store.account()).epoch !== metricsEpoch) throw new TokenFreeError('Account was revoked while observing official pressure.', 'ABORTED')
    await this.store.amendSession(session.sessionKey, { usage, budget, modelType, thinking, metricsCurrent: true, metricsEpoch })
    this.dependencies.log?.write('metrics.observed')
    this.dependencies.log?.content(randomUUID(), 'metrics.observed', { sessionKey: session.sessionKey, usage, budget, modelType, thinking })
    Object.assign(session, { usage, budget, modelType, thinking, metricsCurrent: true, metricsEpoch })
  }
  async usage(sessionId: string): Promise<UsageStatus> {
    const session = await this.store.session(this.key(sessionId)), account = await this.store.account(), active = await this.store.pending(this.key(sessionId))
    if (session && (session.metricsEpoch !== account.epoch || (account.accountKey !== undefined && session.accountKey !== account.accountKey))) session.metricsCurrent = false
    return { sessionId, ...metricView(session), generation: active?.sessionKey === this.key(sessionId) ? {
      operationId: active.id, compactionId: active.compaction?.compactionId, purpose: active.kind === 'compaction' ? 'compaction' : 'conversation', count: active.usage, source: active.usageSource, observedAt: active.usageObservedAt,
      chatId: active.identity?.chatId, messageId: active.identity?.responseId, stage: active.stage,
    } : undefined }
  }
  private async reconcileCompaction(operation: ActiveOperation): Promise<boolean> {
    if (!operation.compaction || !this.dependencies.native?.inspectCompaction) return false
    const saved = await this.dependencies.native.inspectCompaction(operation.compaction)
    if (!saved || (!operation.verifiedPath && !operation.knownRejected)) return false
    const previous = await this.store.session(operation.sessionKey)
    if (!previous) throw new TokenFreeError('Compaction association was lost.', 'STATE_STORAGE')
    if (saved.outcome === 'committed') {
      if (!operation.expected || operation.rebase || operation.knownRejected || canonical(saved.summary) !== canonical(operation.expected.filter(x => x.type === 'text'))) {
        throw new TokenFreeError('Native checkpoint does not match the verified Web summary.', 'COMPACTION_PENDING')
      }
      await this.store.commit(operation.sessionKey, operation.id, { ...previous, needsRebase: true, metricsCurrent: false,
        compaction: { compactionId: saved.compactionId, startSeq: operation.compaction.startSeq, phase: 'needs-new-chat', operationId: operation.id,
          checkpointSeq: saved.checkpointSeq, endSeq: saved.endSeq } })
      this.dependencies.log?.content(operation.id, 'native.commit', { compactionId: saved.compactionId, checkpointSeq: saved.checkpointSeq, endSeq: saved.endSeq })
    } else {
      await this.store.commit(operation.sessionKey, operation.id, { ...previous, compaction: { compactionId: saved.compactionId, startSeq: operation.compaction.startSeq,
        phase: 'failed', operationId: operation.id, endSeq: saved.endSeq } })
    }
    this.dependencies.log?.write('operation.committed', { operationId: operation.id })
    return true
  }
  private async preserveInitialization(operation: ActiveOperation) {
    if (!operation.sessionId || !operation.chatId || operation.kind) return
    const previous = await this.store.session(operation.sessionKey)
    if (previous?.compaction?.phase === 'needs-new-chat') await this.store.amendSession(operation.sessionKey,
      { compaction: { ...previous.compaction, initializingChatId: operation.chatId } }, operation.id)
  }
  /** Post-commit notifications and each admission settle only their own session. */
  async reconcile(sessionId?: string, attempt?: NativeAttempt): Promise<boolean> {
    if (sessionId === undefined) {
      const results = await Promise.allSettled((await this.store.sessionKeys()).map(async key => {
        const pending = await this.store.pending(key)
        return !pending || pending.storeId !== this.dependencies.storeId ? true : this.reconcileKey(key)
      }))
      const failed = results.find(x => x.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
      return results.every(x => x.status === 'fulfilled' && x.value)
    }
    return this.reconcileKey(this.key(sessionId), attempt)
  }
  private async reconcileKey(key: string, attempt?: NativeAttempt): Promise<boolean> {
    let release: () => Promise<void>
    try { release = await this.store.sessionLock(key, AbortSignal.timeout(5000)) }
    catch (error) { if (error instanceof TokenFreeError && error.code === 'SESSION_BUSY') return false; throw error }
    try {
      const operation = await this.store.pending(key)
      if (attempt && operation?.native && operation.native.instance === attempt.instance && operation.native.attemptId === attempt.attemptId
        && operation.native.afterSeq === attempt.afterSeq) await this.update(operation, { native: attempt })
      return await this.settle(operation)
    } finally { await release() }
  }
  private async settle(operation?: ActiveOperation): Promise<boolean> {
    const account = await this.store.account()
    if (!operation) return true
    if (operation.storeId !== this.dependencies.storeId) return false
    if (operation.kind === 'compaction') return this.reconcileCompaction(operation)
    // Proven non-submission changes no native/Web cursor and needs no fabricated native event.
    if (operation.storeId === this.dependencies.storeId && operation.knownRejected) { await this.preserveInitialization(operation); await this.store.commit(operation.sessionKey, operation.id); return true }
    if (operation.storeId !== this.dependencies.storeId || !operation.native || !this.dependencies.native) return false
    const saved = await this.dependencies.native.inspect(operation.native)
    if (!saved) return false
    if (!operation.verifiedPath && !operation.knownRejected) return false
    const previous = await this.store.session(operation.sessionKey)
    if (previous?.lastOperationId === operation.id) { await this.store.commit(operation.sessionKey, operation.id); return true }
    const cancelled = saved.interrupted || operation.rebase || operation.epoch !== account.epoch || !saved.message
    const expected = operation.expected?.filter(x => x.type !== 'reasoning')
    if (!cancelled && (saved.operationId !== operation.id || canonical(saved.message!.content) !== canonical(expected))) throw new TokenFreeError('Native result differs from the validated delivery; no cursor was advanced.', 'PENDING_OPERATION')
    const next: SessionState = {
      schemaVersion: 1, sessionKey: operation.sessionKey, sessionId: operation.sessionId!, storeId: operation.storeId, accountKey: operation.accountKey,
      modelType: operation.identity?.modelType, thinking: operation.thinking, budget: operation.budget, metricsCurrent: !cancelled, metricsEpoch: operation.epoch,
      compaction: previous?.compaction ? { ...previous.compaction, phase: 'complete', initializingChatId: undefined } : undefined,
      generation: operation.generation, chatId: operation.chatId ?? previous?.chatId, parentId: operation.identity?.responseId ?? previous?.parentId ?? null,
      prefix: [...operation.inputHashes, ...(saved.message ? [messageHash(saved.message)] : [])],
      instructionsHash: operation.instructionsHash, toolsHash: operation.toolsHash, tools: operation.tools, executionTools: operation.executionTools,
      webPath: operation.verifiedPath ?? previous?.webPath, needsRebase: Boolean(cancelled), previousChatId: previous?.chatId !== operation.chatId ? previous?.chatId : previous?.previousChatId,
      lastOperationId: operation.id, nativeSeq: saved.seq,
      ...(operation.usage !== undefined && operation.identity ? { usage: { accumulated_token_usage: operation.usage, chatId: operation.identity.chatId, messageId: operation.identity.responseId, source: 'history', observedAt: new Date().toISOString() } } : {}),
    }
    await this.store.commit(operation.sessionKey, operation.id, next)
    this.dependencies.log?.content(operation.id, 'native.commit', { native: operation.native, seq: saved.seq, interrupted: Boolean(cancelled), sessionKey: operation.sessionKey })
    this.dependencies.log?.write('operation.committed', { operationId: operation.id })
    return true
  }
  /** Owner recovery: queries/stops the original operation; never generates a replacement. */
  async verifyPending(accountKey: string, client: WebTransport, signal: AbortSignal, sessionId: string, expectedId: string, requestStop = false): Promise<boolean> {
    const key = this.key(sessionId), release = await this.store.sessionLock(key, signal)
    try {
      const current = await this.store.pending(key)
      if (current?.id !== expectedId) throw new TokenFreeError('The operation has changed.', 'OPERATION_CHANGED')
      return await this.verifyOperation(accountKey, client, signal, key, requestStop)
    } finally { await release() }
  }
  private async verifyOperation(accountKey: string, client: WebTransport, signal: AbortSignal, key: string, requestStop = false): Promise<boolean> {
      if (await this.settle(await this.store.pending(key))) return true
      const pending = await this.store.pending(key)
      if (!pending) return true
      if (pending.accountKey !== accountKey || pending.storeId !== this.dependencies.storeId) throw new TokenFreeError('Another account/store owns the pending operation.', 'PENDING_OPERATION')
      client.bindOperation?.(pending.id)
      if (pending.stage === 'prepared') await this.update(pending, { stage: 'failed', knownRejected: true })
      else if (!pending.verifiedPath && !pending.knownRejected) {
        if (!pending.identity) await this.discover(pending, client, signal)
        if (requestStop || pending.stopRequested || pending.epoch !== (await this.store.account()).epoch) await this.stop(pending, client)
        else {
          const messages = await client.history(pending.chatId!, signal)
          const response = this.verify(pending, messages)
          if (terminal(response.status)) await this.update(pending, { finalStatus: response.status, verifiedPath: pathOf(messages, response.id), rebase: true, stage: 'failed' })
        }
      }
      if (!pending.native && !pending.kind && (pending.verifiedPath || pending.knownRejected)) { await this.store.commit(pending.sessionKey, pending.id); return true }
      return this.settle(await this.store.pending(key))
  }
  async inspect(sessionId: string) {
    return { session: await this.store.session(this.key(sessionId)), pending: await this.store.pending(this.key(sessionId)) }
  }
  async rebuild(sessionId: string): Promise<void> {
    const release = await this.store.sessionLock(this.key(sessionId), AbortSignal.timeout(5_000))
    try {
      if (await this.store.pending(this.key(sessionId))) throw new TokenFreeError('Verify the pending operation before rebuilding.', 'PENDING_OPERATION')
      // A requested rebuild is recorded by a local-only operation and never submits a model request.
      const session = await this.store.session(this.key(sessionId))
      if (!session) return
      const op: ActiveOperation = { id: randomUUID(), accountKey: session.accountKey, epoch: (await this.store.account()).epoch, sessionKey: session.sessionKey,
        sessionId, storeId: this.dependencies.storeId, generation: session.generation, stage: 'prepared', parentId: session.parentId,
        promptHash: '', inputHashes: session.prefix, instructionsHash: session.instructionsHash, toolsHash: session.toolsHash, tools: session.tools, thinking: false }
      await this.store.begin(op)
      await this.store.commit(op.sessionKey, op.id, { ...session, needsRebase: true })
    } finally { await release() }
  }
  async *run(input: ModelInput, accountKey: string, client: WebTransport, signal: AbortSignal, validate: (text: string, id: string) => Block[], id = randomUUID(), summary?: CompactionAnchor, expectedEpoch?: number): AsyncIterable<ModelEvent> {
    const sessionKey = input.sessionId ? this.key(input.sessionId) : digest(['temporary', id])
    const release = await this.store.sessionLock(sessionKey, signal)
    let operation: ActiveOperation | undefined
    let raw = '', reasoning = '', shown = '', shownReasoning = '', decoder: FinalDecoder | undefined, revision = false
    let monitoring: ReturnType<typeof setInterval> | undefined
    const revoked = new AbortController()
    signal = AbortSignal.any([signal, revoked.signal])
    try {
      let account = await this.store.account()
      if (expectedEpoch !== undefined && expectedEpoch !== account.epoch) throw new TokenFreeError('Account changed before admission.', 'ABORTED')
      if (await this.store.pending(sessionKey)) {
        // Known Web terminal evidence can settle from native records without network. Otherwise inspect only the original response.
        if (!(await this.settle(await this.store.pending(sessionKey)))) {
          await this.verifyOperation(accountKey, client, signal, sessionKey)
          if (await this.store.pending(sessionKey)) throw new TokenFreeError('The previous attempt is not durably settled; no request was repeated.', 'PENDING_OPERATION')
        }
        account = await this.store.account()
      }
      const native = input.sessionId && !summary ? this.dependencies.native?.current(input.sessionId) : undefined
      if (input.sessionId && !native && !summary) throw new TokenFreeError('Missing native attempt association; no Web request was sent.', 'NATIVE_CONTEXT')
      const previous = input.sessionId ? await this.store.session(sessionKey) : undefined
      const hashes = input.messages.map(messageHash)
      const instructionHash = digest(canonical([input.system, input.instructions]))
      const toolsHash = catalogueHash(input.tools)
      const rebase = !previous || previous.needsRebase || previous.accountKey !== accountKey || previous.prefix.length > hashes.length
        || previous.prefix.some((hash, i) => hashes[i] !== hash)
      if (summary && (previous?.accountKey !== accountKey || !previous?.chatId || !previous.webPath?.length || !client.editRoot)) throw new TokenFreeError('A confirmed original chat for this account and root editor are required for compaction.', 'COMPACTION_UNAVAILABLE')
      if (previous && !summary && ['awaiting-checkpoint', 'failed'].includes(previous.compaction?.phase ?? '')) throw new TokenFreeError('The previous compaction needs native verification or an explicit manual retry.', 'COMPACTION_PENDING')
      if (previous && (!rebase || summary)) {
        await this.refresh(previous, client, input.thinking, signal, Boolean(summary), expectedEpoch ?? account.epoch)
        if (!summary && pressure(previous)) throw new TokenFreeError('Context count reached 50% of the effective budget; native TokenFree compaction must complete first.', 'COMPACTION_REQUIRED')
      }
      client.bindOperation?.(id)
      const prompt = summary ? encodeSummary(input, id, summary.compactionId, Math.min(this.dependencies.maxPromptChars, previous?.budget?.inputCharacterLimit ?? Infinity)) : encodeInput(input, id, rebase ? 0 : previous!.prefix.length, rebase ? [] : previous!.tools,
        rebase || instructionHash !== previous!.instructionsHash, this.dependencies.maxPromptChars, Boolean(rebase), previous?.catalogueKnown !== false)
      operation = { id, ...(summary ? { kind: 'compaction' as const, compaction: { ...summary, rootId: previous!.webPath![0]!.id, oldParentId: previous!.parentId!, oldPath: previous!.webPath! } } : {}), accountKey, epoch: expectedEpoch ?? account.epoch, sessionKey, sessionId: input.sessionId, storeId: this.dependencies.storeId,
        generation: (previous?.generation ?? 0) + (rebase && !summary ? 1 : 0), stage: 'prepared', native, parentId: summary || rebase ? null : previous!.parentId,
        chatId: summary ? previous!.chatId : rebase ? previous?.compaction?.initializingChatId : previous!.chatId, parentPath: summary || rebase ? undefined : previous!.webPath, promptHash: digest(prompt), inputHashes: hashes, instructionsHash: instructionHash, toolsHash, tools: input.tools, thinking: input.thinking,
        ...(!summary ? { policy: input.policy, executionTools: input.executionTools } : {}) }
      await this.store.begin(operation)
      if ((await this.store.account()).epoch !== operation.epoch) throw new TokenFreeError('Account was revoked before submission.', 'ABORTED')
      if (summary) await this.store.amendSession(sessionKey, { compaction: { ...summary, phase: 'awaiting-checkpoint', operationId: id } }, id)
      this.dependencies.log?.content(id, 'dsh.request', { sessionId: input.sessionId, native, compaction: operation.compaction, policy: input.policy, executionTools: input.executionTools, inputHashes: hashes, toolsHash, instructionsHash: instructionHash,
        ...(!native ? { system: input.system, instructions: input.instructions, messages: input.messages, tools: input.tools } : {}) })
      const epoch = operation.epoch
      monitoring = setInterval(() => { void this.store.account().then(state => { if (state.epoch !== epoch) revoked.abort() }).catch(() => revoked.abort()) }, 250)
      monitoring.unref()
      if (!operation.chatId) {
        await this.update(operation, { stage: 'creating' })
        const chatId = await client.create(signal)
        await this.update(operation, { chatId, stage: 'prepared' })
        await this.preserveInitialization(operation)
      }
      let repairAttempt = 0
      let nextPrompt = prompt
      for (;;) {
        decoder = new FinalDecoder(id)
        raw = ''; reasoning = ''; revision = false
        await this.update(operation, { stage: 'sending' })
        let resumes = 0
        let source = summary ? client.editRoot!(operation.chatId!, operation.compaction!.rootId, nextPrompt, input.thinking, signal)
          : client.generate(operation.chatId!, operation.parentId, nextPrompt, input.thinking && repairAttempt === 0, signal)
        for (;;) {
          try {
            for await (const event of source) {
              signal.throwIfAborted()
              if (event.type === 'event') { this.dependencies.log?.content(id, 'web.event', { name: event.name, data: event.data, resume: resumes, step: repairAttempt }); continue }
              if (event.type === 'ready') {
                if (event.identity.chatId !== operation.chatId) throw new TokenFreeError('Ready belongs to another chat.', 'WEB_IDENTITY')
                await this.update(operation, { identity: event.identity, stage: 'receiving' }); continue
              }
              const snapshot: WebSnapshot = event.snapshot
              if (snapshot.cleared) { this.dependencies.log?.write('stream.withdrawn', { operationId: id }); yield { type: 'withdraw' }; throw new TokenFreeError('Web response was withdrawn.', 'CONTENT_RETRACTED') }
              if (snapshot.identity && operation.identity && canonical(snapshot.identity) !== canonical(operation.identity)) throw new TokenFreeError('Snapshot identity changed.', 'WEB_IDENTITY')
              if (snapshot.usage !== undefined && snapshot.usage !== operation.usage) await this.update(operation, { usage: snapshot.usage, usageSource: 'sse', usageObservedAt: new Date().toISOString() })
              if (!summary && !snapshot.text.startsWith(raw)) { revision = true; decoder = new FinalDecoder(id); decoder.append(snapshot.text); this.dependencies.log?.write('stream.revised', { operationId: id }) }
              else if (!summary) decoder.append(snapshot.text.slice(raw.length))
              raw = snapshot.text; reasoning = snapshot.reasoning
              if (input.thinking && !repairAttempt && reasoning.startsWith(shownReasoning) && reasoning.length > shownReasoning.length) {
                const suffix = reasoning.slice(shownReasoning.length); shownReasoning = reasoning; yield { type: 'reasoning', text: suffix }
              }
              const text = visible(decoder.text, input.stop)
              if (streamsFinal(input.policy) && !revision && text.startsWith(shown) && text.length > shown.length) { const suffix = text.slice(shown.length); shown = text; yield { type: 'text', text: suffix } }
            }
            break
          } catch (error) {
            if (signal.aborted || !(error instanceof TokenFreeError) || error.details?.accepted === false || !['WEB_DISCONNECTED', 'TRANSPORT'].includes(error.code) || resumes >= 2) throw error
            if (!operation.identity) await this.discover(operation, client, signal)
            resumes++
            this.dependencies.log?.write('stream.resuming', { operationId: id, attempt: resumes })
            source = client.resume(operation.identity!, signal)
          }
        }
        if (!operation.identity) await this.discover(operation, client, signal)
        const messages = await client.history(operation.chatId!, signal)
        const response = this.verify(operation, messages)
        if (response.status !== 'FINISHED' || response.content !== raw) throw new TokenFreeError('History did not confirm the same completed response.', 'WEB_IDENTITY')
        await this.update(operation, { finalStatus: 'FINISHED', verifiedPath: pathOf(messages, response.id), usage: response.usage, usageSource: 'history', usageObservedAt: new Date().toISOString(),
          identity: { ...operation.identity!, ...(response.modelType ? { modelType: response.modelType } : {}) },
          budget: await this.settingsBudget(client, response.modelType ?? operation.identity?.modelType, input.thinking, signal) })
        this.dependencies.log?.content(id, 'metrics.observed', { identity: operation.identity, count: operation.usage, source: operation.usageSource, observedAt: operation.usageObservedAt, budget: operation.budget, thinking: input.thinking })
        this.dependencies.log?.content(id, 'web.response', { formatStage: repairAttempt ? 'repair' : 'initial', text: raw })
        let blocks: Block[]
        try { blocks = validate(raw, id) }
        catch (error) {
          if (!(error instanceof WebResponseFormatError) || !error.repairable || repairAttempt || shown) throw error
          const candidate = decodeResponse(raw, input.tools)
          nextPrompt = encodeFormatRepair({ messages: [], tools: input.tools }, raw, this.dependencies.maxPromptChars, id)
          // Validation must also accept the exact old intent; schema/name failures are never repaired.
          validate(JSON.stringify({ ...strictEnvelope(raw), protocol_version: 1, request_id: id }), id)
          operation.expected = candidate
          await this.update(operation, { repair: { original: operation.identity!, candidateHash: digest(canonical(candidate)), parentId: operation.parentId, promptHash: operation.promptHash, path: operation.verifiedPath! }, parentId: operation.identity!.responseId,
            parentPath: operation.verifiedPath, identity: undefined, verifiedPath: undefined, finalStatus: undefined, promptHash: digest(nextPrompt) })
          repairAttempt++
          continue
        }
        if (operation.repair && digest(canonical(blocks.map(x => x.type === 'tool-call' ? { ...x, id: x.id } : x))) !== operation.repair.candidateHash) {
          // Candidate was decoded with the same request identity for stable IDs below.
          const expected = operation.expected ?? []
          const semantics = (items: Block[]) => items.map(x => x.type === 'tool-call' ? { type: x.type, name: x.name, arguments: x.arguments } : x)
          if (canonical(semantics(blocks)) !== canonical(semantics(expected))) throw new TokenFreeError('Formatting changed the original intent.', 'WEB_TOOL_FORMAT')
        }
        const textBlock = blocks.find(x => x.type === 'text')
        if (textBlock?.type === 'text' && input.stop.length && !blocks.some(x => x.type === 'tool-call')) {
          const truncated = visible(textBlock.text, input.stop, true)
          if (truncated !== textBlock.text) { textBlock.text = truncated; operation.rebase = true }
        }
        if (shownReasoning) blocks.unshift({ type: 'reasoning', text: repairAttempt ? shownReasoning : reasoning })
        await this.update(operation, { stage: 'awaiting-native', expected: blocks, responseText: raw, reasoning, rebase: operation.rebase })
        this.dependencies.log?.content(id, 'validation', { passed: true, identity: operation.identity, blocks })
        if (!native && !summary) await this.store.commit(operation.sessionKey, id)
        yield { type: 'result', blocks, operation }
        return
      }
    } catch (error) {
      if (operation) {
        this.dependencies.log?.content(operation.id, 'preview', { text: error instanceof TokenFreeError && error.code === 'CONTENT_RETRACTED' ? '' : shown, reasoning: shownReasoning, failed: true })
        if (error instanceof TokenFreeError && error.details?.accepted === false) {
          if (operation.repair) await this.update(operation, { stage: 'failed', rebase: true, identity: operation.repair.original,
            parentId: operation.repair.parentId, promptHash: operation.repair.promptHash, verifiedPath: operation.repair.path, finalStatus: 'FINISHED' })
          else await this.update(operation, { stage: 'failed', knownRejected: true })
        }
        else if (operation.verifiedPath) await this.update(operation, { stage: signal.aborted ? 'stopped' : 'failed', rebase: true, responseText: raw, reasoning })
        else if (operation.chatId && operation.stage !== 'prepared') await this.stop(operation, client)
        else if (operation.stage === 'prepared') await this.update(operation, { stage: 'failed', knownRejected: true })
        else await this.update(operation, { stage: 'uncertain' })
        if (!operation.native && !operation.kind && (operation.verifiedPath || operation.knownRejected)) await this.store.commit(operation.sessionKey, operation.id)
      }
      if (revoked.signal.aborted) throw new TokenFreeError('Account was revoked during generation.', 'ABORTED')
      throw error
    } finally {
      if (monitoring) clearInterval(monitoring)
      // for-await cancellation calls return(), not catch(). The server still needs its own stop/confirmation.
      if (operation && !operation.verifiedPath && !operation.knownRejected && ['sending', 'receiving'].includes(operation.stage)) await this.stop(operation, client)
      await release()
    }
  }
}
function strictEnvelope(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  if (!record(value)) throw new TokenFreeError('Invalid formatting candidate.', 'WEB_TOOL_FORMAT')
  return value
}
