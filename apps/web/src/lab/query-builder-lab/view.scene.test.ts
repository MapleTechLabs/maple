import { createFormulaDraft, createQueryDraft } from "@maple/query-engine/query-builder"
import { click, Command, expect as expectView, given, Mount, role, scene, text } from "foldkit/scene"
import { describe, test } from "vitest"
import { CreateQuery, MeasureScrollArea } from "./command"
import { Message } from "./model"
import { init, update } from "./update"
import { view } from "./view"

const model = init({
	nowMs: Date.UTC(2026, 9, 1, 12, 0, 0),
	timeZone: "UTC",
	search: {},
	queries: [
		{ ...createQueryDraft(0), id: "q0" },
		{ ...createQueryDraft(1), id: "q1" },
	],
	formulas: [{ ...createFormulaDraft(0, ["A", "B"]), id: "f0" }],
}).model

const measured = () =>
	Mount.resolve(
		MeasureScrollArea,
		Message.MeasuredScroll({ metrics: { clientHeight: 832, scrollHeight: 1401 } }),
	)

describe("query builder lab view", () => {
	test("shows the window, both queries and the formula before anything runs", () => {
		scene(
			{ update, view },
			given(model),
			measured(),
			expectView(text("Run the query to see results.")).toExist(),
			expectView(role("textbox", { name: "Where clause for query A" })).toExist(),
			expectView(role("textbox", { name: "Where clause for query B" })).toExist(),
			expectView(text("Formula F1 (executed after query runs)")).toExist(),
			expectView(text("2026-10-01 11:00:00 → 2026-10-01 12:00:00")).toExist(),
		)
	})

	test("disabling every query and running shows the no-enabled-queries error", () => {
		scene(
			{ update, view },
			given({ ...model, queries: model.queries.map((query) => ({ ...query, enabled: false })) }),
			measured(),
			click(role("button", { name: "Run query" })),
			expectView(text("No enabled queries to run")).toExist(),
		)
	})

	test("Add Query asks for a new draft and shows it as query C", () => {
		scene(
			{ update, view },
			given(model),
			measured(),
			click(role("button", { name: "Add query" })),
			Command.resolve(
				CreateQuery,
				Message.CreatedQuery({ query: { ...createQueryDraft(2), id: "q2" } }),
			),
			expectView(role("textbox", { name: "Where clause for query C" })).toExist(),
		)
	})
})
