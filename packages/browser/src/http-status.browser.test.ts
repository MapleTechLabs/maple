// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { SpanStatusCode } from "@opentelemetry/api"
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

afterEach(() => {
	exported.length = 0
	vi.unstubAllGlobals()
})

// HTTP client span status per the OTel HTTP conventions: 4xx and 5xx SHOULD be Error,
// with error.type set to the status code and no status description.
describe("HTTP client span status", () => {
	it("marks 4xx and 5xx fetch spans Error with error.type, and leaves 2xx Unset", async () => {
		const statusFor = new Map([
			["/missing", 404],
			["/down", 503],
		])
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const path = new URL(String(input instanceof Request ? input.url : input)).pathname
				return new Response("{}", { status: statusFor.get(path) ?? 200 })
			}),
		)
		const handle = MapleBrowser.init({
			ingestKey: "k",
			serviceName: "web",
			endpoint: "https://ingest.test",
			replay: { enabled: false },
			tracing: { instrumentXhr: false },
		})
		for (const path of ["/ok", "/missing", "/down"]) await (await fetch(`https://api.test${path}`)).text()
		await new Promise((resolve) => setTimeout(resolve, 400))
		await handle.shutdown()

		const byPath = (path: string) =>
			exported.find((span) => String(span.attributes["url.full"]).endsWith(path))
		expect(byPath("/ok")?.status.code).toBe(SpanStatusCode.UNSET)
		for (const [path, status] of [
			["/missing", "404"],
			["/down", "503"],
		] as const) {
			const span = byPath(path)
			expect(span?.status).toEqual({ code: SpanStatusCode.ERROR })
			expect(span?.attributes["error.type"]).toBe(status)
			expect(span?.attributes["http.response.status_code"]).toBe(Number(status))
			expect(span?.attributes["http.request.method"]).toBe("GET")
		}
	})
})
