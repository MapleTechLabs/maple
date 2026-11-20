import { Submodel } from "foldkit"
import { click, expect, given, role, scene, text, withViewInputs } from "foldkit/scene"
import { describe, test } from "vitest"
import { chartSkeleton } from "@maple/views/ui/chart-skeleton"
import type { WidgetDataState } from "./data-state"
import { widgetFrame } from "./tile-shell"

// The frame's muted range error: "Show last 7 days" when the surface offers narrowing.

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

const HINT = 'no metric named "http_request_total" in the query window; did you mean "http_requests_total"?'

describe("a PromQL tile with warnings", () => {
	test("shows the hint in place of the generic advice when nothing matched", () => {
		scene(
			config,
			given({
				state: {
					_tag: "Error",
					title: null,
					message: "No data in this window",
					kind: "empty",
					warnings: [HINT],
				},
				canNarrow: false,
				clicked: 0,
			}),
			expect(text(HINT)).toExist(),
			expect(text("Widen the time range or check the query's filters.")).toBeAbsent(),
		)
	})

	test("keeps the generic advice for an empty answer without hints", () => {
		scene(
			config,
			given({
				state: { _tag: "Error", title: null, message: "No data in this window", kind: "empty" },
				canNarrow: false,
				clicked: 0,
			}),
			expect(text("Widen the time range or check the query's filters.")).toExist(),
		)
	})

	test("names the warning in the header beside data", () => {
		scene(
			config,
			given({
				state: { _tag: "Ready", data: { _tag: "Rows", rows: [] }, warnings: [HINT] },
				canNarrow: false,
				clicked: 0,
			}),
			expect(role("img", { name: HINT })).toExist(),
		)
	})
})
