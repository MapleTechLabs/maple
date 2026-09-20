import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi"
import { Schema } from "effect"
import { AlertChartPoint, AlertChartUnit } from "./alerts"
import { SessionAuthorization } from "./current-tenant"

/**
 * Apply an approval-gated AI chat proposal.
 *
 * The agent's turn *stops* on a mutating tool and records a `tool-call` with `proposed: true` and
 * no result — nothing fabricates an outcome. This endpoint is where the mutation actually happens,
 * on the user's click, authenticated as the user: it re-runs the named MCP tool under the caller's
 * org, reusing the exact tool implementation so each mutation has one source of truth.
 *
 * `sessionId` and `toolCallId` close the loop. Without them the applied result never reached the
 * transcript: the proposal stayed output-less forever, and the model's next turn was never told
 * the mutation happened — the precise failure the interrupt design exists to avoid.
 */
export class ChatApplyRequest extends Schema.Class<ChatApplyRequest>("ChatApplyRequest")({
	/** MCP tool base name, e.g. `update_dashboard_widget`. */
	tool: Schema.String,
	/** The proposed tool input (validated against the tool's own schema server-side). */
	input: Schema.Unknown,
	/** The conversation this proposal came from, so the outcome can be recorded against it. */
	sessionId: Schema.optionalKey(Schema.String),
	/** The assistant message that issued the proposal — the result attaches to it. */
	messageId: Schema.optionalKey(Schema.String),
	/** The proposed call's id, so the outcome settles that call rather than appearing loose. */
	toolCallId: Schema.optionalKey(Schema.String),
}) {}

export class ChatApplyResponse extends Schema.Class<ChatApplyResponse>("ChatApplyResponse")({
	/** Human-readable result text from the tool (joined content). */
	content: Schema.String,
	/** True when the tool ran but reported a domain-level error (e.g. validation). */
	isError: Schema.optionalKey(Schema.Boolean),
}) {}

export class ChatToolNotFoundError extends Schema.TaggedError<ChatToolNotFoundError>()(
	"@maple/http/errors/ChatToolNotFoundError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 404 },
) {}

export class ChatToolNotApplicableError extends Schema.TaggedError<ChatToolNotApplicableError>()(
	"@maple/http/errors/ChatToolNotApplicableError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatToolInvalidInputError extends Schema.TaggedError<ChatToolInvalidInputError>()(
	"@maple/http/errors/ChatToolInvalidInputError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 400 },
) {}

export class ChatToolExecutionError extends Schema.TaggedError<ChatToolExecutionError>()(
	"@maple/http/errors/ChatToolExecutionError",
	{
		tool: Schema.String,
		message: Schema.String,
	},
	{ httpApiStatus: 500 },
) {}

/**
 * The opaque, signed id of a chart an agent drew inside a reply (see
 * `chatChartId` in `@maple/db`).
 *
 * Loosely checked here for the same reason `AlertChartId` is: its structure is
 * the signer's business, and a malformed id fails verification into the same
 * uniform "no such chart" as a tampered one.
 */
export const ChatChartId = Schema.String.check(Schema.isMinLength(3), Schema.isMaxLength(1024)).annotate({
	identifier: "ChatChartId",
})

export const ChatChartRequest = Schema.Struct({
	chartId: ChatChartId,
}).annotate({ identifier: "ChatChartRequest" })

/**
 * The units the image renderer knows.
 *
 * Imported rather than restated: `AlertChartUnit` is the declaration of what
 * `@maple/widgets`' static renderer can draw, and a chart out of a reply is
 * drawn by that same renderer. A fence's own unit vocabulary is wider, and
 * `staticChartUnit` in `@maple/domain/chat-chart-spec` is what lands it here.
 */
export const ChatChartUnit = AlertChartUnit
export type ChatChartUnit = AlertChartUnit

/** One named series over the reply's time axis; `[epochMillis, value]`, oldest first. */
export const ChatChartSeries = Schema.Struct({
	name: Schema.String,
	points: Schema.Array(AlertChartPoint),
}).annotate({ identifier: "ChatChartSeries" })

/** One category and its value, for a ranking. */
export const ChatChartRankedPoint = Schema.Struct({
	name: Schema.String,
	value: Schema.Finite,
}).annotate({ identifier: "ChatChartRankedPoint" })

export class ChatChartTimeseries extends Schema.Class<ChatChartTimeseries>("ChatChartTimeseries")({
	kind: Schema.Literals(["line", "area", "bar"]),
	title: Schema.String,
	unit: ChatChartUnit,
	series: Schema.Array(ChatChartSeries),
}) {}

export class ChatChartRanked extends Schema.Class<ChatChartRanked>("ChatChartRanked")({
	kind: Schema.Literal("ranked"),
	title: Schema.String,
	unit: ChatChartUnit,
	points: Schema.Array(ChatChartRankedPoint),
}) {}

/**
 * Everything the image needs, and nothing else.
 *
 * Deliberately not the reply it came from: this is fetched by whatever renders
 * the picture, so it carries the chart's own numbers and the words drawn on
 * the card. No prose, no conversation, no org name.
 *
 * A union on `kind` rather than one class with both payloads, because a ranking
 * has categories where a timeseries has a time axis, and a renderer that has to
 * check which array is empty is a renderer that will one day draw neither.
 */
export const ChatChartResponse = Schema.Union([ChatChartTimeseries, ChatChartRanked]).annotate({
	identifier: "ChatChartResponse",
})
export type ChatChartResponse = Schema.Schema.Type<typeof ChatChartResponse>

export class ChatApiGroup extends HttpApiGroup.make("chat")
	.add(
		HttpApiEndpoint.post("apply", "/apply", {
			payload: ChatApplyRequest,
			success: ChatApplyResponse,
			error: [
				ChatToolNotFoundError,
				ChatToolNotApplicableError,
				ChatToolInvalidInputError,
				ChatToolExecutionError,
			],
		}),
	)
	.prefix("/internal/chat")
	.middleware(SessionAuthorization) {}
