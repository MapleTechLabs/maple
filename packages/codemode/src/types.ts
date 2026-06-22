// Shared, dependency-free types + constants for Code Mode. Importable by both
// the pure helpers (api-gen / harness / format) and the Workers-only `./sandbox`
// driver, and safe to pull into Node-side unit tests.

/** A trimmed JSON Schema node, as produced by the tool registries. */
export interface JsonSchema {
	type?: string | string[]
	properties?: Record<string, JsonSchema>
	required?: ReadonlyArray<string>
	items?: JsonSchema
	enum?: ReadonlyArray<unknown>
	description?: string
	anyOf?: ReadonlyArray<JsonSchema>
	oneOf?: ReadonlyArray<JsonSchema>
	$ref?: string
	[key: string]: unknown
}

/** The minimum a tool must expose to be projected into the `maple.*` API. */
export interface CodeModeToolSpec {
	/** Name the model calls as `maple.<name>(...)` — already stripped of any `mcp__` prefix. */
	readonly name: string
	readonly description: string
	/** Raw JSON Schema for the tool's single input object (may be absent). */
	readonly parameters?: JsonSchema
}

/** Result the sandbox isolate returns (parsed from its fetch response). */
export interface CodeRunResult {
	readonly logs: ReadonlyArray<string>
	readonly returnValue: unknown
	readonly error: { name: string; message: string; stack?: string } | null
	/** Set when the isolate failed to load/run at the harness boundary (not user code). */
	readonly crashed?: boolean
}

/** Envelope crossing the RPC boundary for each `maple.<tool>(input)` call. */
export interface RpcCallResult {
	readonly ok: boolean
	readonly value?: string
	readonly error?: { name: string; message: string }
}

/** One pending mutation captured from a code run (chat propose-then-apply flow). */
export interface CodeProposal {
	readonly tool: string
	readonly input: unknown
}

export const PROPOSED_BATCH_STATUS = "proposed_batch" as const

/** The `run_code` output envelope when a code run queued mutating proposals. */
export interface ProposedBatch {
	readonly status: typeof PROPOSED_BATCH_STATUS
	readonly proposals: ReadonlyArray<CodeProposal>
	/** Human/model-facing summary of the run (console + return value + queue note). */
	readonly text: string
}

export const DEFAULT_OUTPUT_CAP_BYTES = 24_000
/**
 * Compatibility date for the dynamically-loaded isolate. The harness uses only
 * standard globals (Response, Proxy, console), so any recent date works; this
 * matches the blog's Worker Loader example. Bump deliberately.
 */
export const DEFAULT_COMPAT_DATE = "2025-06-01"
export const DEFAULT_CPU_MS = 10_000
export const DEFAULT_SUBREQUESTS = 50
export const DEFAULT_WALL_MS = 20_000
