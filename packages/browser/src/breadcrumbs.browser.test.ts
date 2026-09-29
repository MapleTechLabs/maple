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
const { resetReportedErrorsForTests } = await import("./errors")

type InitConfig = Parameters<typeof MapleBrowser.init>[0]
const BASE: InitConfig = {
	ingestKey: "k",
	serviceName: "web",
	endpoint: "https://ingest.test",
	replay: { enabled: false },
	tracing: { instrumentFetch: false, instrumentXhr: false },
	webVitals: false,
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
	resetReportedErrorsForTests()
	document.body.replaceChildren()
	vi.unstubAllGlobals()
})

/** Breadcrumbs start with the deferred chunk, a moment after `init()`. */
const init = async (config: InitConfig): Promise<void> => {
	handle = MapleBrowser.init(config)
	await import("./deferred")
	await new Promise((resolve) => setTimeout(resolve, 0))
}

const clickButton = (id: string): void => {
	const button = document.createElement("button")
	button.id = id
	button.textContent = "Save"
	document.body.append(button)
	button.click()
}

describe("breadcrumbs", () => {
	it("exports the trail before an error as logs linked to the error span", async () => {
		await init(BASE)
		clickButton("save")
		console.info("saving draft")
		MapleBrowser.captureException(new Error("save failed"))
		await stop()

		const error = exportedSpans.find((span) => span.name === "exception")
		const click = exportedLogs.find((log) => log.attributes["maple.breadcrumb.type"] === "click")
		const line = exportedLogs.find((log) => log.body === "saving draft")
		expect(click?.eventName).toBe("maple.browser.breadcrumb")
		expect(click?.attributes["maple.breadcrumb.target"]).toBe("button#save")
		expect(click?.spanContext?.spanId).toBe(error?.spanContext().spanId)
		expect(line?.severityText).toBe("INFO")
		expect(line?.attributes["maple.breadcrumb.type"]).toBe("console")
		expect(line?.spanContext?.spanId).toBe(error?.spanContext().spanId)
	})

	it("sends each breadcrumb once, and nothing without an error", async () => {
		await init(BASE)
		clickButton("first")
		MapleBrowser.captureException(new Error("one"))
		MapleBrowser.captureException(new Error("two"))
		clickButton("never-reported")
		await stop()

		const clicks = exportedLogs.filter((log) => log.attributes["maple.breadcrumb.type"] === "click")
		expect(clicks.map((log) => log.attributes["maple.breadcrumb.target"])).toEqual(["button#first"])
	})

	it("keeps nothing with breadcrumbs off", async () => {
		await init({ ...BASE, breadcrumbs: false })
		clickButton("save")
		MapleBrowser.captureException(new Error("save failed"))
		await stop()
		expect(exportedLogs).toEqual([])
	})
})

describe("logs.captureConsole", () => {
	it("exports the chosen console levels as logs right away, and the rest only as breadcrumbs", async () => {
		await init({ ...BASE, logs: { captureConsole: ["warn"] } })
		console.warn("disk almost full")
		console.info("not forwarded")
		await stop()

		expect(exportedLogs.map((log) => log.body)).toEqual(["disk almost full"])
		expect(exportedLogs[0]?.severityText).toBe("WARN")
		expect(exportedLogs[0]?.attributes["maple.log.source"]).toBe("console")
		expect(exportedLogs[0]?.attributes["maple.breadcrumb.type"]).toBeUndefined()
	})
})
