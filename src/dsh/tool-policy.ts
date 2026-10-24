import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { SessionId } from '@deepseek-ai/dsh-session'
import { canonical } from '../core/codec.js'
import { record, TokenFreeError } from '../core/errors.js'
import type { Block, Tool } from '../core/types.js'

const operationOf = (id: string) => /^tokenfree_([a-f0-9-]{36})_\d+$/.exec(id)?.[1]
const changed = '工具已变化，本次调用未执行。'

/** Native execution remains native. These guards can only deny a bound TokenFree call. */
export class ToolPolicyBridge {
  private readonly attached = new WeakSet<Agent>()
  constructor(private readonly ctx: Context, private readonly saved: (sessionId: string, operationId: string) => Promise<Tool[]>) {
    ctx.on('agent/created', ({ agent }) => { if (agent.ctx.get('tools')) this.attach(agent) })
    for (const agent of ctx.get('agents')?.list() ?? []) if (agent.ctx.get('tools')) this.attach(agent)
  }
  private agent(id: string): Agent {
    const agent = this.ctx.get('agents')?.get(SessionId(id))
    if (!agent || !agent.ctx.get('tools')) throw new TokenFreeError('Native scoped tools are unavailable.', 'TOOL_BINDING')
    this.attach(agent)
    return agent
  }
  catalogue(id: string, declared?: readonly Tool[]): Tool[] {
    const agent = this.agent(id), tools = agent.ctx.get('tools')!
    const catalogue = tools.schemas(agent).map(schema => ({ ...schema, output: tools.get(schema.name, agent)?.output.schema }))
    for (const tool of declared ?? []) {
      const current = catalogue.find(x => x.name === tool.name)
      const wire = (value: Tool) => ({ name: value.name, description: value.description, parameters: value.parameters, ...(value.deferLoading ? { deferLoading: true } : {}) })
      if (!current || canonical(wire(tool)) !== canonical(wire(current))) throw new TokenFreeError(changed, 'TOOL_CHANGED')
    }
    return catalogue
  }
  private same(expected: Tool | undefined, current: Tool | undefined) { return !!expected && !!current && canonical(expected) === canonical(current) }
  check(id: string, blocks: Block[], snapshot: Tool[]) {
    const calls = blocks.filter(x => x.type === 'tool-call')
    if (!calls.length) return
    const current = this.catalogue(id)
    for (const call of calls) if (call.name === 'web_search' || !this.same(snapshot.find(x => x.name === call.name), current.find(x => x.name === call.name))) throw new TokenFreeError(changed, 'TOOL_CHANGED')
  }
  private attach(agent: Agent) {
    if (this.attached.has(agent)) return
    this.attached.add(agent)
    let active = true
    const retired = new Set<string>()
    const bindings = new Map<symbol, { tools?: Tool[]; reason?: string }>()
    const before = agent.ctx.on('tools/pre-execute', async (exec, next) => {
      const operationId = operationOf(exec.rootCallId)
      if (operationId) {
        try {
          // Verify native ownership as well as the durable Web/input snapshot; never trust a prefix alone.
          const matches = agent.session.snapshotEvents().filter(event => event.type === 'assistant/message' && !event.data.interrupted
            && event.data.message.content.some(x => x.type === 'tool-call' && x.id === exec.rootCallId))
          const event = matches.length === 1 ? matches[0] : undefined
          const source = event?.type === 'assistant/message' ? event.data.message.source : undefined
          const response = record(source?.replayState) ? source.replayState.response : undefined
          if (source?.provider !== 'tokenfree-deepseek-web' || source.model !== 'web-default' || !record(response) || response.operationId !== operationId || response.sessionId !== agent.id) throw new Error('binding')
          const call = event?.type === 'assistant/message' ? event.data.message.content.find(x => x.type === 'tool-call' && x.id === exec.rootCallId) : undefined
          if (!exec.parent && (call?.type !== 'tool-call' || call.name !== exec.name || canonical(JSON.parse(call.arguments)) !== canonical(exec.arguments))) throw new Error('call')
          bindings.set(exec.token, { tools: await this.saved(agent.id, operationId) })
        } catch { bindings.set(exec.token, { reason: 'TokenFree 工具关联尚未核实，本次调用未执行。' }) }
      }
      return next()
    })
    const guard = agent.ctx.tools.guard((exec: Readonly<ToolExecution>) => {
      if (!operationOf(exec.rootCallId)) return
      if (!active) return retired.has(exec.rootCallId) ? 'TokenFree 已停用，本次调用未执行。' : undefined
      if (exec.name === 'web_search') return 'TokenFree 不支持网页搜索，本次调用未执行。'
      const binding = bindings.get(exec.token)
      if (!binding?.tools) return binding?.reason ?? 'TokenFree 工具关联尚未核实，本次调用未执行。'
      const expected = binding.tools.find(x => x.name === exec.name)
      const current = this.catalogue(agent.id).find(x => x.name === exec.name)
      return this.same(expected, current) ? undefined : changed
    })
    const after = agent.ctx.on('tools/result', exec => {
      bindings.delete(exec.token)
      if (!active && exec.callId === exec.rootCallId) {
        retired.delete(exec.rootCallId)
        if (!retired.size) { guard(); after() }
      }
    })
    const release = this.ctx.effect(() => () => {
      active = false; before(); bindings.clear()
      // The Agent owns calls already saved before unload. Keep only a denial for those
      // unfinished roots until their native result; fresh calls after reload are unaffected.
      const events = agent.session.snapshotEvents()
      const ended = new Set(events.flatMap(e => e.type === 'tool/result' ? [e.data.message.source.callId] : []))
      for (const event of events) if (event.type === 'assistant/message' && !event.data.interrupted && event.data.message.source.provider === 'tokenfree-deepseek-web') {
        for (const call of event.data.message.content) if (call.type === 'tool-call' && operationOf(call.id) && !ended.has(call.id)) retired.add(call.id)
      }
      if (!retired.size) { guard(); after() }
    })
    agent.ctx.effect(() => release)
  }
}
