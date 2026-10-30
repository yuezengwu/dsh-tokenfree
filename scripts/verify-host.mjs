import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, isAbsolute } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const source = process.env.DSH_SOURCE_DIR
const install = process.env.DSH_TOKENFREE_INSTALL_SPEC
assert(source && isAbsolute(source), 'Set DSH_SOURCE_DIR to an exact supported source checkout')
assert(install, 'Set DSH_TOKENFREE_INSTALL_SPEC to the same built package for every host')
const inventory = JSON.parse(readFileSync(join(root, 'scripts/dsh-hosts.json'), 'utf8'))
const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
const host = inventory.hosts.find(host => host.version === manifest.version)
assert(host, `Unverified DSH source version: ${manifest.version}`)
const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim()
assert.equal(sha, host.sha, 'Host source must match its exact inventory SHA')
const temporary = mkdtempSync(join(tmpdir(), 'tokenfree-host-'))
const env = { ...process.env, DSH_HOME: join(temporary, 'home'), DSH_AGENTS_HOME: join(temporary, 'agents'), DSH_TELEMETRY_DISABLED: '1' }
for (const name of Object.keys(env)) if (/(?:API_KEY|TOKEN|SECRET|PASSWORD|COOKIE)/i.test(name)) delete env[name]
const cli = ['--import', 'tsx/esm', join(source, 'apps/cli/src/bin.ts')]
const run = args => {
  const result = spawnSync(process.execPath, [...cli, ...args], { cwd: source, env, encoding: 'utf8', timeout: 180_000, maxBuffer: 4_000_000 })
  if (result.status !== 0) throw new Error(`Isolated DSH command failed (${result.status}): ${result.stderr}\n${result.stdout}`)
  return result.stdout
}
for (const profile of ['web', 'headless']) run(['plugin', '--profile', profile, 'add', install])
assert(run(['--profile', 'web', '--dump-config']).includes('dsh-tokenfree'), 'Web composition must include the package')
const resultFile = join(temporary, 'result.json')
const probeFile = join(temporary, 'probe.mjs')
const guardFile = join(temporary, 'no-network.mjs')
writeFileSync(guardFile, "globalThis.fetch = async () => { throw new Error('Network is forbidden in the keyless host probe') }\n")
writeFileSync(probeFile, `
import { writeFileSync } from 'node:fs'
import assert from 'node:assert/strict'
export const inject = ['llm', 'agentLoop', 'tokenfree']
export function apply(ctx) {
  const timer = setTimeout(async () => {
    try {
      await ctx.loader.await()
      let calls = 0
      ctx.on('llm/stream', () => { calls++; throw new Error('Model calls are forbidden in this probe') })
      assert(ctx.llm.listProviders().some(row => row.id === 'tokenfree-deepseek-web'))
      assert((await ctx.llm.listModels('tokenfree-deepseek-web')).some(row => row.id === 'web-default'))
      const agent = await ctx.agentLoop.create('tokenfree-keyless-host-probe', { provider: 'tokenfree-deepseek-web', model: 'web-default' })
      const engine = ctx.get('agentPresets')?.serviceFor(agent, 'compaction') ?? agent.ctx.get('compaction')
      assert.equal(engine?.constructor.name, 'TokenFreeCompactionEngine')
      assert.equal(engine.config.auto, true)
      const policy = engine.config.modelPolicies.find(row => row.provider === 'tokenfree-deepseek-web' && row.model === 'web-default')
      assert.equal(policy.retainTokens, 0)
      assert.equal(policy.compactionRetries, 0)
      assert.equal(calls, 0)
      writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ provider: true, model: true, engine: engine.constructor.name, auto: engine.config.auto, preset: ctx.get('agentPresets')?.defaultId ?? null, policy, modelCalls: calls }))
      ctx.get('appExit')(0)
    } catch (error) { console.error(error); ctx.get('appExit')(1) }
  }, 0)
  ctx.effect(() => () => clearTimeout(timer))
}
`)
const overlay = join(temporary, 'probe.yml')
writeFileSync(overlay, `- id: headless-runner\n  disabled: true\n- id: dsh-tokenfree\n  config:\n    credentialFile: ${JSON.stringify(join(temporary, 'empty-account', 'credentials.json'))}\n    logContent: false\n- insert:\n    - id: tokenfree-keyless-probe\n      name: ${JSON.stringify(probeFile)}\n`)
const actual = spawnSync(process.execPath, ['--import', guardFile, ...cli, '--profile', 'headless', '--patch', overlay, 'keyless probe only'], { cwd: source, env, encoding: 'utf8', timeout: 45_000, maxBuffer: 4_000_000 })
if (actual.status !== 0 || !existsSync(resultFile)) throw new Error(`Keyless host probe failed (${actual.status}): ${actual.stderr}\n${actual.stdout}`)
const result = { version: host.version, sha, installSpec: install, webComposition: true, ...JSON.parse(readFileSync(resultFile, 'utf8')) }
if (process.env.DSH_TOKENFREE_PROBE_RESULT) writeFileSync(process.env.DSH_TOKENFREE_PROBE_RESULT, JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
