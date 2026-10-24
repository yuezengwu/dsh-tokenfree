import { readdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { privateDirectory, readJson, writeJson } from './files.js'
import { TokenFreeError } from '../core/errors.js'

interface Ticket { pid: number; id: string; choosing: boolean; order: number }
const alive = (pid: number) => {
  try { process.kill(pid, 0); return true }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH' }
}

/** Local-file bakery queue: never expires a live owner or deletes another owner's reused lock path. */
export async function acquireLock(directory: string, signal: AbortSignal, wait = true): Promise<() => Promise<void>> {
  signal.throwIfAborted()
  await privateDirectory(directory)
  const own: Ticket = { pid: process.pid, id: randomUUID(), choosing: true, order: 0 }
  const path = join(directory, `${own.id}.json`)
  const tickets = async () => {
    const entries: { path: string; ticket: Ticket }[] = []
    for (const name of await readdir(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue
      const file = join(directory, name)
      const ticket = await readJson<Ticket>(file)
      if (!ticket) continue
      if (!Number.isSafeInteger(ticket.pid) || ticket.pid < 1 || ticket.id !== name.slice(0, -5)
        || typeof ticket.choosing !== 'boolean' || !Number.isSafeInteger(ticket.order) || ticket.order < 0) {
        throw new TokenFreeError('Lock state is invalid; no ownership was assumed.', 'STATE_STORAGE')
      }
      entries.push({ path: file, ticket })
    }
    return entries
  }
  try {
    await writeJson(path, own)
    own.order = 1 + Math.max(0, ...(await tickets()).filter(x => alive(x.ticket.pid)).map(x => x.ticket.order))
    if (!Number.isSafeInteger(own.order)) throw new TokenFreeError('Lock queue exhausted.', 'STATE_STORAGE')
    own.choosing = false
    await writeJson(path, own)
    for (;;) {
      signal.throwIfAborted()
      const others = await tickets()
      const blocked = others.some(({ ticket: other }) => other.id !== own.id && alive(other.pid)
        && (other.choosing || other.order < own.order || (other.order === own.order && other.id < own.id)))
      if (!blocked) {
        // UUID ticket names are never reused. Remove only known-dead process registrations after admission.
        for (const item of others) if (item.ticket.id !== own.id && !alive(item.ticket.pid)) await rm(item.path, { force: true })
        return async () => { await rm(path, { force: true }) }
      }
      if (!wait) throw new TokenFreeError('This session is busy in another operation.', 'SESSION_BUSY')
      await delay(30, undefined, { signal })
    }
  } catch (error) { await rm(path, { force: true }); throw error }
}
