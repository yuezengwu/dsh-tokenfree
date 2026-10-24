import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertDocumentationLinks, assertZodNotice } from '../scripts/package-contents.mjs'

test('archive documentation rejects targets missing from the package and links escaping it', () => {
  const contents = new Map([
    ['README.md', '[Guide](docs/guide.md#setup)'],
    ['docs/guide.md', '[Source](../src/client.ts)'],
    ['src/client.ts', 'export {}'],
  ])
  assert.equal(assertDocumentationLinks(contents), 2)
  contents.delete('src/client.ts')
  assert.throws(() => assertDocumentationLinks(contents), /missing package link/)
  contents.set('docs/guide.md', '[Private](../../private.md)')
  assert.throws(() => assertDocumentationLinks(contents), /link escapes package/)
})

test('archive licensing rejects missing notices, stale versions and a client without its license', () => {
  const license = 'MIT License\n\nCopyright fixture owner\n\nComplete fixture permission notice.'
  const contents = new Map([
    ['THIRD_PARTY_NOTICES.md', `## Zod 1.2.3 (MIT)\n\n${license}`],
    ['lib/client.js', `/*!\n${license}\n*/\nwindow.client = true;`],
  ])
  assert.doesNotThrow(() => assertZodNotice(contents, '1.2.3', license))
  assert.throws(() => assertZodNotice(contents, '1.2.4', license), /stale Zod version/)
  contents.set('lib/client.js', 'window.client = true;')
  assert.throws(() => assertZodNotice(contents, '1.2.3', license), /license in client bundle/)
  contents.set('THIRD_PARTY_NOTICES.md', '## Zod 1.2.3 (MIT)\nMentioning MIT alone is insufficient.')
  assert.throws(() => assertZodNotice(contents, '1.2.3', license), /full Zod license in third-party notices/)
  contents.delete('THIRD_PARTY_NOTICES.md')
  assert.throws(() => assertZodNotice(contents, '1.2.3', license), /Missing or stale Zod version/)
})
