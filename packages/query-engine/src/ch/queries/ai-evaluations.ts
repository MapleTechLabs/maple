// LLM evaluation reads over `ai_evaluations`: one row per `gen_ai.evaluation.result` score, keyed to
// the span it grades. The Evals tab, the session page's scores and the
// evaluation MCP tools all read through these, so the numbers agree everywhere.
//
// A pass rate is `pass / (pass + fail)`: scores whose label says neither (numeric or categorical
// ones) count toward the evaluator's volume and its mean, never toward its pass rate.

import * as CH from "@maple-dev/effect-orm/expr"
import { type ColumnAccessor, from, param } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { orgIdParam } from "../tables"

type Columns = ColumnAccessor<typeof Datasources.aiEvaluations.columns>

const windowConds = ($: Columns) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	$.Timestamp.lte(param.dateTime("endTime")),
]

const measures = ($: Columns) => ({
	scoreCount: CH.count(),
	passCount: CH.countIf($.Verdict.eq("pass")),
	failCount: CH.countIf($.Verdict.eq("fail")),
	valueCount: CH.countIf($.HasScore.eq(1)),
	// avgIf over no numeric scores is NaN, which no row decoder accepts.
	avgValue: CH.ifNotFinite(CH.avgIf($.ScoreValue, $.HasScore.eq(1)), CH.lit(0)),
	errorCount: CH.countIf($.ErrorType.neq("")),
})

export interface AiEvaluationsSummaryOpts {
	/** Only this evaluator (`gen_ai.evaluation.name`). */
	readonly name?: string
	readonly limit?: number
}

/** One row per evaluator in the window: volume, verdicts, mean score, failures of the evaluator itself. */
export function aiEvaluationsSummaryQuery(opts: AiEvaluationsSummaryOpts = {}) {
	return from(Datasources.aiEvaluations)
		.select(($) => ({
			name: $.Name,
			...measures($),
			traceCount: CH.uniq($.TraceId),
			sources: CH.groupUniqArray($.Source),
			annotatorKinds: CH.groupUniqArrayIf(8)($.AnnotatorKind, $.AnnotatorKind.neq("")),
			lastSeen: CH.toString_(CH.max_($.Timestamp)),
		}))
		.where(($) => [...windowConds($), opts.name === undefined ? undefined : $.Name.eq(opts.name)])
		.groupBy("name")
		.orderBy(["scoreCount", "desc"], ["name", "asc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}

/** One evaluator's measures per time bucket (`bucketSeconds` param), oldest first. */
export function aiEvaluationTimeseriesQuery() {
	return from(Datasources.aiEvaluations)
		.select(($) => ({
			bucket: CH.toString_(CH.toStartOfInterval($.Timestamp, param.int("bucketSeconds"))),
			...measures($),
		}))
		.where(($) => [...windowConds($), $.Name.eq(param.string("name"))])
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2_000)
		.format("JSON")
}

/** One evaluator's measures split by the service that emitted the score. */
export function aiEvaluationBreakdownQuery() {
	return from(Datasources.aiEvaluations)
		.select(($) => ({
			serviceName: $.ServiceName,
			deploymentEnv: $.DeploymentEnv,
			...measures($),
		}))
		.where(($) => [...windowConds($), $.Name.eq(param.string("name"))])
		.groupBy("serviceName", "deploymentEnv")
		.orderBy(["scoreCount", "desc"])
		.limit(50)
		.format("JSON")
}

export interface AiEvaluationScoresOpts {
	/** Only this evaluator. */
	readonly name?: string
	/** Only scores grading these traces (a session's traces). */
	readonly traceIds?: ReadonlyArray<string>
	/** Also session-scope scores naming this session; only with `traceIds`. */
	readonly sessionId?: string
	readonly verdict?: "pass" | "fail"
	readonly limit?: number
}

/**
 * Individual scores, failing first then newest. With `traceIds` it is a session's scores: every
 * score grading one of its traces, plus session-scope scores naming the session. `traceIds` must
 * not be empty.
 */
export function aiEvaluationScoresQuery(opts: AiEvaluationScoresOpts = {}) {
	const traceIds = opts.traceIds
	return from(Datasources.aiEvaluations)
		.select(($) => ({
			timestamp: CH.toString_($.Timestamp),
			failing: CH.if_($.Verdict.eq("fail"), CH.lit(1), CH.lit(0)),
			name: $.Name,
			traceId: $.TraceId,
			spanId: $.SpanId,
			scope: $.Scope,
			sessionId: $.SessionId,
			scoreValue: $.ScoreValue,
			hasScore: $.HasScore,
			scoreLabel: $.ScoreLabel,
			verdict: $.Verdict,
			explanation: $.Explanation,
			errorType: $.ErrorType,
			annotatorKind: $.AnnotatorKind,
			source: $.Source,
			evaluatorVersion: $.EvaluatorVersion,
			judgeModel: $.JudgeModel,
			serviceName: $.ServiceName,
		}))
		.where(($) => [
			...windowConds($),
			opts.name === undefined ? undefined : $.Name.eq(opts.name),
			opts.verdict === undefined ? undefined : $.Verdict.eq(opts.verdict),
			traceIds === undefined
				? undefined
				: opts.sessionId === undefined
					? CH.inList($.TraceId, traceIds)
					: CH.inList($.TraceId, traceIds).or(
							$.Scope.eq("session").and($.SessionId.eq(opts.sessionId)),
						),
		])
		.orderBy(["failing", "desc"], ["timestamp", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}
