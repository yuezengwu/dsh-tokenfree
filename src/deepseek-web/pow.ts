import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import { TokenFreeError as LlmError } from '../core/errors.js'
import { writePrivateFile } from '../local/files.js'
import { defaultHome } from '../local/auth.js'

// Asset loaded by the official Chat frontend on 2026-10-20. Never execute a downloaded JS bundle.
export const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
export const WASM_SHA256 = 'b3fca8cc072c1defbd60c02266a8e48bd307a1804aaff4314900aea720e72f7d'
export interface Challenge { algorithm: string; challenge: string; salt: string; signature: string; difficulty: number; expire_at: number; target_path?: string }

export function parseChallenge(value: unknown): Challenge {
  if (!value || typeof value !== 'object') throw new LlmError('Missing Web proof-of-work challenge.', 'WEB_PROTOCOL')
  const v = value as Record<string, unknown>
  if (v.algorithm !== 'DeepSeekHashV1' || !['challenge', 'salt', 'signature'].every(k => typeof v[k] === 'string' && v[k].length > 0)
    || typeof v.difficulty !== 'number' || !Number.isFinite(v.difficulty) || v.difficulty <= 0 || v.difficulty > 10_000_000
    || typeof v.expire_at !== 'number' || !Number.isFinite(v.expire_at)) throw new LlmError('Unsupported Web proof-of-work challenge.', 'WEB_PROTOCOL')
  return v as unknown as Challenge
}

export async function loadWasm(signal?: AbortSignal, dependencies: { path?: string; fetch?: typeof fetch } = {}): Promise<Uint8Array> {
  const path = dependencies.path ?? join(defaultHome(), 'cache', 'sha3.wasm')
  let bytes: Uint8Array | undefined
  try { bytes = await readFile(path) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new LlmError('Cannot read the proof-of-work cache.', 'POW_ASSET') }
  const valid = (data: Uint8Array) => createHash('sha256').update(data).digest('hex') === WASM_SHA256
  if (bytes && !valid(bytes)) throw new LlmError('Proof-of-work asset checksum mismatch. Remove the local cache and retry.', 'POW_ASSET')
  if (!bytes) {
    const response = await (dependencies.fetch ?? fetch)(WASM_URL, { signal, redirect: 'error' })
    if (!response.ok) throw new LlmError('Cannot download the official proof-of-work asset.', 'POW_ASSET')
    bytes = new Uint8Array(await response.arrayBuffer())
    if (!valid(bytes)) throw new LlmError('Official proof-of-work asset checksum mismatch.', 'POW_ASSET')
    signal?.throwIfAborted()
    await writePrivateFile(path, bytes)
  }
  return bytes
}

export async function solveChallenge(challenge: Challenge, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted()
  const bytes = await loadWasm(signal)
  const answer = await new Promise<number>((resolve, reject) => {
    const worker = new Worker(new URL('./pow-worker.js', import.meta.url), { workerData: { bytes, challenge }, execArgv: [] })
    let settled = false
    const finish = (error?: Error, value?: number) => {
      if (settled) return
      settled = true
      clearTimeout(timer); signal.removeEventListener('abort', abort)
      void worker.terminate()
      error ? reject(error) : resolve(value!)
    }
    const abort = () => finish(new LlmError('Web request cancelled.', 'ABORTED'))
    const timer = setTimeout(() => finish(new LlmError('Web proof-of-work timed out.', 'TIMEOUT')), 30_000)
    worker.once('message', value => typeof value.answer === 'number' ? finish(undefined, value.answer) : finish(new LlmError('Web proof-of-work failed.', 'POW_FAILED')))
    worker.once('error', () => finish(new LlmError('Web proof-of-work worker failed.', 'POW_FAILED')))
    worker.once('exit', code => { if (code !== 0) finish(new LlmError('Web proof-of-work worker stopped.', 'POW_FAILED')) })
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
  })
  return Buffer.from(JSON.stringify({ algorithm: challenge.algorithm, challenge: challenge.challenge, salt: challenge.salt, answer,
    signature: challenge.signature, target_path: '/api/v0/chat/completion' })).toString('base64')
}
