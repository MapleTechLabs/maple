// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { createElement, type ReactNode } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
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

const { MapleBrowser } = await import("./index")
const { resetNavigationForTests } = await import("./navigation")
const { resetReportedErrorsForTests } = await import("./errors")
const { MapleErrorBoundary, instrumentReactRouter, instrumentTanStackRouter, mapleReactErrorHandler } =
	await import("./react")
type ReactRouterState = import("./react").ReactRouterState

let handle: ReturnType<typeof MapleBrowser.init> | undefined
const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}
const TIMING_SPANS = new Set([
	"documentFetch",
	"dns",
	"connect",
	"request",
	"response",
	"domProcessing",
	"loadEvent",
])
const spanNames = () => exported.filter((span) => !TIMING_SPANS.has(span.name)).map((span) => span.name)

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
		tracing: { instrumentFetch: false, instrumentXhr: false },
		webVitals: false,
		breadcrumbs: false,
	})
})

afterEach(async () => {
	await stop()
	exported.length = 0
	resetNavigationForTests()
	resetReportedErrorsForTests()
	vi.unstubAllGlobals()
})

describe("MapleErrorBoundary", () => {
	it("reports a render error once with its component stack, renders the fallback, and resets", async () => {
		let shouldThrow = true
		const Broken = (): ReactNode => {
			if (shouldThrow) throw new Error("render failed")
			return createElement("p", null, "recovered")
		}
		let resetBoundary = (): void => {}
		const container = document.createElement("div")
		const root = createRoot(container)
		// React logs caught errors; keep the test output quiet.
		vi.spyOn(console, "error").mockImplementation(() => {})
		flushSync(() =>
			root.render(
				createElement(MapleErrorBoundary, {
					fallback: ({ reset }: { reset: () => void }) => {
						resetBoundary = reset
						return createElement("p", null, "fallback")
					},
					children: createElement(Broken),
				}),
			),
		)
		expect(container.textContent).toBe("fallback")

		shouldThrow = false
		flushSync(() => resetBoundary())
		expect(container.textContent).toBe("recovered")
		root.unmount()
		await stop()

		const reported = exported.filter((span) => span.name === "react.render_error")
		expect(reported).toHaveLength(1)
		expect(reported[0]?.attributes["maple.exception.source"]).toBe("react.error_boundary")
		expect(String(reported[0]?.attributes["maple.react.component_stack"])).toContain("Broken")
	})
})

describe("mapleReactErrorHandler", () => {
	it("reports what a React 19 root caught, once", async () => {
		const onCaughtError = mapleReactErrorHandler()
		const error = new Error("caught by root")
		onCaughtError(error, { componentStack: "\n    at Widget" })
		onCaughtError(error, { componentStack: "\n    at Widget" })
		await stop()
		const reported = exported.filter((span) => span.name === "react.render_error")
		expect(reported).toHaveLength(1)
		expect(reported[0]?.attributes["maple.exception.source"]).toBe("react.root")
		expect(reported[0]?.attributes["maple.react.component_stack"]).toBe("at Widget")
	})
})

/** A React Router data router, reduced to what the adapter reads. */
function fakeReactRouter(initial: ReactRouterState) {
	const listeners = new Set<(state: ReactRouterState) => void>()
	const router = {
		state: initial,
		subscribe(listener: (state: ReactRouterState) => void) {
			listeners.add(listener)
			return () => listeners.delete(listener)
		},
		set(next: Partial<ReactRouterState>) {
			router.state = { ...router.state, ...next }
			for (const listener of listeners) listener(router.state)
		},
	}
	return router
}

const idle = { state: "idle" }
const projectMatches = [{ route: { path: "/" } }, { route: { path: "projects/:id" } }]

describe("instrumentReactRouter", () => {
	it("spans the page load until the router initializes, then each loading navigation by template", async () => {
		const router = fakeReactRouter({
			initialized: false,
			location: { pathname: "/" },
			navigation: idle,
			matches: [{ route: { path: "/" } }],
		})
		const unsubscribe = instrumentReactRouter(router)
		router.set({ initialized: true })
		router.set({ navigation: { state: "loading", location: { pathname: "/projects/42" } } })
		router.set({ navigation: idle, location: { pathname: "/projects/42" }, matches: projectMatches })
		unsubscribe()
		await stop()
		expect(spanNames()).toEqual(["pageload /", "navigate /projects/:id"])
	})

	it("spans a navigation to a route without loaders, which never enters loading", async () => {
		const router = fakeReactRouter({
			initialized: true,
			location: { pathname: "/" },
			navigation: idle,
			matches: [{ route: { path: "/" } }],
		})
		const unsubscribe = instrumentReactRouter(router)
		router.set({ location: { pathname: "/projects/7" }, matches: projectMatches })
		unsubscribe()
		await stop()
		expect(spanNames()).toEqual(["pageload /", "navigate /projects/:id"])
	})
})

type TanStackEvent = { toLocation: { pathname: string }; pathChanged: boolean }

function fakeTanStackRouter() {
	const listeners = new Map<string, Set<(event: TanStackEvent) => void>>()
	const router = {
		state: {
			status: "pending",
			location: { pathname: "/" },
			matches: [] as Array<{ fullPath?: string; routeId: string }>,
		},
		subscribe(eventType: "onBeforeNavigate" | "onResolved", listener: (event: TanStackEvent) => void) {
			const set = listeners.get(eventType) ?? new Set()
			set.add(listener)
			listeners.set(eventType, set)
			return () => set.delete(listener)
		},
		emit(eventType: string, event: TanStackEvent) {
			for (const listener of listeners.get(eventType) ?? []) listener(event)
		},
	}
	return router
}

describe("instrumentTanStackRouter", () => {
	it("keeps the initial load as the page load and ignores search-only changes", async () => {
		const router = fakeTanStackRouter()
		const unsubscribe = instrumentTanStackRouter(router)
		// The router's own initial load re-announces the page load.
		router.emit("onBeforeNavigate", { toLocation: { pathname: "/" }, pathChanged: true })
		router.state.matches = [{ routeId: "__root__" }, { fullPath: "/", routeId: "/" }]
		router.emit("onResolved", { toLocation: { pathname: "/" }, pathChanged: true })

		router.emit("onBeforeNavigate", { toLocation: { pathname: "/" }, pathChanged: false })
		router.emit("onBeforeNavigate", { toLocation: { pathname: "/projects/42" }, pathChanged: true })
		router.state.matches = [
			{ routeId: "__root__" },
			{ fullPath: "/projects/$projectId", routeId: "/projects/$projectId" },
		]
		router.emit("onResolved", { toLocation: { pathname: "/projects/42" }, pathChanged: true })
		unsubscribe()
		await stop()
		expect(spanNames()).toEqual(["pageload /", "navigate /projects/$projectId"])
	})
})
