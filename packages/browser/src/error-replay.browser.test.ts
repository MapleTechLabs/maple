// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { getSession } from "@maple/browser-session"
import { afterEach, describe, expect, it, vi } from "vitest"

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

// Headless Chromium's user agent is classified as a bot, which never gets replay.
const DESKTOP_UA =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"

let handle: ReturnType<typeof MapleBrowser.init> | undefined
afterEach(async () => {
	await handle?.shutdown()
	handle = undefined
	Reflect.deleteProperty(navigator, "userAgent")
	sessionStorage.clear()
	vi.unstubAllGlobals()
})

describe("replay.onErrorSampleRate", () => {
	it("buffers an unsampled session, uploading nothing until an error keeps it", async () => {
		const urls: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				urls.push(String(input))
				return new Response("{}")
			}),
		)
		Object.defineProperty(navigator, "userAgent", { value: DESKTOP_UA, configurable: true })
		handle = MapleBrowser.init({
			ingestKey: "k",
			serviceName: "web",
			endpoint: "https://ingest.test",
			tracing: { instrumentFetch: false, instrumentXhr: false },
			webVitals: false,
			replay: { sampleRate: 0, onErrorSampleRate: 1 },
		})
		// The buffered session announces itself, unrecorded, once the replay chunk lands.
		await vi.waitFor(() => expect(urls.some((url) => url.endsWith("/v1/sessionReplays/meta"))).toBe(true))
		expect(getSession()).toMatchObject({ replaySampled: false, replayBuffered: true })
		await new Promise((resolve) => setTimeout(resolve, 50))
		expect(urls.some((url) => url.endsWith("/v1/sessionReplays/blob"))).toBe(false)

		MapleBrowser.captureException(new Error("checkout failed"))
		expect(getSession()).toMatchObject({ replaySampled: true, replayTrigger: "error" })
		await vi.waitFor(() => expect(urls.some((url) => url.endsWith("/v1/sessionReplays/blob"))).toBe(true))
	})
})
