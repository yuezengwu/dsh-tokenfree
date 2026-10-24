#!/usr/bin/env node
import { build } from 'esbuild'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { assertZodNotice } from './package-contents.mjs'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(repository, 'lib', 'client.js')
const platformModules = ['react', 'react/jsx-runtime', '@deepseek-ai/cordis']
const require = createRequire(import.meta.url)
const zodDirectory = dirname(require.resolve('zod/package.json'))
const zod = JSON.parse(readFileSync(resolve(zodDirectory, 'package.json'), 'utf8'))
const zodLicense = readFileSync(resolve(zodDirectory, 'LICENSE'), 'utf8').trim()
const notices = readFileSync(resolve(repository, 'THIRD_PARTY_NOTICES.md'), 'utf8')

if (!existsSync(resolve(repository, 'lib', 'typert.remote-client.js'))) {
  throw new Error('client build requires generated lib/typert.remote-client.js; run build:host first')
}

const result = await build({
  absWorkingDir: repository,
  entryPoints: ['src/dsh/client/index.ts'],
  outfile: output,
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: ['es2022'],
  jsx: 'automatic',
  sourcemap: true,
  metafile: true,
  external: platformModules,
  banner: {
    js: `/*! Zod ${zod.version}\n${zodLicense}\n*/\nwindow.__ModuleLoader__.load({ id: "dsh-tokenfree", factory: (require) => { var module = { exports: {} }; var exports = module.exports;`,
  },
  footer: { js: 'return module.exports; } });' },
  define: { 'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production') },
  logLevel: 'info',
})

for (const input of Object.keys(result.metafile.inputs)) {
  if (!input.includes('node_modules/')) continue
  const dependency = input.split('node_modules/').at(-1).split('/')[0]
  if (dependency !== 'zod') throw new Error(`Client bundles ${dependency}; add its full third-party notice before shipping`)
}

const bundle = readFileSync(output, 'utf8')
assertZodNotice(new Map([['THIRD_PARTY_NOTICES.md', notices], ['lib/client.js', bundle]]), zod.version, zodLicense)
if (
  !bundle.includes('window.__ModuleLoader__.load(')
  || !bundle.includes('var module = { exports: {} }')
  || !bundle.includes('dsh-tokenfree')
) {
  throw new Error('dsh-tokenfree: client bundle is missing the ModuleLoader handoff')
}
if (bundle.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundle)) {
  throw new Error('dsh-tokenfree: client bundle contains ESM syntax')
}
if (bundle.includes('React.createElement')) {
  throw new Error('dsh-tokenfree: client bundle contains classic JSX without an in-scope React binding')
}
for (const match of bundle.matchAll(/require\(\s*["'](@deepseek-ai\/[^"']+)["']\s*\)/g)) {
  if (!platformModules.includes(match[1])) {
    throw new Error(`dsh-tokenfree: unsupported client runtime dependency ${match[1]}`)
  }
}

const tsc = require.resolve('typescript/bin/tsc')
rmSync(resolve(repository, 'lib', 'dsh', 'client'), { recursive: true, force: true })
const declarations = spawnSync(process.execPath, [tsc, '-p', 'tsconfig.client.json'], {
  cwd: repository,
  encoding: 'utf8',
})
if (declarations.status !== 0) {
  throw new Error(`client declaration build failed:\n${declarations.stdout}${declarations.stderr}`)
}
