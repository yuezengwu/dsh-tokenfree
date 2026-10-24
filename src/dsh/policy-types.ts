import type { JsonValue } from '@deepseek-ai/dsh-util-values'
import type { ToolChoice } from '../core/types.js'

/** Native wire uses DSH's recognized JSON domain; core keeps its own JSON-only types. */
export interface SessionPolicy {
  tools: ToolChoice
  output: { type: 'text' | 'json' } | { type: 'schema'; schema: Record<string, JsonValue> }
}
export interface PolicyState extends SessionPolicy { revision: string }
