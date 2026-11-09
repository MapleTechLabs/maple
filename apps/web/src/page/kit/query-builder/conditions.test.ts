import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import type { QueryDraft } from "./draft"
import { init, Message, type Model, operatorSelectId, type PanelInputs, update } from "./panel"

// The builder's operator and value steps, as the where-clause edit they emit.

const traces = (whereClause: string): QueryDraft => ({
	...resetQueryForDataSource({ ...createQueryDraft(0), id: "q", name: "A" }, "traces"),
	whereClause,
})

const inputsFor = (query: QueryDraft): PanelInputs => ({
	queryOf: (queryId) => (queryId === query.id ? query : undefined),
	baseValuesOf: () => ({ services: ["checkout", "api"] }),
	orgId: "org_test",
	window: null,
})

/** The where clause a message leaves as, or null when it leaves none. */
const emitted = (whereClause: string, message: Message, model: Model = init("test")): string | null => {
	const next = update(model, message, inputsFor(traces(whereClause)))
	const change = next.outMessage?._tag === "ChangedQuery" ? next.outMessage.change : null
	return change?._tag === "SetText" ? change.value : null
}

const pickOperator = (rowId: string, value: string) =>
	Message.GotSelectMessage({
		id: operatorSelectId("q", rowId),
		message: { _tag: "SelectedItem", index: 0, value },
	})

describe("operator", () => {
	test("is set drops the values", () => {
		expect(
			emitted('(service.name = "checkout" OR service.name = "api")', pickOperator("c0", "exists")),
		).toBe("service.name exists")
	})

	test("is not keeps every value, as AND-ed negations", () => {
		expect(emitted('(service.name = "checkout" OR service.name = "api")', pickOperator("c0", "!="))).toBe(
			'service.name != "checkout" AND service.name != "api"',
		)
	})

	test("a comparison keeps one value", () => {
		expect(
			emitted(
				"(attr.http.response.status_code = 500 OR attr.http.response.status_code = 503)",
				pickOperator("c0", ">="),
			),
		).toBe("attr.http.response.status_code >= 500")
	})
})

describe("values", () => {
	// The query engine ORs attribute filters only; a named field's "is" holds one value.
	test("a named field's new value replaces the old one", () => {
		const message = Message.GotConditionValues({
			queryId: "q",
			rowId: "c0",
			message: { _tag: "ClickedItem", value: "api" },
		})
		expect(emitted('service.name = "checkout"', message)).toBe('service.name = "api"')
	})

	test("an attribute's new value joins the OR group", () => {
		const message = Message.GotConditionValues({
			queryId: "q",
			rowId: "c0",
			message: { _tag: "ClickedItem", value: "POST" },
		})
		expect(emitted('attr.http.request.method = "GET"', message)).toBe(
			'(attr.http.request.method = "GET" OR attr.http.request.method = "POST")',
		)
	})

	test("a named field's is not keeps every value", () => {
		const message = Message.GotConditionValues({
			queryId: "q",
			rowId: "c0",
			message: { _tag: "ClickedItem", value: "api" },
		})
		expect(emitted('service.name != "checkout"', message)).toBe(
			'service.name != "checkout" AND service.name != "api"',
		)
	})

	test("a comparison's new value replaces the old one", () => {
		const message = Message.GotConditionValues({
			queryId: "q",
			rowId: "c0",
			message: { _tag: "ClickedItem", value: "404" },
		})
		expect(emitted("attr.http.response.status_code > 499", message)).toBe(
			"attr.http.response.status_code > 404",
		)
	})

	test("removing a chip removes the value", () => {
		const message = Message.GotConditionValues({
			queryId: "q",
			rowId: "c0",
			message: { _tag: "RemovedChip", value: "api" },
		})
		expect(emitted('(service.name = "checkout" OR service.name = "api")', message)).toBe(
			'service.name = "checkout"',
		)
	})
})

describe("mode", () => {
	test("switching editors is draft state, not an edit", () => {
		const next = update(
			init("test"),
			Message.ChangedWhereMode({ queryId: "q", mode: "text" }),
			inputsFor(traces("")),
		)
		expect(next.outMessage).toBeUndefined()
		expect(next.model.whereModes).toEqual({ q: "text" })
	})
})
