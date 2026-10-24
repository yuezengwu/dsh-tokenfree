import { parentPort, workerData } from 'node:worker_threads'

interface WasmExports {
  memory: WebAssembly.Memory
  wasm_solve: (out: number, challenge: number, challengeLength: number, prefix: number, prefixLength: number, difficulty: number) => void
  __wbindgen_export_0: (size: number, alignment: number) => number
  __wbindgen_add_to_stack_pointer: (delta: number) => number
}

try {
  const { bytes, challenge } = workerData
  const { instance } = await WebAssembly.instantiate(bytes, {})
  const wasm = instance.exports as unknown as WasmExports
  const put = (value: string): [number, number] => {
    const data = new TextEncoder().encode(value)
    const ptr = wasm.__wbindgen_export_0(data.length, 1)
    new Uint8Array(wasm.memory.buffer, ptr, data.length).set(data)
    return [ptr, data.length]
  }
  const out = wasm.__wbindgen_add_to_stack_pointer(-16)
  const [c, cl] = put(challenge.challenge)
  const [p, pl] = put(`${challenge.salt}_${challenge.expire_at}_`)
  wasm.wasm_solve(out, c, cl, p, pl, challenge.difficulty)
  const view = new DataView(wasm.memory.buffer)
  const success = view.getInt32(out, true)
  const answer = view.getFloat64(out + 8, true)
  if (!success || !Number.isSafeInteger(answer) || answer < 0) throw new Error('No answer')
  parentPort?.postMessage({ answer })
} catch {
  parentPort?.postMessage({ error: 'Proof-of-work computation failed.' })
}
