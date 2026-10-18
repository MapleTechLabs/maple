import { describe, expect, test } from "vitest"
import { Message as HubMessage } from "../../page/alerts/hub/message"
import * as Tabs from "../../ui/tabs"
import { type Flags, Message, type Model } from "./model"
import * as TraceBox from "./trace-box"
import { init, update } from "./update"

const FLAGS: Flags = { nowMs: Date.UTC(2026, 9, 1, 12), timeZone: "UTC", mode: "worst" }

const step = (model: Model, ...messages: ReadonlyArray<Message>): Model =>
	messages.reduce((current, message) => update(current, message).model, model)

describe("worst-case lab", () => {
	test("opens on the worst case: one box per view, each on the 60-deep chain's deepest span", () => {
		const { model } = init(FLAGS)
		expect([model.waterfallBox?.tabs.selected, model.waterfallBox?.selectedSpanId]).toEqual([
			"waterfall",
			"d59",
		])
		expect([model.timelineBox?.tabs.selected, model.timelineBox?.selectedSpanId]).toEqual([
			"timeline",
			"d59",
		])
		expect(model.logs.rows.length).toBe(3)
	})

	test("the mode toggle swaps in the demo twins and writes ?data= to the URL", () => {
		const opened = init(FLAGS).model
		const toggled = update(opened, Message.ClickedMode({ mode: "demo" }))
		expect(toggled.model.mode).toBe("demo")
		expect(toggled.model.waterfallBox?.selectedSpanId).toBe("d3")
		expect(toggled.model.logs.rows.length).toBe(2)
		expect((toggled.commands ?? []).map(({ name }) => name)).toContain("ReplaceModeUrl")
		expect(update(toggled.model, Message.ClickedMode({ mode: "demo" })).commands ?? []).toEqual([])
	})

	test("a tab picked in a box mounts that view and keeps the selection", () => {
		const opened = init(FLAGS).model
		const picked = step(
			opened,
			Message.GotWaterfallBoxMessage({
				message: TraceBox.Message.GotTabsMessage({ message: Tabs.Message.ClickedTab({ index: 1 }) }),
			}),
		)
		expect([
			picked.waterfallBox?.tabs.selected,
			picked.waterfallBox?.waterfall,
			picked.waterfallBox?.timeline?.rootSpans.length,
		]).toEqual(["timeline", null, 1])
	})

	test("legend rows hide and show a series; host heads sort", () => {
		const opened = init(FLAGS).model
		const hidden = step(opened, Message.ToggledLegendSeries({ key: "s2" }))
		expect(hidden.hiddenSeries).toEqual(["s2"])
		expect(step(hidden, Message.ToggledLegendSeries({ key: "s2" })).hiddenSeries).toEqual([])
		expect(step(opened, Message.ClickedHostSort({ key: "hostName" })).hostSort).toEqual({
			key: "hostName",
			dir: "asc",
		})
	})

	test("the rules tab keeps its search, and its status chips stay inert as legacy's", () => {
		const opened = init(FLAGS).model
		const searched = step(
			opened,
			Message.GotRulesMessage({ message: HubMessage.ChangedRulesQuery({ value: "p1" }) }),
		)
		expect(searched.hub.rulesQuery).toBe("p1")
		const filtered = step(
			opened,
			Message.GotRulesMessage({ message: HubMessage.ClickedStatusFilter({ bucket: "firing" }) }),
		)
		expect(filtered.hub).toEqual(opened.hub)
	})
})
