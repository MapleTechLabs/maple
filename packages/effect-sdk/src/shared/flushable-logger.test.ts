import { describe, expect, it } from "@effect/vitest"
import { makeLogBuffer } from "./flushable-logger.js"

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736"
const SPAN_ID = "00f067aa0ba902b7"

const vital = {
	eventName: "browser.web_vital",
	severityNumber: 9,
	severityText: "INFO",
	attributes: { "browser.web_vital.name": "lcp", "browser.web_vital.value": 1234.5 },
	timestamp: 1_700_000_000_000,
	link: { traceId: TRACE_ID, spanId: SPAN_ID, traceFlags: 1 },
}

describe("makeLogBuffer push", () => {
	it("buffers a record from outside Effect as an OTLP log event linked to its span", () => {
		const logs = makeLogBuffer()
		logs.push(vital)
		expect(logs.drain()).toEqual([
			{
				eventName: "browser.web_vital",
				severityNumber: 9,
				severityText: "INFO",
				timeUnixNano: "1700000000000000000",
				observedTimeUnixNano: "1700000000000000000",
				attributes: [
					{ key: "browser.web_vital.name", value: { stringValue: "lcp" } },
					{ key: "browser.web_vital.value", value: { doubleValue: 1234.5 } },
				],
				droppedAttributesCount: 0,
				traceId: TRACE_ID,
				spanId: SPAN_ID,
				flags: 1,
			},
		])
	})

	it("drops records while capture is not allowed", () => {
		const logs = makeLogBuffer()
		logs.setDisabled(true)
		logs.push(vital)
		expect(logs.size()).toBe(0)
	})
})
