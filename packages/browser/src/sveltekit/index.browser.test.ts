// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import type { AfterNavigate, BeforeNavigate, NavigationEvent, NavigationTarget } from "@sveltejs/kit"
import { error, redirect } from "@sveltejs/kit"
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
const { handleErrorWithMaple, loadSpan, startPageLoad, traceNavigation } = await import("./index")

let handle: ReturnType<typeof MapleBrowser.init> | undefined

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

const names = () => exported.map((span) => span.name)
const named = (name: string): ReadableSpan | undefined => exported.find((span) => span.name === name)
const exceptionEvents = () =>
	exported.flatMap((span) => span.events.filter((event) => event.name === "exception"))

const target = (pathname: string): NavigationTarget => ({
	params: {},
	route: { id: null },
	url: new URL(pathname, location.href),
	scroll: null,
})

/** The route an error was thrown in, as `handleError` receives it. */
const event: NavigationEvent = {
	params: {},
	route: { id: "/broken" },
	url: new URL("/broken", location.href),
}

/**
 * SvelteKit's client router, as far as the root layout's callbacks can tell
 * (`navigate()` in its `client.js`): `beforeNavigate` runs only while no
 * navigation is loading, a newer navigation aborts the one it overtook once
 * that one's load finishes, and `navigating` is the navigation loading.
 */
function sveltekit() {
	const before = new Set<(navigation: BeforeNavigate) => void>()
	const after = new Set<(navigation: AfterNavigate) => void>()
	const page = { route: { id: null as string | null } }
	let loading: BeforeNavigate | null = null
	let token = {}

	traceNavigation({
		beforeNavigate: (callback) => before.add(callback),
		afterNavigate: (callback) => after.add(callback),
		navigating: {
			get type() {
				return loading?.type ?? null
			},
		},
		page,
	})

	/** A click, `goto()` or back to `pathname`. Carries the token of the navigation it redirects. */
	const start = (pathname: string, options: { willUnload?: boolean; redirects?: object } = {}) => {
		let fulfil = () => {}
		let reject: (error: Error) => void = () => {}
		const complete = new Promise<void>((resolve, fail) => {
			fulfil = resolve
			reject = fail
		})
		complete.catch(() => {})
		let cancelled = false
		const navigation: BeforeNavigate = {
			from: target(location.pathname),
			to: target(pathname),
			type: "goto",
			willUnload: options.willUnload ?? false,
			complete,
			cancel: () => {
				cancelled = true
				reject(new Error("navigation cancelled"))
			},
		}
		if (!loading) for (const callback of before) callback(navigation)
		if (cancelled || navigation.willUnload) return undefined
		const own = options.redirects ?? {}
		token = own
		loading = navigation
		return {
			/** Its route loaded: renders it, unless a newer navigation took over meanwhile. */
			finish(routeId: string): void {
				if (token !== own) {
					reject(new Error("navigation aborted"))
					return
				}
				page.route.id = routeId
				loading = null
				fulfil()
				for (const callback of after) callback({ ...navigation, type: "goto", willUnload: false })
			},
			/** A load threw `redirect()`: SvelteKit navigates again, under the same token. */
			redirect(to: string, routeId: string): void {
				start(to, { redirects: own })?.finish(routeId)
				fulfil()
			},
		}
	}

	return {
		start,
		/** Hydration rendered the first route: `afterNavigate` runs, without its route id. */
		enter(routeId: string): void {
			page.route.id = routeId
			for (const callback of after) {
				callback({
					from: null,
					to: target(location.pathname),
					type: "enter",
					willUnload: false,
					complete: Promise.resolve(),
				})
			}
		},
		/** Your own `beforeNavigate`, registered after the root layout's. */
		guard: (callback: (navigation: BeforeNavigate) => void) => before.add(callback),
	}
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
	await stop()
	exported.length = 0
	vi.unstubAllGlobals()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

describe("startPageLoad and traceNavigation", () => {
	it("names the page load and each navigation after the route", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		kit.start("/projects/8f2a")?.finish("/projects/[id]")
		kit.start("/projects/9b1c")?.finish("/projects/[id]")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/[id]", "navigate /projects/[id]"])
		expect(exported[0]?.attributes["url.path"]).toBe(location.pathname)
		expect(exported[1]?.attributes["url.path"]).toBe("/projects/8f2a")
	})

	it("keeps route groups in the name, as SvelteKit's server spans do", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/(app)/projects/[id]")
		await stop()

		expect(names()).toEqual(["pageload /(app)/projects/[id]"])
	})

	it("keeps one span for a click while a navigation loads, named after where it ends", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		const slow = kit.start("/slow")
		// No `beforeNavigate` for this one: SvelteKit skips it while /slow loads
		const projects = kit.start("/projects/1")
		// /slow's load finishes first: aborted, while /projects/1 still loads
		slow?.finish("/slow")
		await Promise.resolve()
		projects?.finish("/projects/[id]")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/[id]"])
		expect(exported[1]?.attributes["url.path"]).toBe("/slow")
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("ignores the overtaken navigation's abort after the newer one ended", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		const slow = kit.start("/slow")
		kit.start("/projects/1")?.finish("/projects/[id]")
		// A click after that one: its span must survive the stale abort below
		const settings = kit.start("/settings")
		slow?.finish("/slow")
		await Promise.resolve()
		settings?.finish("/settings")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/[id]", "navigate /settings"])
		expect(exported.some((span) => span.attributes["app.navigation.interrupted"])).toBe(false)
	})

	it("ends a cancelled navigation right away, as interrupted", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		kit.guard((navigation) => navigation.cancel())
		kit.start("/settings")
		await Promise.resolve()
		// Ended: it no longer parents what runs next
		await MapleBrowser.traced("query", async () => undefined)
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "query"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
		expect(named("query")?.parentSpanContext).toBeUndefined()
	})

	it("keeps a redirect in one span, named after the destination", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		kit.start("/old")?.redirect("/projects/1", "/projects/[id]")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/[id]"])
		expect(exported[1]?.attributes["url.path"]).toBe("/old")
	})

	it("starts nothing for a navigation that leaves the app", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		kit.start("/does-not-exist", { willUnload: true })
		await stop()

		expect(names()).toEqual(["pageload /"])
	})
})

describe("loadSpan", () => {
	it("nests a load under the navigation", async () => {
		const kit = sveltekit()
		startPageLoad()
		kit.enter("/")
		const navigation = kit.start("/projects/1")
		await loadSpan("loader /projects/[id]", () => fetch("/api/projects/1"))
		navigation?.finish("/projects/[id]")
		await stop()

		const load = named("loader /projects/[id]")
		expect(load?.parentSpanContext?.spanId).toBe(named("navigate /projects/[id]")?.spanContext().spanId)
	})

	it("doesn't count redirect() or error() below 500 as failures", async () => {
		await expect(loadSpan("loader /old", async () => redirect(307, "/projects/1"))).rejects.toMatchObject(
			{
				status: 307,
			},
		)
		await expect(
			loadSpan("loader /projects/[id]", async () => error(404, "Not found")),
		).rejects.toMatchObject({
			status: 404,
		})
		await stop()

		expect(exported.map((span) => span.status.code)).toEqual([0, 0])
		expect(exceptionEvents()).toHaveLength(0)
	})

	it("records error() from 500 and thrown errors, once even when handleError sees them", async () => {
		await expect(loadSpan("loader /down", async () => error(503, "Unavailable"))).rejects.toMatchObject({
			status: 503,
		})
		const failure = await loadSpan("loader /broken", async () => {
			throw new Error("loader exploded")
		}).catch((caught: unknown) => caught)
		// SvelteKit hands the unexpected one to handleError next
		await handleErrorWithMaple()({
			error: failure,
			event,
			status: 500,
			message: "Internal Error",
		})
		await stop()

		expect(names()).toEqual(["loader /down", "loader /broken"])
		expect(exported.map((span) => span.status.code)).toEqual([2, 2])
		expect(exceptionEvents()).toHaveLength(2)
	})
})

describe("handleErrorWithMaple", () => {
	it("reports an unexpected error and returns what your handleError returns", async () => {
		const yours = vi.fn(() => ({ message: "Something broke" }))
		const result = await handleErrorWithMaple(yours)({
			error: new Error("render exploded"),
			event,
			status: 500,
			message: "Internal Error",
		})
		await stop()

		expect(result).toEqual({ message: "Something broke" })
		expect(yours).toHaveBeenCalledOnce()
		expect(names()).toEqual(["sveltekit.client_error"])
		expect(exceptionEvents()[0]?.attributes?.["exception.message"]).toBe("render exploded")
	})

	it("skips a 404, which is what an unknown route reports, but still calls yours", async () => {
		const yours = vi.fn()
		await handleErrorWithMaple(yours)({
			error: new Error("Not found: /does-not-exist"),
			event,
			status: 404,
			message: "Not Found",
		})
		await stop()

		expect(yours).toHaveBeenCalledOnce()
		expect(names()).toEqual([])
	})
})
