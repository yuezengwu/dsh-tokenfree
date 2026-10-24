import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const run = (command, args) => execFileSync(command, args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim()
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const { version, name } = manifest
const repo = 'yuezengwu/dsh-tokenfree'
assert(/^\d+\.\d+\.\d+$/.test(version), 'Use an explicit release version')
assert(!manifest.private, 'Remove private only after human release authorization')
assert.equal(name, 'dsh-tokenfree')
assert.equal(manifest.publishConfig?.registry, 'https://registry.npmjs.org/')
assert.equal(run('git', ['status', '--porcelain']), '', 'Commit all release inputs first')
assert.equal(run('git', ['branch', '--show-current']), 'main', 'Release from main')
const commit = run('git', ['rev-parse', 'HEAD'])
const tag = `v${version}`
assert.equal(run('git', ['rev-parse', `${tag}^{commit}`]), commit, 'Local release tag must point to HEAD')
assert.equal(run('git', ['ls-remote', `https://github.com/${repo}.git`, 'refs/heads/main']).split(/\s/)[0], commit, 'Remote main must match HEAD')
const runs = JSON.parse(run('gh', ['run', 'list', '--repo', repo, '--workflow', 'ci.yml', '--commit', commit, '--event', 'push', '--limit', '5', '--json', 'headSha,status,conclusion,url']))
const ci = runs.find(value => value.headSha === commit && value.status === 'completed' && value.conclusion === 'success')
assert(ci, 'The exact commit must pass the complete remote CI workflow')
const output = resolve(root, '.local', 'releases', version)
assert(!existsSync(output), 'Release artifacts already exist; verify and reuse them instead of overwriting')
const lines = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8').split('\n')
const start = lines.findIndex(line => line.startsWith(`## ${version} (`))
assert(start >= 0, 'Add dated release notes to CHANGELOG.md')
const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
const notes = `${lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim()}\n`

// CI has tested this commit. Recheck mutable advisories, then freeze one tarball.
execFileSync('pnpm', ['audit', '--prod', '--audit-level', 'high'], { cwd: root, stdio: 'inherit' })
execFileSync('pnpm', ['build'], { cwd: root, stdio: 'inherit' })
execFileSync('pnpm', ['check:package'], { cwd: root, stdio: 'inherit' })
assert.equal(run('git', ['status', '--porcelain']), '', 'Build changed release inputs')
mkdirSync(output, { recursive: true })
const [packed] = JSON.parse(run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', output]))
const bytes = readFileSync(resolve(output, packed.filename))
const sha256 = createHash('sha256').update(bytes).digest('hex')
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`
assert.equal(packed.integrity, integrity)
assert.equal(run('git', ['status', '--porcelain']), '', 'Package creation changed release inputs')
assert.equal(run('git', ['rev-parse', 'HEAD']), commit, 'HEAD changed during package creation')
writeFileSync(resolve(output, 'notes.md'), notes)
writeFileSync(resolve(output, 'SHA256SUMS'), `${sha256}  ${packed.filename}\n`)
writeFileSync(resolve(output, 'release.json'), `${JSON.stringify({ name, version, tag, commit, ci: ci.url, dsh: manifest.engines.dsh, node: process.version, tarball: packed.filename, sha256, integrity, size: bytes.length, fileCount: packed.files.length }, null, 2)}\n`)
console.log(`Prepared ${name}@${version} at ${commit}. Artifacts: ${output}. Nothing published.`)
