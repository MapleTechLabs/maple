import { DateTime } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { PageOutMessage } from "../contract"
import type { MetricEntry } from "../metrics/catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { init, update } from "./update"

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T12:00:00Z"))
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://localhost:4318", isHosted: false }
const contextAt = (search: string, canGoBack = false): PageContext => ({
	env,
	location: { path: "/metrics/http.server.request.duration", search },
	rememberedRange: "1h",
	canGoBack,
})
const context = contextAt("range=1h&spanId=abc")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) => (commands ?? []).map(({ name }) => name)

const entry: MetricEntry = {
	metricName: "http.server.request.duration",
	metricType: "histogram",
	metricUnit: "s",
	metricDescription: "",
	serviceNames: ["checkout-api"],
	dataPointCount: 183,
	firstSeen: "2026-10-01T11:00:00.000Z",
	lastSeen: "2026-10-01T12:00:00.000Z",
	isMonotonic: false,
}

const entered = () =>
	pageUpdate(init(context, "http.server.request.duration").model, Message.CompletedReadClock({ nowMs: NOW }))

describe("local metric detail", () => {
	test("entry asks for the metric's catalog entry, then its timeseries and breakdown", () => {
		const step = entered()
		expect(names(step.commands)).toEqual(["FetchLocalMetricEntry"])
		const found = pageUpdate(
			step.model,
			Message.SucceededFetchEntry({ key: step.model.entry.key ?? "", entry, fetchedAtMs: NOW }),
		)
		expect(names(found.commands)).toEqual(["FetchLocalMetricTimeseries", "FetchLocalMetricBreakdown"])
	})

	test("an entry answer for a superseded window is dropped", () => {
		const first = entered().model
		const later = pageUpdate(first, Message.CompletedReadRefreshClock({ nowMs: NOW + 120_000 })).model
		const dropped = pageUpdate(later, Message.SucceededFetchEntry({ key: first.entry.key ?? "", entry, fetchedAtMs: NOW }))
		expect(dropped.model.entry).toEqual(later.entry)
		expect(names(dropped.commands)).toEqual([])
	})

	test("a missing metric asks for nothing more", () => {
		const step = entered()
		const missing = pageUpdate(step.model, Message.SucceededFetchEntry({ key: step.model.entry.key ?? "", entry: null, fetchedAtMs: NOW }))
		expect(names(missing.commands)).toEqual([])
	})

	test("back without in-app history opens the list, filters kept, detail params dropped", () => {
		const back = pageUpdate(entered().model, Message.ClickedBack())
		expect(back.outMessage).toEqual(PageOutMessage.RequestedBack({ fallbackHash: "#/metrics?range=1h" }))
	})
})
