import { Effect, Schema, Array as Arr } from "effect"
import { GetAiEvaluatorRequest, ListAiEvaluatorsRequest } from "@maple/domain/http"
import type { AiEvaluationMeasures, AiEvaluationScore } from "@maple/domain/http"
import { GetEvaluationScoresOutput, ListEvaluationsOutput } from "@maple/domain/mcp-outputs"
import { AiEvaluationReadService } from "@maple/backend/services/ai-evaluations/AiEvaluationReadService"
import { type McpToolRegistrar, McpUnavailableError } from "./types"
import { CurrentMcpTenant } from "../tenant"
import { formatNumber, truncate } from "../lib/format"
import { warehouseReadToMcpHandlers } from "../lib/map-warehouse-error"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const WINDOW = P.timeWindow({ defaultHours: 24 * 7, maxHours: 24 * 30 })

/** The org is outside the `llmEvals` rollout: the tools have nothing to read. */
const refuseDisabled = (tool: string) => ({
	"@maple/http/ai-evaluations/LlmEvalsDisabledError": () =>
		Effect.fail(
			new McpUnavailableError({
				message: `${tool} needs LLM evals, which are not enabled for this organization.`,
				capability: "llm_evals",
			}),
		),
})

const passRate = (m: AiEvaluationMeasures): string => {
	const judged = m.passCount + m.failCount
	return judged === 0
		? "-"
		: `${Math.round((m.passCount / judged) * 1000) / 10}% of ${formatNumber(judged)}`
}

const meanScore = (m: AiEvaluationMeasures): string =>
	m.valueCount === 0 ? "-" : `${Math.round(m.avgValue * 1000) / 1000} (${formatNumber(m.valueCount)})`

const scoreText = (score: AiEvaluationScore): string =>
	score.value !== undefined ? String(score.value) : score.label || "-"

export function registerListEvaluationsTool(server: McpToolRegistrar) {
	server.define({
		name: "list_evaluations",
		title: "List Evaluations",
		description:
			"List the LLM evaluators that scored this org's agent traffic (OTel `gen_ai.evaluation.result` scores, from the org's own eval code or Maple): per evaluator the number of scores, the pass rate over scores with a pass/fail verdict, the mean numeric score, and how many evaluations themselves failed. Open one with `get_evaluation_scores` to see its failing scores and the sessions they graded.",
		parameters: Schema.Struct({ ...WINDOW.fields }),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Listing evaluations"],
		handler: Effect.fn("McpTool.listEvaluations")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "list_evaluations")
			const tenant = yield* CurrentMcpTenant
			const reads = yield* AiEvaluationReadService
			const result = yield* reads
				.list(tenant, new ListAiEvaluatorsRequest({ startTime: st, endTime: et }))
				.pipe(
					Effect.catchTags({
						...warehouseReadToMcpHandlers("list_evaluations"),
						...refuseDisabled("list_evaluations"),
					}),
				)
			yield* Effect.annotateCurrentSpan("result.rowCount", result.evaluators.length)
			return { timeRange: { start: st, end: et }, evaluators: result.evaluators }
		}),
		render: (output: typeof ListEvaluationsOutput.Type) => {
			const window = { start_time: output.timeRange.start, end_time: output.timeRange.end }
			return {
				title: "LLM evaluations",
				scope: [["Time range", `${output.timeRange.start} to ${output.timeRange.end}`]],
				...(output.evaluators.length === 0
					? {
							empty: {
								message: "No evaluation scores in this window.",
								hints: [
									"Scores arrive as OTel `gen_ai.evaluation.result` events (log records or span events) parented to the graded span.",
									"Widen start_time/end_time.",
								],
							},
						}
					: undefined),
				blocks:
					output.evaluators.length === 0
						? []
						: [
								doc.table(
									[
										"Evaluator",
										"Scores",
										"Pass rate",
										"Mean score",
										"Eval errors",
										"Traces",
										"Sources",
										"Last",
									],
									Arr.map(output.evaluators, (e) => [
										e.name,
										formatNumber(e.scoreCount),
										passRate(e),
										meanScore(e),
										formatNumber(e.errorCount),
										formatNumber(e.traceCount),
										truncate(Arr.join(e.sources, ", "), 30),
										e.lastSeen,
									]),
								),
							],
				next: Arr.map(Arr.filter(output.evaluators, (e) => e.failCount > 0).slice(0, 3), (e) =>
					doc.next(
						"get_evaluation_scores",
						{ name: e.name, verdict: "fail", ...window },
						`why ${e.name} fails`,
					),
				),
			}
		},
	})
}

export function registerGetEvaluationScoresTool(server: McpToolRegistrar) {
	server.define({
		name: "get_evaluation_scores",
		title: "Get Evaluation Scores",
		description:
			"One LLM evaluator's scores (name as `list_evaluations` lists it): its pass rate and mean score, the split by emitting service and environment, and its most recent individual scores, failing first, each with the explanation, the graded trace and span, and the Agent Session that trace belongs to. Pass `verdict: fail` to read only failures. Open a session with `get_agent_session`.",
		parameters: Schema.Struct({
			name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)).annotate({
				description: "The evaluator's name (`gen_ai.evaluation.name`)",
			}),
			verdict: P.optionalOneOf(["pass", "fail"], "Only scores with this verdict"),
			...WINDOW.fields,
		}),
		untrustedOutput: true,
		hints: { readOnly: true },
		phrases: ["Reading evaluation scores"],
		handler: Effect.fn("McpTool.getEvaluationScores")(function* (params) {
			const { st, et } = yield* WINDOW.resolve(params, "get_evaluation_scores")
			const tenant = yield* CurrentMcpTenant
			const reads = yield* AiEvaluationReadService
			const result = yield* reads
				.evaluator(
					tenant,
					new GetAiEvaluatorRequest({
						startTime: st,
						endTime: et,
						name: params.name,
						// No series is read (`series: false`); the request still names a bucket.
						bucketSeconds: 3600,
						...(params.verdict === undefined ? undefined : { verdict: params.verdict }),
					}),
					{ series: false },
				)
				.pipe(
					Effect.catchTags({
						...warehouseReadToMcpHandlers("get_evaluation_scores"),
						...refuseDisabled("get_evaluation_scores"),
					}),
				)
			yield* Effect.annotateCurrentSpan("result.rowCount", result.scores.length)
			return {
				timeRange: { start: st, end: et },
				name: params.name,
				...(params.verdict === undefined ? undefined : { verdict: params.verdict }),
				...(result.summary === undefined ? undefined : { summary: result.summary }),
				breakdown: result.breakdown,
				scores: result.scores,
			}
		}),
		render: (output: typeof GetEvaluationScoresOutput.Type) => {
			const summary = output.summary
			const sessions = Arr.dedupe(
				Arr.flatMap(output.scores, (s) =>
					s.verdict === "fail" && s.sessionId !== undefined ? [s.sessionId] : [],
				),
			)
			return {
				title: `Evaluation: ${output.name}`,
				scope: [
					["Time range", `${output.timeRange.start} to ${output.timeRange.end}`],
					["Verdict", output.verdict],
				],
				...(summary === undefined
					? {
							empty: {
								message: `No scores from ${output.name} in this window.`,
								hints: [
									"Check the name with `list_evaluations`, or widen start_time/end_time.",
								],
							},
						}
					: undefined),
				blocks:
					summary === undefined
						? []
						: [
								doc.text(
									`${formatNumber(summary.scoreCount)} scores over ${formatNumber(summary.traceCount)} traces. Pass rate ${passRate(summary)}. Mean score ${meanScore(summary)}. ${formatNumber(summary.errorCount)} evaluations failed to run.`,
								),
								doc.table(
									["Service", "Environment", "Scores", "Pass rate", "Mean score"],
									Arr.map(output.breakdown, (row) => [
										row.serviceName || "-",
										row.deploymentEnv || "-",
										formatNumber(row.scoreCount),
										passRate(row),
										meanScore(row),
									]),
								),
								doc.table(
									["Time", "Verdict", "Score", "Explanation", "Session", "Trace", "Span"],
									Arr.map(output.scores, (s) => [
										s.timestamp,
										s.verdict || "-",
										scoreText(s),
										truncate(s.explanation, 160) || "-",
										s.sessionId ?? "-",
										s.traceId,
										s.spanId || "-",
									]),
								),
							],
				next: Arr.map(sessions.slice(0, 3), (sessionId) =>
					doc.next(
						"get_agent_session",
						{ session_id: sessionId },
						"the session behind a failing score",
					),
				),
			}
		},
	})
}
