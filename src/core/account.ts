import { dirname, join } from 'node:path'
import { rm } from 'node:fs/promises'
import { TokenFreeError as LlmError } from '../core/errors.js'
import { defaultCredentialFile } from '../local/auth.js'
import type { WebCredential } from '../local/auth.js'
import { DeepSeekWebClient } from '../deepseek-web/client.js'
import { ManagedBrowserLogin } from '../deepseek-web/browser-login.js'
import type { BrowserLogin } from '../deepseek-web/browser-login.js'
import type { AccountStatus } from './account-types.js'
import { LocalDiagnostics, failureCategory } from '../local/diagnostics.js'
import { LocalStore, digest } from '../local/store.js'
import { acquireLock } from '../local/lock.js'

interface AccountDependencies {
  browser?: BrowserLogin
  check?: (credential: WebCredential, signal: AbortSignal) => Promise<void>
  diagnostics?: LocalDiagnostics
}

/** One local account, with a single login/restore flight and no background keepalive. */
export class LocalAccount {
  private readonly file: string
  private readonly profile: string
  private readonly browser: BrowserLogin
  private readonly check: NonNullable<AccountDependencies['check']>
  private readonly lifetime = new AbortController()
  private generation = new AbortController()
  private attempt?: AbortController
  private running?: Promise<void>
  private forgetting?: Promise<AccountStatus>
  private committing = false
  private interactive = false
  private cached?: WebCredential
  private observedCredential?: string
  private readonly log: LocalDiagnostics
  private view: AccountStatus = { state: 'signed-out', message: '登录 DeepSeek 网页账号即可开始。', configured: false, busy: false }

  constructor(file = defaultCredentialFile(), dependencies: AccountDependencies = {}) {
    this.file = file
    this.profile = join(dirname(file), 'browser-profile')
    this.log = dependencies.diagnostics ?? new LocalDiagnostics(dirname(file))
    this.browser = dependencies.browser ?? new ManagedBrowserLogin(this.profile, { diagnostics: this.log })
    this.check = dependencies.check ?? ((credential, signal) => new DeepSeekWebClient(credential, { diagnostics: this.log }).check(signal))
  }

  status(): AccountStatus { return { ...this.view } }
  requestSignal(): AbortSignal { return this.generation.signal }

  /** Settings polling observes shared local login changes without network keepalive. */
  async refreshLocalStatus(): Promise<AccountStatus> {
    if (this.running || this.forgetting || this.lifetime.signal.aborted) return this.status()
    try {
      const credential = await new LocalStore(dirname(this.file)).credential(this.file)
      const identity = credential ? digest([credential.token, credential.accountId, credential.epoch]) : undefined
      if (identity === this.observedCredential) return this.status()
      const previouslyConfigured = this.observedCredential !== undefined || this.cached !== undefined
      this.observedCredential = identity
      this.cached = undefined
      if (previouslyConfigured) {
        this.generation.abort()
        this.generation = new AbortController()
      }
      this.view = credential
        ? { state: 'connected', configured: true, busy: false, message: '本机登录状态已同步；首次使用时核实官网连接。' }
        : { state: 'signed-out', configured: false, busy: false, message: '已在其他入口退出本插件。' }
    } catch {
      this.view = { state: 'error', configured: true, busy: false, message: '无法读取本地登录状态，请检查文件权限；未改写凭据。' }
    }
    return this.status()
  }

  /** A UI click returns immediately; status polling follows the plugin-owned login window. */
  login(): AccountStatus {
    if (this.lifetime.signal.aborted || this.running || this.forgetting) return this.status()
    this.log.write('account.login')
    this.start(true)
    return this.status()
  }

  private start(interactive: boolean): void {
    if (!interactive) this.log.write('account.recovering')
    const before = this.status()
    this.interactive = interactive
    const controller = new AbortController()
    this.attempt = controller
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    this.view = { ...this.view, state: before.state === 'connected' ? 'connected' : interactive ? 'signing-in' : 'restoring', busy: true,
      message: interactive ? '请在 TokenFree 专用的官方窗口完成登录，成功后窗口会自动关闭。' : '正在恢复本插件保存的登录状态…' }
    this.running = (async () => {
      try {
        const store = new LocalStore(dirname(this.file))
        const epoch = (await store.account()).epoch
        signal.throwIfAborted()
        const credential = await this.browser.obtain({ interactive, signal, epoch })
        signal.throwIfAborted()
        if (credential) {
          // Validate independently of the browser driver before replacing the account.
          this.log.write('account.validating', { phase: 'verify', interactive })
          await this.check(credential, AbortSignal.any([signal, AbortSignal.timeout(20_000)]))
          signal.throwIfAborted()
          // Cancellation waits for an admitted atomic commit, just as logout
          // waits before deleting it. No partially written account is visible.
          this.committing = true
          this.log.write('account.persisting', { phase: 'persist', interactive })
          credential.epoch = await store.saveLogin(this.file, credential, epoch)
          this.observedCredential = digest([credential.token, credential.accountId, credential.epoch])
          if (interactive && this.cached && this.cached.token !== credential.token) {
            this.generation.abort()
            this.generation = new AbortController()
          }
          this.cached = credential
          this.connected()
        } else {
          this.view = before.configured && interactive ? { ...before, busy: false } : {
            state: before.configured ? 'reauth-required' : 'signed-out', configured: before.configured,
            busy: false, message: interactive ? '登录未完成，可点击登录重试。' : '请在 TokenFree 中登录；登录状态有效时会自动恢复。',
          }
        }
      } catch (error) {
        this.log.write(signal.aborted ? 'account.cancelled' : 'account.failed', failureCategory(error))
        if (error instanceof LlmError && error.code === 'LOGIN_REVOKED') {
          this.view = { state: 'error', configured: false, busy: false, message: error.message }
          return
        }
        let usable: WebCredential | undefined
        try { usable = await new LocalStore(dirname(this.file)).credential(this.file) } catch {}
        if (usable && !signal.aborted) {
          this.cached = undefined
          this.observedCredential = digest([usable.token, usable.accountId, usable.epoch])
        }
        this.view = usable && !signal.aborted ? { state: 'connected', configured: true, busy: false,
          message: '本次登录未完成，继续使用本机已连接账号。' } : signal.aborted ? { ...before, busy: false } : {
          ...before, state: 'error', busy: false,
          message: error instanceof LlmError && (error.code.startsWith('LOGIN_') || error.code === 'AUTH_STORAGE')
            ? error.message : '连接失败，请检查网络后重试登录。',
        }
      } finally { this.committing = false; this.attempt = undefined; this.running = undefined; this.view = { ...this.view, busy: false } }
    })()
  }

  private connected(): void {
    this.log.write('account.connected')
    this.view = { state: 'connected', configured: true, busy: Boolean(this.running), lastValidatedAt: Date.now(), message: '已连接；登录状态由插件自动管理。' }
  }

  async requireVerification(rejected: WebCredential): Promise<void> {
    if (!(await new LocalStore(dirname(this.file)).rejectCredential(this.file, rejected))) return
    this.cached = undefined
    this.observedCredential = undefined
    this.generation.abort()
    this.generation = new AbortController()
    this.view = { state: 'reauth-required', configured: true, busy: Boolean(this.running), message: 'DeepSeek 已要求重新验证，请点击登录。' }
  }

  /** Called on demand, so idle time never spends chat quota or keeps sessions artificially alive. */
  async credential(signal: AbortSignal): Promise<WebCredential> {
    signal = AbortSignal.any([signal, this.lifetime.signal, this.generation.signal])
    signal.throwIfAborted()
    if (this.forgetting) throw new LlmError('正在退出本插件。', 'AUTH')
    const credential = await new LocalStore(dirname(this.file)).credential(this.file)
    this.observedCredential = credential ? digest([credential.token, credential.accountId, credential.epoch]) : undefined
    signal.throwIfAborted()
    if (!credential) {
      if (this.interactive && this.running || this.view.state === 'reauth-required') throw new LlmError('请完成 TokenFree 登录后重试。', 'MISSING_CREDENTIAL')
      if (!this.running) this.start(false)
      await this.wait(signal)
      if (!this.cached || this.view.state !== 'connected') throw new LlmError('请在 DSH 设置 → TokenFree 中点击登录。', 'MISSING_CREDENTIAL')
      return this.cached
    }
    if (this.cached?.token === credential.token && this.cached.epoch === credential.epoch && Date.now() - (this.view.lastValidatedAt ?? 0) < 600_000) return { ...credential, accountId: this.cached.accountId }
    try {
      this.log.write('account.validating', { phase: 'verify' })
      await this.check(credential, AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(20_000)]))
      signal.throwIfAborted()
      const current = await new LocalStore(dirname(this.file)).credential(this.file)
      if (current?.epoch !== credential.epoch || current?.token !== credential.token) throw new LlmError('登录状态已变化，请重试本次请求。', 'ABORTED')
      this.cached = credential
      this.connected()
      return credential
    } catch (error) {
      if (signal.aborted) throw new LlmError('操作已取消。', 'ABORTED')
      if (!(error instanceof LlmError) || error.code !== 'AUTH') {
        throw error
      }
      return this.recover(credential, signal)
    }
  }

  /** Try the plugin-owned profile once; human verification opens only after an explicit login click. */
  async recover(rejected: WebCredential, signal: AbortSignal): Promise<WebCredential> {
    signal.throwIfAborted()
    const current = await new LocalStore(dirname(this.file)).credential(this.file)
    if (current?.epoch !== rejected.epoch || current?.token !== rejected.token) throw new LlmError('登录状态已变化，请重试本次请求。', 'ABORTED')
    if (!this.running) this.start(false)
    await this.wait(signal)
    if (this.cached && this.cached.token !== rejected.token && this.view.state === 'connected') return this.cached
    await this.requireVerification(rejected)
    throw new LlmError(this.view.message, 'AUTH')
  }

  async restore(): Promise<AccountStatus> {
    if (this.forgetting) return this.status()
    if (!this.running) {
      try { await this.credential(this.lifetime.signal) } catch {
        // Only sanitized status crosses to the settings page.
        if (this.view.state === 'signed-out') return this.status()
      }
    }
    return this.status()
  }

  async cancel(): Promise<AccountStatus> {
    if (!this.committing) this.attempt?.abort()
    await this.browser.close()
    await this.running
    return this.status()
  }

  /** Forget only this plugin's local login. Does not revoke other browser/device sessions. */
  async logout(): Promise<AccountStatus> {
    if (this.forgetting) return this.forgetting
    this.forgetting = (async () => {
      this.log.write('account.logout')
      this.generation.abort()
      try {
        await new LocalStore(dirname(this.file)).forgetLogin(this.file)
        await this.cancel()
        this.view = { ...this.view, busy: true, message: '正在清除本地登录状态…' }
        const release = await acquireLock(join(dirname(this.file), 'locks', 'browser'), AbortSignal.timeout(15_000))
        try { await rm(this.profile, { recursive: true, force: true }) } finally { await release() }
        this.cached = undefined
        this.observedCredential = undefined
        this.generation = new AbortController()
        this.view = { state: 'signed-out', configured: false, busy: false, message: '已退出，已清除本插件凭据和专用窗口的登录数据。日常浏览器不受影响。' }
      } catch {
        this.view = { ...this.view, state: 'error', busy: false, message: '未能清除本地登录状态，请重试退出。' }
        throw new LlmError(this.view.message, 'AUTH_STORAGE')
      } finally { this.forgetting = undefined }
      return this.status()
    })()
    return this.forgetting
  }

  private async wait(signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    await new Promise<void>((resolve, reject) => {
      const abort = () => { signal.removeEventListener('abort', abort); reject(new LlmError('操作已取消。', 'ABORTED')) }
      signal.addEventListener('abort', abort, { once: true })
      void this.running!.then(() => { signal.removeEventListener('abort', abort); resolve() }, reject)
      if (signal.aborted) abort()
    })
  }

  async dispose(): Promise<void> {
    this.lifetime.abort()
    this.generation.abort()
    await this.cancel()
    await this.log.flush()
  }
}
