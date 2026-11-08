import { expect as expectView, given, placeholder, scene, text } from "foldkit/scene"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Schema } from "effect"
import { describe, test } from "vitest"
import { filterSection } from "./filter-section"
import type * as FilterSections from "./filter-sections"

const Message = defineMessageUnion({ Toggled: { name: Schema.String }, GotSections: {} })
type Message = typeof Message.Type

const LABELS = new Map([["grp_1", "Acme Inc."]])

const sectionsSearching = (search: string): FilterSections.Model => ({
	remembered: {},
	sections: { Group: { isOpen: true, isShowingAll: false, search } },
})

const view = (model: FilterSections.Model, h: HtmlBuilder<Message>): Html =>
	filterSection(h, {
		title: "Group",
		options: [
			{ name: "grp_1", count: 3 },
			{ name: "grp_2", count: 1 },
		],
		selected: [],
		isSearchable: true,
		sections: model,
		toSectionsMessage: () => Message.GotSections(),
		onToggle: (name) => Message.Toggled({ name }),
		getOptionLabel: (name) => LABELS.get(name) ?? name,
	}) ?? h.div([], [])
const update = (model: FilterSections.Model) => ({ model, commands: [] })

describe("filter section search", () => {
	test("finds an option by the label it shows, not only by its value", () => {
		scene(
			{ update, view },
			given(sectionsSearching("acme")),
			expectView(text("Acme Inc.")).toExist(),
			expectView(text("grp_2")).not.toExist(),
		)
	})

	test("still finds an option by its value", () => {
		scene(
			{ update, view },
			given(sectionsSearching("grp_2")),
			expectView(text("grp_2")).toExist(),
			expectView(text("Acme Inc.")).not.toExist(),
		)
	})
})

const idle: FilterSections.Model = { remembered: {}, sections: {} }

const names = (count: number) => Array.from({ length: count }, (_, i) => ({ name: `grp_${i}`, count: 1 }))

const listView =
	(options: ReadonlyArray<{ name: string; count: number }>, selected: ReadonlyArray<string>) =>
	(model: FilterSections.Model, h: HtmlBuilder<Message>): Html =>
		filterSection(h, {
			title: "Group",
			options,
			selected,
			isSearchable: true,
			sections: model,
			toSectionsMessage: () => Message.GotSections(),
			onToggle: (name) => Message.Toggled({ name }),
		}) ?? h.div([], [])

describe("filter section search box", () => {
	test("is left out while every value fits in the list", () => {
		scene(
			{ update, view: listView(names(5), []) },
			given(idle),
			expectView(placeholder("Search group…")).not.toExist(),
		)
	})

	test("shows once the list has more values than it shows", () => {
		scene(
			{ update, view: listView(names(6), []) },
			given(idle),
			expectView(placeholder("Search group…")).toExist(),
		)
	})

	test("counts a selected value the options no longer carry", () => {
		scene(
			{ update, view: listView(names(5), ["grp_gone"]) },
			given(idle),
			expectView(placeholder("Search group…")).toExist(),
		)
	})
})
