import { Effect, FiberSet, Schema } from "effect"
import { formatRunOutput, RUN_CODE_TOOL_NAME, type RpcCallResult } from "@maple/codemode"
import { WorkerEnvironment } from "@/lib/WorkerEnvironment"
import { resolveTenant } from "../lib/query-warehouse"
// Type-only: a value import would create an eager require cycle with registry.ts
// (registry imports this module to register the tool). The definitions are passed
// into resolveCodeModeCall / fetched via dynamic import at request time instead.
import type { MapleToolDefinition } from "./registry"
import { MUTATING_TOOL_NAMES } from "./mutating"
import { requiredStringParam, validationError, type McpToolRegistrar, type McpToolResult } from "./types"

const DESCRIPTION = `Run a JavaScript snippet that orchestrates other Maple tools in one call, instead of issuing many separate tool calls. Inside the snippet, \`await maple.<tool>(input)\` invokes any READ-ONLY Maple tool by name (same names and inputs as the other tools you have) and returns its text output (human-readable text followed by a \`Structured content:\` line of JSON — JSON.parse it to filter/sort). The snippet runs in a sandbox with no network and no imports; \`console.log(...)\` and the \`return\` value come back to you. Mutating tools are NOT callable here — call those directly so they go through approval. Ideal for multi-step investigations (find → for each → inspect → correlate) where chaining and filtering in code beats round-tripping every result.`

/** Join an McpToolResult's content into the `Structured content:` convention the sandbox API uses. */
export const textOfResult = (result: McpToolResult): string => {
	const texts = result.content.map((c) => c.text)
	if (texts.length <= 1) return texts.join("\n")
	const [human, ...rest] = texts
	return `${human}\n\nStructured content:\n${rest.join("\n")}`
}

/**
 * Resolve one `maple.<name>(input)` call to an RPC result: block mutating tools,
 * reject unknown names, decode the input against the tool's schema, then run the
 * handler via `invoke` (which the caller binds to the captured request runtime).
 * Errors are returned as values so the model can self-correct. Pure of the
 * Effect runtime — the dispatch logic is unit-testable with a fake `invoke`.
 */
export const resolveCodeModeCall = async (
	definitions: ReadonlyArray<MapleToolDefinition>,
	name: string,
	input: unknown,
	invoke: (definition: MapleToolDefinition, decoded: unknown) => Promise<McpToolResult>,
): Promise<RpcCallResult> => {
	if (name === RUN_CODE_TOOL_NAME) {
		// `run_code` is in `mapleToolDefinitions` (registered last), so without this
		// guard a snippet calling maple.run_code(...) would nest a sandbox.
		return {
			ok: false,
			error: { name: "Blocked", message: "maple.run_code cannot be called from inside code mode." },
		}
	}
	const definition = definitions.find((d) => d.name === name)
	if (!definition) {
		return { ok: false, error: { name: "UnknownTool", message: `maple.${name} is not available` } }
	}
	// Structural gate: a tool registered via `mutatingTool` carries `mutating: true`,
	// so a mutating tool can't slip past code mode regardless of its name. (The
	// shared MUTATING_TOOL_NAMES set is verified to equal this flag in tests.)
	if (definition.mutating || MUTATING_TOOL_NAMES.has(name)) {
		return {
			ok: false,
			error: {
				name: "MutatingToolBlocked",
				message: `maple.${name} mutates state and can't run inside code mode. Call the ${name} tool directly so it goes through approval.`,
			},
		}
	}
	let decoded: unknown
	try {
		decoded = Schema.decodeUnknownSync(definition.schema)(input ?? {})
	} catch (error) {
		return { ok: false, error: { name: "InvalidInput", message: String(error) } }
	}
	try {
		const result = await invoke(definition, decoded)
		if (result.isError) {
			return { ok: false, error: { name: "ToolError", message: textOfResult(result) } }
		}
		return { ok: true, value: textOfResult(result) }
	} catch (error) {
		return {
			ok: false,
			error: {
				name: error instanceof Error ? error.name : "Error",
				message: error instanceof Error ? error.message : String(error),
			},
		}
	}
}

/**
 * Code Mode for the MCP server (Cloudflare Dynamic Workers). Exposes a single
 * `run_code` tool whose sandboxed snippet calls back into the existing read-only
 * tool handlers via RPC, run on the SAME request/tenant context — so org scoping
 * is identical to a direct tool call and the sandbox can never widen it. Mutating
 * tools are blocked inside code (they must go through the host's approval path).
 *
 * Active when the `LOADER` (worker_loader) binding is present; without it the
 * tool returns an "unavailable" result (e.g. local/test runs). The Workers-only
 * sandbox driver is imported dynamically so this module's static graph stays
 * Node-safe (the tool registry is imported by node-based evals/tests).
 */
export function registerRunCodeTool(server: McpToolRegistrar) {
	server.tool(
		RUN_CODE_TOOL_NAME,
		DESCRIPTION,
		Schema.Struct({
			code: requiredStringParam(
				"A JavaScript snippet using `await maple.<tool>(input)`, `console.log(...)`, and `return`. No imports, no network, no type annotations.",
			),
		}),
		Effect.fn("McpTool.runCode")(function* ({ code }) {
			const tenant = yield* resolveTenant
			yield* Effect.annotateCurrentSpan({ orgId: tenant.orgId })

			const env = yield* WorkerEnvironment
			const loader = env.LOADER as WorkerLoader | undefined
			if (!loader) {
				return validationError(
					"Code mode is unavailable here (no sandbox runtime is bound). Call the individual Maple tools directly instead.",
				)
			}
			if (!code.trim()) {
				return validationError("Provide a `code` snippet that uses the `maple` API.")
			}

			return yield* Effect.scoped(
				Effect.gen(function* () {
					// Capture the current request context so RPC callbacks (which fire
					// from the isolate while we await the sandbox) can run tool handlers
					// with the same tenant/services. `any`: tool handlers are
					// type-erased over their service requirements (see registry.ts).
					// eslint-disable-next-line @typescript-eslint/no-explicit-any
					const runPromise = yield* FiberSet.makeRuntimePromise<any>()

					// Fetched lazily (the static import is type-only to avoid a require
					// cycle); registry is fully initialized by request time.
					const { mapleToolDefinitions } = yield* Effect.promise(() => import("./registry"))
					const dispatch = (name: string, input: unknown): Promise<RpcCallResult> =>
						resolveCodeModeCall(mapleToolDefinitions, name, input, (definition, decoded) =>
							runPromise(definition.handler(decoded)),
						)

					const result = yield* Effect.promise(async () => {
						const { runCodeInSandbox } = await import("@maple/codemode/sandbox")
						return runCodeInSandbox(loader, {
							id: `maple-codemode-${crypto.randomUUID()}`,
							code,
							dispatch,
						})
					})

					yield* Effect.annotateCurrentSpan({
						"codemode.log_lines": result.logs.length,
						"codemode.crashed": result.crashed === true,
						"codemode.errored": result.error !== null,
					})

					return {
						content: [{ type: "text" as const, text: formatRunOutput(result) }],
					} satisfies McpToolResult
				}),
			)
		}),
	)
}
