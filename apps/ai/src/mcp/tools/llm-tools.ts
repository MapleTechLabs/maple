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
import { Cause, Effect, Option, Schema } from "effect"
import { Tool, Toolkit } from "effect/unstable/ai"
import type { McpToolExecutorApi } from "../dispatcher"
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { mapleToolCatalogFor, toInputSchema } from "./registry"
import { truncateToolOutput } from "./tool-output"
import { toolHandlersWithContent } from "../../platform/genai-spans"
import type { TenantContext } from "@maple/backend/services/auth/tenant-context"

const UI_MARKER = "__maple_ui"

/** A tool's typed output in the shape the chat UI's renderers take. */
export interface ToolUiPayload {
	readonly [UI_MARKER]: true
	readonly tool: string
	readonly data: Schema.Json
}

const LegacyUiBlock = Schema.fromJsonString(
	Schema.Struct({ [UI_MARKER]: Schema.Literal(true), tool: Schema.String, data: Schema.Json }),
)
const decodeLegacyUiBlock = Schema.decodeUnknownOption(LegacyUiBlock)

const isLegacyUiBlock = (text: string): boolean => text.startsWith(`{"${UI_MARKER}":true`)

/**
 * The model's text and the UI's payload, split. The payload is never shown to a model: it doubled
 * every result it rode along on, and half of all tool results carried one.
 */
export const splitToolResult = (
	name: string,
	result: {
		readonly content: ReadonlyArray<{ readonly text: string }>
		readonly structuredContent?: Schema.Json
	},
): { readonly text: string; readonly ui: ToolUiPayload | undefined } => {
	const legacy = result.content.find((block) => isLegacyUiBlock(block.text))
	const ui: ToolUiPayload | undefined =
		result.structuredContent !== undefined
			? { [UI_MARKER]: true, tool: name, data: result.structuredContent }
			: legacy === undefined
				? undefined
				: Option.getOrUndefined(decodeLegacyUiBlock(legacy.text))
	const text = result.content
		.filter((block) => !isLegacyUiBlock(block.text))
		.map((block) => block.text)
		.join("\n\n")
	return { text, ui }
}

/**
 * Serialize an MCP tool result for the model: its text blocks only.
 *
 * Bounded here, at creation, and never again — see `./tool-output.ts` for why that matters more than
 * the token saving. A warehouse query with no `limit` used to enter the transcript whole.
 */
export const toolResultText = (result: { content: ReadonlyArray<{ text: string }> }): string =>
	truncateToolOutput(splitToolResult("", result).text).text

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

/** The description the model sees, which is also the one its tool span records. */
const describe = (definition: { readonly description: string }, gated: boolean): string =>
	gated ? `${definition.description}${APPROVAL_NOTE}` : definition.description

export interface BuildMapleToolsOptions {
	/** Which registry tools to expose. Defaults to all of them. */
	readonly include?: (name: string) => boolean
	/**
	 * Which exposed tools are approval-gated. A gated tool keeps a real handler so the schema the
	 * model sees is identical to the ungated case, but the handler refuses.
	 */
	readonly gate?: (name: string) => boolean
	/**
	 * Which audience this build may see, and the attribution on every tool call it dispatches.
	 *
	 * Required rather than defaulted to `"chat"`. Every surface used to be an internal one, so the
	 * default cost nothing; now a caller that forgets it would be handed the agents-only tools —
	 * `sandbox_exec` among them — by omission.
	 */
	readonly surface: McpToolSurface
	/** The agent-session identity of the run, stamped on every tool span — see `withToolCallContent`. */
	readonly sessionAttributes?: Readonly<Record<string, string>>
	/** Sees every successful answer this build dispatches; a review pass tracks what it read here. */
	readonly onAnswer?: (tool: string, answer: string) => void
	/** Receives each successful call's UI payload, keyed by the call it belongs to. */
	readonly onUi?: (toolCallId: string, ui: ToolUiPayload) => void
}

/**
 * A tool's failure as the model sees it: one line of text, never a cause.
 *
 * An ordinary tool returns it to the model, which rewrites the call. A gated tool fails with
 * {@link ApprovalRequired} instead, which ends the run.
 */
export class MapleToolFailure extends Schema.TaggedError<MapleToolFailure>()(
	"@maple/api/mcp/MapleToolFailure",
	{ message: Schema.String },
) {}

const fail = (message: string) => Effect.fail(new MapleToolFailure({ message }))

/**
 * A gated tool's refusal: the call is a proposal, and the run stops on it to wait for a decision.
 *
 * Its own tag, because the engine reports it as a failed call and a failed run, and neither is: the
 * wire drops the one and ends the turn normally on the other (`chat/events.ts`).
 */
export class ApprovalRequired extends Schema.TaggedError<ApprovalRequired>()(
	"@maple/api/mcp/ApprovalRequired",
	{ message: Schema.String },
) {}

/** The tag the engine reports an {@link ApprovalRequired} under, as `errorTag`. */
export const APPROVAL_REQUIRED: ApprovalRequired["_tag"] = "@maple/api/mcp/ApprovalRequired"

const ToolFailure = Schema.Union([MapleToolFailure, ApprovalRequired])

/**
 * How many times one build may dispatch the identical call before refusing it.
 *
 * The doom-loop guard, and the one ceiling here that is not about volume. Every other bound says
 * how much a productive run may consume; this one says how long an unproductive one may look
 * productive. A model that reissues a call with byte-identical arguments is not reading the result
 * it already has, and left alone it will spend every turn it owns doing that.
 *
 * It refuses rather than denying authorization, because the two end differently: a refusal is a
 * returned tool failure the model can read and route around, and enough consecutive ones trip the
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

/**
 * The registry entries this build exposes: what the surface may see at all, then
 * the caller's `include` filter. The surface cut comes first so a ruleset that
 * allows `*` cannot widen a build past its audience.
 */
const exposed = (options: BuildMapleToolsOptions) =>
	mapleToolCatalogFor(options.surface).filter((definition) => options.include?.(definition.name) ?? true)

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
	options: BuildMapleToolsOptions,
) => {
	const definitions = exposed(options)
	const tools = definitions.map((definition) => {
		const gated = options.gate?.(definition.name) ?? false
		return Tool.dynamic(definition.name, {
			description: describe(definition, gated),
			parameters: toInputSchema(definition.schema),
			success: Schema.String,
			failure: ToolFailure,
			// A proposal must end the run; any other failure goes back to the model as the call's result.
			failureMode: gated ? "error" : "return",
		})
	})
	const toolkit = Toolkit.make(...tools)
	// Per build, which is per run: two turns of one conversation are two builds, so a model may ask
	// the same question again in a later turn. Repeating it inside one turn is the loop.
	const dispatched = new Map<string, number>()
	const handlers = Object.fromEntries(
		definitions.map((definition) => {
			const gated = options.gate?.(definition.name) ?? false
			const dispatch = (params: unknown, toolCallId: string | undefined) =>
				executor.execute(tenant, definition.name, params, options.surface).pipe(
					// A tool that dies (unknown tool, tenant error) fails like one that reported an error.
					// Caught before the `flatMap`, so a reported error is not wrapped a second time.
					Effect.catchCause((cause) => fail(`Tool failed: ${summarizeToolFailure(cause)}`)),
					Effect.flatMap((result) => {
						const { text, ui } = splitToolResult(definition.name, result)
						const bounded = truncateToolOutput(text).text
						if (result.isError) return fail(bounded)
						if (ui !== undefined && toolCallId !== undefined) options.onUi?.(toolCallId, ui)
						return Effect.succeed(bounded)
					}),
					Effect.tap((answer) => Effect.sync(() => options.onAnswer?.(definition.name, answer))),
				)
			const handle = (
				params: unknown,
				toolCallId: string | undefined,
			): Effect.Effect<string, typeof ToolFailure.Type> => {
				if (gated) {
					return Effect.fail(
						new ApprovalRequired({
							message: `${definition.name} requires user approval and was not executed.`,
						}),
					)
				}
				if (repeats(dispatched, definition.name, params) > IDENTICAL_CALL_LIMIT) {
					return fail(
						`${definition.name} has already been called ${IDENTICAL_CALL_LIMIT} times with these ` +
							"exact arguments in this turn. Read the result you already have, or call it differently.",
					)
				}
				return dispatch(params, toolCallId)
			}
			return [
				definition.name,
				(params: unknown, context: { readonly toolCallId?: string | undefined }) =>
					Effect.suspend(() => handle(params, context.toolCallId)),
			]
		}) as ReadonlyArray<
			// A dynamic tool's shape is known only at runtime, so the model's arguments arrive
			// unparsed and the handler parses them.
			readonly [
				string,
				(
					// oxlint-disable-next-line anti-slop/no-unknown-parameters
					params: unknown,
					context: { readonly toolCallId?: string | undefined },
				) => Effect.Effect<string, MapleToolFailure | ApprovalRequired>,
			]
		>,
	)
	// Registered as one map, so a tool added to the catalogue cannot arrive without its span content.
	// `handlers` is exposed alongside the layer because a caller that merges this toolkit with one
	// of its own must build a single handler map: two partial layers would each be missing the
	// other's tools. It is the wrapped map for the same reason.
	return { toolkit, ...toolHandlersWithContent(toolkit, handlers, options.sessionAttributes) }
}
