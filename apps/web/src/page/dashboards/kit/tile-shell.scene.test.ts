import { Submodel } from "foldkit"
import { click, expect, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { chartSkeleton } from "../../../ui/chart-skeleton"
import type { WidgetDataState } from "./data-state"
import { widgetFrame } from "./tile-shell"

// `WidgetFrame`'s muted range error: "Show last 7 days" when the surface offers narrowing.

type Model = Readonly<{ state: WidgetDataState; canNarrow: boolean; clicked: number }>
type Message = "ClickedNarrow"

const tile = withViewInputs(
	Submodel.defineView<Model, Message, Record<string, never>>((model, _inputs, h) =>
		h.div(
			[],
			[
				widgetFrame<Message>(
					h,
					{
						widgetId: "logs",
						hasGrip: false,
						title: "Recent logs",
						isEdit: false,
						menu: null,
						isMenuOpen: false,
						contentClassName: undefined,
						state: model.state,
						loadingSkeleton: chartSkeleton(h, "line"),
						configure: null,
						narrowRange: model.canNarrow ? "ClickedNarrow" : null,
					},
					() => [],
				),
				h.span([], [`narrowed ${model.clicked}`]),
			],
		),
	),
	{},
)()

const range: WidgetDataState = {
	_tag: "Error",
	title: "Range too wide for this list",
	message: null,
	kind: "range",
}
const config = {
	update: (model: Model, _message: Message) => ({ model: { ...model, clicked: model.clicked + 1 } }),
	view: tile,
}

describe("a list tile blocked by the list cap", () => {
	test("offers to narrow when the surface can, and the click reaches it", () => {
		scene(
			config,
			given({ state: range, canNarrow: true, clicked: 0 }),
			click(role("button", { name: "Show last 7 days" })),
			expect(text("narrowed 1")).toExist(),
		)
	})

	test("shows no CTA where the surface cannot narrow (a share)", () => {
		scene(
			config,
			given({ state: range, canNarrow: false, clicked: 0 }),
			expect(role("button", { name: "Show last 7 days" })).toBeAbsent(),
		)
	})
})
