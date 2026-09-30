// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { resetConsentForTests, setConsent } from "@maple/browser-session"
import { context, trace } from "@opentelemetry/api"
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const exportedSpans: ReadableSpan[] = []
const exportedLogs: ReadableLogRecord[] = []
const exporter = <T>(sink: T[]) =>
	class {
		export(items: T[], callback: (result: { code: number }) => void): void {
			sink.push(...items)
			callback({ code: 0 })
		}
		forceFlush(): Promise<void> {
			return Promise.resolve()
		}
		shutdown(): Promise<void> {
			return Promise.resolve()
		}
	}
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({ OTLPTraceExporter: exporter(exportedSpans) }))
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({ OTLPLogExporter: exporter(exportedLogs) }))

const { MapleBrowser } = await import("./index")
const { resetLogsForTests } = await import("./logs")
const { resetNavigationForTests } = await import("./navigation")
const { resetReportedErrorsForTests } = await import("./errors")

type InitConfig = Parameters<typeof MapleBrowser.init>[0]
const BASE: InitConfig = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	replay: { enabled: false },
	tracing: { instrumentFetch: false },
	// Covered in web-vitals.browser.test.ts; vitals report once per page and would leak across tests.
	webVitals: false,
}

/** Document timing spans (`documentFetch`, `dns`, ...) are covered by their own tests. */
const TIMING_SPANS = new Set([
	"documentFetch",
	"dns",
	"connect",
	"request",
	"response",
	"domProcessing",
	"loadEvent",
])
const spanNames = () => exportedSpans.filter((span) => !TIMING_SPANS.has(span.name)).map((span) => span.name)

let handle: ReturnType<typeof MapleBrowser.init> | undefined
const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
})

afterEach(async () => {
	await stop()
	exportedSpans.length = 0
	exportedLogs.length = 0
	vi.unstubAllGlobals()
	resetConsentForTests()
	resetLogsForTests()
	resetNavigationForTests()
	resetReportedErrorsForTests()
	MapleBrowser.identify(undefined)
	trace.disable()
	context.disable()
})

describe("MapleBrowser.logger", () => {
	it("exports log records with severity, attributes, session and user", async () => {
		handle = MapleBrowser.init({ ...BASE, user: { id: "user_1" } })
		MapleBrowser.logger.warn("cart went stale", { "cart.items": 3 })
		await stop()

		expect(exportedLogs).toHaveLength(1)
		const [log] = exportedLogs
		expect(log?.body).toBe("cart went stale")
		expect(log?.severityText).toBe("WARN")
		expect(log?.severityNumber).toBe(13)
		expect(log?.attributes["cart.items"]).toBe(3)
		expect(log?.attributes["user.id"]).toBe("user_1")
		expect(typeof log?.attributes["session.id"]).toBe("string")
		expect(log?.resource.attributes["service.name"]).toBe("web")
	})

	it("links a record to the span active when it was logged", async () => {
		handle = MapleBrowser.init(BASE)
		const tracer = trace.getTracer("test")
		const spanContext = tracer.startActiveSpan("work", (span) => {
			MapleBrowser.logger.info("inside")
			span.end()
			return span.spanContext()
		})
		await stop()

		expect(exportedLogs[0]?.spanContext?.traceId).toBe(spanContext.traceId)
		expect(exportedLogs[0]?.spanContext?.spanId).toBe(spanContext.spanId)
	})

	it("keeps records logged before init and exports them once it runs", async () => {
		MapleBrowser.logger.info("early")
		handle = MapleBrowser.init(BASE)
		await stop()
		expect(exportedLogs.map((log) => log.body)).toEqual(["early"])
	})

	it("drops records while consent is withheld", async () => {
		handle = MapleBrowser.init({ ...BASE, privacy: { requireConsent: true } })
		MapleBrowser.logger.info("before consent")
		setConsent(true)
		MapleBrowser.logger.info("after consent")
		await stop()
		expect(exportedLogs.map((log) => log.body)).toEqual(["after consent"])
	})
})

describe("tracing.sampleRate", () => {
	it("drops an unsampled session's spans but still exports its errors", async () => {
		handle = MapleBrowser.init({ ...BASE, tracing: { instrumentFetch: false, sampleRate: 0 } })
		MapleBrowser.startNavigation("/a")
		const error = new Error("boom")
		await MapleBrowser.traced("loader", async () => {}).catch(() => {})
		MapleBrowser.endNavigation("/a")
		MapleBrowser.captureException(error)
		await stop()

		expect(spanNames()).toEqual(["exception"])
		expect(exportedSpans[0]?.parentSpanContext).toBeUndefined()
	})

	it("still exports a failure inside an unsampled traced() call, as its own error span", async () => {
		handle = MapleBrowser.init({ ...BASE, tracing: { instrumentFetch: false, sampleRate: 0 } })
		const error = new Error("loader failed")
		await expect(
			MapleBrowser.traced("loader /a", async () => {
				throw error
			}),
		).rejects.toBe(error)
		// Rethrown to the app, then reported again by a boundary: still one error.
		MapleBrowser.captureException(error)
		await stop()
		expect(exportedSpans.map((span) => span.name)).toEqual(["loader /a"])
		expect(exportedSpans[0]?.events.some((event) => event.name === "exception")).toBe(true)
	})

	it("exports everything at the default rate, with no sampling weight", async () => {
		handle = MapleBrowser.init(BASE)
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await stop()
		expect(spanNames()).toEqual(["pageload /a"])
		expect(exportedSpans[0]?.spanContext().traceState).toBeUndefined()
	})
})
