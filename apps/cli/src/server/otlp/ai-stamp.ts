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

/** Stamp a protobuf `ExportTraceServiceRequest`; fails with the decode error
 *  when it is not one, which the gateway rejects too. */
export function stampTraceRequest(request: Uint8Array): Result.Result<Uint8Array, string> {
	return Result.try({
		try: () => {
			// `input` may grow memory, detaching any earlier view of it.
			const at = wasm.input(request.length)
			new Uint8Array(wasm.memory.buffer, at, request.length).set(request)
			return wasm.stamp() === 1
		},
		// A panic traps and can leave the instance unusable; the next request gets a fresh one.
		catch: (trap) => {
			wasm = instantiate()
			return `AI stamping failed: ${String(trap)}`
		},
	}).pipe(
		Result.flatMap((stamped) => {
			const output = new Uint8Array(wasm.memory.buffer, wasm.output(), wasm.output_len()).slice()
			return stamped ? Result.succeed(output) : Result.fail(new TextDecoder().decode(output))
		}),
	)
}
