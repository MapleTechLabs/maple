import { Result } from "effect"
import { readFileSync } from "node:fs"
import wasmPath from "./ai-stamp.wasm" with { type: "file" }

/**
 * The ingest gateway's `maple_ai.*` stamping (`apps/ingest/crates/ai-session`),
 * compiled to WebAssembly by `bun run build:ai-stamp`. Local ingest runs the
 * same code as the gateway, so Agent Sessions reads the same stamps locally.
 * See `apps/ingest/crates/ai-session-wasm` for the calling protocol.
 */
interface AiStampExports {
	readonly memory: WebAssembly.Memory
	readonly input: (length: number) => number
	readonly stamp: () => number
	readonly output: () => number
	readonly output_len: () => number
}

const module = new WebAssembly.Module(readFileSync(wasmPath))
// `opentelemetry-proto` depends on `opentelemetry`, which links wasm-bindgen's
// `js-sys` on wasm32. The stamping never reaches it, so its imports are no-ops.
const imports: Record<string, Record<string, () => void>> = {}
for (const { module: namespace, name } of WebAssembly.Module.imports(module))
	(imports[namespace] ??= {})[name] = () => {}
const instantiate = () =>
	// SAFETY: these are the exports of `apps/ingest/crates/ai-session-wasm`, built alongside this file.
	new WebAssembly.Instance(module, imports).exports as unknown as AiStampExports
let wasm = instantiate()

/** Wasm memory never shrinks; past this, the next request gets a fresh instance. */
const MAX_RETAINED_MEMORY_BYTES = 64 * 1024 * 1024

/** Stamp a protobuf `ExportTraceServiceRequest`; fails with the decode error
 *  when it is not one, which the gateway rejects too. */
export function stampTraceRequest(request: Uint8Array): Result.Result<Uint8Array, string> {
	const stamped = Result.try({
		try: () => {
			// `input` may grow memory, detaching any earlier view of it.
			const at = wasm.input(request.length)
			new Uint8Array(wasm.memory.buffer, at, request.length).set(request)
			const ok = wasm.stamp() === 1
			const output = wasm.output()
			const length = wasm.output_len()
			return { ok, bytes: new Uint8Array(wasm.memory.buffer, output, length).slice() }
		},
		// A panic is a stamping bug, not bad input, and a trap can leave the
		// instance unusable: keep the batch unstamped and start over.
		catch: () => {
			wasm = instantiate()
			return { ok: true, bytes: request }
		},
	}).pipe(Result.merge)
	if (wasm.memory.buffer.byteLength > MAX_RETAINED_MEMORY_BYTES) wasm = instantiate()
	return stamped.ok ? Result.succeed(stamped.bytes) : Result.fail(new TextDecoder().decode(stamped.bytes))
}
