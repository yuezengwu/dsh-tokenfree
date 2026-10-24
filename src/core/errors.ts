/** Provider-independent failure; only dsh/ maps this to the native LlmError. */
export class TokenFreeError extends Error {
  constructor(message: string, readonly code: string, readonly details?: { status?: number; accepted?: false }) {
    super(message)
    this.name = 'TokenFreeError'
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
