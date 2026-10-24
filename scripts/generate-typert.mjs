#!/usr/bin/env node
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FaceModelEmitter, WorkspaceAnalyzer } from '@deepseek-ai/dsh-typert-generator'
import { buildSync } from 'esbuild'


const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-tokenfree-typert-')))
const packageRoot = join(workspace, 'packages', 'dsh-tokenfree')
const protocolRoot = join(workspace, 'packages', 'typert', 'protocol')

try {
  mkdirSync(packageRoot, { recursive: true })
  cpSync(join(repository, 'src'), join(packageRoot, 'src'), { recursive: true })
  rmSync(join(packageRoot, 'src', 'dsh', 'client'), { recursive: true, force: true })
  // TypeRT declaration merges must have owners in the temporary Host face.
  const sdkNames = ['dsh-typert-protocol', 'dsh-llm', 'dsh-api-gateway', 'dsh-util-values']
  const sdkRoots = sdkNames.map(name => ({
    name: `@deepseek-ai/${name}`,
    source: join(repository, 'node_modules', '@deepseek-ai', name),
    target: name === 'dsh-typert-protocol' ? protocolRoot : join(workspace, 'packages', 'sdk', name),
  }))
  const sdkPaths = Object.fromEntries(sdkRoots.flatMap(({ name, target }) => [
    [name, [join(target, 'src', 'index.d.ts')]],
    [`${name}/*`, [join(target, 'src', '*.d.ts'), join(target, 'src', '*', 'index.d.ts')]],
  ]))
  for (const { source, target } of sdkRoots) {
    const declarations = join(source, 'lib', 'types')
    mkdirSync(join(target, 'src'), { recursive: true })
    for (const name of readdirSync(declarations, { recursive: true })) {
      if (!name.endsWith('.d.ts')) continue
      const file = join(target, 'src', name)
      mkdirSync(dirname(file), { recursive: true })
      cpSync(join(declarations, name), file)
    }
    const sdkManifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'))
    const declarationExports = value => {
      if (typeof value === 'string') return value.replace('./lib/types/', './src/')
      if (Array.isArray(value)) return value.map(declarationExports)
      if (value !== null && typeof value === 'object') {
        return Object.fromEntries(Object.entries(value).map(([key, target]) => [key, declarationExports(target)]))
      }
      return value
    }
    sdkManifest.exports = declarationExports(sdkManifest.exports)
    writeFileSync(join(target, 'package.json'), `${JSON.stringify(sdkManifest, null, 2)}\n`)
    writeFileSync(join(target, 'tsconfig.json'), `${JSON.stringify({
      compilerOptions: {
        target: 'ES2024', lib: ['ES2024', 'ESNext.Disposable', 'DOM'], types: ['node'],
        module: 'ESNext', moduleResolution: 'bundler', strict: true,
        noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true,
        baseUrl: workspace, paths: sdkPaths,
      },
      include: ['src'], exclude: ['src/dsh/client'],
    }, null, 2)}\n`)
  }
  const manifest = JSON.parse(readFileSync(join(repository, 'package.json'), 'utf8'))
  manifest.exports = {
    '.': './src/index.ts',
    './account-types': './src/account-types.ts',
    './typert': {
      types: './lib/typert.host.d.ts',
      default: './lib/typert.host.js',
    },
    './remote': {
      types: './lib/typert.remote-client.d.ts',
      default: './lib/typert.remote-client.js',
    },
  }
  writeFileSync(join(packageRoot, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(packageRoot, 'tsconfig.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2024', 'DOM'],
      types: ['node'],
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: true,
      baseUrl: '.',
      paths: sdkPaths,
      useDefineForClassFields: true,
    },
    include: ['src'],
  }, null, 2)}\n`)
  writeFileSync(join(workspace, 'tsconfig.host.json'), `${JSON.stringify({
    compilerOptions: {
      target: 'ES2024',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '.',
      paths: sdkPaths,
    },
    files: [],
    references: [
      { path: './packages/dsh-tokenfree' },
      ...sdkRoots.map(({ target }) => ({ path: target })),
    ],
  }, null, 2)}\n`)
  symlinkSync(join(repository, 'node_modules'), join(workspace, 'node_modules'), 'dir')

  const model = new WorkspaceAnalyzer({ root: workspace, packages: ['dsh-tokenfree'], faces: ['host'] }).analyze()
  const face = model.faces.find(candidate => candidate.face === 'host')
  if (face === undefined) throw new Error('TypeRT analyzer did not find the dsh-tokenfree Host face')
  const artifact = new FaceModelEmitter(face).emit('dsh-tokenfree')
  if (artifact.remote === undefined) throw new Error('TypeRT emitter did not emit dsh-tokenfree Remote artifacts')
  mkdirSync(join(repository, 'lib'), { recursive: true })
  const bundle = source => {
    // Bundle the generated protocol helpers so the artifacts are self-contained.
    const bundled = buildSync({
      stdin: { contents: source, resolveDir: repository, sourcefile: 'typert.generated.js' },
      bundle: true, format: 'esm', platform: 'neutral', target: 'es2024',
      external: ['zod'], write: false,
    }).outputFiles[0].text
    return `${bundled}\n`
  }
  writeFileSync(join(repository, 'lib', 'typert.host.js'), bundle(artifact.js))
  writeFileSync(join(repository, 'lib', 'typert.host.d.ts'), artifact.dts)
  writeFileSync(join(repository, 'lib', 'typert.remote-client.js'), bundle(artifact.remote.js))
  writeFileSync(join(repository, 'lib', 'typert.remote-client.d.ts'), artifact.remote.dts)
  writeFileSync(join(repository, 'lib', 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
  console.log('generated TypeRT host and Remote artifacts')
} finally {
  rmSync(workspace, { recursive: true, force: true })
}
