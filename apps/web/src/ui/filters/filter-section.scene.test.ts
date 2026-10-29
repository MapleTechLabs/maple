import { Schema } from "effect"
import { Block } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { click, Command, expect as expectView, given, role, scene, text, type } from "foldkit/scene"
import { describe, test } from "vitest"
import { filterSection } from "./filter-section"
import { FilterSectionsBlock, SaveRemembered } from "./filter-sections"

// A rail with one searchable facet: its open state, search and "Show more" belong to the bound Block.

const Model = Schema.Struct({ sections: FilterSectionsBlock.Model })
const Message = defineMessageUnion({ ToggledOption: { name: Schema.String } })

const RailDefinition = Block.makeDefinition("Rail", { Model, Message })
const SectionsBinding = RailDefinition.makeBinding(FilterSectionsBlock, { field: "sections" })
const RailComposition = RailDefinition.makeComposition({ bindings: [SectionsBinding] })

const init = RailComposition.makeInit(() => ({ model: {} }))
const update = RailComposition.makeUpdate({ ToggledOption: (model) => ({ model }) })
const view = RailComposition.makeView(
	(model, h) =>
		filterSection(h, {
			title: "Service",
			options: ["api", "web", "worker"].map((name) => ({ name, count: 1 })),
			selected: [],
			isSearchable: true,
			maxVisible: 2,
			embedSection: (viewInputs) =>
				h.block(
					SectionsBinding.embedView({ slotId: `section-${viewInputs.key}`, model: model.sections, viewInputs }),
				),
			onToggle: (name) => Message.ToggledOption({ name }),
		}) ?? h.div([], []),
)

describe("filter section", () => {
	test("show more reveals the hidden rows", () => {
		scene(
			{ update, view },
			given(init().model),
			expectView(text("worker")).not.toExist(),
			click(role("button", { name: "Show 1 more" })),
			expectView(text("worker")).toExist(),
		)
	})

	test("search narrows the rows to the matches", () => {
		scene(
			{ update, view },
			given(init().model),
			type(role("textbox"), "work"),
			expectView(text("worker")).toExist(),
			expectView(text("api")).not.toExist(),
		)
	})

	test("closing the section hides its rows and remembers it", () => {
		scene(
			{ update, view },
			given(init().model),
			click(role("button", { name: "Service" })),
			Command.expectHas(SaveRemembered),
			Command.resolve(SaveRemembered, FilterSectionsBlock.Message.CompletedSaveRemembered()),
			expectView(text("api")).not.toExist(),
		)
	})
})
