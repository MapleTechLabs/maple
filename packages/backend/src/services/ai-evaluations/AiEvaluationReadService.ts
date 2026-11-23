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
import { Array as Arr, Context, Effect, Layer, Option, Order, Record as Rec } from "effect"
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

const scoreKey = (row: ScoreRow): string => `${row.timestamp}|${row.traceId}|${row.spanId}|${row.name}`

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
 * has not run migration 0071 yet. The rollout flags come from the app root, so a runtime that
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

	/** The Agent Session each graded trace is filed under, keyed by trace id. */
	const sessionsOf = (
		tenant: TenantContext,
		rows: ReadonlyArray<ScoreRow>,
		payload: ListAiEvaluatorsRequest,
	) => {
		const traceIds = Arr.dedupe(Arr.map(rows, (row) => row.traceId))
		if (traceIds.length === 0) return Effect.succeed<Record<string, string>>({})
		return warehouse
			.compiledQuery(
				tenant,
				CH.compile(Integrations.aiSessionsOfTracesQuery(traceIds), {
					orgId: tenant.orgId,
					startTime: formatWarehouseDateTime(
						parseWarehouseDateTime(payload.startTime) - SESSION_LOOKBACK_MS,
					),
					endTime: payload.endTime,
				}),
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
							...(payload.verdict === undefined ? undefined : { verdict: payload.verdict }),
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
		const failureKeys = new Set(Arr.map(found.failures, scoreKey))
		const scoreRows = [
			...found.failures,
			...Arr.filter(found.recent, (row) => !failureKeys.has(scoreKey(row))),
		]
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
		// Two reads: by trace id (the bloom index finds them) and session-scope scores by session id.
		const halves = yield* Effect.all(
			[
				scores(
					tenant,
					payload,
					{ traceIds: payload.traceIds, limit: SESSION_SCORES_LIMIT },
					"aiSessionEvaluations",
				),
				scores(
					tenant,
					payload,
					{ sessionId: payload.sessionId, limit: SESSION_SCORES_LIMIT },
					"aiSessionScopeEvaluations",
				),
			],
			{ concurrency: "unbounded" },
		).pipe(Effect.catchIf(isMissingAiEvaluations, () => Effect.succeed([[], []] as const)))
		const rows = Arr.sort(
			Arr.dedupeWith([...halves[0], ...halves[1]], (a, b) => scoreKey(a) === scoreKey(b)),
			newestFirst,
		)
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
