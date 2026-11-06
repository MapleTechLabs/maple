import { expect as expectView, given, scene, text } from "foldkit/scene"
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
