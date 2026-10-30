import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))
const inventory = JSON.parse(readFileSync(new URL('scripts/dsh-hosts.json', root), 'utf8'))
const versions = inventory.hosts.map(host => host.version).sort()
const range = value => value.split('||').map(value => value.trim()).sort()
assert.equal(new Set(versions).size, versions.length)
assert(versions.includes(inventory.developmentVersion))
assert.deepEqual(range(pkg.engines.dsh), versions)
for (const [name, version] of Object.entries(pkg.peerDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) assert.deepEqual(range(version), versions, `Peer ${name}`)
}
for (const [name, version] of Object.entries(pkg.devDependencies)) {
  if (name.startsWith('@deepseek-ai/dsh-')) assert.equal(version, inventory.developmentVersion, `SDK ${name}`)
}
const ci = readFileSync(new URL('.github/workflows/ci.yml', root), 'utf8')
const pins = [...ci.matchAll(/- version: ([^\s]+)\s+sha: ([a-f0-9]{40})/g)].map(([, version, sha]) => ({ version, sha }))
assert.deepEqual(pins, inventory.hosts.map(({ version, sha }) => ({ version, sha })))
console.log(`Compatibility inventory and CI match ${versions.length} exact hosts; development ${inventory.developmentVersion}.`)
