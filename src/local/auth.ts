import { readFile, mkdir, open, rename, chmod, lstat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TokenFreeError as LlmError } from '../core/errors.js'

export interface WebCredential { epoch?: number; token: string; cookie?: string; accountId?: string }
export const defaultHome = () => process.env.DSH_TOKENFREE_HOME || join(homedir(), '.dsh-tokenfree')
export const defaultCredentialFile = () => join(defaultHome(), 'credentials.json')

/** Accept only one credential; errors never include credential material. */
export function normalizeCredential(value: unknown): WebCredential {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LlmError('Expected a single Web credential.', 'INVALID_CREDENTIAL')
  const record = value as Record<string, unknown>
  if (typeof record.token !== 'string') throw new LlmError('Missing DeepSeek Web token.', 'MISSING_CREDENTIAL')
  const token = record.token.trim().replace(/^Bearer\s+/i, '')
  if (!/^[\x21-\x7e]+$/.test(token)) throw new LlmError('Invalid DeepSeek Web token. Import the raw token again.', 'INVALID_CREDENTIAL')
  if (record.cookie !== undefined && (typeof record.cookie !== 'string' || !/^[\x20-\x7e]*$/.test(record.cookie))) {
    throw new LlmError('Invalid Web cookie.', 'INVALID_CREDENTIAL')
  }
  if (record.accountId !== undefined && (typeof record.accountId !== 'string' || !record.accountId.length || record.accountId.length > 256)) throw new LlmError('Invalid account identity.', 'INVALID_CREDENTIAL')
  return { token, ...(record.cookie ? { cookie: String(record.cookie) } : {}), ...(record.accountId ? { accountId: String(record.accountId) } : {}) }
}

export async function readCredential(file = defaultCredentialFile()): Promise<WebCredential | undefined> {
  let text: string
  try {
    const stat = await lstat(file)
    if (!stat.isFile() || stat.isSymbolicLink()) throw new LlmError('Credential path must be a regular file.', 'INVALID_CREDENTIAL')
    if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) throw new LlmError('Credential file permissions must be 0600.', 'INVALID_CREDENTIAL')
    text = await readFile(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error instanceof LlmError ? error : new LlmError('Cannot read the local Web credential.', 'INVALID_CREDENTIAL')
  }
  try { return normalizeCredential(JSON.parse(text)) }
  catch { throw new LlmError('Invalid credential file. Run dsh-tokenfree auth again.', 'INVALID_CREDENTIAL') }
}

export async function saveCredential(value: unknown, file = defaultCredentialFile()): Promise<void> {
  const credential = normalizeCredential(value)
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = join(dirname(file), `.credential-${randomUUID()}`)
  const handle = await open(temp, 'wx', 0o600)
  try { await handle.writeFile(JSON.stringify({ version: 1, ...credential }) + '\n'); await handle.sync() }
  finally { await handle.close() }
  await rename(temp, file)
  await chmod(file, 0o600)
}

export async function resolveCredential(file = defaultCredentialFile()): Promise<WebCredential> {
  if (process.env.DEEPSEEK_WEB_TOKEN?.trim()) return normalizeCredential({ token: process.env.DEEPSEEK_WEB_TOKEN })
  const credential = await readCredential(file)
  if (!credential) throw new LlmError('请在 DSH 设置 → TokenFree 中点击登录。', 'MISSING_CREDENTIAL')
  return credential
}
