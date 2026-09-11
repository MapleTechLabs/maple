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
 * The API fixes tenancy when it supplies the execution callback. This service cannot select
 * another tenant or calling surface.
 */
import { Cause, Effect, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { ToolExecutorApi } from "./tool-executor"

import { truncateToolOutput } from "@maple/domain/ai-tool-output"

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

/**
 * How many times one build may dispatch the identical call before refusing it.
 *
 * The doom-loop guard, and the one ceiling here that is not about volume. Every other bound says
 * how much a productive run may consume; this one says how long an unproductive one may look
 * productive. A model that reissues a call with byte-identical arguments is not reading the result
 * it already has, and left alone it will spend every turn it owns doing that.
 *
 * It refuses rather than denying authorization, because the two end differently: a refusal is a
 * declared tool failure the model can read and route around, and a third consecutive one trips the
 * policy's own `repeatedFailureLimit`, which stops the run. A host authorization denial ends the
 * run outright, and a user watching a chat turn would see an error instead of an answer.
 */
const IDENTICAL_CALL_LIMIT = 3

/**
 * How many times this exact call has been dispatched, counting the one being asked about.
 *
 * Keyed on the encoded arguments, so a repeat with one field changed is a different call and does
 * not count. The arguments came off the wire as JSON, so re-encoding them cannot fail.
 */
const repeats = (dispatched: Map<string, number>, name: string, params: unknown): number => {
	const key = `${name}:${JSON.stringify(params)}`
	const seen = (dispatched.get(key) ?? 0) + 1
	dispatched.set(key, seen)
	return seen
}

/** The registry entries this build exposes, after the caller's `include` filter. */
const exposed = (executor: ToolExecutorApi, options: BuildMapleToolsOptions) =>
	executor.tools.filter((definition) => options.include?.(definition.name) ?? true)

/**
 * The Maple MCP registry as an Effect AI toolkit plus its handler layer.
 *
 * Both come back together because they are built from one filtered catalogue: a handler map that
 * disagreed with the toolkit it was registered against would fail at layer construction, which is
 * later than it needs to be.
 */
export const buildMapleToolkit = (executor: ToolExecutorApi, options: BuildMapleToolsOptions = {}) => {
	const definitions = exposed(executor, options)
	const tools = definitions.map((definition) => {
		const gated = options.gate?.(definition.name) ?? false
		return Tool.dynamic(definition.name, {
			description: gated ? `${definition.description}${APPROVAL_NOTE}` : definition.description,
			parameters: definition.inputSchema,
			success: Schema.String,
			failure: MapleToolFailure,
		})
	})
	const toolkit = Toolkit.make(...tools)
	// Per build, which is per run: two turns of one conversation are two builds, so a model may ask
	// the same question again in a later turn. Repeating it inside one turn is the loop.
	const dispatched = new Map<string, number>()
	const handlers = Object.fromEntries(
		definitions.map((definition) => {
			const gated = options.gate?.(definition.name) ?? false
			const dispatch = (params: unknown) =>
				executor.execute(definition.name, params).pipe(
					Effect.flatMap((result) =>
						result.isError
							? fail(toolResultText(result))
							: Effect.succeed(toolResultText(result)),
					),
					// A tool that fails outright (unknown tool, tenant error) must not kill the run —
					// hand the model the message and let it route around.
					Effect.catchCause((cause) => fail(`Tool failed: ${summarizeToolFailure(cause)}`)),
				)
			return [
				definition.name,
				(params: unknown) => {
					if (gated) return fail(`${definition.name} requires user approval and was not executed.`)
					if (repeats(dispatched, definition.name, params) > IDENTICAL_CALL_LIMIT) {
						return fail(
							`${definition.name} has already been called ${IDENTICAL_CALL_LIMIT} times with these ` +
								"exact arguments in this turn. Read the result you already have, or call it differently.",
						)
					}
					return dispatch(params)
				},
			]
			// A dynamic tool's shape is known only at runtime, so the model's arguments arrive
			// unparsed and the handler parses them.
			// oxlint-disable-next-line anti-slop/no-unknown-parameters
		}) as ReadonlyArray<readonly [string, (params: unknown) => Effect.Effect<string, MapleToolFailure>]>,
	)
	// `handlers` is exposed alongside the layer because a caller that merges this toolkit with one
	// of its own must build a single handler map: two partial layers would each be missing the
	// other's tools.
	return { toolkit, handlers, layer: toolkit.toLayer(handlers) }
}
