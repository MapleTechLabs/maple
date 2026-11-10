import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import {
	click,
	Command,
	expect as expectView,
	given,
	keydown,
	label,
	Mount,
	role,
	scene,
	text,
	type as typeInto,
} from "foldkit/scene"
import { describe, test } from "vitest"
import * as Animation from "@foldkit/ui/animation"
import * as Combobox from "@maple/views/ui/combobox"
import { CaretMessage } from "../where-autocomplete"
import { WhereFieldMessage } from "../where-field"
import { MountWhereFieldCaret } from "../where-field-command"
import { type Model, update, view } from "../../../lab/condition-builder-lab"
import type { QueryDraft } from "./draft"
import * as QueryPanel from "./panel"

// The where clause as condition rows: every pick prints the clause the text editor would hold.

const traces = (whereClause: string): QueryDraft => ({
	...resetQueryForDataSource({ ...createQueryDraft(0), id: "q", name: "A" }, "traces"),
	whereClause,
})

const hosted = (whereClause: string): Model => ({
	panel: QueryPanel.init("test"),
	queries: [traces(whereClause)],
})

const comboMounted = () => Mount.resolve(Combobox.MountCombobox, Combobox.Message.CompletedMountCombobox())

/** A picker's close animation, `generation` counting its open and close transitions. */
const pickerClosed = (id: string, generation: number) => [
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(
		Combobox.WaitForComboboxExit({ id, generation }),
		Animation.Message.EndedAnimation({ generation }),
	),
	Mount.expectEnded(Combobox.MountCombobox),
]

/** A picker's open animation. */
const pickerOpened = (generation: number) => [
	comboMounted(),
	Command.resolve(Animation.WaitForPaint, Animation.Message.CompletedWaitForPaint({ generation })),
	Command.resolve(Animation.WaitForAnimationSettled, Animation.Message.EndedAnimation({ generation })),
]

/** The text editor's caret, read when it mounts. */
const caretMounted = () =>
	Mount.resolve<string, QueryPanel.Message>(
		MountWhereFieldCaret,
		QueryPanel.Message.GotWhereField({
			message: WhereFieldMessage.GotCaret({ fieldId: "q", message: CaretMessage.BlurredEditor() }),
		}),
	)

describe("condition builder", () => {
	test("a new row picks an attribute, then typed values, and prints an OR group", () => {
		const value = role("combobox", { name: "Value for http.route" })
		scene(
			{ update, view },
			given(hosted("")),
			expectView(text("(empty where clause)")).toExist(),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			click(role("option", { name: /^Span attributes/ })),
			click(role("option", { name: /^http\.route/ })),
			...pickerClosed("cond-q-c0-field", 1),
			// Adding a row and picking its field leave the clause alone until a value completes it.
			expectView(text("(empty where clause)")).toExist(),
			typeInto(value, "/cart"),
			...pickerOpened(1),
			keydown(value, "Enter"),
			typeInto(value, "/checkout"),
			keydown(value, "Enter"),
			expectView(text('(attr.http.route = "/cart" OR attr.http.route = "/checkout")')).toExist(),
		)
	})

	test("the field picker drills into resource attributes", () => {
		const value = role("combobox", { name: "Value for host.name" })
		scene(
			{ update, view },
			given(hosted('service.name = "checkout"')),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			click(role("option", { name: /^Resource attributes/ })),
			click(role("option", { name: /^host\.name/ })),
			...pickerClosed("cond-q-c1-field", 1),
			typeInto(value, "web-1"),
			...pickerOpened(1),
			keydown(value, "Enter"),
			expectView(text('service.name = "checkout" AND resource.host.name = "web-1"')).toExist(),
		)
	})

	test("a named field holds one value: a pick replaces it and closes the list", () => {
		scene(
			{ update, view },
			given(hosted('service.name = "checkout"')),
			click(role("combobox", { name: "Value for Service" })),
			...pickerOpened(1),
			click(role("option", { name: "api" })),
			...pickerClosed("cond-q-c0-values", 2),
			expectView(text('service.name = "api"')).toExist(),
		)
	})

	test("a value with both quote kinds is refused in the open list, and Enter keeps the clause", () => {
		const value = role("combobox", { name: "Value for http.route" })
		scene(
			{ update, view },
			given(hosted('attr.http.route = "/cart"')),
			typeInto(value, `it's "x"`),
			...pickerOpened(1),
			expectView(role("status")).toHaveText(`A value can't contain both ' and "`),
			expectView(role("option", { name: /^Use/ })).not.toExist(),
			keydown(value, "Enter"),
			expectView(role("status")).toHaveText(`A value can't contain both ' and "`),
			expectView(text('attr.http.route = "/cart"')).toExist(),
		)
	})

	test("either quote alone is offered as a value", () => {
		const value = role("combobox", { name: "Value for http.route" })
		scene(
			{ update, view },
			given(hosted('attr.http.route = "/cart"')),
			typeInto(value, `it's`),
			...pickerOpened(1),
			expectView(role("option", { name: `Use "it's"` })).toExist(),
			keydown(value, "Enter"),
			expectView(text(`(attr.http.route = "/cart" OR attr.http.route = "it's")`)).toExist(),
		)
	})

	test("removing a row keeps the other clauses as the user wrote them", () => {
		scene(
			{ update, view },
			given(hosted("service = checkout AND attr.http.route exists")),
			click(label("Remove condition: http.route is set")),
			expectView(text("service = checkout")).toExist(),
		)
	})

	test("Text shows the editor over the same clause, and Builder brings the rows back", () => {
		scene(
			{ update, view },
			given(hosted('service.name = "checkout"')),
			expectView(role("group", { name: "Conditions for query A" })).toExist(),
			click(role("button", { name: "Text" })),
			caretMounted(),
			expectView(label("Where clause for query A")).toHaveValue('service.name = "checkout"'),
			expectView(role("group", { name: "Conditions for query A" })).not.toExist(),
			click(role("button", { name: "Builder" })),
			Mount.expectEnded(MountWhereFieldCaret),
			expectView(role("group", { name: "Conditions for query A" })).toExist(),
		)
	})

	test("typing in the field search and pressing Enter picks the highlighted field", () => {
		const search = role("combobox", { name: "Search Field for condition 1" })
		scene(
			{ update, view },
			given(hosted("")),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			typeInto(search, "http.ro"),
			keydown(search, "Enter"),
			...pickerClosed("cond-q-c0-field", 1),
			expectView(role("combobox", { name: "Field for condition 1: attr.http.route" })).toExist(),
		)
	})

	test("Enter on a freshly opened field list picks its first field", () => {
		scene(
			{ update, view },
			given(hosted("")),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			keydown(role("combobox", { name: "Search Field for condition 1" }), "Enter"),
			...pickerClosed("cond-q-c0-field", 1),
			expectView(role("combobox", { name: "Field for condition 1: service.name" })).toExist(),
		)
	})

	test("a clause the rows can't show stays in the text editor and says why, once", () => {
		scene(
			{ update, view },
			given(hosted('(attr.http.route = "/cart" OR attr.rpc.method = "Checkout")')),
			caretMounted(),
			expectView(text("This filter mixes fields in an OR, so it stays in Text.")).toExist(),
			// The query applies an OR of attribute filters, so nothing warns.
			expectView(text(/This OR group is not applied/)).not.toExist(),
			expectView(label("Where clause for query A")).toExist(),
			expectView(role("button", { name: "Builder" })).toBeDisabled(),
		)
	})

	test("an OR group the query drops also says which group is not applied", () => {
		scene(
			{ update, view },
			given(hosted('(service.name = "a" OR span.name = "b")')),
			caretMounted(),
			expectView(text("This filter mixes fields in an OR, so it stays in Text.")).toExist(),
			expectView(
				text(
					"This OR group is not applied: (service.name = a OR span.name = b). Only attribute filters can be OR-ed.",
				),
			).toExist(),
		)
	})

	test("an OR group on a named field stays in Text, untouched, with its reason and the dropped group", () => {
		const clause = '(service.name = "checkout" OR service.name = "worker")'
		scene(
			{ update, view },
			given(hosted(clause)),
			caretMounted(),
			expectView(label("Where clause for query A")).toHaveValue(clause),
			expectView(role("group", { name: "Conditions for query A" })).not.toExist(),
			expectView(role("button", { name: "Builder" })).toBeDisabled(),
			expectView(
				text("This OR group is on a field that can't be OR-ed, so it stays in Text."),
			).toExist(),
			// The note already says why, so the warning only names the group.
			expectView(
				text("This OR group is not applied: (service.name = checkout OR service.name = worker)."),
			).toExist(),
			expectView(text(clause)).toExist(),
		)
	})

	test("two dropped OR groups give two lines, one per group", () => {
		scene(
			{ update, view },
			given(
				hosted('(service.name = "a" OR service.name = "b") AND (span.name = "x" OR span.name = "y")'),
			),
			caretMounted(),
			expectView(
				text("This OR group is not applied: (service.name = a OR service.name = b)."),
			).toExist(),
			expectView(text("This OR group is not applied: (span.name = x OR span.name = y).")).toExist(),
		)
	})

	test("the same OR group on an attribute key reads as one row with both values", () => {
		scene(
			{ update, view },
			given(hosted('(attr.http.route = "/cart" OR attr.http.route = "/pay")')),
			expectView(role("group", { name: "Conditions for query A" })).toExist(),
			expectView(text(/stays in Text/)).not.toExist(),
			expectView(text(/This OR group is not applied/)).not.toExist(),
		)
	})

	test("typing in the text editor keeps it, even once the text reads as rows", () => {
		const editor = label("Where clause for query A")
		scene(
			{ update, view },
			given(hosted('(service.name = "a" OR span.name = "b")')),
			caretMounted(),
			typeInto(editor, 'service.name = "a"'),
			expectView(editor).toExist(),
			expectView(role("group", { name: "Conditions for query A" })).not.toExist(),
			expectView(role("button", { name: "Builder" })).not.toBeDisabled(),
		)
	})
})
