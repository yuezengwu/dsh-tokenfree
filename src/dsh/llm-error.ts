import { LlmError } from '@deepseek-ai/dsh-llm'
import type { LlmErrorOptions } from '@deepseek-ai/dsh-llm'

/** Preserve provider error codes on both sides of DSH's rc.2 constructor change. */
export function providerLlmError(failure: { message: string; code: string } & LlmErrorOptions): LlmError {
  if ('fromFailure' in LlmError && typeof LlmError.fromFailure === 'function') {
    return LlmError.fromFailure(failure)
  }
  // Earlier hosts accept arbitrary provider codes in the constructor.
  const LegacyLlmError = LlmError as new (message: string, code: string, options?: LlmErrorOptions) => LlmError
  return new LegacyLlmError(failure.message, failure.code, failure)
}
