import {
	AI_EVALUATION_SERIES_MAX_BUCKETS,
	type AiEvaluationScore,
	type AiEvaluatorSummary,
	GetAiEvaluatorResponse,
	type GetAiEvaluatorRequest,
	GetAiSessionEvaluationsResponse,
	type GetAiSessionEvaluationsRequest,
	ListAiEvaluatorsResponse,
	type ListAiEvaluatorsRequest,
	LlmEvalsDisabledError,
	type TenantContext,
} from "@maple/domain/http"
import { Array as Arr, Context, Effect, Layer, Option, Order, Record as Rec, Result } from "effect"
import { CH, formatWarehouseDateTime, parseWarehouseDateTime } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { isMissingAiEvaluations } from "@maple/backend/services/warehouse/missing-table"

/** Scores the evaluator detail lists: its newest failures first, then its newest scores. */
const EVALUATOR_FAILURES_LIMIT = 50
const EVALUATOR_SCORES_LIMIT = 100
/** Scores one session read returns, per half (by trace, by session id). */
const SESSION_SCORES_LIMIT = 500
/** How far before the window a graded trace may start: an offline score lands after its trace. */
const SESSION_LOOKBACK_MS = 6 * 3_600_000

type ScoreRow = Readonly<{
	timestamp: string
	name: string
	traceId: string
	spanId: string
	responseId: string
	scope: string
	sessionId: string
	scoreValue: number
	hasScore: number
	scoreLabel: string
	verdict: string
	explanation: string
	errorType: string
	annotatorKind: string
	source: string
	evaluatorVersion: string
	judgeModel: string
	serviceName: string
}>

/** A session-scope score names its session; any other is filed under its graded trace's. */
const sessionOf = (row: ScoreRow, byTrace: Readonly<Record<string, string>>): string | undefined =>
	row.scope === "session" && row.sessionId !== "" ? row.sessionId : byTrace[row.traceId]

type ResponseSpans = Readonly<Record<string, { readonly traceId: string; readonly spanId: string }>>

/** A score that names only a provider response takes the span that response came from. */
const onResponseSpan = (row: ScoreRow, spans: ResponseSpans): ScoreRow => {
	const span = row.traceId === "" ? spans[row.responseId] : undefined
	return span === undefined ? row : { ...row, traceId: span.traceId, spanId: span.spanId }
}

const newestFirst = Order.mapInput(Order.flip(Order.String), (row: ScoreRow) => row.timestamp)

/** A series bucket no finer than the window allows, so the newest buckets are never cut off. */
const boundedBucketSeconds = (payload: GetAiEvaluatorRequest): number => {
	const spanSeconds =
		(parseWarehouseDateTime(payload.endTime) - parseWarehouseDateTime(payload.startTime)) / 1000
	return Math.max(payload.bucketSeconds, Math.ceil(spanSeconds / AI_EVALUATION_SERIES_MAX_BUCKETS))
}

const toScore = (row: ScoreRow, sessionId: string | undefined): AiEvaluationScore => ({
	timestamp: row.timestamp,
	name: row.name,
	traceId: row.traceId,
	spanId: row.spanId,
	scope: row.scope,
	...(sessionId === undefined ? undefined : { sessionId }),
	...(Number(row.hasScore) === 1 ? { value: Number(row.scoreValue) } : undefined),
	label: row.scoreLabel,
	verdict: row.verdict,
	explanation: row.explanation,
	errorType: row.errorType,
	annotatorKind: row.annotatorKind,
	source: row.source,
	evaluatorVersion: row.evaluatorVersion,
	judgeModel: row.judgeModel,
	serviceName: row.serviceName,
})

const measures = (row: {
	readonly scoreCount: number
	readonly passCount: number
	readonly failCount: number
	readonly valueCount: number
	/** Typed nullable by `avgIf`; the query maps an empty mean to 0. */
	readonly avgValue: number | null
	readonly errorCount: number
}) => ({
	scoreCount: Number(row.scoreCount),
	passCount: Number(row.passCount),
	failCount: Number(row.failCount),
	valueCount: Number(row.valueCount),
	avgValue: row.avgValue ?? 0,
	errorCount: Number(row.errorCount),
})

export interface AiEvaluatorReadOptions {
	/** Read the time series too; the MCP tool renders none. Default true. */
	readonly series?: boolean
}

/**
 * LLM evaluation reads (`ai_evaluations`) for the Evals tab, the session page and the MCP tools.
 * Every read refuses an org outside the `llmEvals` rollout, and reads as empty on a warehouse that
 * has not run migration 0072 yet. The rollout flags come from the app root, so a runtime that
 * fixes them (tests, the MCP eval runtime) is answered by the same flags as its tool gates.
 */
const make = Effect.gen(function* () {
	const warehouse = yield* WarehouseQueryService
	const featureFlags = yield* OrganizationFeatureFlagsService

	const requireEnabled = Effect.fn("AiEvaluationReads.requireEnabled")(function* (tenant: TenantContext) {
		const flags = yield* featureFlags.flags(tenant.orgId)
		if (!flags.llmEvals) {
			return yield* new LlmEvalsDisabledError({
				message: "LLM evals are not enabled for this organization.",
			})
		}
	})

	const window = (
		tenant: TenantContext,
		payload: { readonly startTime: string; readonly endTime: string },
	) => ({
		orgId: tenant.orgId,
		startTime: payload.startTime,
		endTime: payload.endTime,
	})

	const summaries = (tenant: TenantContext, payload: ListAiEvaluatorsRequest, name?: string) =>
		warehouse
			.compiledQuery(
				tenant,
				CH.compile(
					CH.aiEvaluationsSummaryQuery(name === undefined ? undefined : { name }),
					window(tenant, payload),
				),
				{ profile: "list", context: "aiEvaluationsSummary" },
			)
			.pipe(
				Effect.map(
					Arr.map((row): AiEvaluatorSummary => ({
						...measures(row),
						name: row.name,
						traceCount: Number(row.traceCount),
						sources: row.sources,
						annotatorKinds: row.annotatorKinds,
						lastSeen: row.lastSeen,
					})),
				),
			)

	const scores = (
		tenant: TenantContext,
		payload: { readonly startTime: string; readonly endTime: string },
		opts: CH.AiEvaluationScoresOpts,
		context: string,
	) =>
		warehouse.compiledQuery(
			tenant,
			CH.compile(CH.aiEvaluationScoresQuery(opts), window(tenant, payload)),
			{
				profile: "list",
				context,
			},
		)

	/** Where the graded spans can start: an offline score lands after its trace. */
	const spanWindow = (
		tenant: TenantContext,
		payload: { readonly startTime: string; readonly endTime: string },
	) => ({
		orgId: tenant.orgId,
		startTime: formatWarehouseDateTime(parseWarehouseDateTime(payload.startTime) - SESSION_LOOKBACK_MS),
		endTime: payload.endTime,
	})

	const responseSpans = (
		tenant: TenantContext,
		by: { readonly traceIds: ReadonlyArray<string> } | { readonly responseIds: ReadonlyArray<string> },
		payload: { readonly startTime: string; readonly endTime: string },
	) =>
		warehouse
			.compiledQuery(
				tenant,
				CH.compile(Integrations.aiResponseSpansQuery(by), spanWindow(tenant, payload)),
				{
					profile: "list",
					context: "aiEvaluationResponseSpans",
				},
			)
			.pipe(
				Effect.map((found): ResponseSpans =>
					Rec.fromEntries(
						Arr.map(found, (row) => [
							row.responseId,
							{ traceId: row.traceId, spanId: row.spanId },
						]),
					),
				),
			)

	/** The spans of the rows' scores that name only a response. */
	const spansOfResponses = (
		tenant: TenantContext,
		rows: ReadonlyArray<ScoreRow>,
		payload: { readonly startTime: string; readonly endTime: string },
	) => {
		const responseIds = Arr.take(
			Arr.dedupe(
				Arr.filterMap(rows, (row) =>
					row.traceId === "" && row.responseId !== ""
						? Result.succeed(row.responseId)
						: Result.failVoid,
				),
			),
			Integrations.AI_RESPONSE_SPANS_LIMIT,
		)
		return responseIds.length === 0
			? Effect.succeed<ResponseSpans>({})
			: responseSpans(tenant, { responseIds }, payload)
	}

	/** The Agent Session each graded trace is filed under, keyed by trace id. */
	const sessionsOf = (
		tenant: TenantContext,
		rows: ReadonlyArray<ScoreRow>,
		payload: ListAiEvaluatorsRequest,
	) => {
		const traceIds = Arr.dedupe(
			Arr.filter(
				Arr.map(rows, (row) => row.traceId),
				(id) => id !== "",
			),
		)
		if (traceIds.length === 0) return Effect.succeed<Record<string, string>>({})
		return warehouse
			.compiledQuery(
				tenant,
				CH.compile(Integrations.aiSessionsOfTracesQuery(traceIds), spanWindow(tenant, payload)),
				{ profile: "list", context: "aiEvaluationsSessions" },
			)
			.pipe(
				Effect.map((filed) => Rec.fromEntries(Arr.map(filed, (row) => [row.traceId, row.sessionId]))),
			)
	}

	const list = Effect.fn("AiEvaluationReads.list")(function* (
		tenant: TenantContext,
		payload: ListAiEvaluatorsRequest,
	) {
		yield* requireEnabled(tenant)
		const evaluators = yield* summaries(tenant, payload).pipe(
			Effect.catchIf(isMissingAiEvaluations, () =>
				Effect.succeed<ReadonlyArray<AiEvaluatorSummary>>([]),
			),
		)
		yield* Effect.annotateCurrentSpan({ "maple.ai.evaluators": evaluators.length })
		return new ListAiEvaluatorsResponse({ evaluators })
	})

	const evaluator = Effect.fn("AiEvaluationReads.evaluator")(function* (
		tenant: TenantContext,
		payload: GetAiEvaluatorRequest,
		options: AiEvaluatorReadOptions = {},
	) {
		yield* requireEnabled(tenant)
		const params = { ...window(tenant, payload), name: payload.name }
		// Two newest-first reads rather than one sorted on its verdict: a sort on a computed column
		// would read every score's explanation in the window to keep 100 of them.
		const failures =
			payload.verdict === "pass"
				? Effect.succeed([])
				: scores(
						tenant,
						payload,
						{ name: payload.name, verdict: "fail", limit: EVALUATOR_FAILURES_LIMIT },
						"aiEvaluationFailures",
					)
		const recent =
			payload.verdict === "fail"
				? Effect.succeed([])
				: scores(
						tenant,
						payload,
						{
							name: payload.name,
							limit: EVALUATOR_SCORES_LIMIT,
							// Disjoint from the failures read, so no score is merged away or shown twice.
							...(payload.verdict === undefined
								? { excludeVerdict: "fail" }
								: { verdict: payload.verdict }),
						},
						"aiEvaluationScores",
					)
		const read = Effect.all(
			{
				summary: summaries(tenant, payload, payload.name),
				series:
					options.series === false
						? Effect.succeed([])
						: warehouse.compiledQuery(
								tenant,
								CH.compile(CH.aiEvaluationTimeseriesQuery(), {
									...params,
									bucketSeconds: boundedBucketSeconds(payload),
								}),
								{ profile: "list", context: "aiEvaluationSeries" },
							),
				breakdown: warehouse.compiledQuery(
					tenant,
					CH.compile(CH.aiEvaluationBreakdownQuery(), params),
					{
						profile: "list",
						context: "aiEvaluationBreakdown",
					},
				),
				failures,
				recent,
			},
			{ concurrency: "unbounded" },
		)
		const found = yield* read.pipe(
			Effect.catchIf(isMissingAiEvaluations, () =>
				Effect.succeed({ summary: [], series: [], breakdown: [], failures: [], recent: [] }),
			),
		)
		const scored = [...found.failures, ...found.recent]
		const spans = yield* spansOfResponses(tenant, scored, payload)
		const scoreRows = Arr.map(scored, (row) => onResponseSpan(row, spans))
		const sessions = yield* sessionsOf(tenant, scoreRows, payload)
		return new GetAiEvaluatorResponse({
			...Option.match(Arr.head(found.summary), {
				onNone: () => undefined,
				onSome: (summary) => ({ summary }),
			}),
			series: Arr.map(found.series, (row) => ({ ...measures(row), bucket: row.bucket })),
			breakdown: Arr.map(found.breakdown, (row) => ({
				...measures(row),
				serviceName: row.serviceName,
				deploymentEnv: row.deploymentEnv,
			})),
			scores: Arr.map(scoreRows, (row) => toScore(row, sessionOf(row, sessions))),
		})
	})

	const session = Effect.fn("AiEvaluationReads.session")(function* (
		tenant: TenantContext,
		payload: GetAiSessionEvaluationsRequest,
	) {
		yield* requireEnabled(tenant)
		// Disjoint reads: by trace id (the bloom index finds them), session-scope scores that name a
		// session by session id, and scores with no trace context by the responses of the session's
		// model calls. A score naming another session is not this session's.
		const read = Effect.gen(function* () {
			const [byTrace, bySession, spans] = yield* Effect.all(
				[
					scores(
						tenant,
						payload,
						{
							traceIds: payload.traceIds,
							excludeNamedSessions: true,
							limit: SESSION_SCORES_LIMIT,
						},
						"aiSessionEvaluations",
					),
					scores(
						tenant,
						payload,
						{ sessionId: payload.sessionId, limit: SESSION_SCORES_LIMIT },
						"aiSessionScopeEvaluations",
					),
					responseSpans(tenant, { traceIds: payload.traceIds }, payload),
				],
				{ concurrency: "unbounded" },
			)
			const responseIds = Rec.keys(spans)
			const byResponse =
				responseIds.length === 0
					? []
					: yield* scores(
							tenant,
							payload,
							{ responseIds, limit: SESSION_SCORES_LIMIT },
							"aiSessionResponseEvaluations",
						)
			return Arr.map([...byTrace, ...bySession, ...byResponse], (row) => onResponseSpan(row, spans))
		})
		const found = yield* read.pipe(
			Effect.catchIf(isMissingAiEvaluations, () => Effect.succeed<ReadonlyArray<ScoreRow>>([])),
		)
		const rows = Arr.sort(found, newestFirst)
		yield* Effect.annotateCurrentSpan({ "maple.ai.session_scores": rows.length })
		return new GetAiSessionEvaluationsResponse({
			scores: Arr.map(rows, (row) => toScore(row, payload.sessionId)),
		})
	})

	return { list, evaluator, session }
})

export class AiEvaluationReadService extends Context.Service<AiEvaluationReadService>()(
	"@maple/backend/services/ai-evaluations/AiEvaluationReadService",
	{ make },
) {
	/** Needs `OrganizationFeatureFlagsService` from the app root. */
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(WarehouseQueryService.layer))
}
