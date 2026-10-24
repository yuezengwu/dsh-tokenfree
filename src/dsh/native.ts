import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { isCompactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import { record } from '../core/errors.js'
import { projectMessage } from '../core/codec.js'
import type { NativeAttempt, NativeBoundary, NativeSettlement, CompactionAnchor, CompactionSettlement } from '../core/types.js'

/** Observes native public events; it never appends a successful assistant or edits DSH storage. */
export class DshBoundary implements NativeBoundary {
  private readonly attempts = new Map<string, NativeAttempt>()
  private readonly instances = new WeakMap<object, string>()
  constructor(private readonly ctx: Context, committed: (attempt: NativeAttempt) => void | Promise<void>) {
    ctx.on('agent/assistant-stream', ({ agent, frame }) => {
      if (frame.type === 'start') {
        let instance = this.instances.get(agent)
        if (!instance) { instance = randomUUID(); this.instances.set(agent, instance) }
        const afterSeq = (agent.session.snapshotEvents().at(-1)?.seq ?? -1) + 1
        this.attempts.set(agent.id, { sessionId: agent.id, turn: frame.turn, step: frame.step, attemptId: frame.attemptId, instance, afterSeq })
      }
      if (frame.type === 'end') {
        const start = this.attempts.get(agent.id)
        if (start && start.attemptId === frame.attemptId) {
          const settled = { ...start, ...(frame.outcome.kind === 'committed' ? { settlementSeq: frame.outcome.seq } : { abandoned: true }) }
          this.attempts.set(agent.id, settled)
          void committed(settled)
        }
      }
    })
    // Unlike stream notifications this public boundary is awaited before normal idle/CLI exit.
    ctx.on('agent/turn-stopping', async ({ agent, turn }) => {
      const attempt = this.attempts.get(agent.id)
      if (attempt?.turn === turn && attempt.settlementSeq !== undefined) await committed(attempt)
    })
    ctx.on('agent/disposed', ({ agent }) => { this.attempts.delete(agent.id) })
  }
  current(sessionId: string): NativeAttempt | undefined { return this.attempts.get(sessionId) }
  async inspect(attempt: NativeAttempt): Promise<NativeSettlement | undefined> {
    if (attempt.abandoned) return undefined
    const sessions = this.ctx.get('sessions')
    const live = sessions?.get(SessionId(attempt.sessionId))
    let events: readonly SessionEvent[]
    if (live) events = live.snapshotEvents()
    else {
      const query = this.ctx.get('sessionQuery')
      if (!query) return undefined
      const observation = await query.observeSession(SessionId(attempt.sessionId))
      try { events = observation.events } finally { observation[Symbol.dispose]() }
    }
    const matches = events.filter(event => event.seq >= attempt.afterSeq
      && (attempt.settlementSeq === undefined || event.seq === attempt.settlementSeq)
      && (event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && event.data.turn === attempt.turn && event.data.step === attempt.step)
    if (!matches.length && attempt.settlementSeq === undefined) {
      // Native cold adoption closes a shutdown-interrupted step without inventing an assistant.
      // Headers are deduplicated by DSH; use the effective header before this exact step closure.
      const index = events.findIndex(x => x.seq === attempt.afterSeq)
      const prefix = index >= 0 ? events.slice(0, index) : []
      const request = prefix.findLast(x => x.type === 'request/header')
      const header = request?.type === 'request/header' ? request.data.header : undefined
      const start = prefix.findLast(x => ['step/start', 'step/end', 'turn/start', 'turn/end'].includes(x.type))
      const startIndex = start ? prefix.indexOf(start) : -1
      const untouched = startIndex >= 0 && prefix.slice(startIndex + 1).every(x => ['user/message', 'request/header'].includes(x.type))
      const end = events[index], turnEnd = events[index + 1]
      if (record(header) && record(header.config) && header.config.provider === 'tokenfree-deepseek-web' && header.config.model === 'web-default'
        && untouched && start?.type === 'step/start' && start.data.turn === attempt.turn && start.data.step === attempt.step
        && end?.type === 'step/end' && end.data.turn === attempt.turn && end.data.step === attempt.step
        && turnEnd?.type === 'turn/end' && turnEnd.data.turn === attempt.turn && turnEnd.data.reason.kind === 'interrupted') {
        if (live && !(await sessions!.flush(live))) return undefined
        return { seq: turnEnd.seq, interrupted: true, durable: true }
      }
    }
    if (matches.length !== 1) return undefined
    const event = matches[0]!
    if (live && !(await sessions!.flush(live))) return undefined
    if (event.type === 'assistant/message') {
      const envelope = event.data.message.source.replayState
      const replay = record(envelope) ? envelope.response : undefined
      return { seq: event.seq, interrupted: event.data.interrupted === true, message: projectMessage(event.data.message),
        operationId: record(replay) && typeof replay.operationId === 'string' ? replay.operationId : undefined, durable: true }
    }
    if (event.type === 'assistant/attempt') return { seq: event.seq, interrupted: true, durable: true }
    return undefined
  }
  async inspectCompaction(anchor: CompactionAnchor): Promise<CompactionSettlement | undefined> {
    const sessions = this.ctx.get('sessions')
    const live = sessions?.get(SessionId(anchor.sessionId))
    let events: readonly SessionEvent[]
    if (live) events = live.snapshotEvents()
    else {
      const query = this.ctx.get('sessionQuery')
      if (!query) return undefined
      const observation = await query.observeSession(SessionId(anchor.sessionId))
      try { events = observation.events } finally { observation[Symbol.dispose]() }
    }
    const start = events.find(x => x.seq === anchor.startSeq)
    if (start?.type !== 'compaction/start' || start.data.compactionId !== anchor.compactionId) return undefined
    const ends = events.filter(x => x.type === 'compaction/end' && x.data.compactionId === anchor.compactionId)
    if (ends.length !== 1) return undefined
    const end = ends[0]!
    if (end.type !== 'compaction/end' || events.indexOf(end) <= events.indexOf(start)) return undefined
    const summaries = events.filter(x => x.type === 'compaction/summary' && x.data.compactionId === anchor.compactionId)
    const checkpoints = events.filter(x => x.type === 'user/message' && isCompactCheckpointSource(x.data.source) && x.data.source.compactionId === anchor.compactionId)
    if (end.data.error !== undefined) {
      if (checkpoints.length) return undefined
      if (live && !(await sessions!.flush(live))) return undefined
      return { outcome: 'failed', compactionId: anchor.compactionId, endSeq: end.seq, durable: true }
    }
    if (summaries.length !== 1 || checkpoints.length !== 1) return undefined
    const summary = summaries[0]!, checkpoint = checkpoints[0]!
    if (summary.type !== 'compaction/summary' || events[events.indexOf(summary) + 1] !== checkpoint
      || summary.data.provider !== 'tokenfree-deepseek-web' || summary.data.model !== 'web-default'
      || events.indexOf(summary) <= events.indexOf(start) || events.indexOf(end) <= events.indexOf(checkpoint)
      || !record(checkpoint.surfaceOp) || checkpoint.surfaceOp.op !== 'replace'
      || checkpoint.surfaceOp.startSeq !== summary.data.shadowedRange.start || checkpoint.surfaceOp.endSeq !== summary.data.shadowedRange.end
      || JSON.stringify(checkpoint.sourceEventSeqs) !== JSON.stringify([start.seq, summary.seq, ...summary.data.shadowedSeqs])) return undefined
    if (live && !(await sessions!.flush(live))) return undefined
    return { outcome: 'committed', compactionId: anchor.compactionId, endSeq: end.seq, checkpointSeq: checkpoint.seq,
      summary: summary.data.summary.filter(x => x.type === 'text'), durable: true }
  }

}
