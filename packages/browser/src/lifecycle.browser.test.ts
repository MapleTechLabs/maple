// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { resetUrlSanitizersForTests } from "../../browser-session/src/platform/url-privacy"

const exportedSpans: ReadableSpan[] = []
const exportedLogs: ReadableLogRecord[] = []
vi.mock("./otlp", async (original) => ({
	...(await original<typeof import("./otlp")>()),
	OtlpExporter: class {
		constructor(private readonly url: string) {}
		export(items: never[], callback: (result: { code: number }) => void): void {
			if (this.url.endsWith("/v1/logs")) exportedLogs.push(...items)
			else exportedSpans.push(...items)
			callback({ code: 0 })
		}
		forceFlush(): Promise<void> {
			return Promise.resolve()
		}
		shutdown(): Promise<void> {
			return Promise.resolve()
		}
	},
}))

const { MapleBrowser } = await import("./index")
const { resetNavigationForTests } = await import("./navigation")
const { resetReportedErrorsForTests } = await import("./errors")

type InitConfig = Parameters<typeof MapleBrowser.init>[0]
const BASE: InitConfig = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	replay: { enabled: false },
	tracing: { instrumentFetch: false, instrumentXhr: false },
	webVitals: false,
	breadcrumbs: false,
}

const handles: Array<ReturnType<typeof MapleBrowser.init>> = []
const init = (config: InitConfig = BASE) => {
	const handle = MapleBrowser.init(config)
	handles.push(handle)
	return handle
}
const messages = () =>
	exportedSpans.flatMap((span) =>
		span.events
			.filter((event) => event.name === "exception")
			.map((event) => event.attributes?.["exception.message"]),
	)

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
})

afterEach(async () => {
	await Promise.all(handles.splice(0).map((handle) => handle.shutdown()))
	exportedSpans.length = 0
	exportedLogs.length = 0
	resetNavigationForTests()
	resetReportedErrorsForTests()
	resetUrlSanitizersForTests()
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
})

describe("init and shutdown", () => {
	it("warns once when init is called again with a different config, and not for an equal one", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
		const first = init()
		expect(init({ ...BASE })).toBe(first)
		expect(warn).not.toHaveBeenCalled()

		expect(init({ ...BASE, serviceName: "other" })).toBe(first)
		init({ ...BASE, serviceName: "third" })
		const reinitWarnings = warn.mock.calls.filter(([message]) =>
			String(message).includes("init() was called again"),
		)
		expect(reinitWarnings).toHaveLength(1)
	})

	it("gives an init right after a shutdown still flushing a live SDK (React StrictMode, remounts)", async () => {
		const first = init()
		const flushing = first.shutdown()
		const second = init()
		expect(second).not.toBe(first)

		MapleBrowser.captureException(new Error("during the old flush"))
		MapleBrowser.logger.info("during the old flush")
		await flushing
		// The old teardown must not have taken down what the new init started.
		MapleBrowser.captureException(new Error("after the old flush"))
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		MapleBrowser.logger.info("after the old flush")
		await vi.waitFor(() => expect(second.sessionId).not.toBe(""))
		await second.shutdown()

		expect(messages()).toEqual(["during the old flush", "after the old flush"])
		expect(exportedSpans.map((span) => span.name)).toContain("pageload /a")
		expect(exportedLogs.map((log) => log.body)).toEqual(
			expect.arrayContaining(["during the old flush", "after the old flush"]),
		)
	})

	it("keeps a track() made while the previous handle is still flushing", async () => {
		const first = init()
		await vi.waitFor(() => expect(first.sessionId).not.toBe(""))
		void first.shutdown()
		MapleBrowser.track("during_teardown")
		const second = init()
		await vi.waitFor(() => expect(second.sessionId).not.toBe(""))
		await second.shutdown()

		const sent = vi
			.mocked(fetch)
			.mock.calls.filter(([url]) => String(url).endsWith("/v1/sessionEvents"))
			.map(([, request]) => String(request?.body))
		expect(sent.join("\n")).toContain("during_teardown")
	})

	it("records a captureException made before init once init runs", async () => {
		const before = Date.now()
		MapleBrowser.captureException(new Error("before init"))
		const handle = init()
		await handle.shutdown()

		expect(messages()).toEqual(["before init"])
		const [span] = exportedSpans
		// Stamped when it happened, not when init ran.
		expect(span?.startTime[0] ?? 0).toBeLessThanOrEqual(Math.ceil(before / 1_000))
	})

	it("runs a host sanitizeUrl once on the URLs of Maple's own spans", async () => {
		const handle = init({ ...BASE, privacy: { sanitizeUrl: (url) => `${url}#seen` } })
		MapleBrowser.captureException(new Error("with a page url"))
		await handle.shutdown()

		const url = String(exportedSpans[0]?.attributes["url.full"])
		expect(url.endsWith("#seen")).toBe(true)
		expect(url.endsWith("#seen#seen")).toBe(false)
	})
})
