import { OrgId } from "@maple/domain"
import type { AiEvaluatorSummary } from "@maple/domain/http"
import { Result, Schema, Array as Arr } from "effect"
import { AsyncData } from "foldkit"
import { expect as expectView, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../../contract"
import * as Frame from "../../kit/time-frame"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"
import { view as pageView } from "./view"

const orgId = Schema.decodeSync(OrgId)("org_acme")
const context: PageContext = { orgId, pinnedNamespace: null, timeZone: "UTC", hasLlmEvals: true }
const window = { startTime: "2026-09-25 00:00:00", endTime: "2026-10-01 12:00:00" }
const NOW = Date.parse("2026-10-01T12:00:00Z")

const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const view = withViewInputs(pageView, { context })()
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	Arr.map(commands ?? [], ({ name }) => name)

const resolved = Message.GotFrameMessage({
	message: Frame.Message.CompletedResolveWindow({ window, nowMs: NOW, locale: "en-US", mode: "Load" }),
})

const evaluator = (name: string, overrides: Partial<AiEvaluatorSummary> = {}): AiEvaluatorSummary => ({
	name,
	scoreCount: 10,
	passCount: 8,
	failCount: 2,
	valueCount: 10,
	avgValue: 0.75,
	errorCount: 0,
	traceCount: 9,
	sources: ["log"],
	annotatorKinds: ["llm"],
	lastSeen: "2026-10-01 11:00:00",
	...overrides,
})

const windowed = () => pageUpdate(init({ search: { timePreset: "1w" } }, context).model, resolved)

const answered = (rows: ReadonlyArray<AiEvaluatorSummary>): Model => {
	const entered = windowed().model
	return pageUpdate(
		entered,
		Message.CompletedFetchEvaluators({ key: entered.evaluators.key ?? "", result: Result.succeed(rows) }),
	).model
}

describe("agent evals", () => {
	test("a resolved window reads the evaluators once, and an answer for an older key is dropped", () => {
		const entered = windowed()
		expect(names(entered.commands)).toEqual(["FetchAgentEvaluators"])
		const late = pageUpdate(
			entered.model,
			Message.CompletedFetchEvaluators({ key: "old", result: Result.succeed([evaluator("stale")]) }),
		)
		expect(AsyncData.hasData(late.model.evaluators.data)).toBe(false)
	})

	test("each evaluator links to its page in the same window, with its pass rate", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				answered([
					evaluator("faithfulness", { scoreCount: 4 }),
					evaluator("answer_relevance", { scoreCount: 40 }),
				]),
			),
			expectView(role("link", { name: /answer_relevance/ })).toHaveAttr(
				"href",
				"/agent-sessions/evals/answer_relevance?timePreset=1w",
			),
			expectView(text("80.0%")).toExist(),
		)
	})

	test("an evaluator with no verdicts and no values shows a dash for pass rate and mean", () => {
		scene(
			{ update: pageUpdate, view },
			given(
				answered([
					evaluator("labels_only", { passCount: 0, failCount: 0, valueCount: 0, avgValue: 0 }),
				]),
			),
			expectView(text("labels_only")).toExist(),
			expectView(text("80.0%")).not.toExist(),
			expectView(role("link", { name: /labels_only/ })).toHaveText(/labels_only\s*[\d.K]+\s*-/),
		)
	})

	test("no scores in the window says how scores arrive", () => {
		scene(
			{ update: pageUpdate, view },
			given(answered([])),
			expectView(text("No eval scores in this window")).toExist(),
			expectView(text("gen_ai.evaluation.result")).toExist(),
		)
	})
})
