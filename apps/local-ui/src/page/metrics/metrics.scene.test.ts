import { DateTime } from "effect"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { PageOutMessage } from "../contract"
import type { MetricEntry } from "./catalog"
import { Message } from "./message"
import type { Model } from "./model"
import { init, locationChanged, update } from "./update"

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T12:00:00Z"))
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://localhost:4318", isHosted: false }
const contextAt = (search: string): PageContext => ({
	env,
	location: { path: "/metrics", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack: false,
})
const context = contextAt("")
const pageUpdate = (model: Model, message: Message) => update(model, message, context)
const names = (commands: ReadonlyArray<{ readonly name: string }> | undefined) =>
	(commands ?? []).map(({ name }) => name)

const entry = (metricName: string, metricType: string, serviceNames: ReadonlyArray<string>): MetricEntry => ({
	metricName,
	metricType,
	metricUnit: "",
	metricDescription: "",
	serviceNames,
	dataPointCount: 10,
	firstSeen: "2026-10-01T11:20:00.000Z",
	lastSeen: "2026-10-01T12:00:00.000Z",
	isMonotonic: false,
})

const entered = () => pageUpdate(init(context).model, Message.CompletedReadClock({ nowMs: NOW }))

const withList = (model: Model, entries: ReadonlyArray<MetricEntry>, ctx = context) =>
	update(
		model,
		Message.SucceededFetchList({
			key: model.list.key ?? "",
			data: { entries, serviceFacets: [] },
			fetchedAtMs: NOW,
		}),
		ctx,
	)

describe("local metrics list", () => {
	test("entry reads the clock, then asks for the catalog and the type summary", () => {
		expect(names(init(context).commands)).toContain("ReadMetricsClock")
		expect(names(entered().commands)).toEqual(
			expect.arrayContaining(["FetchLocalMetricsList", "FetchLocalMetricsSummary"]),
		)
	})

	test("the listed metrics ask for one sparkline batch", () => {
		const listed = withList(entered().model, [entry("a", "gauge", ["x"]), entry("b", "sum", ["x"])])
		expect(names(listed.commands)).toEqual(["FetchLocalMetricsSparklines"])
		expect(listed.model.sparklines.key).toContain('"gauge",["a"]')
	})

	test("a catalog answer for a superseded search is dropped", () => {
		const first = entered().model
		const searched = update(first, Message.CompletedReadClock({ nowMs: NOW }), contextAt("q=http")).model
		const dropped = update(
			searched,
			Message.SucceededFetchList({
				key: first.list.key ?? "",
				data: { entries: [], serviceFacets: [] },
				fetchedAtMs: NOW,
			}),
			contextAt("q=http"),
		)
		expect(dropped.model.list).toEqual(searched.list)
	})

	test("an empty catalog renders the signal empty state, which reads the presence", () => {
		const listed = withList(entered().model, [])
		expect(listed.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
		expect(names(listed.commands)).toEqual([])
	})

	test("a service filter that matches nothing asks for the presence without new SQL", () => {
		const listed = withList(entered().model, [entry("a", "gauge", ["x"])]).model
		const filtered = locationChanged(listed, contextAt("service=y"))
		expect(names(filtered.commands)).toEqual(["FetchLocalMetricsSummary"])
		expect(filtered.outMessage).toEqual(PageOutMessage.RequestedSignalPresence())
	})
})
