// SAFETY-FILE: JSON in this test is the OTLP body the SDK under test posted, parsed before its fields are asserted.
import type { EmitLog, SpanLink } from "@maple/sdk-core"
import { Array as Arr, String as Str } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { make, type MapleClientFlushableConfig } from "./flushable.js"
import { type WebVitalsCollector, withIntegration } from "./flushable-integration.js"

interface LogsBody {
	readonly resourceLogs: ReadonlyArray<{
		readonly scopeLogs: ReadonlyArray<{
			readonly logRecords: ReadonlyArray<{
				readonly eventName?: string
				readonly traceId?: string
				readonly spanId?: string
				readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
			}>
		}>
	}>
}

const PAGELOAD: SpanLink = {
	traceId: "4bf92f3577b34da6a3ce929d0e0e4736",
	spanId: "00f067aa0ba902b7",
	traceFlags: 1,
}

/** Stands in for the `web-vitals` observers (tested in sdk-core): records what the SDK wires in. */
const fakeCollector = () => {
	const starts: Array<{ readonly sink: EmitLog; readonly link: () => SpanLink | undefined }> = []
	let stops = 0
	const collector: WebVitalsCollector = {
		startWebVitals: (sink, link) => {
			starts.push({ sink, link })
			return () => {
				stops += 1
			}
		},
	}
	return { starts, stops: () => stops, load: () => Promise.resolve(collector) }
}

const setup = () => {
	const logBodies: Array<LogsBody> = []
	vi.stubGlobal("document", { visibilityState: "visible" })
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (Str.endsWith("/v1/logs")(url) && typeof init?.body === "string")
			logBodies.push(JSON.parse(init.body))
		return new Response(null, { status: 200 })
	})
	return { logBodies }
}

const config: MapleClientFlushableConfig = {
	serviceName: "unit-test",
	endpoint: "https://collector.test",
	autoFlushInterval: false,
	flushOnUnload: false,
	captureGlobalErrors: false,
	emitSessionMeta: false,
	replay: { enabled: false },
}

const later = () => new Promise((resolve) => setTimeout(resolve, 20))

describe("MapleFlush.make webVitals", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("posts a reported vital as a browser.web_vital log event linked to the page load", async () => {
		const { logBodies } = setup()
		const collector = fakeCollector()
		const telemetry = make(
			withIntegration(
				{ ...config, webVitals: true },
				{ pageloadLink: () => PAGELOAD, loadWebVitals: collector.load },
			),
		)
		await vi.waitFor(() => expect(collector.starts).toHaveLength(1))
		const { sink, link } = Arr.getUnsafe(collector.starts, 0)
		sink({
			eventName: "browser.web_vital",
			severityNumber: 9,
			severityText: "INFO",
			attributes: { "browser.web_vital.name": "ttfb", "browser.web_vital.value": 42 },
			link: link(),
		})
		await telemetry.flush()
		const records = Arr.flatMap(logBodies, (body) =>
			Arr.flatMap(body.resourceLogs, (r) => Arr.flatMap(r.scopeLogs, (s) => s.logRecords)),
		)
		expect(records).toHaveLength(1)
		expect(records[0]).toMatchObject({
			eventName: "browser.web_vital",
			traceId: PAGELOAD.traceId,
			spanId: PAGELOAD.spanId,
		})
		expect(records[0]?.attributes).toContainEqual({
			key: "browser.web_vital.name",
			value: { stringValue: "ttfb" },
		})
		await telemetry.dispose()
		expect(collector.stops()).toBe(1)
	})

	it("does not start when disposed before the collector loads", async () => {
		setup()
		const collector = fakeCollector()
		const telemetry = make(
			withIntegration({ ...config, webVitals: true }, { loadWebVitals: collector.load }),
		)
		const disposal = telemetry.dispose()
		await later()
		await disposal
		expect(collector.starts).toHaveLength(0)
	})

	it("loads nothing by default", async () => {
		setup()
		const collector = fakeCollector()
		const telemetry = make(withIntegration(config, { loadWebVitals: collector.load }))
		await later()
		expect(collector.starts).toHaveLength(0)
		await telemetry.dispose()
	})
})
