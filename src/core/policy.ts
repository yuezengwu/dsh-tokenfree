import { record, TokenFreeError } from './errors.js'
import { strictJson } from './json.js'
import type { Block, SessionPolicy, Tool } from './types.js'

export const defaultPolicy = (): SessionPolicy => ({ tools: { mode: 'auto' }, output: { type: 'text' } })
const exact = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))

/** Transport-independent settings. Native schema validation is supplied by dsh/. */
export function parsePolicy(value: unknown, schema?: (value: unknown) => void): SessionPolicy {
  if (!record(value) || !exact(value, ['tools', 'output']) || !record(value.tools) || !record(value.output)) throw new TokenFreeError('Invalid TokenFree session policy.', 'INVALID_POLICY')
  const tools = value.tools, output = value.output
  if (!['auto', 'none', 'required', 'named'].includes(String(tools.mode)) || !exact(tools, tools.mode === 'named' ? ['mode', 'name'] : ['mode'])
    || tools.mode === 'named' && (typeof tools.name !== 'string' || !tools.name || tools.name.length > 256)) throw new TokenFreeError('Invalid tool choice.', 'INVALID_POLICY')
  if (!['text', 'json', 'schema'].includes(String(output.type)) || !exact(output, output.type === 'schema' ? ['type', 'schema'] : ['type'])
    || output.type === 'schema' && !record(output.schema)) throw new TokenFreeError('Invalid final output format.', 'INVALID_POLICY')
  if (output.type === 'schema') schema?.(output.schema)
  let text: string
  try { text = JSON.stringify(value); if (text.length > 65_536) throw new Error('size'); strictJson(text) }
  catch { throw new TokenFreeError('Session policy must be bounded JSON.', 'INVALID_POLICY') }
  return JSON.parse(text) as SessionPolicy
}
export const oneShot = (policy: SessionPolicy) => ['required', 'named'].includes(policy.tools.mode)
export const streamsFinal = (policy?: SessionPolicy) => !policy || policy.output.type === 'text' && !oneShot(policy)

export function allowedTools(tools: Tool[], policy: SessionPolicy): Tool[] {
  if (policy.tools.mode === 'none') return []
  if (policy.tools.mode === 'named') {
    const name = policy.tools.name, tool = tools.find(x => x.name === name)
    if (!tool) throw new TokenFreeError('The selected tool is not currently available.', 'TOOL_UNAVAILABLE')
    return [tool]
  }
  if (policy.tools.mode === 'required' && !tools.length) throw new TokenFreeError('No current tool can satisfy the next-call requirement.', 'TOOL_UNAVAILABLE')
  return tools
}

export function validatePolicyResult(blocks: Block[], policy: SessionPolicy, stops: string[], schema: (schema: Record<string, unknown>, value: unknown) => void): void {
  const calls = blocks.filter(x => x.type === 'tool-call')
  const named = policy.tools.mode === 'named' ? policy.tools.name : undefined
  if (policy.tools.mode === 'none' && calls.length || oneShot(policy) && !calls.length
    || named !== undefined && calls.some(x => x.name !== named)) throw new TokenFreeError('The response did not follow this session tool choice. No tools were delivered.', 'TOOL_CHOICE')
  if (calls.length || policy.output.type === 'text') return
  const block = blocks.find(x => x.type === 'text')
  if (block?.type !== 'text') throw new TokenFreeError('Missing structured final result.', 'OUTPUT_FORMAT')
  // Stop is applied before validation; an incomplete JSON value is never delivered.
  let end = block.text.length
  for (const stop of stops) { const i = block.text.indexOf(stop); if (i >= 0) end = Math.min(end, i) }
  const text = block.text.slice(0, end)
  let value: unknown
  try { value = strictJson(text) }
  catch { throw new TokenFreeError('Final output is not one complete JSON value.', 'OUTPUT_FORMAT') }
  if (policy.output.type === 'schema') schema(policy.output.schema, value)
}
