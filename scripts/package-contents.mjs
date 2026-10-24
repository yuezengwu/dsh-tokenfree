import assert from 'node:assert/strict'
import { posix } from 'node:path'

/** Check local documentation against the extracted archive, not the checkout. */
export function assertDocumentationLinks(contents) {
  let checked = 0
  for (const [file, body] of contents) {
    if (!file.endsWith('.md')) continue
    for (const [, target] of body.matchAll(/\]\(([^)]+)\)/g)) {
      if (/^(?:https?:|mailto:|#)/.test(target)) continue
      const path = decodeURIComponent(target.split(/[?#]/)[0])
      if (!path) continue
      const resolved = posix.normalize(posix.join(posix.dirname(file), path))
      assert(!posix.isAbsolute(path) && resolved !== '..' && !resolved.startsWith('../'), `${file}: link escapes package: ${target}`)
      assert(contents.has(resolved), `${file}: missing package link ${target}`)
      checked++
    }
  }
  return checked
}

/** Zod is the only third-party implementation bundled into the client. */
export function assertZodNotice(contents, version, license) {
  const notice = contents.get('THIRD_PARTY_NOTICES.md') ?? ''
  assert(notice.includes(`## Zod ${version} (MIT)`), 'Missing or stale Zod version in third-party notices')
  assert(notice.includes(license.trim()), 'Missing full Zod license in third-party notices')
  assert((contents.get('lib/client.js') ?? '').includes(license.trim()), 'Missing full Zod license in client bundle')
}
