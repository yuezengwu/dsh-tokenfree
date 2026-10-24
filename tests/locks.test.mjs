import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, writeFile, stat, symlink, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { once } from 'node:events'
import { LocalStore } from '../lib/local/store.js'
import { readJson, writeJson } from '../lib/local/files.js'
import { acquireLock } from '../lib/local/lock.js'

const lockURL = new URL('../lib/local/lock.js', import.meta.url).href
const child = (path, text) => spawn(process.execPath, ['--input-type=module', '-e', `import { acquireLock } from ${JSON.stringify(lockURL)}; import { appendFile } from 'node:fs/promises'; const release=await acquireLock(process.argv[1],AbortSignal.timeout(10000)); ${text}`, path], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })

test('short shared-state locks serialize writes; cancellation and dead owner recovery preserve successors', { timeout: 15000 }, async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-lock-')), path = join(home, 'queue'), events = join(home, 'events')
  let first
  try {
    first = child(path, "process.send('acquired'); await new Promise(()=>{setInterval(()=>{},1000)})")
    assert.deepEqual((await once(first, 'message'))[0], 'acquired')
    const cancel = new AbortController(), queued = acquireLock(path, cancel.signal)
    cancel.abort(); await assert.rejects(queued)
    first.kill('SIGKILL'); await once(first, 'exit')
    const workers = Array.from({ length: 4 }, (_, i) => child(path, `await appendFile(${JSON.stringify(events)},'start${i}\\n'); await new Promise(r=>setTimeout(r,40)); await appendFile(${JSON.stringify(events)},'end${i}\\n'); await release(); process.disconnect()`))
    const results = await Promise.all(workers.map(async p => { const [code] = await once(p, 'exit'); return code }))
    assert.deepEqual(results, [0, 0, 0, 0])
    const rows = (await readFile(events, 'utf8')).trim().split('\n')
    assert.equal(rows.length, 8)
    for (let i = 0; i < rows.length; i += 2) assert.equal(rows[i].slice(5), rows[i + 1].slice(3))
    assert.deepEqual(await readdir(path), [])
  } finally { first?.kill('SIGKILL'); await rm(home, { recursive: true, force: true }) }
})

test('state is versioned, private and atomic; damaged or symlinked state is preserved and refused', async () => {
  const home = await mkdtemp(join(tmpdir(), 'tokenfree-state-'))
  try {
    const store = new LocalStore(home); await store.revoke()
    assert.equal((await store.account()).epoch, 1)
    assert.equal((await stat(join(home, 'account.json'))).mode & 0o777, 0o600)
    await writeFile(join(home, 'account.json'), '{"schemaVersion":99}', { mode: 0o600 })
    await assert.rejects(store.account(), error => error.code === 'STATE_STORAGE')
    assert.equal(await readFile(join(home, 'account.json'), 'utf8'), '{"schemaVersion":99}')
    const target = join(home, 'safe.json'); await writeJson(target, { fixture: true })
    const link = join(home, 'link.json'); await symlink(target, link)
    await assert.rejects(readJson(link), error => error.code === 'STATE_STORAGE')
    await rm(join(home, 'sessions'), { recursive: true }); await symlink(home, join(home, 'sessions'))
    await assert.rejects(store.account(), error => error.code === 'STATE_STORAGE')
  } finally { await rm(home, { recursive: true, force: true }) }
})
