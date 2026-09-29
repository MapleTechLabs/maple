// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
import { context, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { type App, type Component, createApp, defineComponent, h, nextTick, onMounted } from "vue"
import * as VueRouter5 from "vue-router"
import type { Router, RouteRecordRaw } from "vue-router"
import * as VueRouter4 from "vue-router-4"

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
const { MapleVue, traceRouter } = await import("./index")

let handle: ReturnType<typeof MapleBrowser.init> | undefined
let app: App | undefined

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

const names = () => exported.map((span) => span.name)
const named = (name: string): ReadableSpan => {
	const span = exported.find((candidate) => candidate.name === name)
	if (!span) throw new Error(`no span named ${name}: ${names().join(", ")}`)
	return span
}
const exceptionEvents = () =>
	exported.flatMap((span) => span.events.filter((event) => event.name === "exception"))

const page = (text: string): Component => ({ render: () => h("p", text) })

/** A promise a test settles by hand, to hold a navigation in a guard. */
function gate(): { promise: Promise<void>; open: () => void; fail: (error: Error) => void } {
	let open = (): void => undefined
	let fail = (_error: Error): void => undefined
	const promise = new Promise<void>((resolve, reject) => {
		open = resolve
		fail = reject
	})
	return { promise, open, fail }
}

/** Let a navigation run its guards up to one that waits. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response("{}")),
	)
	consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
	handle = MapleBrowser.init({
		ingestKey: "k",
		serviceName: "web",
		endpoint: "https://ingest.test",
		replay: { enabled: false },
	})
})

afterEach(async () => {
	app?.unmount()
	app = undefined
	await stop()
	exported.length = 0
	vi.unstubAllGlobals()
	vi.restoreAllMocks()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

const routers = [
	["Vue Router 5", VueRouter5],
	// SAFETY: Vue Router 4 has the same runtime API; its types are a separate copy, not a different contract
	["Vue Router 4", VueRouter4 as unknown as typeof VueRouter5],
] as const

describe.each(routers)("traceRouter with %s", (_, lib) => {
	const routes: RouteRecordRaw[] = [
		{ path: "/", component: page("home") },
		{ path: "/projects/:id", component: page("project") },
		{
			path: "/teams/:team",
			component: { render: () => h(lib.RouterView) },
			children: [{ path: "members", component: page("members") }],
		},
		{ path: "/old", redirect: "/projects/1" },
		{ path: "/admin", component: page("admin") },
		{ path: "/login", component: page("login") },
		{ path: "/slow", component: page("slow") },
		{ path: "/broken", component: page("broken") },
		{ path: "/:pathMatch(.*)*", component: page("not found") },
	]

	/** A router at `path`, traced and mounted in an app, with the page load finished. */
	async function start(path = "/", extra: RouteRecordRaw[] = [], guards?: (router: Router) => void) {
		const history = lib.createMemoryHistory()
		history.replace(path)
		const router = lib.createRouter({ history, routes: [...extra, ...routes] })
		traceRouter(router)
		guards?.(router)
		app = createApp({ render: () => h(lib.RouterView) })
		app.use(router)
		app.mount(document.body.appendChild(document.createElement("div")))
		await router.isReady()
		await nextTick()
		return router
	}

	it("names the page load and each navigation after the route template", async () => {
		const router = await start("/projects/8f2a")
		await router.push("/projects/9b1c")
		await router.push("/teams/core/members")
		await nextTick()
		await stop()

		expect(names()).toEqual([
			"pageload /projects/:id",
			"navigate /projects/:id",
			"navigate /teams/:team/members",
		])
		expect(exported.map((span) => span.attributes["url.path"])).toEqual([
			"/projects/8f2a",
			"/projects/9b1c",
			"/teams/core/members",
		])
	})

	it("ends the span once the new page rendered, so what its setup starts nests under it", async () => {
		const loading = defineComponent({
			setup() {
				void MapleBrowser.traced("loader /loading", async () => undefined)
				return () => h("p", "loading")
			},
		})
		const router = await start("/", [{ path: "/loading", component: loading }])
		await router.push("/loading")
		await nextTick()
		await stop()

		const navigation = named("navigate /loading")
		expect(named("loader /loading").parentSpanContext?.spanId).toBe(navigation.spanContext().spanId)
	})

	it("keeps a route record's redirect in one span, named after the target", async () => {
		const router = await start()
		await router.push("/old")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/:id"])
		expect(exported[1]?.attributes["url.path"]).toBe("/projects/1")
	})

	it("keeps a guard's redirect in the span the original location opened", async () => {
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => (to.path === "/admin" ? "/login" : undefined))
		})
		await router.push("/admin")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /login"])
		expect(exported[1]?.attributes["url.path"]).toBe("/admin")
	})

	it("ends an aborted navigation, named after the route it tried to reach", async () => {
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => to.path !== "/admin")
		})
		await router.push("/admin")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /admin"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("ends a navigation replaced by a newer one as interrupted", async () => {
		const slow = gate()
		const next = gate()
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => {
				if (to.path === "/slow") return slow.promise
				if (to.path === "/admin") return next.promise
			})
		})
		const first = router.push("/slow")
		await settle()
		const second = router.push("/admin")
		await settle()
		// /slow is cancelled while /admin is still in flight
		slow.open()
		await first
		next.open()
		await second
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "navigate /admin"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
		expect(exported[2]?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("ends a navigation cancelled by one a guard before its own stopped as interrupted", async () => {
		const slow = gate()
		// Leave guards run before every `beforeEach`
		const home = { ...page("home"), beforeRouteLeave: (to: { path: string }) => to.path !== "/login" }
		const router = await start("/", [{ path: "/", component: home }], (router) => {
			router.beforeEach((to) => (to.path === "/slow" ? slow.promise : undefined))
		})
		const first = router.push("/slow")
		await settle()
		await router.push("/login")
		slow.open()
		await first
		await router.push("/projects/1")
		await nextTick()
		await stop()

		// Not named after /login, which it never reached, and not left open until the next click
		expect(names()).toEqual(["pageload /", "navigate", "navigate /projects/:id"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
	})

	it("ends a navigation cancelled by a link back to the page on screen as interrupted", async () => {
		const slow = gate()
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => (to.path === "/slow" ? slow.promise : undefined))
		})
		const first = router.push("/slow")
		await settle()
		// Runs no guards, but cancels /slow
		await router.push("/")
		slow.open()
		await first
		// Ended now: it no longer parents what runs next
		await MapleBrowser.traced("query members", async () => undefined)
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "query members"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBe(true)
		expect(exported[2]?.parentSpanContext).toBeUndefined()
	})

	it("ends a guard's redirect back to the page on screen", async () => {
		const router = await start("/login", [], (router) => {
			router.beforeEach((to) => (to.path === "/admin" ? "/login" : undefined))
		})
		await router.push("/admin")
		await MapleBrowser.traced("query session", async () => undefined)
		await stop()

		expect(names()).toEqual(["pageload /login", "navigate /login", "query session"])
		expect(exported[1]?.attributes["url.path"]).toBe("/admin")
		expect(exported[2]?.parentSpanContext).toBeUndefined()
	})

	it("ignores a link to the page on screen", async () => {
		const router = await start("/projects/1")
		await router.push("/projects/1")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /projects/:id"])
	})

	it("traces query and hash changes, and back and forward", async () => {
		const router = await start("/projects/1")
		await router.push("/projects/1?tab=members")
		await router.push("/projects/1?tab=members#section")
		router.back()
		await settle()
		await nextTick()
		await stop()

		expect(names()).toEqual([
			"pageload /projects/:id",
			"navigate /projects/:id",
			"navigate /projects/:id",
			"navigate /projects/:id",
		])
		expect(exported.at(-1)?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("names a URL no route matches after the catch-all route", async () => {
		const router = await start()
		await router.push("/does-not-exist")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /:pathMatch(.*)*"])
		expect(exported[1]?.attributes["url.path"]).toBe("/does-not-exist")
	})

	it("reports an error a guard throws once, ends its span, and still logs it", async () => {
		const error = new Error("guard exploded")
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => {
				if (to.path === "/broken") throw error
			})
		})
		await expect(router.push("/broken")).rejects.toBe(error)
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /broken", "vue_router.error"])
		expect(exceptionEvents()).toHaveLength(1)
		expect(consoleError).toHaveBeenCalledWith(error)
	})

	it("doesn't report a guard error again that traced already recorded", async () => {
		const error = new Error("loader exploded")
		const router = await start("/", [], (router) => {
			router.beforeResolve((to) =>
				to.path === "/broken"
					? MapleBrowser.traced("loader /broken", async () => {
							throw error
						})
					: undefined,
			)
		})
		await expect(router.push("/broken")).rejects.toBe(error)
		await stop()

		expect(names()).toEqual(["pageload /", "loader /broken", "navigate /broken"])
		expect(exceptionEvents()).toHaveLength(1)
		expect(named("loader /broken").parentSpanContext?.spanId).toBe(
			named("navigate /broken").spanContext().spanId,
		)
	})

	it("doesn't end the navigation in flight for an older navigation's error", async () => {
		const slow = gate()
		const next = gate()
		const router = await start("/", [], (router) => {
			router.beforeEach((to) => {
				if (to.path === "/slow") return slow.promise
				if (to.path === "/admin") return next.promise
			})
		})
		const first = router.push("/slow").catch(() => undefined)
		await settle()
		const second = router.push("/admin")
		await settle()
		slow.fail(new Error("stale guard exploded"))
		await first
		next.open()
		await second
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate", "vue_router.error", "navigate /admin"])
	})

	it("traces a router once, however often it's passed", async () => {
		const router = await start("/", [], (router) => traceRouter(router))
		await router.push("/projects/1")
		await nextTick()
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /projects/:id"])
	})
})

describe("MapleVue", () => {
	const mount = (component: Component, setup?: (app: App) => void): void => {
		app = createApp(component)
		setup?.(app)
		app.use(MapleVue)
		app.mount(document.body.appendChild(document.createElement("div")))
	}
	const broken = {
		render: () => {
			throw new Error("render exploded")
		},
	}

	it("reports a component error once, with where Vue caught it, and hands it back to Vue", async () => {
		// Development builds throw an error no handler took; production builds log it
		expect(() => mount(broken)).toThrow("render exploded")
		await stop()

		const span = named("vue.error")
		expect(span.attributes["vue.error.info"]).toBe("render function")
		expect(exceptionEvents()).toHaveLength(1)
		expect(exceptionEvents()[0]?.attributes?.["exception.message"]).toBe("render exploded")
	})

	it("calls the errorHandler set before it instead of logging", async () => {
		const own = vi.fn()
		mount(broken, (app) => {
			app.config.errorHandler = own
		})
		await stop()

		expect(names()).toEqual(["vue.error"])
		expect(own).toHaveBeenCalledWith(
			expect.objectContaining({ message: "render exploded" }),
			expect.anything(),
			"render function",
		)
		expect(consoleError).not.toHaveBeenCalled()
	})

	it("doesn't report an error traced already recorded", async () => {
		const own = vi.fn()
		const loading = {
			setup() {
				onMounted(() =>
					MapleBrowser.traced("loader /", async () => {
						throw new Error("loader exploded")
					}),
				)
				return () => h("p", "page")
			},
		}
		mount(loading, (app) => {
			app.config.errorHandler = own
		})
		// Vue hands the rejected hook to the handler once the promise settles
		await vi.waitFor(() => expect(own).toHaveBeenCalledOnce())
		await stop()

		expect(names()).toEqual(["loader /"])
		expect(exceptionEvents()).toHaveLength(1)
	})
})
