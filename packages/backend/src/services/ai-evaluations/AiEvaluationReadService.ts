import {
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
import { Array as Arr, Context, Effect, Layer, Option, Record as Rec } from "effect"
import { CH } from "@maple/query-engine"
import * as Integrations from "@maple/query-engine-integrations"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { isMissingAiEvaluations } from "@maple/backend/services/warehouse/missing-table"

/** Scores the evaluator detail lists. */
const EVALUATOR_SCORES_LIMIT = 100
/** Scores one session read returns. */
const SESSION_SCORES_LIMIT = 500

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

/**
 * LLM evaluation reads (`ai_evaluations`) for the Evals tab, the session page and the MCP tools.
 * Every read refuses an org outside the `llmEvals` rollout, and reads as empty on a warehouse that
 * has not run migration 0071 yet.
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

	const summaries = (tenant: TenantContext, window: ListAiEvaluatorsRequest, name?: string) =>
		warehouse
			.compiledQuery(
				tenant,
				CH.compile(CH.aiEvaluationsSummaryQuery(name === undefined ? undefined : { name }), {
					orgId: tenant.orgId,
					startTime: window.startTime,
					endTime: window.endTime,
				}),
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
				Effect.catchIf(isMissingAiEvaluations, () =>
					Effect.succeed<ReadonlyArray<AiEvaluatorSummary>>([]),
				),
			)

	/** The Agent Session each graded trace is filed under, keyed by trace id. */
	const sessionsOf = (
		tenant: TenantContext,
		rows: ReadonlyArray<ScoreRow>,
		window: ListAiEvaluatorsRequest,
	) => {
		const traceIds = Arr.dedupe(Arr.map(rows, (row) => row.traceId))
		if (traceIds.length === 0) return Effect.succeed<Record<string, string>>({})
		return warehouse
			.compiledQuery(
				tenant,
				CH.compile(Integrations.aiSessionsOfTracesQuery(traceIds), {
					orgId: tenant.orgId,
					startTime: window.startTime,
					endTime: window.endTime,
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
		const evaluators = yield* summaries(tenant, payload)
		yield* Effect.annotateCurrentSpan({ "maple.ai.evaluators": evaluators.length })
		return new ListAiEvaluatorsResponse({ evaluators })
	})

	const evaluator = Effect.fn("AiEvaluationReads.evaluator")(function* (
		tenant: TenantContext,
		payload: GetAiEvaluatorRequest,
	) {
		yield* requireEnabled(tenant)
		const params = {
			orgId: tenant.orgId,
			startTime: payload.startTime,
			endTime: payload.endTime,
			name: payload.name,
		}
		const [summary, series, breakdown, scoreRows] = yield* Effect.all(
			[
				summaries(tenant, payload, payload.name),
				warehouse.compiledQuery(
					tenant,
					CH.compile(CH.aiEvaluationTimeseriesQuery(), {
						...params,
						bucketSeconds: payload.bucketSeconds,
					}),
					{ profile: "list", context: "aiEvaluationSeries" },
				),
				warehouse.compiledQuery(tenant, CH.compile(CH.aiEvaluationBreakdownQuery(), params), {
					profile: "list",
					context: "aiEvaluationBreakdown",
				}),
				warehouse.compiledQuery(
					tenant,
					CH.compile(
						CH.aiEvaluationScoresQuery({
							name: payload.name,
							limit: EVALUATOR_SCORES_LIMIT,
							...(payload.verdict === undefined ? undefined : { verdict: payload.verdict }),
						}),
						params,
					),
					{ profile: "list", context: "aiEvaluationScores" },
				),
			],
			{ concurrency: "unbounded" },
		).pipe(Effect.catchIf(isMissingAiEvaluations, () => Effect.succeed([[], [], [], []] as const)))
		const sessions = yield* sessionsOf(tenant, scoreRows, payload)
		return new GetAiEvaluatorResponse({
			...Option.match(Arr.head(summary), {
				onNone: () => ({}),
				onSome: (found) => ({ summary: found }),
			}),
			series: Arr.map(series, (row) => ({ ...measures(row), bucket: row.bucket })),
			breakdown: Arr.map(breakdown, (row) => ({
				...measures(row),
				serviceName: row.serviceName,
				deploymentEnv: row.deploymentEnv,
			})),
			scores: Arr.map(scoreRows, (row) => toScore(row, sessions[row.traceId])),
		})
	})

	const session = Effect.fn("AiEvaluationReads.session")(function* (
		tenant: TenantContext,
		payload: GetAiSessionEvaluationsRequest,
	) {
		yield* requireEnabled(tenant)
		const rows = yield* warehouse
			.compiledQuery(
				tenant,
				CH.compile(
					CH.aiEvaluationScoresQuery({
						traceIds: payload.traceIds,
						sessionId: payload.sessionId,
						limit: SESSION_SCORES_LIMIT,
					}),
					{ orgId: tenant.orgId, startTime: payload.startTime, endTime: payload.endTime },
				),
				{ profile: "list", context: "aiSessionEvaluations" },
			)
			.pipe(Effect.catchIf(isMissingAiEvaluations, () => Effect.succeed([])))
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
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(WarehouseQueryService.layer),
		Layer.provide(OrganizationFeatureFlagsService.layer),
	)
}
