import { createQueryDraft } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import { CaretMessage } from "../where-autocomplete"
import type { QueryDraft } from "./draft"
import { init, Message, type Model, type PanelInputs, update } from "./panel"

const anchor = { left: 0, top: 0, bottom: 32, width: 400, viewportHeight: 900 }
const window = { startTime: "2026-10-17 00:00:00", endTime: "2026-10-18 00:00:00" }

const traces = (whereClause: string): QueryDraft => ({ ...createQueryDraft(0), dataSource: "traces", whereClause })

const inputsFor = (query: QueryDraft, isActive = true): PanelInputs => ({
	queryOf: (queryId) => (queryId === query.id ? query : undefined),
	baseValuesOf: () => ({ services: ["checkout", "payments"], attributeKeys: ["http.route"] }),
	orgId: "org_acme",
	window: isActive ? window : null,
})

/** Focused with `text` typed and the caret at its end. */
const typed = (query: QueryDraft, isActive = true): Model => {
	const inputs = inputsFor(query, isActive)
	const focus = CaretMessage.FocusedEditor({ cursor: query.whereClause.length, anchor })
	return update(init("test"), Message.GotWhereCaret({ queryId: query.id, message: focus }), inputs).model
}

describe("query panel where editor", () => {
	test("Enter on an open list applies the active suggestion as a where-clause edit", () => {
		const query = traces("service.name = ")
		const step = update(typed(query), Message.PressedWhereEnter({ queryId: query.id }), inputsFor(query))
		expect(step.outMessage).toMatchObject({
			_tag: "ChangedQuery",
			change: { _tag: "SetText", field: "whereClause", value: 'service.name = "checkout" ' },
		})
	})

	test("Enter with the list closed changes nothing", () => {
		const query = traces("service.name = ")
		const blurred = update(
			typed(query),
			Message.GotWhereCaret({ queryId: query.id, message: CaretMessage.BlurredEditor() }),
			inputsFor(query),
		)
		const step = update(blurred.model, Message.PressedWhereEnter({ queryId: query.id }), inputsFor(query))
		expect(step.outMessage).toBeUndefined()
	})

	test("a caret in an attribute's value asks for that key's values once the provider is active", () => {
		const query = traces("attr.http.route = ")
		const active = update(init("test"), Message.GotWhereCaret({
			queryId: query.id,
			message: CaretMessage.FocusedEditor({ cursor: query.whereClause.length, anchor }),
		}), inputsFor(query))
		expect(active.commands?.map((command) => command.name)).toEqual(["FetchQueryPanelWhereValues"])
		expect(typed(query, false).whereValues).toEqual({})
	})
})
