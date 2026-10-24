import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { assertDocumentationLinks, assertZodNotice } from './package-contents.mjs'

const root = resolve(import.meta.dirname, '..')
const temporary = mkdtempSync(join(tmpdir(), 'tokenfree-package-'))
try {
  const output = execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const [packed] = JSON.parse(output)
  const files = new Set(packed.files.map(file => file.path))
  for (const file of files) assert(!isAbsolute(file) && !file.split('/').includes('..'), `Unsafe package path: ${file}`)
  const unpacked = join(temporary, 'unpacked')
  mkdirSync(unpacked)
  execFileSync('tar', ['-xzf', join(temporary, packed.filename), '-C', unpacked], { stdio: 'pipe' })
  const directory = join(unpacked, 'package')
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'))
  const documents = manifest.files.filter(file => file.endsWith('.md'))
  const sources = manifest.files.filter(file => file.startsWith('src/'))
  const images = ['assets/readme/tokenfree-login.png', 'assets/readme/tokenfree-model-selection.png']
  const allowed = new Set(['package.json', 'cordis.patch.yml', 'LICENSE', ...documents, ...sources, ...images])
  const required = [manifest.main, manifest.types, ...Object.values(manifest.bin), manifest.dsh.bundle.patch, 'lib/client.js', 'lib/deepseek-web/pow-worker.js', 'README.md', 'LICENSE', 'NOTICE.md', 'THIRD_PARTY_NOTICES.md', ...documents, ...sources, ...images]
  function collect(value) {
    if (typeof value === 'string') required.push(value)
    else if (value && typeof value === 'object') Object.values(value).forEach(collect)
  }
  collect(manifest.exports)
  for (const file of required) assert(files.has(file.replace(/^\.\//, '')), `Missing package entry: ${file}`)
  const contents = new Map()
  for (const file of files) {
    assert(file.startsWith('lib/') || allowed.has(file), `Unexpected package file: ${file}`)
    assert(!/^lib\/(?:local\/browser-(?:bridge|host-cli|identity|setup)|deepseek-web\/browser-extension)/.test(file), `Removed browser connector must not ship: ${file}`)
    assert(!file.endsWith('.map'), `Source map must stay local: ${file}`)
    assert(!file.endsWith('.wasm') && !/(?:^|\/)(?:credentials\.json|\.env(?:\..*)?|browser-profile|logs|cache)(?:\/|$)/.test(file), `Private or unbundled asset: ${file}`)
    assert(lstatSync(join(directory, file)).isFile(), `Package entry must be a regular file: ${file}`)
    const body = readFileSync(join(directory, file), 'utf8')
    contents.set(file, body)
    if (/\.(?:js|ts|json|md|yml)$/.test(file)) {
      assert(!/\/Users\/[^/\s]+\//.test(body), `Private path in package: ${file}`)
      assert(!/https:\/\/chat\.deepseek\.com\/a\/chat\/s\//.test(body), `Private chat URL in package: ${file}`)
    }
  }
  const links = assertDocumentationLinks(contents)
  const require = createRequire(import.meta.url)
  const zodDirectory = dirname(require.resolve('zod/package.json'))
  const zod = JSON.parse(readFileSync(join(zodDirectory, 'package.json'), 'utf8'))
  assertZodNotice(contents, zod.version, readFileSync(join(zodDirectory, 'LICENSE'), 'utf8'))
  console.log(`Package checks passed (${files.size} files, ${links} local documentation links, full Zod notices; local tgz created and removed, no publish).`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}
