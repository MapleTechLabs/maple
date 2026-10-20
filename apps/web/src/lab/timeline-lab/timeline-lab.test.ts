import { Option } from "effect"
import { describe, expect, test } from "vitest"
import * as Timeline from "../../page/traces/detail/timeline"
import { LAB_TRACE, Message } from "./model"
import { init, update } from "./update"

describe("timeline lab", () => {
	test("the fixture decodes as the trace page's data", () => {
		expect(Option.map(LAB_TRACE, (trace) => trace.spans.length)).toEqual(Option.some(59))
	})

	test("opens on the Timeline tab, and a span picked there opens its events", () => {
		const opened = init().model
		expect(opened.timeline?.rootSpans.length).toBe(1)
		const picked = update(
			opened,
			Message.GotTimelineMessage({ message: Timeline.Message.ClickedRow({ spanId: "svc3" }) }),
		).model
		expect([picked.selectedSpanId, picked.panel?.span.spanId]).toEqual(["svc3", "svc3"])
	})
})
