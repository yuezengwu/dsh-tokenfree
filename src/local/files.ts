import { constants } from 'node:fs'
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TokenFreeError } from '../core/errors.js'

export async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  const stat = await lstat(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new TokenFreeError('Local state must use a private regular directory.', 'STATE_STORAGE')
  await chmod(path, 0o700)
}

export async function readJson<T>(path: string): Promise<T | undefined> {
  let file
  try { file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new TokenFreeError('Cannot open local state safely.', 'STATE_STORAGE')
  }
  try {
    const stat = await file.stat()
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 32 * 1024 * 1024) throw new Error('Invalid state file')
    return JSON.parse(await file.readFile('utf8')) as T
  } catch { throw new TokenFreeError('Local state is damaged or has unsafe permissions; it was preserved.', 'STATE_STORAGE') }
  finally { await file.close() }
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  return writePrivateFile(path, JSON.stringify(value) + '\n')
}

export async function writePrivateFile(path: string, value: string | Uint8Array): Promise<void> {
  await privateDirectory(dirname(path))
  const temporary = join(dirname(path), `.state-${randomUUID()}.tmp`)
  try {
    const file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
    try { await file.writeFile(value); await file.sync() } finally { await file.close() }
    await rename(temporary, path)
    const dir = await open(dirname(path), constants.O_RDONLY)
    try { await dir.sync() } finally { await dir.close() }
  } finally { await rm(temporary, { force: true }) }
}
