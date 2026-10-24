import type { TokenFreeAdapter } from './adapter.js'
// Cordis traces services through different proxies; bind by an opaque host identity, not proxy equality.
const runtimes = new Map<string, TokenFreeAdapter>()
export function bindRuntime(id: string, runtime: TokenFreeAdapter) { runtimes.set(id, runtime); return () => { runtimes.delete(id) } }
export function runtimeFor(id: string): TokenFreeAdapter {
  const runtime = runtimes.get(id)
  if (!runtime) throw new Error('TokenFree adapter is not mounted.')
  return runtime
}
