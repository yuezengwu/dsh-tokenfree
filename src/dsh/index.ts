import type { Context } from '@deepseek-ai/cordis'
import { TokenFreeAdapter, PROVIDER } from './adapter.js'
import type { Config } from './adapter.js'
import { LocalAccount } from '../core/account.js'
import { TokenFreeGateway } from './gateway.js'
import { LocalDiagnostics } from '../local/diagnostics.js'
import { defaultCredentialFile } from '../local/auth.js'
import { dirname } from 'node:path'
import { DshBoundary } from './native.js'
import { LocalStore } from '../local/store.js'
import { installCompaction } from './compaction.js'
import { SessionId } from '@deepseek-ai/dsh-session'
import { TokenFreeError } from '../core/errors.js'
import { ToolPolicyBridge } from './tool-policy.js'

export { TokenFreeAdapter, PROVIDER, MODEL } from './adapter.js'
export type { Config } from './adapter.js'
export { TokenFreeGateway } from './gateway.js'
export const name = 'dsh-tokenfree'
export const inject = ['llm']

/** Register one local account route; unload cancels outstanding requests and removes the route. */
export function apply(ctx: Context, config: Config = {}): void {
  const log = new LocalDiagnostics(dirname(config.credentialFile ?? defaultCredentialFile()), true, config.logContent !== false)
  const account = new LocalAccount(config.credentialFile, { diagnostics: log })
  let adapter: TokenFreeAdapter | undefined
  let compaction: ReturnType<typeof installCompaction>
  const tools = new ToolPolicyBridge(ctx, (sessionId, operationId) => adapter!.toolCatalogueForCall(sessionId, operationId))
  const native = new DshBoundary(ctx, attempt => adapter?.reconcile(attempt))
  adapter = new TokenFreeAdapter(config, {
    credential: signal => account.credential(signal),
    signal: () => account.requestSignal(),
    authRejected: credential => account.requireVerification(credential),
    diagnostics: log,
    native,
    store: new LocalStore(dirname(config.credentialFile ?? defaultCredentialFile())),
    compactionReady: async id => {
      const agent = ctx.get('agents')?.get(SessionId(id))
      if (!agent) throw new TokenFreeError('The native TokenFree session is unavailable.', 'COMPACTION_UNAVAILABLE')
      await compaction.ensure(agent)
    },
    toolCatalogue: (id, declared) => tools.catalogue(id, declared),
    checkTools: (id, blocks, snapshot) => tools.check(id, blocks, snapshot),
  })
  new TokenFreeGateway(ctx, account, adapter)
  compaction = installCompaction(ctx)
  const mounted = adapter
  ctx.effect(() => {
    const remove = ctx.llm.registerAdapter([PROVIDER], mounted)
    log.write('plugin.started')
    return async () => {
      await mounted.dispose(); remove(); await account.dispose()
      log.write('plugin.stopped')
      await log.flush()
    }
  })
  // On demand only: opening the settings page or sending a request restores the session.
}
