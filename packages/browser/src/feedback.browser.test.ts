// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
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
const { resetFeedbackForTests } = await import("./feedback")
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
	resetFeedbackForTests()
	resetReportedErrorsForTests()
	vi.unstubAllGlobals()
})

const feedback = () => exportedLogs.filter((log) => log.eventName === "maple.user_feedback")

describe("MapleBrowser.sendFeedback", () => {
	it("sends a feedback event linked to the last error the user hit", async () => {
		handle = MapleBrowser.init(BASE)
		MapleBrowser.captureException(new Error("checkout failed"))
		expect(
			MapleBrowser.sendFeedback({
				message: "  the pay button does nothing ",
				email: "ada@example.com",
				name: "Ada",
				attributes: { "feedback.category": "bug" },
			}),
		).toBe(true)
		await stop()

		const error = exportedSpans.find((span) => span.name === "exception")
		const [sent] = feedback()
		expect(sent?.body).toBe("the pay button does nothing")
		expect(sent?.attributes["user.email"]).toBe("ada@example.com")
		expect(sent?.attributes["user.name"]).toBe("Ada")
		expect(sent?.attributes["feedback.category"]).toBe("bug")
		expect(sent?.attributes["maple.feedback.error_trace_id"]).toBe(error?.spanContext().traceId)
		expect(sent?.spanContext?.spanId).toBe(error?.spanContext().spanId)
		expect(typeof sent?.attributes["session.id"]).toBe("string")
	})

	it("does not link feedback to an error from before a shutdown and re-init", async () => {
		handle = MapleBrowser.init(BASE)
		MapleBrowser.captureException(new Error("old page state"))
		await stop()
		handle = MapleBrowser.init(BASE)
		MapleBrowser.sendFeedback({ message: "still broken" })
		await stop()
		expect(feedback()[0]?.attributes["maple.feedback.error_trace_id"]).toBeUndefined()
	})

	it("keeps the email out when captureUserEmail is off, and sends nothing without a message", async () => {
		handle = MapleBrowser.init({ ...BASE, privacy: { captureUserEmail: false } })
		expect(MapleBrowser.sendFeedback({ message: "   " })).toBe(false)
		MapleBrowser.sendFeedback({ message: "slow", email: "ada@example.com" })
		await stop()
		expect(feedback()).toHaveLength(1)
		expect(feedback()[0]?.attributes["user.email"]).toBeUndefined()
		expect(feedback()[0]?.attributes["maple.feedback.error_trace_id"]).toBeUndefined()
	})

	it("reports has_replay for the buffered replay the feedback itself keeps", async () => {
		// Headless Chromium's user agent is classified as a bot, which never gets replay.
		Object.defineProperty(navigator, "userAgent", {
			value: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
			configurable: true,
		})
		const urls: string[] = []
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				urls.push(String(input))
				return new Response("{}")
			}),
		)
		try {
			handle = MapleBrowser.init({ ...BASE, replay: { sampleRate: 0, onErrorSampleRate: 1 } })
			await vi.waitFor(() =>
				expect(urls.some((url) => url.endsWith("/v1/sessionReplays/meta"))).toBe(true),
			)
			MapleBrowser.sendFeedback({ message: "it froze" })
			await stop()
			expect(feedback()[0]?.attributes["maple.feedback.has_replay"]).toBe(true)
		} finally {
			Reflect.deleteProperty(navigator, "userAgent")
			sessionStorage.clear()
		}
	})
})
