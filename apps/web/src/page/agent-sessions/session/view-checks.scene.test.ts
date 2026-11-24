import type { AiEvaluationScore } from "@maple/domain/http"
import type { Html, HtmlBuilder } from "foldkit/html"
import { expect, given, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import type { Message } from "./message"
import { sessionScores } from "./view-checks"

const score = (name: string, spanId: string, scope: string): AiEvaluationScore => ({
	timestamp: "2026-11-22 10:00:00.000000000",
	name,
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	spanId,
	scope,
	label: "pass",
	verdict: "pass",
	explanation: "",
	errorType: "",
	annotatorKind: "llm",
	source: "otel",
	evaluatorVersion: "",
	judgeModel: "",
	serviceName: "agent",
})

const scores = [
	score("Groundedness", "00f067aa0ba902b7", "span"),
	score("Answer quality of the whole run", "", "trace"),
]

const view = (_model: null, h: HtmlBuilder<Message>): Html =>
	h.div([], [...sessionScores(h, scores, undefined)])

describe("session scores", () => {
	test("a span score opens its span; a trace score has no span, so it is no button, and long names keep a title", () => {
		scene(
			{ update: (model: null) => ({ model }), view },
			given(null),
			expect(role("button", { name: /Groundedness/ })).toExist(),
			expect(role("button", { name: /Answer quality/ })).not.toExist(),
			expect(text("Answer quality of the whole run")).toHaveAttr(
				"title",
				"Answer quality of the whole run",
			),
		)
	})
})
