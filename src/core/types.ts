export interface Tool { name: string; description: string; parameters: Record<string, unknown>; deferLoading?: boolean; output?: unknown }
export type ToolChoice = { mode: 'auto' | 'none' | 'required' } | { mode: 'named'; name: string }
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }
export type OutputFormat = { type: 'text' | 'json' } | { type: 'schema'; schema: { [key: string]: JsonValue } }
export interface SessionPolicy { tools: ToolChoice; output: OutputFormat }
export interface PolicyState extends SessionPolicy { revision: string }
export type Block = { type: 'text'; text: string } | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; id: string; name: string; arguments: string }
export interface InputMessage {
  id?: string
  role: string
  content: readonly unknown[]
  callId?: string
  isError?: boolean
}
export interface ModelInput {
  sessionId?: string
  system: string
  instructions: InputMessage[]
  messages: InputMessage[]
  tools: Tool[]
  thinking: boolean
  stop: string[]
  maxTokens?: number
  policy?: PolicyState
  executionTools?: Tool[]
}
export interface NativeAttempt {
  sessionId: string
  turn: number
  step: number
  attemptId: string
  instance: string
  afterSeq: number
  settlementSeq?: number
  abandoned?: boolean
}
export interface NativeSettlement {
  seq: number
  interrupted: boolean
  message?: InputMessage
  /** Native persistence was flushed, or this was read from durable cold storage. */
  operationId?: string
  durable: true
}
export interface NativeBoundary {
  current(sessionId: string): NativeAttempt | undefined
  inspect(attempt: NativeAttempt): Promise<NativeSettlement | undefined>
  inspectCompaction?(anchor: CompactionAnchor): Promise<CompactionSettlement | undefined>
}
export interface WebIdentity { chatId: string; requestId: number; responseId: number; modelType?: string }
export interface WebSnapshot {
  identity?: WebIdentity
  text: string
  reasoning: string
  status?: string
  usage?: number
  cleared?: boolean
}
export type WebEvent = { type: 'ready'; identity: WebIdentity }
  | { type: 'snapshot'; snapshot: WebSnapshot }
  | { type: 'event'; name: string; data: unknown }
export interface WebMessage {
  id: number
  parentId: number | null
  role: 'USER' | 'ASSISTANT'
  content: string
  reasoning: string
  status: string
  usage?: number
  modelType?: string
}
export interface WebTransport {
  bindOperation?(id: string): void
  create(signal: AbortSignal): Promise<string>
  generate(chatId: string, parentId: number | null, prompt: string, thinking: boolean, signal: AbortSignal): AsyncIterable<WebEvent>
  resume(identity: WebIdentity, signal: AbortSignal): AsyncIterable<WebEvent>
  history(chatId: string, signal: AbortSignal): Promise<WebMessage[]>
  stop(identity: WebIdentity, signal: AbortSignal): Promise<void>
  settings?(deviceId: string, signal: AbortSignal): Promise<WebSettings>
  editRoot?(chatId: string, rootId: number, prompt: string, thinking: boolean, signal: AbortSignal): AsyncIterable<WebEvent>
}

export interface WebModelConfig {
  modelType: string
  tokenLimit?: number
  tokenLimitWithThinking?: number
  inputCharacterLimit?: number
}
export interface WebSettings { version: number; models: WebModelConfig[]; observedAt: string }
export interface OfficialBudget {
  value?: number
  modelType?: string
  thinking: boolean
  field: 'token_limit' | 'token_limit_with_thinking'
  source: 'client/settings' | 'default'
  settingsVersion?: number
  observedAt: string
  inputCharacterLimit?: number
}
export interface CompactionAnchor { sessionId: string; compactionId: string; startSeq: number; thinking: boolean }
export interface CompactionSettlement {
  outcome: 'committed' | 'failed'
  compactionId: string
  endSeq: number
  checkpointSeq?: number
  summary?: Block[]
  durable: true
}
