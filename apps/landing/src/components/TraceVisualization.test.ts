import * as TraceFlow from "@maple/views/service-map/trace-flow/trace-flow"
import * as Flamegraph from "@maple/views/traces/flamegraph"
import { Option, Array as Arr, String as Str } from "effect"
import { describe, expect, it } from "vitest"
import renderer from "../foldkit-island/server"
import { init, TraceVisualization, update } from "./TraceVisualization"
import { Message, type Model } from "./trace-explorer/model"

const run = (messages: ReadonlyArray<Message>): Model =>
	Arr.reduce(messages, init(), (model, message) => update(model, message).model)
const clickNode = (nodeId: string) =>
	Message.GotFlowMessage({ message: TraceFlow.Message.ClickedSpanNode({ nodeId }) })
const flame = (message: Flamegraph.Message) => Message.GotFlameMessage({ message })

describe("TraceVisualization island", () => {
	it("renders the frame, the tabs and the flow pane on the server", async () => {
		const { html } = await renderer.renderToStaticMarkup(TraceVisualization, {})
		const text = Str.replace(/<[^>]+>/g, " ")(html)
		for (const label of [
			"/traces",
			"a3f8c1d2e5b7f901",
			"POST /checkout",
			"8 spans across 4 services",
			"Flow",
			"Waterfall",
			"Flamegraph",
			"Fit view",
		])
			expect(text).toContain(label)
		expect(html).toContain('data-testid="rf__wrapper"')
	})

	it("one selection across the tabs: a flow node selects its span, a second click clears it", () => {
		const selected = run([clickNode("span-3")])
		expect(selected.selectedSpanId).toEqual(Option.some("span-3"))
		expect(selected.flow.selectedSpanId).toEqual(Option.some("span-3"))
		const cleared = run([
			clickNode("span-3"),
			Message.ClickedTab({ tab: "waterfall" }),
			Message.ClickedWaterfallRow({ spanId: "span-3" }),
		])
		expect(cleared.selectedSpanId).toEqual(Option.none())
		const fromFlame = run([
			Message.ClickedTab({ tab: "flamegraph" }),
			flame(Flamegraph.Message.ClickedBar({ spanId: "span-6", isShift: false })),
		])
		expect(fromFlame.selectedSpanId).toEqual(Option.some("span-6"))
	})

	it("Shift+click zooms the flamegraph without selecting, and leaving the tab drops the zoom", () => {
		const zoomed = run([
			Message.ClickedTab({ tab: "flamegraph" }),
			flame(Flamegraph.Message.ClickedBar({ spanId: "span-3", isShift: true })),
		])
		expect(zoomed.flame.focusedSpanId).toEqual(Option.some("span-3"))
		expect(zoomed.selectedSpanId).toEqual(Option.none())
		const back = Arr.reduce(
			[Message.ClickedTab({ tab: "flow" }), Message.ClickedTab({ tab: "flamegraph" })],
			zoomed,
			(model, message) => update(model, message).model,
		)
		expect(back.flame.focusedSpanId).toEqual(Option.none())
	})
})
