import { OrgId } from "@maple/domain"
import type { AiEvaluationScore, AiEvaluatorSummary } from "@maple/domain/http"
import { Option, Result, Schema, Array as Arr } from "effect"
import {
	click,
	expect as expectView,
	expectOutMessage,
	given,
	role,
	scene,
	text,
	withViewInputs,
} from "foldkit/scene"
import { describe, expect, test } from "vitest"
import { PageOutMessage, type PageContext } from "../../contract"
import * as Frame from "../../kit/time-frame"
import { Message } from "./message"
import type { EvaluatorDetail, Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC", hasLlmEvals: true }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()

const resolved = Message.GotFrameMessage({
	message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }),
})

const summary: AiEvaluatorSummary = {
	name: "faithfulness",
	scoreCount: 3,
	passCount: 1,
	failCount: 2,
	valueCount: 3,
	avgValue: 0.4,
	errorCount: 0,
	traceCount: 3,
	sources: ["log"],
	annotatorKinds: ["llm"],
	lastSeen: "2026-10-01 11:00:00",
}

const score = (overrides: Partial<AiEvaluationScore>): AiEvaluationScore => ({
	timestamp: "2026-10-01 10:00:00",
	name: "faithfulness",
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	spanId: "00f067aa0ba902b7",
	scope: "span",
	label: "fail",
	verdict: "fail",
	explanation: "Two claims are not in the context.",
	errorType: "",
	annotatorKind: "llm",
	source: "log",
	evaluatorVersion: "",
	judgeModel: "",
	serviceName: "support-agent",
	...overrides,
})

const detail: EvaluatorDetail = {
	summary,
	series: [],
	breakdown: [
		{
			serviceName: "support-agent",
			deploymentEnv: "production",
			scoreCount: 3,
			passCount: 1,
			failCount: 2,
			valueCount: 3,
			avgValue: 0.4,
			errorCount: 0,
		},
	],
	scores: [
		score({ sessionId: "sess_1", value: 0.2 }),
		score({ spanId: "1111222233334444", verdict: "pass" }),
	],
}

const entered = (search: Model["search"] = {}) =>
	pageUpdate(init({ name: "faithfulness", search }, context).model, resolved)

const fetchInput = (
	commands: ReadonlyArray<{ readonly name: string; readonly args?: unknown }> | undefined,
) =>
	Option.getOrUndefined(
		Option.flatMap(
			Arr.findFirst(commands ?? [], ({ name }) => name === "FetchAgentEvaluator"),
			(command) =>
				typeof command.args === "object" && command.args !== null && "input" in command.args
					? Option.some(command.args.input)
					: Option.none(),
		),
	)

const answered = (value: EvaluatorDetail, search: Model["search"] = {}): Model => {
	const model = entered(search).model
	return pageUpdate(
		model,
		Message.CompletedFetchDetail({ key: model.detail.key ?? "", result: Result.succeed(value) }),
	).model
}

describe("agent evaluator", () => {
	test("the read names the evaluator and a bucket, and asks for failing scores only under Failing only", () => {
		expect(fetchInput(entered().commands)).toMatchObject({ ...window, name: "faithfulness" })
		expect(fetchInput(entered().commands)).not.toHaveProperty("verdict")
		expect(fetchInput(entered({ failing: true }).commands)).toMatchObject({ verdict: "fail" })
	})

	test("Failing only writes the URL", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(detail)),
			click(role("switch", { name: "Failing only" })),
			expectOutMessage(
				PageOutMessage.RequestedNavigation({
					url: "/agent-sessions/evals/faithfulness?failing=true",
					isReplace: false,
				}),
			),
		)
	})

	test("a score links its session and its trace at the graded span, with no time bounds a late score would miss", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered(detail)),
			expectView(text("33.3%")).toExist(),
			expectView(text("Two claims are not in the context.")).toExist(),
			expectView(role("link", { name: "sess_1" })).toHaveAttr(
				"href",
				"/agent-sessions/sess_1?span=00f067aa0ba902b7",
			),
			expectView(role("link", { name: "4bf92f3577b3" })).toHaveAttr(
				"href",
				"/traces/4bf92f3577b34da6a3ce929d0e0e4736?spanId=00f067aa0ba902b7",
			),
		)
	})

	test("a score with no trace links nowhere, and an evaluator with no verdicts draws no pass-rate chart", () => {
		const bucket = (at: string, passCount: number, failCount: number) => ({
			bucket: at,
			scoreCount: 4,
			passCount,
			failCount,
			valueCount: 4,
			avgValue: 0.5,
			errorCount: 0,
		})
		const numericOnly: EvaluatorDetail = {
			...detail,
			series: [bucket("2026-10-01 09:00:00", 0, 0), bucket("2026-10-01 10:00:00", 0, 0)],
			scores: [score({ traceId: "", verdict: "", label: "" })],
		}
		scene(
			{ update: pageUpdate, view },
			given(answered(numericOnly)),
			expectView(text("Two claims are not in the context.")).toExist(),
			expectView(role("link", { name: /^4bf92f/ })).not.toExist(),
			expectView(text("Pass rate over time")).not.toExist(),
		)
		scene(
			{ update: pageUpdate, view },
			given(
				answered({
					...detail,
					series: [bucket("2026-10-01 09:00:00", 3, 1), bucket("2026-10-01 10:00:00", 0, 4)],
				}),
			),
			expectView(text("Pass rate over time")).toExist(),
		)
	})

	test("an evaluator with no scores in the window says how scores arrive", () => {
		const { summary: _summary, ...empty } = detail
		scene(
			{ update: pageUpdate, view },
			given(answered({ ...empty, scores: [], breakdown: [] })),
			expectView(text("No scores from this evaluator in this window")).toExist(),
		)
	})
})
