// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import {
	doPreparation,
	onPageLoad,
	TransitionBeforeSwapEvent,
	triggerEvent,
} from "astro/virtual-modules/transitions-events.js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

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
const { resetReportedErrorsForTests } = await import("../failures")
const { resetNavigationForTests } = await import("../navigation")
const { traceAstroNavigation } = await import("./client")
const { resetAstroNavigationForTests } = await import("./transitions")

let handle: ReturnType<typeof MapleBrowser.init> | undefined

const init = () => {
	handle = MapleBrowser.init({
		ingestKey: "k",
		serviceName: "web",
		endpoint: "https://ingest.test",
		replay: { enabled: false },
	})
}

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

const names = () => exported.map((span) => span.name)
const named = (name: string): ReadableSpan => {
	const span = exported.find((candidate) => candidate.name === name)
	if (!span) throw new Error(`no exported span named ${name}: ${names().join(", ")}`)
	return span
}
const requests = () =>
	exported.filter((span) => span.attributes["url.full"]?.toString().startsWith(location.origin))
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const idOf = (span: ReadableSpan) => span.spanContext().spanId

/** What `<ClientRouter />`'s `fetchHTML` does: fetch the page, give up (a full page load) on anything but HTML. */
const fetchPage = async (event: { readonly to: URL; preventDefault: () => void }) => {
	const response = await fetch(event.to.href).catch(() => undefined)
	if (!response?.headers.get("content-type")?.startsWith("text/html")) event.preventDefault()
}

/**
 * One `<ClientRouter />` navigation, the way its router runs one: the preparation events and
 * loader, then, unless it gave up, the swap (which copies the new page's `<html>` attributes)
 * and `astro:page-load`.
 */
async function navigate(
	path: string,
	route: string,
	{ signal = new AbortController().signal, loader = fetchPage } = {},
): Promise<void> {
	const from = new URL(location.href)
	const to = new URL(path, location.href)
	const prepared = await doPreparation(
		from,
		to,
		"forward",
		"push",
		undefined,
		undefined,
		signal,
		undefined,
		loader,
	)
	if (prepared.defaultPrevented || signal.aborted) return
	document.dispatchEvent(new TransitionBeforeSwapEvent(prepared, {} as ViewTransition))
	document.documentElement.dataset.route = route
	triggerEvent("astro:after-swap")
	onPageLoad()
}

/** A navigation entry for this document, with or without `DOMContentLoaded` behind it. */
const stubNavigationEntry = (domContentLoadedEventStart: number) => {
	const entry: PerformanceNavigationTiming = Object.create(PerformanceNavigationTiming.prototype, {
		domContentLoadedEventStart: { value: domContentLoadedEventStart },
		serverTiming: { value: [] },
	})
	vi.spyOn(performance, "getEntriesByType").mockReturnValue([entry])
}

/** The page requests. Installed before `init`, so the fetch instrumentation wraps it. */
const fetchPageHtml = vi.fn(
	async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
)

beforeEach(() => {
	vi.stubGlobal("fetch", fetchPageHtml)
	document.documentElement.dataset.route = "/"
})

afterEach(async () => {
	await stop()
	exported.length = 0
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	// Each test is a new document
	resetAstroNavigationForTests()
	resetNavigationForTests()
	resetReportedErrorsForTests()
	delete document.documentElement.dataset.route
	trace.disable()
	context.disable()
})

describe("traceAstroNavigation", () => {
	it("names the page load after <html data-route>", async () => {
		document.documentElement.dataset.route = "/projects/[id]"
		init()
		traceAstroNavigation()
		await stop()

		expect(names()).toEqual(["pageload /projects/[id]"])
		expect(named("pageload /projects/[id]").attributes["url.path"]).toBe(location.pathname)
	})

	it("starts the page load after DOMContentLoaded, once init() has run wherever it is on the page", async () => {
		stubNavigationEntry(0)
		traceAstroNavigation()
		init()
		document.dispatchEvent(new Event("DOMContentLoaded"))
		await stop()

		expect(names()).toEqual(["pageload /"])
	})

	it("ends the page load at the window's load event", async () => {
		vi.spyOn(document, "readyState", "get").mockReturnValue("interactive")
		init()
		traceAstroNavigation()
		// `load` fires once and only for the document: the route is whatever it is then
		document.documentElement.dataset.route = "/docs/[...path]"
		window.dispatchEvent(new Event("load"))
		await stop()

		expect(names()).toEqual(["pageload /docs/[...path]"])
	})

	it("does nothing when called again, as from two layouts", async () => {
		init()
		traceAstroNavigation()
		traceAstroNavigation()
		await navigate("/projects/1", "/projects/[id]")
		await stop()

		expect(names().filter((name) => name !== "GET")).toEqual([
			"pageload /",
			"load page",
			"navigate /projects/[id]",
		])
	})

	describe("with <ClientRouter />", () => {
		beforeEach(() => {
			init()
			traceAstroNavigation()
		})

		it("spans each navigation from preparation to page load, with the page request under it", async () => {
			await navigate("/projects/1", "/projects/[id]")
			await navigate("/projects/2?tab=members", "/projects/[id]")
			// The fetch instrumentation ends its spans up to 300ms after the response
			await vi.waitFor(
				() => {
					window.dispatchEvent(new Event("pagehide"))
					expect(requests()).toHaveLength(2)
				},
				{ timeout: 3_000, interval: 50 },
			)
			await stop()

			expect(names().filter((name) => name.startsWith("navigate"))).toEqual([
				"navigate /projects/[id]",
				"navigate /projects/[id]",
			])
			const [first, second] = exported.filter((span) => span.name.startsWith("navigate"))
			expect(first?.attributes["url.path"]).toBe("/projects/1")
			expect(second?.attributes["url.path"]).toBe("/projects/2")
			const load = exported.filter((span) => span.name === "load page")
			expect(load.map(parentOf)).toEqual([idOf(first!), idOf(second!)])
			expect(requests().map(parentOf)).toEqual(load.map(idOf))
		})

		it("ends a navigation another one aborts as interrupted, and keeps the new one open", async () => {
			const first = new AbortController()
			let release: (() => void) | undefined
			const slow = navigate("/slow", "/slow", {
				signal: first.signal,
				// Aborting cancels the fetch, and the router gives up on the page
				loader: (event) =>
					new Promise<void>((resolve) => {
						release = () => {
							event.preventDefault()
							resolve()
						}
					}),
			})
			first.abort()
			const fast = navigate("/projects/1", "/projects/[id]")
			release?.()
			await Promise.all([slow, fast])
			await stop()

			const navigations = exported.filter((span) => span.name.startsWith("navigate"))
			expect(navigations.map((span) => span.name)).toEqual(["navigate", "navigate /projects/[id]"])
			expect(navigations[0]?.attributes["app.navigation.interrupted"]).toBe(true)
			expect(navigations[1]?.attributes["app.navigation.interrupted"]).toBeUndefined()
		})

		it("ends a navigation that falls back to a full page load with the generic name", async () => {
			fetchPageHtml.mockResolvedValueOnce(
				new Response("%PDF", { headers: { "content-type": "application/pdf" } }),
			)
			await navigate("/report.pdf", "/report.pdf")
			await stop()

			expect(names()).toContain("navigate")
			expect(named("navigate").attributes["url.path"]).toBe("/report.pdf")
			expect(named("navigate").attributes["app.navigation.interrupted"]).toBeUndefined()
		})

		it("records a failed page request on its span", async () => {
			const error = new Error("loader exploded")
			await expect(
				navigate("/projects/1", "/projects/[id]", {
					loader: async () => {
						throw error
					},
				}),
			).rejects.toBe(error)
			await stop()

			expect(named("load page").events.filter((event) => event.name === "exception")).toHaveLength(1)
		})

		it("ignores a swap's page load that a newer navigation overtook", async () => {
			await navigate("/a", "/a")
			document.dispatchEvent(new Event("astro:before-swap"))
			void doPreparation(
				new URL(location.href),
				new URL("/b", location.href),
				"forward",
				"push",
				undefined,
				undefined,
				new AbortController().signal,
				undefined,
				() => new Promise<void>(() => {}),
			)
			// The overtaken navigation's scripts finish loading
			onPageLoad()
			await stop()

			expect(names().filter((name) => name.startsWith("navigate"))).toEqual(["navigate /a", "navigate"])
			expect(named("navigate").attributes["app.navigation.interrupted"]).toBe(true)
		})
	})

	it("doesn't end a click on the document's load, which the router reports as a page load too", async () => {
		vi.spyOn(document, "readyState", "get").mockReturnValue("interactive")
		init()
		traceAstroNavigation()
		let loaded: (() => void) | undefined
		const click = navigate("/slow", "/slow", {
			loader: (event) =>
				new Promise<void>((resolve) => (loaded = () => fetchPage(event).then(resolve))),
		})
		// The image the page was waiting for arrives mid-navigation
		window.dispatchEvent(new Event("load"))
		onPageLoad()
		loaded?.()
		await click
		await stop()

		expect(names().filter((name) => !["load page", "GET"].includes(name))).toEqual([
			"pageload",
			"navigate /slow",
		])
		expect(named("pageload").attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("reports an island whose code failed to load", async () => {
		init()
		traceAstroNavigation()
		const island = document.body.appendChild(document.createElement("astro-island"))
		const error = new TypeError("Failed to fetch dynamically imported module")
		island.dispatchEvent(
			new CustomEvent("astro:hydration-error", { bubbles: true, composed: true, detail: { error } }),
		)
		island.remove()
		MapleBrowser.captureException(error)
		await stop()

		const span = named("astro.hydration_error")
		expect(span.events.filter((event) => event.name === "exception")).toHaveLength(1)
		expect(names().filter((name) => name !== "pageload /")).toEqual(["astro.hydration_error"])
	})
})
