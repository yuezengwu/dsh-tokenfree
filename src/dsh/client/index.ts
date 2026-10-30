import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/remote'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import tokenfreeRemote from 'dsh-tokenfree/remote'
import { AccountSettings, type AccountActions } from './AccountSettings.js'

export const inject = ['remote', 'slots']
const provider = 'tokenfree-deepseek-web', model = 'web-default'

async function unwrap<T>(pending: Promise<RemoteResult<T>>): Promise<T> {
  const result = await pending
  if (!result.ok) throw new Error('TokenFree account operation failed.')
  return result.value
}

export async function apply(ctx: Context): Promise<() => Promise<void>> {
  const unmount = await ctx.remote.$mount(tokenfreeRemote)
  const feature = ctx.inject(['remote.tokenfree', 'slots'], scope => {
    const sessionId = () => scope.get('uiSession')?.adapter.current.getSnapshot().key
    const actions: AccountActions = {
      sessionId,
      selection: async id => {
        const defaults = await unwrap(scope.remote.tokenfree.defaultModel())
        const sessions = scope.get('sessions')
        const binding = id ? sessions?.binding(id as SessionId) : undefined
        const projection = binding?.session.projections.faceOf('modelSelection').getSnapshot()
        return { sessionId: id,
          selected: id === undefined ? undefined : projection === undefined ? undefined : projection.next === null ? defaults.selected : projection.next.provider === provider && projection.next.model === model,
          defaultSelected: defaults.selected,
          available: defaults.available && (id === undefined || (binding !== undefined && sessions?.subagentAddress(id as SessionId) === undefined && projection !== undefined)),
        }
      },
      enable: async id => {
        if (id) {
          const sessions = scope.get('sessions')
          if (!sessions?.binding(id as SessionId) || sessions.subagentAddress(id as SessionId) !== undefined) throw new Error('Session model selection is unavailable.')
          // Native selection owns both the session event and its background default save.
          await unwrap(scope.remote.session.selectModel({ sessionId: id as SessionId, provider, model }))
        } else {
          const result = await unwrap(scope.remote.tokenfree.useDefault())
          if (!result.selected) throw new Error('Default model was not saved.')
        }
      },
      running: id => scope.get('sessions')?.binding(id as SessionId)?.session.getSnapshot().running ?? false,
      usage: id => unwrap(scope.remote.tokenfree.usage(id)),
      cancelSummary: async (id, operationId, compactionId) => { await unwrap(scope.remote.tokenfree.cancelSummary(id, operationId, compactionId)) },
      operationStatus: id => unwrap(scope.remote.tokenfree.operationStatus(id)),
      verifyPending: (id, operationId) => unwrap(scope.remote.tokenfree.verifyPending(id, operationId)),
      stopPending: (id, operationId) => unwrap(scope.remote.tokenfree.stopPending(id, operationId)),
      status: () => unwrap(scope.remote.tokenfree.status()),
      login: () => unwrap(scope.remote.tokenfree.login()),
      restore: () => unwrap(scope.remote.tokenfree.restore()),
      cancel: () => unwrap(scope.remote.tokenfree.cancel()),
      logout: () => unwrap(scope.remote.tokenfree.logout()),
    }
    scope.slots.inject('settings.section', () => scope.slots.register({
      name: 'settings.section', id: 'dsh-tokenfree:account', order: 16,
      label: () => 'TokenFree', inject: () => ({ actions }),
    }, AccountSettings))
  })
  try { await feature.await() }
  catch (error) { await feature.dispose(); await unmount(); throw error }
  return async () => { await feature.dispose(); await unmount() }
}
