import { createQueryDraft, resetQueryForDataSource } from "@maple/query-engine/query-builder"
import {
	all,
	click,
	Command,
	expect as expectView,
	given,
	keydown,
	label,
	last,
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

/** The last row's value picker: the row just added. */
const newValue = last(all.role("combobox", { name: "Value" }))

describe("condition builder", () => {
	test("a new row picks an attribute, then typed values, and prints an OR group", () => {
		scene(
			{ update, view },
			given(hosted("")),
			expectView(text("(empty where clause)")).toExist(),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			click(role("option", { name: /^Span attributes/ })),
			click(role("option", { name: /^http\.route/ })),
			...pickerClosed("cond-q-c0-field", 1),
			typeInto(role("combobox", { name: "Value" }), "/cart"),
			...pickerOpened(1),
			keydown(role("combobox", { name: "Value" }), "Enter"),
			typeInto(role("combobox", { name: "Value" }), "/checkout"),
			keydown(role("combobox", { name: "Value" }), "Enter"),
			expectView(text('(attr.http.route = "/cart" OR attr.http.route = "/checkout")')).toExist(),
		)
	})

	test("the field picker drills into resource attributes", () => {
		scene(
			{ update, view },
			given(hosted('service.name = "checkout"')),
			click(role("button", { name: "Add condition" })),
			comboMounted(),
			click(role("option", { name: /^Resource attributes/ })),
			click(role("option", { name: /^host\.name/ })),
			...pickerClosed("cond-q-c1-field", 1),
			typeInto(newValue, "web-1"),
			...pickerOpened(1),
			keydown(newValue, "Enter"),
			expectView(text('service.name = "checkout" AND resource.host.name = "web-1"')).toExist(),
		)
	})

	test("removing a row prints the rest", () => {
		scene(
			{ update, view },
			given(hosted('service.name = "checkout" AND attr.http.route exists')),
			click(label("Remove condition")),
			expectView(text("attr.http.route exists")).toExist(),
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

	test("a clause the rows can't show stays in the text editor and says so", () => {
		scene(
			{ update, view },
			given(hosted('(service.name = "a" OR span.name = "b")')),
			caretMounted(),
			expectView(text("This filter uses syntax the builder can't show, edit as text")).toExist(),
			expectView(label("Where clause for query A")).toExist(),
			expectView(role("button", { name: "Builder" })).toBeDisabled(),
		)
	})
})
