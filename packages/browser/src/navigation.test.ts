// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { afterEach, describe, expect, it, vi } from "vitest"

const exported: ReadableSpan[] = []
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: class {
		export(spans: ReadableSpan[], callback: (result: { code: number }) => void): void {
			exported.push(...spans)
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
const { setupTracing } = await import("./tracing")

const CONFIG = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	serviceNamespace: undefined,
	serviceVersion: undefined,
	environment: undefined,
	identity: undefined,
	tracingEnabled: true,
	tracingInstrumentFetch: false,
	tracingCaptureErrors: false,
	replayEnabled: false,
	replaySampleRate: 0,
	replayOnErrorSampleRate: 0,
	maskAllInputs: true,
	maskAllText: false,
	persistVisitorId: true,
	crossSubdomainCookie: true,
	cookieDomain: undefined,
	requireConsent: false,
	captureUserEmail: true,
	respectDoNotTrack: false,
	propagateTraceHeaderCorsUrls: [],
	tracingSampleRate: 1,
	tracingInstrumentXhr: false,
	errorFilters: {},
	webVitals: false,
	breadcrumbs: false,
	captureConsole: [],
	reportCsp: false,
	reportBrowser: false,
	offlineQueue: false,
	sanitizeUrl: undefined,
}

afterEach(() => {
	vi.unstubAllGlobals()
	trace.disable()
})

describe("on the server", () => {
	it("is a no-op that leaves the module's navigation state alone", async () => {
		expect(typeof window).toBe("undefined")
		const handle = MapleBrowser.init({ ingestKey: "k", serviceName: "web" })

		// Module state is shared by every request a server renders
		MapleBrowser.startNavigation("/request-1")
		MapleBrowser.startNavigation("/request-2")
		MapleBrowser.endNavigation("/request-2")
		const value = { ok: true }
		await expect(MapleBrowser.traced("loader", async () => value)).resolves.toBe(value)
		const error = new Error("loader failed")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
		await handle.shutdown()

		// The page load is still to come in the browser: the server calls above
		// neither consumed it nor left a span open
		const shutdown = setupTracing(CONFIG)
		vi.stubGlobal("window", { addEventListener: () => {} })
		vi.stubGlobal("document", { querySelector: () => null })
		MapleBrowser.endNavigation("/stale")
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await shutdown()

		expect(exported.map((span) => span.name)).toEqual(["pageload /a"])
	})
})
