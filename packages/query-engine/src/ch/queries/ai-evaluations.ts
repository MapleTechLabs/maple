// LLM evaluation reads over `ai_evaluations`: one row per `gen_ai.evaluation.result` score, keyed to
// the span it grades. The Evals tab, the session page's scores and the
// evaluation MCP tools all read through these, so the numbers agree everywhere.
//
// Every read counts a re-scored target once (`latestScores`). A pass rate is `pass / (pass + fail)`:
// scores whose label says neither (numeric or categorical ones) count toward the evaluator's volume
// and its mean, never toward its pass rate.

import * as CH from "@maple-dev/effect-orm/expr"
import { type ColumnAccessor, from, fromQuery, param } from "@maple-dev/effect-orm/clickhouse"
import * as Datasources from "@maple/domain/tinybird/datasources"
import { EVALUATION_SESSION_SCORES_TAIL_MS } from "@maple/domain/gen-ai-evaluation"
import { orgIdParam } from "../tables"

type Columns = ColumnAccessor<typeof Datasources.aiEvaluations.columns>

/** `tailSeconds` reads scores written that long after the window ends (judges score late). */
const windowConds = ($: Columns, tailSeconds = 0) => [
	$.OrgId.eq(orgIdParam),
	$.Timestamp.gte(param.dateTime("startTime")),
	tailSeconds === 0
		? $.Timestamp.lte(param.dateTime("endTime"))
		: $.Timestamp.lte(CH.intervalAdd(param.dateTime("endTime"), tailSeconds)),
]

/**
 * The window's scores, one per re-scored target: a later score with the same target, evaluator
 * and `Identifier` replaces the earlier one. A keyed session-scope score's target is its named
 * session, so a judge re-scoring a session from another trace replaces its earlier score. A score with no identifier is keyed by its timestamp
 * and content, so only an exact resend (an OTLP retry) merges into it. `conds` narrow the raw rows, and may only
 * name columns of the key; a filter on what a re-score can change (the verdict) goes outside.
 */
const latestScores = (
	conds: ($: Columns) => ReadonlyArray<CH.Condition | undefined> = () => [],
	tailSeconds = 0,
) =>
	fromQuery(
		from(Datasources.aiEvaluations)
			.select(($) => ({
				// What the score grades: a keyed session-scope score grades its named session wherever
				// it was emitted; any other grades the span, trace or response it carries.
				target: CH.if_(
					$.Scope.eq("session").and($.SessionId.neq("")).and($.Identifier.neq("")),
					CH.lit(""),
					CH.concat($.TraceId, CH.lit(":"), $.SpanId, CH.lit(":"), $.ResponseId),
				),
				traceId: CH.argMax($.TraceId, $.Timestamp),
				spanId: CH.argMax($.SpanId, $.Timestamp),
				responseId: CH.argMax($.ResponseId, $.Timestamp),
				name: $.Name,
				scope: $.Scope,
				sessionId: $.SessionId,
				scoreKey: CH.if_(
					$.Identifier.eq(""),
					CH.toString_(
						CH.cityHash64($.Timestamp, $.ScoreValue, $.ScoreLabel, $.Verdict, $.Explanation),
					),
					$.Identifier,
				),
				at: CH.max_($.Timestamp),
				scoreValue: CH.argMax($.ScoreValue, $.Timestamp),
				hasScore: CH.argMax($.HasScore, $.Timestamp),
				scoreLabel: CH.argMax($.ScoreLabel, $.Timestamp),
				verdict: CH.argMax($.Verdict, $.Timestamp),
				explanation: CH.argMax($.Explanation, $.Timestamp),
				errorType: CH.argMax($.ErrorType, $.Timestamp),
				annotatorKind: CH.argMax($.AnnotatorKind, $.Timestamp),
				source: CH.argMax($.Source, $.Timestamp),
				evaluatorVersion: CH.argMax($.EvaluatorVersion, $.Timestamp),
				judgeModel: CH.argMax($.JudgeModel, $.Timestamp),
				serviceName: CH.argMax($.ServiceName, $.Timestamp),
				deploymentEnv: CH.argMax($.DeploymentEnv, $.Timestamp),
			}))
			.where(($) => [...windowConds($, tailSeconds), ...conds($)])
			.groupBy("target", "name", "scope", "sessionId", "scoreKey"),
		"scores",
	)

/** The columns of `latestScores` a measure reads. */
interface ScoreColumns {
	readonly verdict: CH.Expr<string>
	readonly hasScore: CH.Expr<number>
	readonly scoreValue: CH.Expr<number>
	readonly errorType: CH.Expr<string>
}

const measures = ($: ScoreColumns) => ({
	scoreCount: CH.count(),
	passCount: CH.countIf($.verdict.eq("pass")),
	failCount: CH.countIf($.verdict.eq("fail")),
	valueCount: CH.countIf($.hasScore.eq(1)),
	// avgIf over no numeric scores is NaN, which no row decoder accepts.
	avgValue: CH.ifNotFinite(CH.avgIf($.scoreValue, $.hasScore.eq(1)), CH.lit(0)),
	errorCount: CH.countIf($.errorType.neq("")),
})

export interface AiEvaluationsSummaryOpts {
	/** Only this evaluator (`gen_ai.evaluation.name`). */
	readonly name?: string
	readonly limit?: number
}

/** One row per evaluator in the window: volume, verdicts, mean score, failures of the evaluator itself. */
export function aiEvaluationsSummaryQuery(opts: AiEvaluationsSummaryOpts = {}) {
	return (
		// A score with no `gen_ai.evaluation.name` belongs to no evaluator.
		latestScores(($) => [$.Name.neq(""), opts.name === undefined ? undefined : $.Name.eq(opts.name)])
			.select(($) => ({
				name: $.name,
				...measures($),
				traceCount: CH.uniqIf($.traceId, $.traceId.neq("")),
				sources: CH.groupUniqArrayIf(8)($.source, $.source.neq("")),
				annotatorKinds: CH.groupUniqArrayIf(8)($.annotatorKind, $.annotatorKind.neq("")),
				lastSeen: CH.toString_(CH.max_($.at)),
			}))
			.groupBy("name")
			.orderBy(["scoreCount", "desc"], ["name", "asc"])
			.limit(opts.limit ?? 200)
			.format("JSON")
	)
}

const byName = ($: Columns) => [$.Name.eq(param.string("name"))]

/** One evaluator's measures per time bucket (`bucketSeconds` param), oldest first. */
export function aiEvaluationTimeseriesQuery() {
	return latestScores(byName)
		.select(($) => ({
			bucket: CH.toString_(CH.toStartOfInterval($.at, param.int("bucketSeconds"))),
			...measures($),
		}))
		.groupBy("bucket")
		.orderBy(["bucket", "asc"])
		.limit(2_000)
		.format("JSON")
}

/** One evaluator's measures split by the service that emitted the score. */
export function aiEvaluationBreakdownQuery() {
	return latestScores(byName)
		.select(($) => ({
			serviceName: $.serviceName,
			deploymentEnv: $.deploymentEnv,
			...measures($),
		}))
		.groupBy("serviceName", "deploymentEnv")
		.orderBy(["scoreCount", "desc"])
		.limit(50)
		.format("JSON")
}

/** One evaluator's latest verdict, the Agent Sessions list's evaluation filter. */
export interface AiEvaluationMatch {
	readonly name: string
	readonly verdict: "pass" | "fail"
}

/**
 * What an evaluation filter matches, over the window's latest scores: the sessions its
 * session-scope scores name, and the traces its other scores grade (filed under each trace's
 * session). A score naming only a response matches neither.
 */
/** A session in the window matches on scores written up to this long after it, as its page reads. */
const SESSION_SCORES_TAIL_SECONDS = EVALUATION_SESSION_SCORES_TAIL_MS / 1000

export function aiEvaluationMatchSubqueries(match: AiEvaluationMatch) {
	const named = ($: Columns) => $.Scope.eq("session").and($.SessionId.neq(""))
	return {
		sessionIds: latestScores(($) => [$.Name.eq(match.name), named($)], SESSION_SCORES_TAIL_SECONDS)
			.select(($) => ({ sessionId: $.sessionId }))
			.where(($) => [$.verdict.eq(match.verdict)]),
		traceIds: latestScores(
			($) => [$.Name.eq(match.name), $.TraceId.neq(""), CH.not(named($))],
			SESSION_SCORES_TAIL_SECONDS,
		)
			.select(($) => ({ traceId: $.traceId }))
			.where(($) => [$.verdict.eq(match.verdict)]),
	}
}

export interface AiEvaluationScoresOpts {
	/** Only this evaluator. */
	readonly name?: string
	/** Only scores grading these traces (a session's traces); must not be empty. */
	readonly traceIds?: ReadonlyArray<string>
	/** Only session-scope scores naming this session. */
	readonly sessionId?: string
	/** Only scores with no trace context that name one of these responses; must not be empty. */
	readonly responseIds?: ReadonlyArray<string>
	readonly verdict?: "pass" | "fail"
	/** Leaves this verdict out, so a read can be disjoint from one asking for it. */
	readonly excludeVerdict?: "fail"
	/** Leaves out session-scope scores that name a session: the session-id read owns those. */
	readonly excludeNamedSessions?: boolean
	readonly limit?: number
}

/**
 * Individual scores, newest first. A session's scores are separate reads, by its traces, by its
 * session id and by its responses: one `OR` of them would scan every row the org has in the window.
 */
export function aiEvaluationScoresQuery(opts: AiEvaluationScoresOpts = {}) {
	const traceIds = opts.traceIds
	const sessionId = opts.sessionId
	const responseIds = opts.responseIds
	return latestScores(($) => [
		opts.name === undefined ? undefined : $.Name.eq(opts.name),
		opts.excludeNamedSessions === true ? $.Scope.neq("session").or($.SessionId.eq("")) : undefined,
		traceIds === undefined ? undefined : CH.inList($.TraceId, traceIds),
		sessionId === undefined ? undefined : $.Scope.eq("session").and($.SessionId.eq(sessionId)),
		responseIds === undefined ? undefined : $.TraceId.eq("").and(CH.inList($.ResponseId, responseIds)),
	])
		.select(($) => ({
			timestamp: CH.toString_($.at),
			name: $.name,
			traceId: $.traceId,
			spanId: $.spanId,
			responseId: $.responseId,
			scope: $.scope,
			sessionId: $.sessionId,
			scoreValue: $.scoreValue,
			hasScore: $.hasScore,
			scoreLabel: $.scoreLabel,
			verdict: $.verdict,
			explanation: $.explanation,
			errorType: $.errorType,
			annotatorKind: $.annotatorKind,
			source: $.source,
			evaluatorVersion: $.evaluatorVersion,
			judgeModel: $.judgeModel,
			serviceName: $.serviceName,
		}))
		.where(($) => [
			opts.verdict === undefined ? undefined : $.verdict.eq(opts.verdict),
			opts.excludeVerdict === undefined ? undefined : $.verdict.neq(opts.excludeVerdict),
		])
		.orderBy(["timestamp", "desc"])
		.limit(opts.limit ?? 200)
		.format("JSON")
}
