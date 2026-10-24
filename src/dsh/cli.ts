#!/usr/bin/env node
import { randomUUID } from 'node:crypto'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { MessageId, LlmError } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, ContentBlock, ToolCallBlock } from '@deepseek-ai/dsh-llm'
import { LocalStore } from '../local/store.js'
import { dirname } from 'node:path'
import { resolveCredential, defaultCredentialFile, normalizeCredential } from '../local/auth.js'
import { DeepSeekWebClient } from '../deepseek-web/client.js'
import { PROVIDER, MODEL, apply } from './index.js'
import { TokenFreeError } from '../core/errors.js'
import { TokenFreeAdapter } from './adapter.js'
import { LocalAccount } from '../core/account.js'
import { readFile } from 'node:fs/promises'
import { strictJson } from '../core/json.js'
import type { SessionPolicy } from '../core/types.js'

async function hiddenInput(): Promise<string> {
  if (!process.stdin.isTTY) throw new Error('Use auth --stdin when piping a credential.')
  process.stdout.write('DeepSeek Web token（隐藏输入，回车保存）: ')
  process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.setEncoding('utf8')
  return new Promise((resolve, reject) => {
    let value = ''
    const finish = () => { process.stdin.off('data', read); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n') }
    const read = (chunk: string) => {
      for (const char of chunk) {
        if (char === '\u0003') { finish(); reject(new Error('Cancelled.')); return }
        if (char === '\r' || char === '\n') { finish(); resolve(value); return }
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1)
        else if (char >= ' ' && char !== '\u001b') value += char
      }
    }
    process.stdin.on('data', read)
  })
}

async function auth(): Promise<void> {
  let value: unknown
  if (process.argv.includes('--stdin')) {
    let input = ''
    for await (const chunk of process.stdin) {
      input += chunk.toString()
      if (input.length > 65536) throw new Error('Credential input too large.')
    }
    try { value = JSON.parse(input) } catch { value = { token: input } }
  } else value = { token: await hiddenInput() }
  const credential = normalizeCredential(value)
  await new DeepSeekWebClient(credential).check(AbortSignal.timeout(20_000))
  const store = new LocalStore(dirname(defaultCredentialFile()))
  await store.saveLogin(defaultCredentialFile(), credential, (await store.account()).epoch)
  console.log(`Web 登录已验证并保存在本机（0600）：${defaultCredentialFile()}`)
}

async function smoke(tools: boolean): Promise<void> {
  const ctx = new Context()
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin({ name: 'dsh-tokenfree', inject: ['llm'], apply })
    const options: GenerateOptions = {
      provider: PROVIDER, model: MODEL,
      messages: [{ role: 'user', content: [{ type: 'text', text: tools ? '必须先调用 tokenfree_test_nonce 工具取得随机口令，再仅输出工具返回的口令。不要猜测。' : '请只回答 TOKENFREE_OK' }] }],
      ...(tools ? { tools: [{ name: 'tokenfree_test_nonce', description: '取得本地生成的随机口令。必须调用此工具才能知道口令。', parameters: { type: 'object', properties: {}, additionalProperties: false } }] } : {}),
    }
    const run = async () => {
      const blocks: ContentBlock[] = []
      for await (const chunk of ctx.llm.stream(options)) {
        if (chunk.type === 'block-end') blocks.push(chunk.block)
        if (chunk.type === 'finish' && (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted')) throw new LlmError(chunk.reason.failure.message, chunk.reason.failure.code)
      }
      return blocks
    }
    const first = await run()
    if (!tools) {
      const answer = first.filter(b => b.type === 'text').map(b => b.text).join('').trim()
      if (answer !== 'TOKENFREE_OK') throw new Error('Text smoke response did not match the requested marker.')
      console.log('PASS: 真实 DeepSeek Web → DSH LlmRuntime → 文本回答。'); return
    }
    const calls = first.filter((b): b is ToolCallBlock => b.type === 'tool-call')
    if (calls.length !== 1 || calls[0]!.name !== 'tokenfree_test_nonce' || calls[0]!.arguments !== '{}') throw new Error('Tool smoke did not produce the required tool call.')
    const nonce = randomUUID()
    options.messages.push({ id: MessageId(randomUUID()), role: 'assistant', source: { kind: 'model', provider: PROVIDER, model: MODEL }, content: first })
    options.messages.push({ id: MessageId(randomUUID()), role: 'tool', source: { kind: 'tool', callId: calls[0]!.id }, toolCallId: calls[0]!.id, content: [{ type: 'text', text: nonce }] })
    const second = await run()
    const answer = second.filter(b => b.type === 'text').map(b => b.text).join('').trim()
    if (second.some(b => b.type === 'tool-call') || answer !== nonce) throw new Error('Tool result round-trip did not return the actual random result.')
    console.log('PASS: 真实 DeepSeek Web → DSH 工具请求 → 本地随机结果 → 第二轮最终回答。')
  } finally { await ctx.fiber.dispose() }
}

async function main(): Promise<void> {
  const command = process.argv[2]
  if (command === 'policy') {
    const id = process.argv[3], file = process.argv[4]
    if (!id || id.length > 512) throw new TokenFreeError('Usage: dsh-tokenfree policy <sessionId> [settings.json]', 'INVALID_POLICY')
    const adapter = new TokenFreeAdapter()
    try { console.log(JSON.stringify(file ? await adapter.setPolicy(id, strictJson(await readFile(file, 'utf8')) as SessionPolicy) : await adapter.policy(id), null, 2)) }
    finally { await adapter.dispose() }
    return
  }
  if (command === 'usage') {
    if (!process.argv[3]) throw new TokenFreeError('Usage: dsh-tokenfree usage <sessionId>', 'NATIVE_CONTEXT')
    const adapter = new TokenFreeAdapter()
    try { console.log(JSON.stringify(await adapter.usage(process.argv[3]), null, 2)) } finally { await adapter.dispose() }
    return
  }
  if (command === 'inspect') {
    const adapter = new TokenFreeAdapter()
    try { console.log(JSON.stringify(process.argv[3] ? await adapter.inspect(process.argv[3]) : await adapter.operationStatus(), null, 2)) }
    finally { await adapter.dispose() }
    return
  }
  if (command === 'rebuild') {
    const sessionId = process.argv[3]
    if (!sessionId) throw new TokenFreeError('Usage: dsh-tokenfree rebuild <sessionId>', 'NATIVE_CONTEXT')
    const adapter = new TokenFreeAdapter()
    try { await adapter.rebuild(sessionId); console.log('已标记：下一轮从 DSH 有效历史重建网页上下文；旧 chat 保留。') }
    finally { await adapter.dispose() }
    return
  }
  if (command === 'login') {
    const account = new LocalAccount()
    const stop = () => { void account.cancel() }
    process.once('SIGINT', stop)
    try {
      console.log(account.login().message)
      while (account.status().busy) await new Promise(resolve => setTimeout(resolve, 500))
      console.log(account.status().message)
      if (account.status().state !== 'connected') process.exitCode = 1
    } finally { process.off('SIGINT', stop); await account.dispose() }
    return
  }
  if (command === 'auth') return auth()
  if (command === 'doctor') {
    await new DeepSeekWebClient(await resolveCredential()).check(AbortSignal.timeout(20_000))
    console.log('PASS: 网页凭据可用；仅验证登录，不代表模型生成或工具调用已通过。'); return
  }
  if (command === 'smoke') return smoke(process.argv.includes('--tools'))
  // readline is not used for credentials; it would echo pasted tokens.
  console.log('dsh-tokenfree policy <sessionId> [settings.json] | usage <sessionId> | inspect [sessionId] | rebuild <sessionId> | login | doctor | smoke [--tools] | auth [--stdin] (advanced)')
}

main().catch(error => {
  // Never print raw fetch errors, response bodies, token values, or stacks.
  console.error((error instanceof LlmError || error instanceof TokenFreeError) ? `${error.code}: ${error.message}` : 'TokenFree operation failed. Check README.md for local setup and authentication.')
  process.exitCode = 1
})
