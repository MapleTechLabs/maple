import { DateTime, Option } from "effect"
import { ResolveThemeColors } from "@maple/web/charts/theme-colors"
import { expect as expectView, given, Mount, scene, text, withViewInputs } from "foldkit/scene"
import { describe, expect, test } from "vitest"
import type { PageContext } from "../contract"
import { PageOutMessage } from "../contract"
import type { MetricEntry } from "../metrics/catalog"
import { FetchBreakdown, FetchEntry, FetchTimeseries } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { MetricDetailBlock } from "./block"
import { init, update } from "./update"
import { type MetricDetailViewInputs, view as pageView } from "./view"

const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-01T12:00:00Z"))
const env = { apiBase: "", port: "4318", otlpEndpoint: "http://localhost:4318", isHosted: false }
const contextAt = (search: string, canGoBack = false): PageContext => ({
	env,
	location: { path: "/metrics/http.server.request.duration", search },
	rememberedRange: "1h",
	timeFormat: { locale: "en-US", timeZone: "UTC" },
	canGoBack,
})
const context = contextAt("range=1h&spanId=abc")
/** Every Message the page's graph accepts: its own and the chart's generated delivery. */
type PageMessage = typeof MetricDetailBlock.Message.Type
const pageUpdate = (model: Model, message: PageMessage) => update(model, message, context)
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
		expect(names(step.commands)).toEqual([FetchEntry.name])
		const found = pageUpdate(
			step.model,
			Message.SucceededFetchEntry({ key: step.model.entry.key ?? "", entry, fetchedAtMs: NOW }),
		)
		expect(names(found.commands)).toEqual(expect.arrayContaining([FetchTimeseries.name, FetchBreakdown.name]))
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

	test("last seen reads the root's newer clock, as legacy reads the time at each render", () => {
		const step = entered()
		const found = pageUpdate(step.model, Message.SucceededFetchEntry({ key: step.model.entry.key ?? "", entry, fetchedAtMs: NOW })).model
		const inputs: MetricDetailViewInputs = { context, clockMs: NOW + 20 * 60_000, lastIngestAtMs: Option.none() }
		scene(
			{ update: pageUpdate, view: withViewInputs(pageView, inputs)() },
			given(found),
			Mount.resolve(ResolveThemeColors, Message.ResolvedThemeColors({ colors: {} })),
			expectView(text(/20m ago/)).toExist(),
		)
	})
})
