import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { describe, expect, test } from "vitest"
import type { QueryDraft } from "./draft"
import { fieldPickerItems, fieldsOf } from "./condition-fields"
import { init, Message, type Model, operatorSelectId, type PanelInputs, update } from "./panel"
import { Array as Arr } from "effect"

// The builder's operator and value steps, as the where-clause edit they emit.

const draftOf = (dataSource: QueryDraft["dataSource"], whereClause: string): QueryDraft => ({
	...resetQueryForDataSource({ ...createQueryDraft(0), id: "q", name: "A" }, dataSource),
	whereClause,
})

const traces = (whereClause: string): QueryDraft => draftOf("traces", whereClause)

const inputsFor = (query: QueryDraft): PanelInputs => ({
	queryOf: (queryId) => (queryId === query.id ? query : undefined),
	baseValuesOf: () => ({ services: ["checkout", "api"] }),
	orgId: "org_test",
	window: null,
})

/** The where clause a message leaves as, or null when it leaves none. */
const emittedOn = (query: QueryDraft, message: Message, model: Model = init("test")): string | null => {
	const next = update(model, message, inputsFor(query))
	const change = next.outMessage?._tag === "ChangedQuery" ? next.outMessage.change : null
	return change?._tag === "SetText" ? change.value : null
}

const emitted = (whereClause: string, message: Message, model?: Model): string | null =>
	emittedOn(traces(whereClause), message, model)

const values = (rowId: string, message: Parameters<typeof Message.GotConditionValues>[0]["message"]) =>
	Message.GotConditionValues({ queryId: "q", rowId, message })

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

describe("rewrites", () => {
	test("adding a row leaves the clause alone until the row is complete", () => {
		expect(emitted('service.name = "checkout"', Message.ClickedAddCondition({ queryId: "q" }))).toBeNull()
	})

	test("an edit rewrites only its own clause", () => {
		expect(emitted('service = checkout AND attr.http.route = "/a"', pickOperator("c1", "exists"))).toBe(
			"service = checkout AND attr.http.route exists",
		)
	})

	test("the span select's root_only clause survives a builder edit", () => {
		expect(emitted('root_only = true AND service.name = "a"', pickOperator("c1", "!="))).toBe(
			'root_only = true AND service.name != "a"',
		)
	})

	test("clicking a single value's current value changes nothing", () => {
		expect(
			emitted('service.name = "checkout"', values("c0", { _tag: "ClickedItem", value: "checkout" })),
		).toBeNull()
	})
})

describe("refusals", () => {
	test("a typed value holding both quotes is not added", () => {
		const query = traces('attr.note = "x"')
		const typed = update(
			init("test"),
			values("c0", { _tag: "ChangedInput", value: `it's "on"` }),
			inputsFor(query),
		)
		expect(typed.outMessage).toBeUndefined()
		const entered = update(
			typed.model,
			values("c0", { _tag: "PressedInputKey", key: "Enter", items: [] }),
			inputsFor(query),
		)
		expect(entered.outMessage).toBeUndefined()
	})

	test("a product-events exclude holds one value, since a second would replace the first", () => {
		expect(
			emittedOn(
				draftOf("product_events", 'event.name != "signup"'),
				values("c0", { _tag: "ClickedItem", value: "login" }),
			),
		).toBe('event.name != "login"')
	})
})

describe("field picker highlight", () => {
	const vocabulary = { attributeKeys: ["http.route", "db.system"], resourceAttributeKeys: ["host.name"] }
	const query = traces('attr.db.system = "postgres"')
	const inputs: PanelInputs = { ...inputsFor(query), baseValuesOf: () => vocabulary }
	const fields = fieldsOf("traces", vocabulary)
	const valuesOf = (drill: "all" | "resource" | "attribute", search = "") =>
		Arr.map(fieldPickerItems(fields, drill, search), (item) => item.value)
	const field = (message: Parameters<typeof Message.GotConditionField>[0]["message"]) =>
		Message.GotConditionField({ queryId: "q", rowId: "c0", message })
	/** The model after the messages, and the value its field list highlights. */
	const after = (messages: ReadonlyArray<Message>) => {
		const model = Arr.reduce(
			messages,
			init("test"),
			(current, message) => update(current, message, inputs).model,
		)
		return { model, highlighted: model.conditionPickers["cond-q-c0-field"]?.highlighted ?? null }
	}
	const opened = field({ _tag: "ClickedTriggerOf", items: valuesOf("all") })
	const drilled = (group: "resource" | "attribute") =>
		field({ _tag: "ClickedItem", value: `@group:${group}` })

	test("opening highlights the first field when the picked one is inside a group", () => {
		expect(after([opened]).highlighted).toBe(0)
	})

	test("drilling into the picked field's group highlights it, not the back row", () => {
		const { highlighted } = after([opened, drilled("attribute")])
		expect(valuesOf("attribute")[highlighted ?? -1]).toBe("attr.db.system")
	})

	test("drilling into another group highlights its first field", () => {
		const { highlighted } = after([opened, drilled("resource")])
		expect(valuesOf("resource")[highlighted ?? -1]).toBe("resource.host.name")
	})

	test("going back highlights the group that was open", () => {
		const { highlighted } = after([
			opened,
			drilled("resource"),
			field({ _tag: "ClickedItem", value: "@back" }),
		])
		expect(valuesOf("all")[highlighted ?? -1]).toBe("@group:resource")
	})

	test("Enter after a search picks the first match", () => {
		const { model } = after([
			opened,
			field({ _tag: "ChangedInput", value: "http.ro" }),
			field({
				_tag: "PressedInputKey",
				key: "Enter",
				items: valuesOf("all", "http.ro"),
				isUnfiltered: true,
			}),
		])
		expect(model.conditions["q"]?.[0]?.key).toBe("attr.http.route")
	})
})
