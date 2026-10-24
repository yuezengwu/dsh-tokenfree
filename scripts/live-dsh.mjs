import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn, execFileSync } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const source = process.env.DSH_SOURCE_DIR
if (!source) throw new Error('Set DSH_SOURCE_DIR to an explicit DSH 0.2.1-rc.3 source checkout. This opt-in demo sends real model requests.')
const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
if (manifest.version !== '0.2.1-rc.3') throw new Error('This MVP demo requires the verified DSH 0.2.1-rc.3 source checkout.')
await mkdir(join(root, '.local'), { recursive: true, mode: 0o700 })
const workspace = await mkdtemp(join(root, '.local', 'agent-demo-'))
const marker = `TOKENFREE_LIVE_${randomUUID()}\n`
await writeFile(join(workspace, 'marker.txt'), marker)
const patch = (await readFile(join(root, 'examples/headless.overlay.yml'), 'utf8'))
  .replace('name: ../lib/index.js', `name: ${JSON.stringify(join(root, 'lib/index.js'))}`)
  + `\n- id: fs-sandbox\n  config:\n    cwd: ${JSON.stringify(workspace)}\n`
const overlay = join(workspace, 'headless.overlay.yml')
await writeFile(overlay, patch)
const task = '请用工具读取当前工作目录的 marker.txt，把读取到的全部内容原样写入当前工作目录的 answer.txt。必须先读取，禁止猜测。不要修改其他文件。完成后仅回复 TOKENFREE_AGENT_OK。'
const child = spawn('pnpm', ['dsh', '--profile', 'headless', '--patch', overlay, task], {
  cwd: source, env: { ...process.env, DSH_HOME: join(root, '.local/dsh-home') }, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
const collect = data => { log += data.toString(); if (log.length > 5_000_000) child.kill('SIGTERM') }
child.stdout.on('data', collect); child.stderr.on('data', collect)
const timer = setTimeout(() => child.kill('SIGTERM'), 300_000)
const exitCode = await new Promise((done, reject) => { child.once('error', reject); child.once('exit', done) }).finally(() => clearTimeout(timer))
await writeFile(join(workspace, 'run.log'), log, { mode: 0o600 })
const answer = await readFile(join(workspace, 'answer.txt'), 'utf8').catch(() => null)
const passed = exitCode === 0 && answer === marker && log.includes('TOKENFREE_AGENT_OK')
const result = { passed, testedAt: new Date().toISOString(), sourceVersion: manifest.version,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(),
  provider: 'tokenfree-deepseek-web', model: 'web-default', exitCode, byteMatch: answer === marker, workspace }
await writeFile(join(root, '.local/latest-demo.json'), JSON.stringify(result, null, 2) + '\n')
console.log(JSON.stringify(result, null, 2))
if (!passed) { console.error('Live DSH demo failed. See the private run.log in the reported workspace.'); process.exitCode = 1 }
