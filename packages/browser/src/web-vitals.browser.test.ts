// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import { afterEach, describe, expect, it, vi } from "vitest"

const exportedLogs: ReadableLogRecord[] = []
vi.mock("@opentelemetry/exporter-logs-otlp-http", () => ({
	OTLPLogExporter: class {
		export(items: ReadableLogRecord[], callback: (result: { code: number }) => void): void {
			exportedLogs.push(...items)
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
vi.mock("@opentelemetry/exporter-trace-otlp-http", () => ({
	OTLPTraceExporter: class {
		export(_spans: unknown[], callback: (result: { code: number }) => void): void {
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

let handle: ReturnType<typeof MapleBrowser.init> | undefined
afterEach(async () => {
	await handle?.shutdown()
	handle = undefined
})

describe("web vitals", () => {
	it("reports browser.web_vital events linked to the pageload span", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		)
		handle = MapleBrowser.init({
			ingestKey: "k",
			serviceName: "web",
			endpoint: "https://ingest.test",
			replay: { enabled: false },
			tracing: { instrumentFetch: false },
		})
		MapleBrowser.startNavigation("/a")
		MapleBrowser.endNavigation("/a")
		await import("./deferred")
		// TTFB reports once the page has loaded, which the test page long has.
		await new Promise((resolve) => setTimeout(resolve, 50))
		await handle.shutdown()
		handle = undefined

		const vitals = exportedLogs.filter((log) => log.eventName === "browser.web_vital")
		const ttfb = vitals.find((log) => log.attributes["browser.web_vital.name"] === "ttfb")
		expect(ttfb).toBeDefined()
		expect(typeof ttfb?.attributes["browser.web_vital.value"]).toBe("number")
		expect(["good", "needs-improvement", "poor"]).toContain(ttfb?.attributes["browser.web_vital.rating"])
		expect(ttfb?.attributes["browser.web_vital.id"]).toMatch(/^v\d+-/)
		expect(ttfb?.attributes["url.path"]).toBe(location.pathname)
		expect(typeof ttfb?.attributes["session.id"]).toBe("string")
		expect(ttfb?.spanContext?.traceId).toMatch(/^[0-9a-f]{32}$/)
		vi.unstubAllGlobals()
	})
})
