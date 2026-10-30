import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { hosts } = JSON.parse(readFileSync(new URL('../../scripts/dsh-hosts.json', import.meta.url), 'utf8'))

// Alpha.2 separates tool execution from ToolRuntime. Official host presets own
// that executor; bare SDK fixtures must mount the same public native plugin.
export async function installNativeToolExecutor(ctx) {
  const { version } = require('@deepseek-ai/dsh-tools/package.json')
  const host = hosts.find(host => host.version === version)
  if (!host) throw new Error(`Unverified DSH SDK fixture: ${version}`)
  if (host.nativeToolExecutor) await ctx.plugin(await import('@deepseek-ai/dsh-tool-executor-native'))
}

// The alpha.2 tools service accepts batches. These direct-call fixtures need
// the public per-call pipeline to preserve their nested parent/root identities.
export async function executeNativeCall(ctx, input) {
  const { version } = require('@deepseek-ai/dsh-tools/package.json')
  if (!hosts.find(host => host.version === version)?.nativeToolExecutor) return ctx.tools.execute(input)
  const { ToolExecutionPipeline } = await import('@deepseek-ai/dsh-tools/pipeline')
  const pipeline = new ToolExecutionPipeline(ctx)
  const prepared = await pipeline.prepare(input)
  const outcome = prepared.kind === 'dispatch' ? await pipeline.dispatch(prepared.exec) : prepared
  return pipeline.complete(prepared.exec, outcome)
}
