// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
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

/** What the App Router's hooks return for the route on screen. */
const route = vi.hoisted(() => ({
	pathname: "/",
	search: "",
	params: {} as Record<string, string | string[]>,
	segments: [] as string[],
}))
vi.mock("next/navigation", () => ({
	usePathname: () => route.pathname,
	useSearchParams: () => new URLSearchParams(route.search),
	useParams: () => route.params,
	useSelectedLayoutSegments: () => route.segments,
}))

const { MapleBrowser } = await import("../index")
const { resetReportedErrorsForTests } = await import("../failures")
const { resetNavigationForTests } = await import("../navigation")
const { MapleNavigation, onRouterTransitionStart, reportNextError } = await import("./index")

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let handle: ReturnType<typeof MapleBrowser.init> | undefined
let root: Root | undefined

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

/** Commit a route, as the App Router does at the end of a navigation. */
const commit = async (pathname: string, params: Record<string, string | string[]> = {}, search = "") => {
	// A new object per route, as `useParams()` returns
	Object.assign(route, { pathname, search, params: { ...params }, segments: [] })
	await act(async () => {
		root ??= createRoot(document.body.appendChild(document.createElement("div")))
		root.render(createElement(MapleNavigation))
	})
}

/** The first load, as `instrumentation-client.ts` starts it. */
const pageLoad = async (pathname: string, params: Record<string, string | string[]> = {}) => {
	MapleBrowser.startNavigation(pathname)
	await commit(pathname, params)
}

const names = () => exported.map((span) => span.name)

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
	handle = MapleBrowser.init({
		ingestKey: "k",
		serviceName: "web",
		endpoint: "https://ingest.test",
		replay: { enabled: false },
	})
})

afterEach(async () => {
	act(() => root?.unmount())
	root = undefined
	await stop()
	exported.length = 0
	vi.unstubAllGlobals()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

describe("MapleNavigation and onRouterTransitionStart", () => {
	it("names the page load and each click after the route", async () => {
		await pageLoad("/projects/8f2a", { id: "8f2a" })
		onRouterTransitionStart("/projects/9b1c")
		await commit("/projects/9b1c", { id: "9b1c" })
		onRouterTransitionStart("/docs/guides/setup")
		await commit("/docs/guides/setup", { slug: ["guides", "setup"] })
		await stop()

		expect(names()).toEqual([
			"pageload /projects/[id]",
			"navigate /projects/[id]",
			"navigate /docs/[...slug]",
		])
		expect(exported[1]?.attributes["url.path"]).toBe("/projects/9b1c")
	})

	it("takes an absolute URL, as back and forward pass it", async () => {
		await pageLoad("/")
		onRouterTransitionStart(new URL("/projects/1", location.href).href)
		await commit("/projects/1", { id: "1" })
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/[id]"])
	})

	it("starts nothing for a hash link or a link to the URL on screen", async () => {
		await pageLoad("/projects/1", { id: "1" })
		onRouterTransitionStart("/projects/1#members")
		onRouterTransitionStart("/projects/1")
		onRouterTransitionStart("/projects/1?")
		await stop()

		// A span left open would export on shutdown, as interrupted
		expect(names()).toEqual(["pageload /projects/[id]"])
	})

	it("traces a query change, which renders the route again", async () => {
		await pageLoad("/projects/1", { id: "1" })
		onRouterTransitionStart("/projects/1?tab=members")
		await commit("/projects/1", { id: "1" }, "tab=members")
		await stop()

		expect(names()).toEqual(["pageload /projects/[id]", "navigate /projects/[id]"])
	})

	it("names a URL no route matches /_not-found", async () => {
		MapleBrowser.startNavigation("/does-not-exist")
		Object.assign(route, {
			pathname: "/does-not-exist",
			search: "",
			params: {},
			segments: ["/_not-found"],
		})
		await act(async () => {
			root = createRoot(document.body.appendChild(document.createElement("div")))
			root.render(createElement(MapleNavigation))
		})
		await stop()

		expect(names()).toEqual(["pageload /_not-found"])
	})

	it("ends a navigation interrupted by the next click as interrupted", async () => {
		await pageLoad("/")
		onRouterTransitionStart("/slow")
		onRouterTransitionStart("/projects/1")
		await commit("/projects/1", { id: "1" })
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "navigate /projects/[id]"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("does not end a navigation in flight when the same route commits again", async () => {
		await pageLoad("/projects/1", { id: "1" })
		onRouterTransitionStart("/settings")
		// A server action revalidates the page on screen: a new params object, same route
		await commit("/projects/1", { id: "1" })
		await commit("/settings")
		await stop()

		expect(names()).toEqual(["pageload /projects/[id]", "navigate /settings"])
	})

	it("does not end a navigation in flight when it renders again for the same route", async () => {
		await pageLoad("/projects/1", { id: "1" })
		onRouterTransitionStart("/projects/2")
		// The layout renders again before the new route commits
		await act(async () => root?.render(createElement(MapleNavigation)))
		await commit("/projects/2", { id: "2" })
		await stop()

		expect(names()).toEqual(["pageload /projects/[id]", "navigate /projects/[id]"])
		expect(exported[1]?.attributes["url.path"]).toBe("/projects/2")
	})
})

describe("reportNextError", () => {
	const reported = () => exported.filter((span) => span.name === "react.render_error")

	it("reports a client error once", async () => {
		const error = new Error("render exploded")
		reportNextError(error)
		// Strict Mode runs the boundary's effect twice
		reportNextError(error)
		await stop()

		expect(reported()).toHaveLength(1)
		expect(reported()[0]?.events[0]?.attributes?.["exception.message"]).toBe("render exploded")
	})

	it("skips a server error, which arrives with a digest", async () => {
		reportNextError(
			Object.assign(new Error("An error occurred in the Server Components render."), { digest: "123" }),
		)
		await stop()

		expect(reported()).toHaveLength(0)
	})

	it("skips an error a traced call already recorded", async () => {
		const error = new Error("loader exploded")
		await expect(
			MapleBrowser.traced("loader", async () => {
				throw error
			}),
		).rejects.toBe(error)
		reportNextError(error)
		await stop()

		expect(reported()).toHaveLength(0)
		expect(names()).toEqual(["loader"])
	})

	it("reports a thrown value that isn't an Error", async () => {
		reportNextError("plain string")
		await stop()

		expect(reported()).toHaveLength(1)
	})
})
