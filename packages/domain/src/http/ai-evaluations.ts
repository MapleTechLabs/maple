import { HttpApiEndpoint, HttpApiGroup } from "effect/http-api"
import { Schema } from "effect"
import { TinybirdDateTime } from "../query-engine"
import { BucketSeconds } from "./query-engine"
import { SessionAuthorization } from "./current-tenant"
import { HttpTaggedError } from "./error-policy"
import { warehouseReadHttpErrors } from "./warehouse"
import { EndpointAccess, requires } from "./endpoint-access"
import { AuditedRead } from "./audit-log"
import { EVALUATION_NAME_MAX } from "../gen-ai-evaluation"

// LLM evaluation reads over `ai_evaluations`: the Evals tab under Agent
// sessions, a session's scores, and the evaluation MCP tools. Internal tier, gated by the
// `llmEvals` org flag while it is internal-only.

/** The organization is outside the `llmEvals` rollout. */
export class LlmEvalsDisabledError extends HttpTaggedError<LlmEvalsDisabledError>()(
	"@maple/http/ai-evaluations/LlmEvalsDisabledError",
	{ message: Schema.String },
	{
		status: 403,
		code: "llm_evals_disabled",
		title: "LLM evals are not enabled",
		retry: "never",
		recovery: "contact_support",
		exposure: "public_message",
	},
) {}

/** Buckets one evaluator series holds at most; a finer `bucketSeconds` is widened to fit. */
export const AI_EVALUATION_SERIES_MAX_BUCKETS = 1_000

/** Traces one session-scores read accepts: a session page's loaded traces. */
export const AI_EVALUATION_SESSION_MAX_TRACES = 500

/** Volume, verdicts and mean score of a set of scores. A pass rate is `pass / (pass + fail)`. */
export const AiEvaluationMeasures = Schema.Struct({
	scoreCount: Schema.Number,
	passCount: Schema.Number,
	failCount: Schema.Number,
	/** Scores carrying a numeric value; `avgValue` is their mean, 0 when there are none. */
	valueCount: Schema.Number,
	avgValue: Schema.Number,
	/** Scores whose evaluation itself failed (`error.type`). */
	errorCount: Schema.Number,
})
export type AiEvaluationMeasures = Schema.Schema.Type<typeof AiEvaluationMeasures>

export const AiEvaluatorSummary = Schema.Struct({
	...AiEvaluationMeasures.fields,
	name: Schema.String,
	traceCount: Schema.Number,
	sources: Schema.Array(Schema.String),
	annotatorKinds: Schema.Array(Schema.String),
	/** Warehouse datetime literal. */
	lastSeen: Schema.String,
})
export type AiEvaluatorSummary = Schema.Schema.Type<typeof AiEvaluatorSummary>

export const AiEvaluationScore = Schema.Struct({
	timestamp: Schema.String,
	name: Schema.String,
	traceId: Schema.String,
	spanId: Schema.String,
	scope: Schema.String,
	/** The Agent Session the graded trace is filed under; absent when it is in none. */
	sessionId: Schema.optionalKey(Schema.String),
	/** Absent for a label-only score. */
	value: Schema.optionalKey(Schema.Number),
	label: Schema.String,
	/** `pass` / `fail` read from the label, `''` when it says neither. */
	verdict: Schema.String,
	explanation: Schema.String,
	errorType: Schema.String,
	annotatorKind: Schema.String,
	source: Schema.String,
	evaluatorVersion: Schema.String,
	judgeModel: Schema.String,
	serviceName: Schema.String,
})
export type AiEvaluationScore = Schema.Schema.Type<typeof AiEvaluationScore>

const EvaluationWindow = {
	startTime: TinybirdDateTime,
	endTime: TinybirdDateTime,
}

/**
 * The longest evaluator name a read accepts, in UTF-16 units: storage cuts names at
 * `EVALUATION_NAME_MAX` code points, which can be twice as many units (emoji, other astral text).
 */
export const AI_EVALUATOR_NAME_MAX_UNITS = EVALUATION_NAME_MAX * 2

const EvaluatorName = Schema.String.check(
	Schema.isMinLength(1),
	Schema.isMaxLength(AI_EVALUATOR_NAME_MAX_UNITS),
)

export class ListAiEvaluatorsRequest extends Schema.Class<ListAiEvaluatorsRequest>("ListAiEvaluatorsRequest")(
	{
		...EvaluationWindow,
	},
) {}

export class ListAiEvaluatorsResponse extends Schema.Class<ListAiEvaluatorsResponse>(
	"ListAiEvaluatorsResponse",
)({
	evaluators: Schema.Array(AiEvaluatorSummary),
}) {}

export class GetAiEvaluatorRequest extends Schema.Class<GetAiEvaluatorRequest>("GetAiEvaluatorRequest")({
	...EvaluationWindow,
	name: EvaluatorName,
	bucketSeconds: BucketSeconds,
	/** Only scores with this verdict in `scores`. */
	verdict: Schema.optionalKey(Schema.Literals(["pass", "fail"])),
}) {}

export const AiEvaluationBucket = Schema.Struct({
	...AiEvaluationMeasures.fields,
	bucket: Schema.String,
})
export type AiEvaluationBucket = Schema.Schema.Type<typeof AiEvaluationBucket>

export const AiEvaluationBreakdownRow = Schema.Struct({
	...AiEvaluationMeasures.fields,
	serviceName: Schema.String,
	deploymentEnv: Schema.String,
})
export type AiEvaluationBreakdownRow = Schema.Schema.Type<typeof AiEvaluationBreakdownRow>

export class GetAiEvaluatorResponse extends Schema.Class<GetAiEvaluatorResponse>("GetAiEvaluatorResponse")({
	/** Absent when the evaluator wrote nothing in the window. */
	summary: Schema.optionalKey(AiEvaluatorSummary),
	series: Schema.Array(AiEvaluationBucket),
	breakdown: Schema.Array(AiEvaluationBreakdownRow),
	/** The most recent scores, failing first. */
	scores: Schema.Array(AiEvaluationScore),
}) {}

export class GetAiSessionEvaluationsRequest extends Schema.Class<GetAiSessionEvaluationsRequest>(
	"GetAiSessionEvaluationsRequest",
)({
	...EvaluationWindow,
	/** As on `GetAiSessionSpansRequest`, including the `trace:` form. */
	sessionId: Schema.String.check(Schema.isMinLength(1)),
	/** The session's traces, as its spans read returned them. */
	traceIds: Schema.Array(Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/))).check(
		Schema.isMinLength(1),
		Schema.isMaxLength(AI_EVALUATION_SESSION_MAX_TRACES),
	),
}) {}

export class GetAiSessionEvaluationsResponse extends Schema.Class<GetAiSessionEvaluationsResponse>(
	"GetAiSessionEvaluationsResponse",
)({
	scores: Schema.Array(AiEvaluationScore),
}) {}

const errors = [...warehouseReadHttpErrors, LlmEvalsDisabledError]

export class AiEvaluationsInternalApiGroup extends HttpApiGroup.make("aiEvaluationsInternal")
	.add(
		HttpApiEndpoint.post("list", "/list", {
			payload: ListAiEvaluatorsRequest,
			success: ListAiEvaluatorsResponse,
			error: errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("evaluator", "/evaluator", {
			payload: GetAiEvaluatorRequest,
			success: GetAiEvaluatorResponse,
			error: errors,
		}),
	)
	.add(
		HttpApiEndpoint.post("session", "/session", {
			payload: GetAiSessionEvaluationsRequest,
			success: GetAiSessionEvaluationsResponse,
			error: errors,
		}),
	)
	.prefix("/internal/ai-evaluations")
	.middleware(SessionAuthorization)
	// Every endpoint here only reads telemetry.
	.annotate(EndpointAccess, requires("telemetry:read"))
	// Explanations quote prompts and completions, which are customer telemetry.
	.annotate(AuditedRead, "telemetry.read") {}
