// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import {
	type AnyRouter,
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	notFound,
	Outlet,
	redirect,
	RouterProvider,
} from "@tanstack/react-router"
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

const { MapleBrowser } = await import("../index")
const { resetReportedErrorsForTests } = await import("../failures")
const { resetNavigationForTests } = await import("../navigation")
const { reportRouterError, tracedLoader, traceRouter } = await import("./index")

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const loaderError = new Error("loader exploded")
const renderError = new Error("render exploded")
/** Holds `/slow`'s loader until released. */
let releaseSlow: () => void = () => {}

const rootRoute = createRootRoute({ component: () => createElement(Outlet) })
const page = (text: string) => () => createElement("h1", null, text)
const routeTree = rootRoute.addChildren([
	createRoute({ getParentRoute: () => rootRoute, path: "/", component: page("Home") }),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/projects/$id",
		loader: ({ params }) =>
			tracedLoader("loader /projects/$id", async () => {
				if (params.id === "missing") throw notFound()
				return params.id
			}),
		component: page("Project"),
		notFoundComponent: page("Project not found"),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/slow",
		loader: () =>
			tracedLoader("loader /slow", () => new Promise<void>((resolve) => (releaseSlow = resolve))),
		component: page("Slow"),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/old",
		beforeLoad: () =>
			tracedLoader("beforeLoad /old", async () => {
				throw redirect({ to: "/projects/$id", params: { id: "1" } })
			}),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/broken-loader",
		loader: () =>
			tracedLoader("loader /broken-loader", async () => {
				throw loaderError
			}),
		errorComponent: page("Loader error"),
	}),
	createRoute({
		getParentRoute: () => rootRoute,
		path: "/broken-render",
		component: () => {
			throw renderError
		},
		errorComponent: page("Render error"),
	}),
])

let handle: ReturnType<typeof MapleBrowser.init> | undefined
let root: Root | undefined

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

/** A router wired as the guide's `getRouter()` does, rendered at `url`. */
const mount = async (url = "/"): Promise<AnyRouter> => {
	const router: AnyRouter = createRouter({
		routeTree,
		history: createMemoryHistory({ initialEntries: [url] }),
		defaultOnCatch: (error) => reportRouterError(router, error),
	})
	traceRouter(router)
	await act(async () => {
		root = createRoot(document.body.appendChild(document.createElement("div")))
		root.render(createElement(RouterProvider, { router }))
	})
	return router
}

/** The next navigation's end. */
const resolved = (router: AnyRouter) =>
	new Promise<void>((resolve) => {
		const unsubscribe = router.subscribe("onResolved", () => {
			unsubscribe()
			resolve()
		})
	})

/** Navigate and wait until the new route is on screen. */
const go = (router: AnyRouter, to: string) => act(() => router.navigate({ to }))

const names = () => exported.map((span) => span.name)
const named = (name: string): ReadableSpan => {
	const span = exported.find((candidate) => candidate.name === name)
	if (!span) throw new Error(`no span named ${name}: ${names().join(", ")}`)
	return span
}
const exceptionEvents = () =>
	exported.flatMap((span) => span.events.filter((event) => event.name === "exception"))

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
	releaseSlow()
	await stop()
	exported.length = 0
	vi.unstubAllGlobals()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

describe("traceRouter", () => {
	it("names the page load and each navigation after the route, with loader spans under them", async () => {
		const router = await mount("/")
		await go(router, "/projects/8f2a")
		await go(router, "/projects/9b1c")
		await stop()

		expect(names()).toEqual([
			"pageload /",
			"loader /projects/$id",
			"navigate /projects/$id",
			"loader /projects/$id",
			"navigate /projects/$id",
		])
		expect(exported[0]?.attributes["url.path"]).toBe("/")
		const navigation = exported[2]
		expect(navigation?.attributes["url.path"]).toBe("/projects/8f2a")
		expect(exported[1]?.parentSpanContext?.spanId).toBe(navigation?.spanContext().spanId)
		expect(exported[1]?.spanContext().traceId).toBe(navigation?.spanContext().traceId)
	})

	it("keeps the page load's own redirect in its span", async () => {
		await mount("/old")
		await stop()

		expect(
			names().filter((name) => !name.startsWith("loader") && !name.startsWith("beforeLoad")),
		).toEqual(["pageload /projects/$id"])
		expect(named("pageload /projects/$id").attributes["url.path"]).toBe("/old")
	})

	it("ends a page load the first click interrupts, before its route resolved", async () => {
		const router = await mount("/slow")
		await go(router, "/projects/1")
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload",
			"navigate /projects/$id",
		])
		expect(named("pageload").attributes["url.path"]).toBe("/slow")
		expect(named("pageload").attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("ends a hydrated page load on onRendered, the only event hydration emits", async () => {
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/projects/1"] }),
		})
		// The server already loaded the route: hydration starts with its matches
		await router.load()
		traceRouter(router)
		const location = router.state.location
		router.emit({
			type: "onRendered",
			fromLocation: location,
			toLocation: location,
			pathChanged: false,
			hrefChanged: false,
			hashChanged: false,
		})
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual(["pageload /projects/$id"])
	})

	it("keeps a redirect in the span of the navigation it came from", async () => {
		const router = await mount("/")
		await go(router, "/old")
		await stop()

		expect(names()).toEqual([
			"pageload /",
			"beforeLoad /old",
			"loader /projects/$id",
			"navigate /projects/$id",
		])
		const navigation = named("navigate /projects/$id")
		expect(navigation.attributes["url.path"]).toBe("/old")
		expect(navigation.attributes["app.navigation.interrupted"]).toBeUndefined()
		expect(named("beforeLoad /old").status.code).not.toBe(SpanStatusCode.ERROR)
	})

	it("keeps a hydrated page load whose URL the router fixes up in one span", async () => {
		const router = createRouter({
			routeTree,
			history: createMemoryHistory({ initialEntries: ["/projects/1"] }),
		})
		await router.load()
		traceRouter(router)
		// The URL the server rendered isn't canonical: the router replaces its history entry
		const hydrated = router.state.location
		const info = { pathChanged: true, hrefChanged: true, hashChanged: false }
		router.emit({
			type: "onBeforeNavigate",
			fromLocation: hydrated,
			toLocation: { ...hydrated, pathname: "/projects/1/" },
			...info,
		})
		router.emit({ type: "onResolved", fromLocation: hydrated, toLocation: hydrated, ...info })
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual(["pageload /projects/$id"])
	})

	it("starts a new span for a redirect when the history has no index", async () => {
		const router = await mount("/")
		const location = router.state.location
		/** A navigation to `pathname` whose history entry has no index, like one pushed by other code. */
		const navigateWithoutIndex = (pathname: string) => {
			const state = { ...location.state }
			Reflect.deleteProperty(state, "__TSR_index")
			router.emit({
				type: "onBeforeNavigate",
				fromLocation: location,
				toLocation: { ...location, pathname, state },
				pathChanged: true,
				hrefChanged: true,
				hashChanged: false,
			})
		}
		navigateWithoutIndex("/old")
		// The redirect
		navigateWithoutIndex("/projects/1")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "navigate"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("traces a search change as a navigation, and a hash link not at all", async () => {
		const router = await mount("/projects/1")
		await act(() =>
			router.navigate({ to: "/projects/$id", params: { id: "1" }, search: { tab: "members" } }),
		)
		await act(() =>
			router.navigate({
				to: "/projects/$id",
				params: { id: "1" },
				search: { tab: "members" },
				hash: "list",
			}),
		)
		await act(() => router.invalidate())
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /projects/$id",
			"navigate /projects/$id",
		])
	})

	it("traces back and forward", async () => {
		const router = await mount("/")
		await go(router, "/projects/1")
		await act(async () => {
			router.history.back()
			await resolved(router)
		})
		await act(async () => {
			router.history.forward()
			await resolved(router)
		})
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /",
			"navigate /projects/$id",
			"navigate /",
			"navigate /projects/$id",
		])
	})

	it("ends a navigation interrupted by the next one as interrupted", async () => {
		const router = await mount("/")
		void router.navigate({ to: "/slow" })
		await go(router, "/projects/1")
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /",
			"navigate",
			"navigate /projects/$id",
		])
		expect(named("navigate").attributes["url.path"]).toBe("/slow")
		expect(named("navigate").attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("ends a navigation abandoned by a link back to the route on screen", async () => {
		const router = await mount("/")
		void router.navigate({ to: "/slow" })
		await go(router, "/")
		// Ended now: it no longer parents what runs next
		await MapleBrowser.traced("query members", async () => undefined)
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "query members"])
		expect(named("navigate").attributes["app.navigation.interrupted"]).toBe(true)
		expect(named("query members").parentSpanContext).toBeUndefined()
	})

	it("names a URL no route matches not-found, and a loader's notFound() after its route", async () => {
		const router = await mount("/")
		await go(router, "/does-not-exist")
		await go(router, "/projects/missing")
		await stop()

		expect(names()).toEqual([
			"pageload /",
			"navigate not-found",
			"loader /projects/$id",
			"navigate /projects/$id",
		])
		expect(exported.filter((span) => span.status.code === SpanStatusCode.ERROR)).toEqual([])
		expect(exceptionEvents()).toEqual([])
	})
})

describe("reportRouterError", () => {
	const reported = () => exported.filter((span) => span.name === "react.render_error")

	it("reports a render error once, as react.render_error", async () => {
		const router = await mount("/")
		await go(router, "/broken-render")
		await stop()

		expect(document.body.textContent).toContain("Render error")
		expect(reported()).toHaveLength(1)
		expect(reported()[0]?.events[0]?.attributes?.["exception.message"]).toBe("render exploded")
	})

	it("leaves a loader error to its loader span", async () => {
		const router = await mount("/")
		await go(router, "/broken-loader")
		await stop()

		expect(document.body.textContent).toContain("Loader error")
		expect(reported()).toHaveLength(0)
		expect(named("loader /broken-loader").status.code).toBe(SpanStatusCode.ERROR)
		expect(exceptionEvents()).toHaveLength(1)
	})

	it("skips a loader error the browser only has a copy of, as after server rendering", async () => {
		const router = await mount("/")
		const copy = new Error("loader exploded")
		router.state.matches[0]!.error = copy
		reportRouterError(router, copy)
		reportRouterError(router, new Error("render exploded"))
		await stop()

		expect(reported()).toHaveLength(1)
	})
})
