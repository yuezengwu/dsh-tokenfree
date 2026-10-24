import { useEffect, useRef, useState } from 'react'
import type { AccountStatus, OperationStatus, UsageStatus } from 'dsh-tokenfree/account-types'

export interface SelectionStatus {
  sessionId?: string
  selected?: boolean
  defaultSelected: boolean
  available: boolean
}
export interface AccountActions {
  sessionId?(): string | undefined
  selection?(sessionId?: string): Promise<SelectionStatus>
  enable?(sessionId?: string): Promise<void>
  usage?(sessionId: string): Promise<UsageStatus>
  running?(sessionId: string): boolean
  cancelSummary?(sessionId: string, operationId: string, compactionId: string): Promise<void>
  operationStatus?(sessionId?: string): Promise<OperationStatus>
  verifyPending?(sessionId: string, operationId: string): Promise<OperationStatus>
  stopPending?(sessionId: string, operationId: string): Promise<OperationStatus>
  status(): Promise<AccountStatus>
  login(): Promise<AccountStatus>
  restore(): Promise<AccountStatus>
  cancel(): Promise<AccountStatus>
  logout(): Promise<AccountStatus>
}

const labels: Record<AccountStatus['state'], string> = {
  'signed-out': '未连接', restoring: '连接中', 'signing-in': '连接中',
  connected: '已连接', 'reauth-required': '未连接', error: '未连接',
}
const number = (value: number | undefined) => value === undefined ? '未知' : value.toLocaleString()

/** Full official observations remain accessible without adding another panel. */
function usageTitle(value?: UsageStatus): string {
  if (!value) return '官网用量未知；不估算、不补 0。'
  return [
    `网页会话用量：${number(value.count)} tokens`, `${value.budgetSource === 'default' ? '默认预算' : '官网文件功能预算'}：${number(value.budget)} tokens`,
    `50% 压缩门槛：${number(value.threshold)}`, `距压缩门槛：${number(value.remainingToThreshold)}`,
    `预算使用比例：${value.percentage === undefined ? '未知' : `${value.percentage.toFixed(1)}%`}`,
    `预算来源：${value.budgetSource === 'default' ? '默认值（官网预算不可用）' : value.budgetSource === 'client/settings' ? '官网 client/settings' : '未知'}`,
    `计数来源：${value.countSource ?? '未知'}；时间：${value.countObservedAt ?? '未知'}`,
    `预算字段：${value.budgetField ?? '未知'}；配置版本：${number(value.settingsVersion)}；时间：${value.budgetObservedAt ?? '未知'}`,
    `模型类型：${value.modelType ?? '未知'}；思考：${value.thinking === undefined ? '未知' : value.thinking ? '开启' : '关闭'}`,
    `压缩门槛：有效预算的 50%；${value.automatic ? '按官网计数判断' : '等待当前官网计数'}`,
    ...(value.generation ? [`生成中观测（尚未结算）：${number(value.generation.count)}；来源：${value.generation.source ?? '未知'}；时间：${value.generation.observedAt ?? '未知'}`] : []),
    ...(value.state !== 'confirmed' && value.lastObservation ? [`旧观测：${value.lastObservation.accumulated_token_usage}（${value.lastObservation.observedAt}），不用于当前判断`] : []),
    '用量来自官网当前网页会话分支的原始计数；优先使用官网文件功能预算，读取不到时用默认预算，不是账号余额或模型总上下文窗口。',
  ].join('\n')
}

const css = `
.dsh-tokenfree-card{box-sizing:border-box;width:100%;min-width:0;padding:16px;border:1px solid var(--border-color,#8884);border-radius:10px;color:inherit;background:var(--bg-card,transparent)}
.dsh-tokenfree-card *{box-sizing:border-box}
.dsh-tokenfree-header{display:flex;align-items:center;justify-content:space-between;gap:12px;min-width:0;height:28px;margin-bottom:12px}
.dsh-tokenfree-header h2{margin:0;min-width:0;font-size:15px;line-height:22px;font-weight:600}
.dsh-tokenfree-header a{display:block;color:inherit;text-decoration:none;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.dsh-tokenfree-header a:hover{text-decoration:underline}
.dsh-tokenfree-actions{display:flex;align-items:center;justify-content:flex-end;gap:8px;flex-shrink:0}
.dsh-tokenfree-actions button{height:26px;flex-shrink:0;min-width:42px;padding:0 9px;border:1px solid var(--border-color,#8885);border-radius:5px;background:transparent;color:inherit;font:inherit;font-size:12px;line-height:1;cursor:pointer}
.dsh-tokenfree-actions button[data-primary]{background:#5269e9;color:white;border-color:#5269e9}
.dsh-tokenfree-actions button:disabled{opacity:.5;cursor:default}
.dsh-tokenfree-card button:focus-visible,.dsh-tokenfree-card a:focus-visible{outline:2px solid #8499ff;outline-offset:2px}
.dsh-tokenfree-status{display:flex;align-items:center;gap:16px;min-width:0;height:22px;white-space:nowrap;font-size:13px;line-height:22px}
.dsh-tokenfree-item{display:flex;align-items:center;gap:6px;min-width:0}
.dsh-tokenfree-item:last-child{flex:1}
.dsh-tokenfree-label{flex-shrink:0;opacity:.65;font-size:12px}
.dsh-tokenfree-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}
.dsh-tokenfree-value[data-tone=good]{color:light-dark(#247441,#98d0ac)}
.dsh-tokenfree-value[data-tone=warning]{color:light-dark(#8a5c0b,#dfbf83)}
.dsh-tokenfree-value[data-tone=muted]{opacity:.7}
.dsh-tokenfree-item:last-child .dsh-tokenfree-value{font-size:12px}
@media(max-width:600px){.dsh-tokenfree-card{padding:14px}.dsh-tokenfree-header{gap:8px}.dsh-tokenfree-header h2{font-size:13px}.dsh-tokenfree-actions{gap:6px}.dsh-tokenfree-status{gap:10px}.dsh-tokenfree-item{gap:4px}.dsh-tokenfree-item:last-child{min-width:64px}.dsh-tokenfree-label,.dsh-tokenfree-value,.dsh-tokenfree-item:last-child .dsh-tokenfree-value{font-size:11px}.dsh-tokenfree-actions button{padding:0 8px}}
`

/** All TokenFree controls stay in this single settings card. */
export function AccountSettings({ actions }: { actions: AccountActions }) {
  const [status, setStatus] = useState<AccountStatus>()
  const [operation, setOperation] = useState<OperationStatus>()
  const [selection, setSelection] = useState<SelectionStatus>()
  const [usage, setUsage] = useState<UsageStatus>()
  const [sessionId, setSessionId] = useState<string>()
  const [hostError, setHostError] = useState(false), [usageError, setUsageError] = useState(false)
  const [error, setError] = useState(''), [pending, setPending] = useState('')
  const alive = useRef(false), busy = useRef(false), revision = useRef(0), actionSession = useRef<string>()
  useEffect(() => {
    alive.current = true
    let disposed = false, timer: ReturnType<typeof setTimeout>, previousId: string | undefined
    const poll = async () => {
      const id = actions.sessionId?.()
      if (previousId !== id) {
        revision.current++
        if (actionSession.current !== undefined) { busy.current = false; setPending(''); actionSession.current = undefined }
        setUsage(undefined); setSelection(undefined); setOperation(undefined); setError(''); previousId = id
      }
      setSessionId(id)
      if (!busy.current) {
        const version = revision.current
        const [account, op, selected, metrics] = await Promise.allSettled([
          actions.status(), actions.operationStatus?.(id), actions.selection?.(id), id ? actions.usage?.(id) : undefined,
        ])
        if (!disposed && version === revision.current) {
          setHostError(account.status === 'rejected')
          if (account.status === 'fulfilled') setStatus(account.value)
          if (id === actions.sessionId?.()) {
            setOperation(op.status === 'fulfilled' ? op.value : undefined)
            if (selected.status === 'fulfilled') setSelection(selected.value)
            else setSelection(undefined)
            setUsageError(metrics.status === 'rejected')
            if (metrics.status === 'fulfilled') setUsage(metrics.value)
          }
        }
      }
      if (!disposed) timer = setTimeout(() => { void poll() }, 1000)
    }
    // Account restore reads saved local state; it does not open the login window.
    void actions.restore().catch(() => {})
    void poll()
    return () => { disposed = true; alive.current = false; clearTimeout(timer) }
  }, [actions])

  const run = async (name: string, operation: () => Promise<void>, targetSession?: string) => {
    if (busy.current || targetSession !== undefined && targetSession !== actions.sessionId?.()) return
    actionSession.current = targetSession
    busy.current = true; const version = ++revision.current; setPending(name); setError('')
    try { await operation() }
    catch { if (alive.current && (targetSession === undefined || version === revision.current && targetSession === actions.sessionId?.())) setError(name === '核实' ? '仍待核实' : name === '停止并核实' || name === '停止摘要' ? '停止尚未确认' : name === '使用' ? '启用未完成' : '操作未完成') }
    finally { if (targetSession === undefined || version === revision.current) { busy.current = false; actionSession.current = undefined; if (alive.current) setPending('') } }
  }
  const accountAction = async (action: () => Promise<AccountStatus>) => {
    const next = await action(); if (alive.current) setStatus(next)
  }
  const connected = status?.state === 'connected' && !hostError
  const activeSummary = usage?.generation?.purpose === 'compaction' && usage.generation.stage === 'receiving'
  const running = operation?.sessionId ? actions.running?.(operation.sessionId) : false
  const needsVerification = Boolean(operation?.pending && (!running || operation.stage === 'uncertain') && !activeSummary)
  const accountText = hostError ? '未连接' : status ? labels[status.state] : '—'
  const selected = sessionId ? selection?.selected : selection?.defaultSelected
  let dshText = !selection || selected === undefined ? '—' : connected && selected ? '已启用' : '未启用'
  if (connected && selected) {
    if (activeSummary || usage?.compaction === 'awaiting-checkpoint' || usage?.compaction === 'needs-new-chat') dshText = '压缩中'
    if (needsVerification || usage?.compaction === 'failed' || error || usage?.backend && usage.backend !== 'ready') dshText = '待处理'
  }
  const official = connected && !usageError && usage?.state === 'confirmed' && usage.count !== undefined ? `${number(usage.count)} tokens` : '—'
  const officialTitle = error ? `${error}，请检查本地日志。` : needsVerification ? '原请求状态未确认；本会话的新生成暂停。核实不会重新发送问题。'
    : `${usageError ? '以下为旧观测，不用于自动压缩判断。\n' : ''}${usageTitle(connected ? usage : undefined)}`
  const disabled = Boolean(pending) || hostError || !status
  const refreshSelection = async (id?: string) => {
    const next = await actions.selection?.(id)
    if (alive.current && id === actions.sessionId?.()) setSelection(next)
  }
  return <div style={{ padding: 24, width: '100%', minWidth: 0, boxSizing: 'border-box' }}>
    <style>{css}</style>
    <section className="dsh-tokenfree-card" data-testid="tokenfree-account" aria-label="DeepSeek 网页连接">
      <header className="dsh-tokenfree-header">
        <h2><a href="https://chat.deepseek.com/" target="_blank" rel="noopener noreferrer">chat.deepseek.com</a></h2>
        <div className="dsh-tokenfree-actions">
          {connected && actions.enable && selection?.available && !selected && !operation?.pending && <button data-primary title={sessionId ? '用于当前会话，并设为当前 DSH 配置默认' : '设为当前 DSH 配置默认'} disabled={disabled} onClick={() => { void run('使用', async () => {
            const id = actions.sessionId?.(); await actions.enable!(id); await refreshSelection(id)
          }) }}>使用</button>}
          {activeSummary && sessionId && usage?.generation?.operationId && usage.generation.compactionId && actions.cancelSummary && <button disabled={disabled} onClick={() => { void run('停止摘要', () => actions.cancelSummary!(sessionId, usage!.generation!.operationId, usage!.generation!.compactionId!), sessionId) }}>停止摘要</button>}
          {needsVerification && sessionId && operation?.operationId && actions.verifyPending && <button disabled={disabled} onClick={() => { void run('核实', async () => { const id = sessionId; const next = await actions.verifyPending!(id, operation.operationId!); if (alive.current && id === actions.sessionId?.()) setOperation(next) }, sessionId) }}>核实</button>}
          {needsVerification && sessionId && operation?.operationId && actions.stopPending && <button disabled={disabled} title="停止原请求并核实，不会撤销已执行的工具" onClick={() => { void run('停止并核实', async () => { const id = sessionId; const next = await actions.stopPending!(id, operation.operationId!); if (alive.current && id === actions.sessionId?.()) setOperation(next) }, sessionId) }}>停止并核实</button>}
          {status?.busy ? <button disabled={disabled} onClick={() => { void run('取消', () => accountAction(() => actions.cancel())) }}>取消</button>
            : connected ? <button disabled={disabled} title="退出本机桌面、CLI 和 Web 的 TokenFree 连接" onClick={() => { void run('退出', () => accountAction(() => actions.logout())) }}>退出</button>
              : <button data-primary disabled={disabled} onClick={() => { void run('登录', () => accountAction(() => actions.login())) }}>登录</button>}
        </div>
      </header>
      <div className="dsh-tokenfree-status" role="status">
        <span className="dsh-tokenfree-item"><span className="dsh-tokenfree-label">账号</span><span className="dsh-tokenfree-value" data-state={status?.state} data-tone={connected ? 'good' : 'muted'} title={status?.message}>{accountText}</span></span>
        <span className="dsh-tokenfree-item"><span className="dsh-tokenfree-label">DSH</span><span className="dsh-tokenfree-value" data-testid="tokenfree-state" data-tone={dshText === '待处理' ? 'warning' : undefined} title={error || (selected && usage?.backend && usage.backend !== 'ready' ? '当前 DSH 作用域未能初始化 TokenFree 原生压缩，请检查插件日志。' : selection?.selected && selection.defaultSelected ? '当前会话和本配置默认均已启用' : sessionId ? '当前会话与本配置默认的设置分别核实' : '当前没有会话，显示本配置默认设置')}>{dshText}</span></span>
        <span className="dsh-tokenfree-item"><span className="dsh-tokenfree-label">用量</span><span className="dsh-tokenfree-value" data-testid="tokenfree-usage" data-tone={error || needsVerification ? 'warning' : 'muted'} title={officialTitle} aria-label={officialTitle}>{official}</span></span>
      </div>
    </section>
  </div>
}
