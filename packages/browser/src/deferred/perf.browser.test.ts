// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { userEvent } from "vitest/browser"
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

const { MapleBrowser } = await import("../index")
const { interactionKey, onLongFrame } = await import("@maple/sdk-core/browser/perf")

describe("interactionKey", () => {
	it("skips non-interactions, groups by id, and still keys events from engines without ids", () => {
		expect(interactionKey({ interactionId: 0, name: "pointermove", startTime: 10 })).toBeUndefined()
		expect(interactionKey({ interactionId: 7, name: "click", startTime: 10 })).toBe(
			interactionKey({ interactionId: 7, name: "pointerup", startTime: 12 }),
		)
		expect(interactionKey({ name: "click", startTime: 10.4 })).toBe("click:10")
	})
})

class ScriptTimingStub {
	constructor(
		private readonly values: {
			duration: number
			invoker: string
			sourceURL: string
			sourceFunctionName: string
		},
	) {}
	get duration(): number {
		return this.values.duration
	}
	get invoker(): string {
		return this.values.invoker
	}
	get sourceURL(): string {
		return this.values.sourceURL
	}
	get sourceFunctionName(): string {
		return this.values.sourceFunctionName
	}
}
const scriptTiming = (duration: number, invoker: string, sourceURL: string, sourceFunctionName = "") =>
	new ScriptTimingStub({ duration, invoker, sourceURL, sourceFunctionName })

const busy = (ms: number): void => {
	const until = performance.now() + ms
	while (performance.now() < until) {
		// Block the main thread, like a slow handler would.
	}
}

let handle: ReturnType<typeof MapleBrowser.init> | undefined
afterEach(async () => {
	await handle?.shutdown()
	handle = undefined
	vi.restoreAllMocks()
	exported.length = 0
	document.body.replaceChildren()
	vi.unstubAllGlobals()
})

const init = async (): Promise<void> => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
	handle = MapleBrowser.init({
		ingestKey: "k",
		serviceName: "web",
		endpoint: "https://ingest.test",
		replay: { enabled: false },
		webVitals: false,
		breadcrumbs: false,
		tracing: { instrumentFetch: false, instrumentXhr: false, longFrames: true, slowInteractions: true },
	})
	await import("./index")
	await new Promise((resolve) => setTimeout(resolve, 0))
}

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

describe("slow interactions", () => {
	it("spans a slow click once, named after the event whose handler ran long", async () => {
		await init()
		const button = document.createElement("button")
		button.id = "save"
		button.textContent = "Save"
		button.addEventListener("click", () => busy(250))
		document.body.append(button)
		await userEvent.click(button)
		// Event timing entries are delivered after the next paint.
		await new Promise((resolve) => setTimeout(resolve, 500))
		await stop()

		const interactions = exported.filter((span) => span.name.startsWith("interaction "))
		expect(interactions.map((span) => span.name)).toEqual(["interaction click"])
		expect(interactions[0]?.attributes["maple.browser.interaction.target"]).toBe("button#save")
		expect(
			Number(interactions[0]?.attributes["maple.browser.interaction.processing_ms"]),
		).toBeGreaterThanOrEqual(200)
	})
})

describe("long frames", () => {
	it("falls back to long tasks where Long Animation Frames are missing", async () => {
		const supported = PerformanceObserver.supportedEntryTypes.filter(
			(type) => type !== "long-animation-frame",
		)
		vi.spyOn(PerformanceObserver, "supportedEntryTypes", "get").mockReturnValue(supported)
		await init()
		busy(150)
		await new Promise((resolve) => setTimeout(resolve, 300))
		await stop()
		expect(exported.map((span) => span.name)).toContain("longtask")
	})

	it("names the longest script of a long animation frame", async () => {
		await init()
		const entry = {
			name: "long-animation-frame",
			entryType: "long-animation-frame",
			startTime: 100,
			duration: 180,
			toJSON: () => ({}),
			blockingDuration: 130,
			// Real PerformanceScriptTiming fields are prototype getters, not own properties.
			scripts: [
				scriptTiming(20, "a", "https://app.test/a.js"),
				scriptTiming(150, "BUTTON#save.onclick", "https://app.test/checkout.js?token=x", "submit"),
			],
		}
		onLongFrame(entry)
		await stop()
		// Buffered real frames (from earlier busy loops) may be reported too; find this one.
		const frame = exported.find(
			(span) =>
				span.name === "longAnimationFrame" && span.attributes["code.function.name"] === "submit",
		)
		expect(frame?.attributes).toMatchObject({
			"maple.browser.frame.blocking_duration_ms": 130,
			"code.file.path": "https://app.test/checkout.js?token=REDACTED",
			"code.function.name": "submit",
			"maple.browser.script.invoker": "BUTTON#save.onclick",
			"maple.browser.script.duration_ms": 150,
		})
	})
})
