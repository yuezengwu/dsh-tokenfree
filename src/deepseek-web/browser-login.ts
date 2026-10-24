import { mkdir, chmod, lstat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { BrowserContext } from 'playwright-core'
import { TokenFreeError as LlmError } from '../core/errors.js'
import { normalizeCredential } from '../local/auth.js'
import type { WebCredential } from '../local/auth.js'
import { DeepSeekWebClient } from './client.js'
import { LocalDiagnostics, failureCategory } from '../local/diagnostics.js'
import { acquireLock } from '../local/lock.js'
import { LocalStore } from '../local/store.js'

const ORIGIN = 'https://chat.deepseek.com'
type LoginPhase = 'launch' | 'navigate' | 'read' | 'verify'

/** Playwright can lose an execution context during the normal sign-in redirect. */
export function isNavigationTransition(error: unknown): boolean {
  const message = error instanceof Error ? error.message : ''
  return /execution context was destroyed|cannot find context with specified id|most likely because of a navigation|frame was detached|interrupted by another navigation|net::ERR_ABORTED/i.test(message)
}

function loginFailure(error: unknown, phase: LoginPhase): LlmError {
  const message = error instanceof Error ? error.message : ''
  if (phase === 'launch' && /singleton|processsingleton|profile.*in use/i.test(message)) {
    return new LlmError('插件登录目录正被另一个 TokenFree 窗口使用。请关闭该窗口后重试。 [LOGIN_PROFILE_BUSY]', 'LOGIN_PROFILE_BUSY')
  }
  if (phase === 'launch' && /executable.*doesn.t exist|distribution.*not found|ENOENT/i.test(message)) {
    return new LlmError('未找到已安装的 Google Chrome。 [LOGIN_CHROME_MISSING]', 'LOGIN_CHROME_MISSING')
  }
  if (phase === 'verify') return new LlmError('网页登录结果已获取，但连接验证未完成。请检查网络后重试，无需重新输入账号。 [LOGIN_VERIFY_NETWORK]', 'LOGIN_VERIFY_NETWORK')
  if (phase === 'navigate') return new LlmError('无法加载 DeepSeek 官方登录页，请检查网络。 [LOGIN_PAGE_NETWORK]', 'LOGIN_PAGE_NETWORK')
  if (phase === 'read') return new LlmError('未能读取官方页面的登录结果。请重试连接。 [LOGIN_RESULT_READ]', 'LOGIN_RESULT_READ')
  return new LlmError('无法启动插件的 Chrome 登录窗口。 [LOGIN_BROWSER]', 'LOGIN_BROWSER')
}

export interface LoginRequest {
  interactive: boolean
  signal: AbortSignal
  epoch?: number
}
export interface BrowserLogin {
  obtain(request: LoginRequest): Promise<WebCredential | undefined>
  close(): Promise<void>
}
interface BrowserDependencies {
  launch?: typeof import('playwright-core').chromium.launchPersistentContext
  check?: (credential: WebCredential, signal: AbortSignal) => Promise<void>
  diagnostics?: LocalDiagnostics
}

/** Owns a separate Chrome profile, controlled through a pipe, never the user's daily browser. */
export class ManagedBrowserLogin implements BrowserLogin {
  private context?: BrowserContext
  private readonly log: LocalDiagnostics
  private operationId = ''
  private startedAt = 0
  constructor(private readonly profile: string, private readonly dependencies: BrowserDependencies = {}) {
    this.log = dependencies.diagnostics ?? new LocalDiagnostics(dirname(profile))
  }

  private async diagnostic(event: 'started' | 'waiting' | 'authorized' | 'failed' | 'closed' | 'timed-out' | 'cancelled', phase: LoginPhase, code?: string): Promise<void> {
    this.log.write(`login.${event}`, { phase, code, operationId: this.operationId, elapsedMs: Date.now() - this.startedAt })
    // Fixed categories only: never save raw errors, URLs, tokens, cookies, or page content.
    await writeFile(join(dirname(this.profile), 'login-status.json'), JSON.stringify({
      at: new Date().toISOString(), event, phase, ...(code ? { code } : {}),
    }) + '\n', { mode: 0o600 }).catch(() => {})
  }

  async obtain({ interactive, signal: input, epoch }: LoginRequest): Promise<WebCredential | undefined> {
    input.throwIfAborted()
    const revoked = new AbortController()
    const signal = AbortSignal.any([input, revoked.signal])
    this.operationId = randomUUID()
    this.startedAt = Date.now()
    if (!interactive) {
      try { await lstat(this.profile) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
        throw new LlmError('无法读取本地登录状态。', 'AUTH_STORAGE')
      }
    }
    const release = await acquireLock(join(dirname(this.profile), 'locks', 'browser'), AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
    let polling = false, finished = false
    const watch = epoch === undefined ? undefined : setInterval(() => {
      if (polling || finished) return
      polling = true
      void new LocalStore(dirname(this.profile)).account().then(account => {
        if (!finished && account.epoch !== epoch) revoked.abort(new LlmError('登录已被其他入口撤销，请重新登录。 [LOGIN_REVOKED]', 'LOGIN_REVOKED'))
      }).catch(() => {
        if (!finished) revoked.abort(new LlmError('无法核实本机登录状态。', 'AUTH_STORAGE'))
      }).finally(() => { polling = false })
    }, 200)
    try {
      await mkdir(this.profile, { recursive: true, mode: 0o700 })
      const stat = await lstat(this.profile)
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LlmError('登录目录必须是本机普通目录。', 'AUTH_STORAGE')
      await chmod(this.profile, 0o700)
      const { chromium } = await import('playwright-core')
      // Playwright's default Chromium transport is --remote-debugging-pipe. Do not
      // use launchServer, connectOverCDP, or a remote-debugging-port here.
      const env = { ...process.env }
      delete env.DEBUG; delete env.PWDEBUG
      const abort = () => { void this.close() }
      signal.addEventListener('abort', abort, { once: true })
      let phase: LoginPhase = 'launch'
      try {
        signal.throwIfAborted()
        if (epoch !== undefined && (await new LocalStore(dirname(this.profile)).account()).epoch !== epoch) {
          throw new LlmError('登录已被其他入口撤销，请重新登录。 [LOGIN_REVOKED]', 'LOGIN_REVOKED')
        }
        await this.diagnostic('started', phase)
        this.context = await (this.dependencies.launch ?? chromium.launchPersistentContext.bind(chromium))(this.profile, {
          channel: 'chrome', headless: !interactive, chromiumSandbox: true,
          viewport: { width: 960, height: 760 }, acceptDownloads: false,
          ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
          env, timeout: 30_000,
        })
        signal.throwIfAborted()
        const page = this.context.pages()[0] ?? await this.context.newPage()
        phase = 'navigate'
        await this.diagnostic('waiting', phase)
        try { await page.goto(`${ORIGIN}/${interactive ? 'sign_in' : ''}`, { waitUntil: 'domcontentloaded', timeout: 30_000 }) }
        catch (error) {
          if (!isNavigationTransition(error)) throw error
          this.log.write('login.transition', { phase, operationId: this.operationId, ...failureCategory(error) })
        }
        if (interactive && !page.isClosed()) await page.bringToFront()
        await this.diagnostic('waiting', 'read')
        const deadline = Date.now() + (interactive ? 300_000 : 12_000)
        let checked = ''
        while (!signal.aborted && this.context && this.context.pages().some(candidate => !candidate.isClosed()) && Date.now() < deadline) {
          for (const candidate of this.context.pages()) {
            if (candidate.isClosed() || new URL(candidate.url()).origin !== ORIGIN) continue
            phase = 'read'
            // This reads only our plugin-owned official page. No credentials are
            // exposed to the DSH renderer, clipboard, DevTools, or diagnostics.
            let token: string | null
            try { token = await candidate.evaluate(() => {
              try {
                const entry: unknown = JSON.parse(localStorage.getItem('userToken') ?? 'null')
                return entry && typeof entry === 'object' && 'value' in entry && typeof entry.value === 'string' ? entry.value : null
              } catch { return null }
            }) } catch (error) {
              if (isNavigationTransition(error) || candidate.isClosed()) {
                this.log.write('login.transition', { phase, operationId: this.operationId, ...failureCategory(error) })
                continue
              }
              throw error
            }
            if (token && token !== checked) {
              checked = token
              const cookies = await this.context.cookies(`${ORIGIN}/api/v0/users/current`)
              const cookie = cookies.map(item => `${item.name}=${item.value}`).join('; ')
              const credential = normalizeCredential({ token, ...(cookie ? { cookie } : {}) })
              try {
                phase = 'verify'
                await this.diagnostic('waiting', phase)
                const check = this.dependencies.check ?? ((value, checkSignal) => new DeepSeekWebClient(value, { diagnostics: this.log, operationId: this.operationId }).check(checkSignal))
                await check(credential, AbortSignal.any([signal, AbortSignal.timeout(15_000)]))
                await this.diagnostic('authorized', phase)
                return credential
              } catch (error) {
                if (!(error instanceof LlmError) || error.code !== 'AUTH') throw error
                // The official page may replace a stale token while restoring.
              }
            }
          }
          await new Promise<void>(resolve => {
            const done = () => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve() }
            const timer = setTimeout(done, 750)
            signal.addEventListener('abort', done, { once: true })
            if (signal.aborted) done()
          })
        }
        signal.throwIfAborted()
        await this.diagnostic(Date.now() >= deadline ? 'timed-out' : 'closed', phase)
        return undefined
      } catch (error) {
        this.log.write('login.failed', { phase, operationId: this.operationId, elapsedMs: Date.now() - this.startedAt, ...failureCategory(error) })
        if (signal.aborted) {
          if (revoked.signal.aborted && revoked.signal.reason instanceof LlmError) {
            await this.diagnostic('failed', phase, revoked.signal.reason.code)
            throw revoked.signal.reason
          }
          await this.diagnostic('cancelled', phase, 'ABORTED')
          throw new LlmError('登录已取消。', 'ABORTED')
        }
        if (error instanceof LlmError) { await this.diagnostic('failed', phase, error.code); throw error }
        // Browser errors may include page contents or profile details.
        const failure = loginFailure(error, phase)
        await this.diagnostic('failed', phase, failure.code)
        throw failure
      } finally {
        signal.removeEventListener('abort', abort)
        await this.close()
        await this.log.flush()
      }
    } finally {
      finished = true
      if (watch) clearInterval(watch)
      await release()
    }
  }

  async close(): Promise<void> {
    const context = this.context
    this.context = undefined
    await context?.close().catch(() => {})
  }
}
