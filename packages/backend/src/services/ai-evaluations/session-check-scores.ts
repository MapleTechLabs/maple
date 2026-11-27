// A finished Agent Session's checks as `gen_ai.evaluation.result` log records: one score per check
// that ran, plus one for the session as a whole. They go through the ingest gateway like any
// other score, so they land in `ai_evaluations` by the same views and route per org the same way.

import type { SessionCheck, SessionCheckStatus, SessionChecksReport } from "@maple/agent-sessions"
import {
	GEN_AI_EVALUATION_ATTRS as OTEL,
	GEN_AI_EVALUATION_EVENT,
	MAPLE_EVALUATION_ATTRS as MAPLE,
} from "@maple/domain/gen-ai-evaluation"
import { Array as Arr, Record as Rec } from "effect"

/** The `source` every session-check score carries. */
export const SESSION_CHECK_SOURCE = "maple_check"

/** Bumped when what a check measures changes, so a trend can be split at the change. */
export const SESSION_CHECKS_VERSION = "1"

/** The evaluator the whole session's score is filed under. */
export const SESSION_CHECKS_EVALUATOR = "Session checks"

const SCOPE_NAME = "maple.session_checks"

/** A check's evaluator name: the check's own name, marked as a session check. */
export const sessionCheckEvaluatorName = (check: Pick<SessionCheck, "name">): string =>
	`Session check: ${check.name}`

/** A warning fails its check: the score asks how often a session got through without it. */
const verdictOf = (status: SessionCheckStatus): "pass" | "fail" => (status === "passed" ? "pass" : "fail")

export interface SessionCheckScoresInput {
	readonly sessionId: string
	readonly report: SessionChecksReport
	/** The service the session's agent ran in; the score is filed under it. */
	readonly serviceName: string
	readonly scoredAtMs: number
}

const attribute = (key: string, value: string) => ({ key, value: { stringValue: value } })

const record = (
	input: SessionCheckScoresInput,
	score: {
		readonly name: string
		readonly evaluatorId: string
		readonly label: string
		readonly verdict: "pass" | "fail"
		readonly explanation: string
	},
) => ({
	timeUnixNano: `${input.scoredAtMs}000000`,
	eventName: GEN_AI_EVALUATION_EVENT,
	attributes: Arr.map(
		Rec.toEntries({
			[OTEL.name]: score.name,
			[OTEL.scoreLabel]: score.label,
			[OTEL.explanation]: score.explanation,
			[MAPLE.verdict]: score.verdict,
			[MAPLE.scope]: "session",
			[MAPLE.sessionId]: input.sessionId,
			[MAPLE.annotatorKind]: "code",
			[MAPLE.source]: SESSION_CHECK_SOURCE,
			[MAPLE.evaluatorId]: score.evaluatorId,
			[MAPLE.evaluatorVersion]: SESSION_CHECKS_VERSION,
			// Stable per session and check: a session scored again (it resumed) replaces its scores.
			[MAPLE.identifier]: score.evaluatorId,
		}),
		([key, value]) => attribute(key, value),
	),
})

/** The session's scores as one OTLP/JSON logs request. Skipped checks are not scored. */
export const sessionCheckScoresToOtlp = (input: SessionCheckScoresInput) => {
	const ran = Arr.filter(input.report.checks, (check) => check.status !== "skipped")
	const flagged = input.report.counts.failed + input.report.counts.warning
	const checkRecords = Arr.map(ran, (check) =>
		record(input, {
			name: sessionCheckEvaluatorName(check),
			evaluatorId: `session_check.${check.id}`,
			label: check.status,
			verdict: verdictOf(check.status),
			explanation: check.action === undefined ? check.headline : `${check.headline} ${check.action}`,
		}),
	)
	const overall = record(input, {
		name: SESSION_CHECKS_EVALUATOR,
		evaluatorId: "session_checks",
		label: flagged === 0 ? "passed" : input.report.counts.failed > 0 ? "failed" : "warning",
		verdict: flagged === 0 ? "pass" : "fail",
		explanation: `${input.report.verdict.status === "failed" ? "Failed" : "Completed"} ${input.report.headline}`,
	})
	return {
		resourceLogs: [
			{
				resource: { attributes: [attribute("service.name", input.serviceName)] },
				scopeLogs: [{ scope: { name: SCOPE_NAME }, logRecords: [...checkRecords, overall] }],
			},
		],
	}
}
