// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import type { ReadableLogRecord } from "@opentelemetry/sdk-logs"
import { describe, expect, it, vi } from "vitest"

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

const { MapleBrowser } = await import("./index")

// Its own file: web-vitals reports each metric once per page.
describe("web vitals without tracing", () => {
	it("still reports vitals, just without a trace link", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("{}")),
		)
		const handle = MapleBrowser.init({
			ingestKey: "k",
			serviceName: "web",
			endpoint: "https://ingest.test",
			replay: { enabled: false },
			tracing: { enabled: false },
		})
		await import("./deferred")
		await new Promise((resolve) => setTimeout(resolve, 50))
		await handle.shutdown()
		vi.unstubAllGlobals()

		const ttfb = exportedLogs.find(
			(log) =>
				log.eventName === "browser.web_vital" && log.attributes["browser.web_vital.name"] === "ttfb",
		)
		expect(ttfb).toBeDefined()
		expect(ttfb?.spanContext).toBeUndefined()
	})
})
