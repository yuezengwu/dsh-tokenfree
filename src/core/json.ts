/** JSON parser with duplicate-key detection at every object level. No coercion or candidate patching. */
export function strictJson(text: string): unknown {
  let i = 0
  const ws = () => { while (/[ \t\r\n]/.test(text[i] ?? '') && i < text.length) i++ }
  const string = () => {
    const start = i++
    let escape = false
    for (; i < text.length; i++) {
      const char = text[i]
      if (!escape && char === '"') return JSON.parse(text.slice(start, ++i)) as string
      if (!escape && char === '\\') escape = true
      else escape = false
    }
    throw new Error('Unterminated string')
  }
  const value = (depth: number): unknown => {
    if (depth > 64) throw new Error('JSON nesting exceeded limit')
    ws()
    if (text[i] === '"') return string()
    if (text[i] === '{') {
      i++; ws()
      const out: Record<string, unknown> = Object.create(null)
      if (text[i] === '}') { i++; return out }
      for (;;) {
        ws(); if (text[i] !== '"') throw new Error('Expected object key')
        const key = string(); ws()
        if (Object.hasOwn(out, key)) throw new Error('Duplicate JSON key')
        if (text[i++] !== ':') throw new Error('Expected colon')
        out[key] = value(depth + 1); ws()
        const separator = text[i++]
        if (separator === '}') return out
        if (separator !== ',') throw new Error('Expected object separator')
      }
    }
    if (text[i] === '[') {
      i++; ws(); const out: unknown[] = []
      if (text[i] === ']') { i++; return out }
      for (;;) {
        out.push(value(depth + 1)); ws()
        const separator = text[i++]
        if (separator === ']') return out
        if (separator !== ',') throw new Error('Expected array separator')
      }
    }
    const rest = text.slice(i)
    const token = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(rest)?.[0]
    if (!token) throw new Error('Invalid JSON value')
    i += token.length
    const parsed: unknown = JSON.parse(token)
    if (typeof parsed === 'number' && !Number.isFinite(parsed)) throw new Error('Invalid JSON number')
    return parsed
  }
  const result = value(0); ws()
  if (i !== text.length) throw new Error('Trailing JSON content')
  return result
}
