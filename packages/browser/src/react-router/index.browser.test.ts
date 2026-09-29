// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, SpanStatusCode, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { act, createElement } from "react"
import { createRoot, type Root } from "react-dom/client"
import {
	createMemoryRouter,
	type DataRouter,
	data,
	Outlet,
	type RouteObject,
	RouterProvider,
	redirect,
} from "react-router"
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
const {
	dataRouterInstrumentation,
	frameworkInstrumentation,
	reportRouteError,
	traceNavigations,
	useMaplePageload,
} = await import("./index")

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

let handle: ReturnType<typeof MapleBrowser.init> | undefined
let router: DataRouter | undefined
let root: Root | undefined

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
const parentOf = (span: ReadableSpan) => span.parentSpanContext?.spanId
const idOf = (span: ReadableSpan) => span.spanContext().spanId

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const Page = () => createElement("main")

/** A route tree like a small app's, with readable ids for the loader spans. */
const routes = (): RouteObject[] => [
	{
		id: "root",
		path: "/",
		Component: Outlet,
		children: [
			{ id: "home", index: true, Component: Page },
			{ id: "project", path: "projects/:id", loader: () => sleep(5), Component: Page },
			{ id: "about", path: "about", Component: Page },
			{ id: "old", path: "old", loader: () => redirect("/projects/1") },
			{ id: "slow", path: "slow", loader: () => sleep(50), Component: Page },
			{
				id: "broken-loader",
				path: "broken-loader",
				loader: () => {
					throw new Error("loader exploded")
				},
				Component: Page,
			},
			{
				id: "missing",
				path: "missing",
				loader: () => {
					throw data("Not found", { status: 404 })
				},
				Component: Page,
			},
			{
				id: "broken-render",
				path: "broken-render",
				Component: () => {
					throw new Error("render exploded")
				},
			},
		],
	},
]

/** Data mode: the router the app creates, then `traceNavigations` right after. */
const dataRouter = async (initial: string) => {
	router = createMemoryRouter(routes(), {
		initialEntries: [initial],
		instrumentations: [dataRouterInstrumentation],
	})
	traceNavigations(router)
	await vi.waitFor(() => expect(router?.state.initialized).toBe(true))
	return router
}

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
	router?.dispose()
	router = undefined
	await stop()
	exported.length = 0
	vi.unstubAllGlobals()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

describe("data mode", () => {
	it("names the page load after its route and nests its loader", async () => {
		await dataRouter("/projects/1")
		await stop()

		expect(names()).toEqual(["loader project", "pageload /projects/:id"])
		expect(parentOf(named("loader project"))).toBe(idOf(named("pageload /projects/:id")))
	})

	it("ends a page load without loaders at once", async () => {
		await dataRouter("/about")
		await stop()

		expect(names()).toEqual(["pageload /about"])
	})

	it("names each navigation after its route, with its loaders under it", async () => {
		const router = await dataRouter("/")
		await router.navigate("/projects/2")
		await router.navigate("/about")
		await stop()

		expect(names()).toEqual(["pageload /", "loader project", "navigate /projects/:id", "navigate /about"])
		const navigate = named("navigate /projects/:id")
		expect(navigate.attributes["url.path"]).toBe("/projects/2")
		expect(parentOf(named("loader project"))).toBe(idOf(navigate))
	})

	it("traces query changes and history navigations, and skips hash changes, revalidations and fetchers", async () => {
		const router = await dataRouter("/projects/1")
		await router.navigate("/projects/1?tab=members")
		await router.navigate("/projects/1?tab=members#section")
		await router.revalidate()
		await router.fetch("members", "root", "/projects/2")
		await router.navigate("/about")
		await router.navigate(-1)
		await vi.waitFor(() => expect(router.state.location.pathname).toBe("/projects/1"))
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /projects/:id",
			"navigate /projects/:id",
			"navigate /about",
			"navigate /projects/:id",
		])
	})

	it("keeps a redirect in one span, named after where it landed", async () => {
		const router = await dataRouter("/")
		await router.navigate("/old")
		await stop()

		const navigate = named("navigate /projects/:id")
		expect(navigate.attributes["url.path"]).toBe("/old")
		expect(names().filter((name) => name.startsWith("navigate"))).toHaveLength(1)
	})

	it("merges a click while loading into the same span", async () => {
		const router = await dataRouter("/")
		void router.navigate("/slow")
		await router.navigate("/projects/1")
		await stop()

		expect(names().filter((name) => name.startsWith("navigate"))).toEqual(["navigate /projects/:id"])
		expect(named("navigate /projects/:id").attributes["url.path"]).toBe("/slow")
	})

	it("names a URL no route matches after the root", async () => {
		const router = await dataRouter("/")
		await router.navigate("/does-not-exist")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /"])
		expect(named("navigate /").attributes["url.path"]).toBe("/does-not-exist")
	})

	it("records a loader error once, on its span", async () => {
		const router = await dataRouter("/")
		root = createRoot(document.body.appendChild(document.createElement("div")))
		await act(async () =>
			root?.render(createElement(RouterProvider, { router, onError: reportRouteError })),
		)
		await act(() => router.navigate("/broken-loader"))
		await stop()

		const loader = named("loader broken-loader")
		expect(loader.status.code).toBe(SpanStatusCode.ERROR)
		expect(loader.events.map((event) => event.attributes?.["exception.message"])).toEqual([
			"loader exploded",
		])
		expect(names()).not.toContain("react_router.error")
	})

	it("reports a render error once, with its route, and skips thrown responses", async () => {
		const router = await dataRouter("/")
		root = createRoot(document.body.appendChild(document.createElement("div")))
		await act(async () =>
			root?.render(createElement(RouterProvider, { router, onError: reportRouteError })),
		)
		await act(() => router.navigate("/missing"))
		await act(() => router.navigate("/broken-render"))
		await stop()

		const reported = exported.filter((span) => span.name === "react_router.error")
		expect(reported).toHaveLength(1)
		expect(reported[0]?.attributes["app.route"]).toBe("/broken-render")
		expect(reported[0]?.events[0]?.attributes?.["exception.message"]).toBe("render exploded")
		expect(named("loader missing").status.code).toBe(SpanStatusCode.UNSET)
	})
})

describe("framework mode", () => {
	/** The root route's `Layout`: renders around every page, the error pages included. */
	function Layout() {
		useMaplePageload()
		return createElement(Outlet)
	}

	const ids = (route: RouteObject): string[] => [route.id ?? "", ...(route.children ?? []).flatMap(ids)]

	/** Framework mode after the server render: hydrated, with the loaders already run. */
	const hydrate = async (initial: string) => {
		const tree = routes()
		tree[0] = { ...tree[0], Component: Layout }
		const hydrated = createMemoryRouter(tree, {
			initialEntries: [initial],
			instrumentations: [frameworkInstrumentation],
			// The server ran every loader: nothing runs again on hydration
			hydrationData: { loaderData: Object.fromEntries(tree.flatMap(ids).map((id) => [id, null])) },
		})
		router = hydrated
		root = createRoot(document.body.appendChild(document.createElement("div")))
		await act(async () =>
			root?.render(createElement(RouterProvider, { router: hydrated, onError: reportRouteError })),
		)
		return hydrated
	}

	it("ends the page load when the page hydrates, named after the matched routes", async () => {
		await hydrate("/projects/1")
		await stop()

		expect(names()).toEqual(["pageload /projects/:id"])
	})

	it("names each navigation after the pattern React Router reports", async () => {
		const router = await hydrate("/")
		await act(() => router.navigate("/projects/2?tab=members"))
		await stop()

		expect(names()).toEqual(["pageload /", "loader project", "navigate /projects/:id"])
		const navigate = named("navigate /projects/:id")
		expect(navigate.attributes["url.path"]).toBe("/projects/2")
		expect(parentOf(named("loader project"))).toBe(idOf(navigate))
	})

	it("skips hash links and history navigations", async () => {
		const router = await hydrate("/about")
		await act(() => router.navigate("#section"))
		await act(() => router.navigate("/projects/1"))
		await act(() => router.navigate(-1))
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /about",
			"navigate /projects/:id",
		])
	})

	it("ends a navigation interrupted by the next click as interrupted", async () => {
		const router = await hydrate("/")
		await act(async () => {
			void router.navigate("/slow")
			await router.navigate("/projects/1")
		})
		// The interrupted navigation's own end, after the next one ended
		await sleep(60)
		await stop()

		expect(names().filter((name) => !name.startsWith("loader"))).toEqual([
			"pageload /",
			"navigate",
			"navigate /projects/:id",
		])
		expect(named("navigate").attributes["app.navigation.interrupted"]).toBe(true)
		expect(named("navigate").attributes["url.path"]).toBe("/slow")
	})

	it("names a redirected navigation after the route that was clicked", async () => {
		const router = await hydrate("/")
		await act(() => router.navigate("/old"))
		await stop()

		expect(names().filter((name) => name.startsWith("navigate"))).toEqual(["navigate /old"])
	})
})
