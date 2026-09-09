/**
 * Maple's MCP registry, wrapped as Effect AI tools.
 *
 * The chat agent and the investigation agents share this wrapper so tool dispatch, runtime
 * provisioning, and safe failure summaries cannot drift.
 *
 * Dynamic (`Tool.dynamic` over raw JSON Schema) is the right fit for every tool here: `toInputSchema`
 * already produces the exact JSON Schema the MCP surface publishes, and `callMcpTool` does its own
 * Effect Schema decode with the tool's own error messages. Decoding twice would only give the model
 * a second, worse phrasing of the same validation failure.
 *
 * The tenant is provided per call rather than ambiently so an agent can never widen its own scope:
 * every tool executes under exactly the org the run was started for.
 */
import { Cause, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi, McpToolSurface } from "@/mcp/dispatcher"
import { mapleToolCatalog, toInputSchema } from "@/mcp/tools/registry"
import { truncateToolOutput } from "@/mcp/tools/tool-output"
import type { TenantContext } from "@/services/auth/tenant-context"

/**
 * Serialize an MCP tool result for the model. Maple's tools already return model-facing text blocks,
 * so this is a join rather than a re-encode.
 *
 * Bounded here, at creation, and never again — see `./tool-output.ts` for why that matters more than
 * the token saving. A warehouse query with no `limit` used to enter the transcript whole.
 */
export const toolResultText = (result: { content: ReadonlyArray<{ text: string }> }): string =>
	truncateToolOutput(result.content.map((block) => block.text).join("\n")).text

/**
 * Capped, because "one line" is a convention the error's author never agreed to: a ClickHouse syntax
 * error arrives with the whole offending query inlined, and on a retry loop that lands in the
 * transcript once per attempt.
 */
const MAX_FAILURE_MESSAGE_CHARS = 500

const cap = (message: string): string =>
	message.length <= MAX_FAILURE_MESSAGE_CHARS
		? message
		: `${message.slice(0, MAX_FAILURE_MESSAGE_CHARS)}…[truncated]`

/**
 * Typed failures only. A defect is an internal breakage the model can do nothing with, and its
 * message is the kind of thing this function exists to keep out of the transcript — so `Die` reasons
 * are filtered out before rendering rather than summarized.
 */
export const summarizeToolFailure = (cause: Cause.Cause<unknown>): string => {
	const failures = Cause.prettyErrors(Cause.fromReasons(cause.reasons.filter(Cause.isFailReason)))
	const first = failures[0]
	return first === undefined ? "the tool failed" : cap(first.message)
}

/**
 * Description suffix on gated tools. The model still calls them normally; it just needs to know the
 * call is a proposal so it stops rather than narrating a completed change.
 */
export const APPROVAL_NOTE =
	"\n\nThis is an approval-gated action. Calling it proposes the change for the user to approve; " +
	"it does NOT take effect until they do. Call it once with the intended arguments and stop."

export interface BuildMapleToolsOptions {
	/** Which registry tools to expose. Defaults to all of them. */
	readonly include?: (name: string) => boolean
	/**
	 * Which exposed tools are approval-gated. A gated tool keeps a real handler so the schema the
	 * model sees is identical to the ungated case, but the handler refuses.
	 */
	readonly gate?: (name: string) => boolean
	/**
	 * Telemetry attribution for every tool call these tools dispatch. Defaults to `"chat"`; workflow
	 * agent passes pass `"workflow"` so the two are separable in traces despite sharing this builder.
	 */
	readonly surface?: McpToolSurface
}

/**
 * A tool's failure as the model sees it: one line of text, never a cause.
 *
 * Declared rather than thrown so the runtime records a tool failure the model can route around,
 * instead of the failure ending the run.
 */
export class MapleToolFailure extends Schema.TaggedError<MapleToolFailure>()(
	"@maple/api/mcp/MapleToolFailure",
	{ message: Schema.String },
) {}

const fail = (message: string) => Effect.fail(new MapleToolFailure({ message }))

/** The registry entries this build exposes, after the caller's `include` filter. */
const exposed = (options: BuildMapleToolsOptions) =>
	mapleToolCatalog.filter((definition) => options.include?.(definition.name) ?? true)

/**
 * The Maple MCP registry as an Effect AI toolkit plus its handler layer.
 *
 * Both come back together because they are built from one filtered catalogue: a handler map that
 * disagreed with the toolkit it was registered against would fail at layer construction, which is
 * later than it needs to be.
 */
export const buildMapleToolkit = (
	executor: McpToolExecutorApi,
	tenant: TenantContext,
	options: BuildMapleToolsOptions = {},
) => {
	const definitions = exposed(options)
	const tools = definitions.map((definition) => {
		const gated = options.gate?.(definition.name) ?? false
		return Tool.dynamic(definition.name, {
			description: gated ? `${definition.description}${APPROVAL_NOTE}` : definition.description,
			parameters: toInputSchema(definition.schema),
			success: Schema.String,
			failure: MapleToolFailure,
		})
	})
	const toolkit = Toolkit.make(...tools)
	const handlers = Object.fromEntries(
		definitions.map((definition) => {
			const gated = options.gate?.(definition.name) ?? false
			return [
				definition.name,
				(params: unknown) =>
					gated
						? fail(`${definition.name} requires user approval and was not executed.`)
						: executor
								.execute(tenant, definition.name, params, options.surface ?? "chat")
								.pipe(
									Effect.flatMap((result) =>
										result.isError ? fail(toolResultText(result)) : Effect.succeed(toolResultText(result)),
									),
									// A tool that fails outright (unknown tool, tenant error) must not kill the
									// run — hand the model the message and let it route around.
									Effect.catchCause((cause) => fail(`Tool failed: ${summarizeToolFailure(cause)}`)),
								),
			]
		}),
	)
	return { toolkit, layer: toolkit.toLayer(handlers) }
}
