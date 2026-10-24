import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
assert.equal(manifest.packageManager, 'pnpm@10.12.1', 'Use the pinned package manager')
assert.equal(manifest.license, 'MIT')
const lock = readFileSync(resolve(root, 'pnpm-lock.yaml'), 'utf8')
assert(!/^\s+version: (?:link:|file:)/m.test(lock), 'Lockfile must not depend on a local checkout')
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean)
const issues = []
for (const file of new Set(files)) {
  if (/^(?:research|logs|cache|\.local|node_modules|lib|browser-profile|\.dsh-tokenfree|\.dsh)\//.test(file)
    || /(?:^|\/)(?:credentials\.json|\.env(?:\..*)?)$/.test(file)) issues.push(`${file}: private/generated file in Git candidates`)
  if (/^src\/(core|deepseek-web|local)\/.*\.tsx?$/.test(file)) {
    const source = readFileSync(resolve(root, file), 'utf8')
    if (/from\s+['"](?:@deepseek-ai\/(?:dsh-|cordis)|react)|from\s+['"][^'"]*\/dsh\//.test(source)) issues.push(`${file}: native dependency outside dsh module`)
  }
  if (!file.endsWith('.md')) continue
  const body = readFileSync(resolve(root, file), 'utf8')
  if (/\/Users\/[^/\s]+\//.test(body) || /https:\/\/chat\.deepseek\.com\/a\/chat\/s\//.test(body)) issues.push(`${file}: private path or chat URL`)
  if ((body.match(/^```/gm) ?? []).length % 2) issues.push(`${file}: unclosed code fence`)
  for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^(?:https?:|mailto:|#)/.test(target)) continue
    const path = target.split('#')[0]
    if (path && !existsSync(resolve(root, file, '..', path))) issues.push(`${file}: missing local link ${target}`)
    if (/^(?:research|\.local)\//.test(path)) issues.push(`${file}: link to private evidence`)
  }
}
for (const path of ['research/private-check.json', 'logs/check.jsonl', 'cache/check.wasm', '.local/check.json', 'credentials.json']) {
  try { execFileSync('git', ['check-ignore', '-q', path], { cwd: root }) }
  catch { issues.push(`${path}: expected Git ignore rule`) }
}
assert.equal(issues.length, 0, issues.join('\n'))
console.log(`Repository checks passed (${new Set(files).size} public file candidates).`)
