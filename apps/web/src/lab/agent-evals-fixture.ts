import type {
	AiEvaluationBreakdownRow,
	AiEvaluationBucket,
	AiEvaluationScore,
	AiEvaluatorSummary,
} from "@maple/domain/http"
import { formatWarehouseDateTime } from "@maple/query-engine"
import { Array as Arr } from "effect"
import type { EvaluatorDetail } from "../page/agent-sessions/evaluator/model"

// The Evals lab's fixture: a week of scores from four evaluators, one of them failing a third of
// the time, and the scores one agent session carries.

/** The fixture's clock: Nov 20, 2026, 12:00 UTC. */
export const EVALS_NOW_MS = Date.UTC(2026, 10, 20, 12)
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

export const EVALS_WINDOW = {
	startTime: formatWarehouseDateTime(EVALS_NOW_MS - 7 * DAY),
	endTime: formatWarehouseDateTime(EVALS_NOW_MS),
}

const at = (hoursAgo: number) => formatWarehouseDateTime(EVALS_NOW_MS - hoursAgo * HOUR)

const measures = (
	scoreCount: number,
	passCount: number,
	failCount: number,
	avgValue: number,
	errorCount = 0,
) => ({
	scoreCount,
	passCount,
	failCount,
	filterablePassCount: passCount,
	filterableFailCount: failCount,
	valueCount: avgValue < 0 ? 0 : scoreCount - errorCount,
	avgValue: avgValue < 0 ? 0 : avgValue,
	errorCount,
})

export const EVALUATORS: ReadonlyArray<AiEvaluatorSummary> = [
	{
		name: "answer_relevance",
		...measures(4_812, 4_590, 222, 0.91),
		traceCount: 4_640,
		sources: ["log"],
		annotatorKinds: ["llm"],
		lastSeen: at(0.2),
	},
	{
		name: "faithfulness",
		...measures(2_204, 1_398, 731, 0.64, 75),
		traceCount: 2_190,
		sources: ["log", "span_event"],
		annotatorKinds: ["llm"],
		lastSeen: at(1.5),
	},
	{
		name: "tool_call_accuracy",
		...measures(918, 0, 0, 0.83),
		traceCount: 902,
		sources: ["span_event"],
		annotatorKinds: ["code"],
		lastSeen: at(6),
	},
	{
		name: "human_review_with_a_long_name_from_the_support_queue",
		...measures(37, 29, 8, -1),
		traceCount: 37,
		sources: ["log"],
		annotatorKinds: ["human"],
		lastSeen: at(30),
	},
]

/** `faithfulness` per 12h bucket: steady, then a regression over the last two days. */
const FAITHFULNESS_SERIES: ReadonlyArray<AiEvaluationBucket> = Arr.map(Arr.range(0, 13), (index) => {
	const pass = index < 10 ? 120 : 45
	const fail = index < 10 ? 40 : 70
	return {
		bucket: formatWarehouseDateTime(EVALS_NOW_MS - 7 * DAY + index * 12 * HOUR),
		...measures(pass + fail, pass, fail, index < 10 ? 0.72 : 0.41),
	}
})

const FAITHFULNESS_BREAKDOWN: ReadonlyArray<AiEvaluationBreakdownRow> = [
	{ serviceName: "support-agent", deploymentEnv: "production", ...measures(1_620, 1_101, 452, 0.68, 67) },
	{ serviceName: "support-agent", deploymentEnv: "staging", ...measures(412, 230, 179, 0.52, 3) },
	{ serviceName: "billing-copilot", deploymentEnv: "production", ...measures(172, 67, 100, 0.47, 5) },
]

const SESSION_ID = "sess_8c2e41f0"

const score = (
	fields: Partial<AiEvaluationScore> & Pick<AiEvaluationScore, "name" | "spanId" | "verdict">,
): AiEvaluationScore => ({
	timestamp: at(2),
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	scope: "span",
	label: fields.verdict,
	explanation: "",
	errorType: "",
	annotatorKind: "llm",
	source: "log",
	evaluatorVersion: "v3",
	judgeModel: "claude-sonnet-4-5",
	serviceName: "support-agent",
	...fields,
})

const FAITHFULNESS_SCORES: ReadonlyArray<AiEvaluationScore> = [
	score({
		name: "faithfulness",
		spanId: "00f067aa0ba902b7",
		verdict: "fail",
		value: 0.18,
		sessionId: SESSION_ID,
		explanation:
			"The answer states the refund window is 60 days; the retrieved policy document says 30 days. Two of four claims are unsupported by the context.",
	}),
	score({
		name: "faithfulness",
		spanId: "5c1a3e2f9d7b4a60",
		verdict: "fail",
		value: 0.32,
		timestamp: at(5),
		traceId: "a1e3c5d7f9b2468ace0f1b3d5e7f9a2c",
		explanation: "Cites an order number that does not appear in the tool result.",
	}),
	score({
		name: "faithfulness",
		spanId: "7d2b9e4f1a3c5e60",
		verdict: "",
		label: "",
		errorType: "JudgeTimeout",
		timestamp: at(9),
		traceId: "b2f4d6e8a0c2e4f6a8b0c2d4e6f8a0b2",
		sessionId: "sess_19d0aa7c",
	}),
	score({
		name: "faithfulness",
		spanId: "9e4c1b7a3d5f2e80",
		verdict: "pass",
		value: 0.94,
		timestamp: at(12),
		traceId: "c3a5e7091b3d5f7a9c1e3a5c7e9a1c3e",
		sessionId: "sess_19d0aa7c",
		explanation: "Every claim is supported by the retrieved context.",
	}),
]

export const FAITHFULNESS_DETAIL: EvaluatorDetail = {
	summary: EVALUATORS[1],
	series: FAITHFULNESS_SERIES,
	breakdown: FAITHFULNESS_BREAKDOWN,
	scores: FAITHFULNESS_SCORES,
}

/** "Failing only": the same read with `verdict=fail`, so only the scores narrow. */
export const FAITHFULNESS_FAILING: EvaluatorDetail = {
	...FAITHFULNESS_DETAIL,
	scores: Arr.filter(FAITHFULNESS_SCORES, (row) => row.verdict === "fail"),
}

/** The scores one session's traces carry: a failing judge, a passing one and a label-only review. */
export const SESSION_SCORES: ReadonlyArray<AiEvaluationScore> = [
	score({
		name: "answer_relevance",
		spanId: "1a2b3c4d5e6f7081",
		verdict: "pass",
		value: 0.88,
		sessionId: SESSION_ID,
		explanation: "Addresses the refund question directly.",
	}),
	FAITHFULNESS_SCORES[0] ?? score({ name: "faithfulness", spanId: "00f067aa0ba902b7", verdict: "fail" }),
	score({
		name: "human_review_with_a_long_name_from_the_support_queue",
		spanId: "1a2b3c4d5e6f7081",
		verdict: "",
		label: "needs-follow-up",
		annotatorKind: "human",
		sessionId: SESSION_ID,
		explanation: "",
	}),
]
