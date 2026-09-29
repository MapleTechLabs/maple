// TEST-SEAM: This focused test replaces process-global modules that have no instance-level injection seam.
// The JIT compiler links Angular's partially compiled packages at runtime, as an app build's linker would
import "@angular/compiler"
import { Location } from "@angular/common"
import { provideLocationMocks } from "@angular/common/testing"
import {
	type ApplicationRef,
	Component,
	ErrorHandler,
	type EnvironmentProviders,
	inject,
	PLATFORM_ID,
	type Provider,
	provideAppInitializer,
	provideBrowserGlobalErrorListeners,
} from "@angular/core"
import { bootstrapApplication, createApplication } from "@angular/platform-browser"
import {
	provideRouter,
	RedirectCommand,
	Router,
	RouterOutlet,
	type Routes,
	withEnabledBlockingInitialNavigation,
} from "@angular/router"
import { context, trace } from "@opentelemetry/api"
import type { ReadableSpan } from "@opentelemetry/sdk-trace-base"
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
const { MapleErrorHandler, provideMapleTracing, reportAngularError, tracedResolver } = await import("./index")

/** Resolves the `/slow` route's data once its resolver runs. */
let releaseSlow: (() => void) | undefined
const loaderError = new Error("loader exploded")

const routes: Routes = [
	{ path: "", children: [] },
	{
		path: "projects/:id",
		children: [],
		resolve: { project: () => tracedResolver("loader /projects/:id", async () => ({ ok: true })) },
	},
	{
		path: "teams/:team",
		children: [{ path: "", children: [{ path: "members/:member", children: [] }] }],
	},
	{ path: "old", children: [], canActivate: [() => inject(Router).parseUrl("/projects/1")] },
	{
		path: "slow",
		children: [],
		resolve: {
			project: () =>
				tracedResolver(
					"loader /slow",
					() =>
						new Promise<void>((resolve) => {
							releaseSlow = resolve
						}),
				),
		},
	},
	{
		path: "broken",
		children: [],
		resolve: {
			project: () =>
				tracedResolver("loader /broken", async () => {
					throw loaderError
				}),
		},
	},
	{
		path: "missing",
		children: [],
		resolve: {
			project: () => {
				const router = inject(Router)
				return tracedResolver(
					"loader /missing",
					async () =>
						new RedirectCommand(router.parseUrl("/not-found"), { skipLocationChange: true }),
				)
			},
		},
	},
	{
		path: "thrown-redirect",
		children: [],
		resolve: {
			project: () => {
				const router = inject(Router)
				return tracedResolver("loader /thrown-redirect", async () => {
					throw new RedirectCommand(router.parseUrl("/not-found"))
				})
			},
		},
	},
	{ path: "guarded", children: [], canActivate: [() => false] },
	{ path: "not-found", children: [] },
	{ path: "**", children: [] },
]

let handle: ReturnType<typeof MapleBrowser.init> | undefined
let app: ApplicationRef | undefined

const stop = async (): Promise<void> => {
	await handle?.shutdown()
	handle = undefined
}

/** An app with the router on mock history, and the page load done. */
const start = async (providers: (Provider | EnvironmentProviders)[] = [provideMapleTracing()]) => {
	app = await createApplication({
		providers: [provideRouter(routes), provideLocationMocks(), ...providers],
	})
	const router = app.injector.get(Router)
	// As the router starts at bootstrap: from the URL on screen, listening for back and forward
	router.initialNavigation()
	await vi.waitFor(() => expect(router.navigated).toBe(true))
	return router
}

const names = () => exported.map((span) => span.name)
const named = (name: string) => exported.find((span) => span.name === name)
const exceptions = () => exported.flatMap((span) => span.events.filter((event) => event.name === "exception"))

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
	app?.destroy()
	app = undefined
	await stop()
	exported.length = 0
	releaseSlow = undefined
	vi.restoreAllMocks()
	vi.unstubAllGlobals()
	resetReportedErrorsForTests()
	resetNavigationForTests()
	trace.disable()
	context.disable()
})

describe("provideMapleTracing", () => {
	it("names the page load and each navigation after the route, with the path on the span", async () => {
		const router = await start()
		await router.navigateByUrl("/projects/1")
		await router.navigateByUrl("/projects/2")
		await stop()

		expect(names()).toEqual([
			"pageload /",
			"loader /projects/:id",
			"navigate /projects/:id",
			"loader /projects/:id",
			"navigate /projects/:id",
		])
		expect(exported[2]?.attributes["url.path"]).toBe("/projects/1")
		expect(exported[4]?.attributes["url.path"]).toBe("/projects/2")
	})

	it("puts the resolver's span under the navigation", async () => {
		const router = await start()
		await router.navigateByUrl("/projects/1")
		await stop()

		const navigation = named("navigate /projects/:id")
		expect(named("loader /projects/:id")?.parentSpanContext?.spanId).toBe(
			navigation?.spanContext().spanId,
		)
		expect(named("loader /projects/:id")?.spanContext().traceId).toBe(navigation?.spanContext().traceId)
	})

	it("joins nested routes' paths and skips layout routes", async () => {
		const router = await start()
		await router.navigateByUrl("/teams/acme/members/7")
		await router.navigateByUrl("/does/not/exist")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate /teams/:team/members/:member", "navigate /**"])
	})

	it("keeps the query and hash out of the path, and traces a query or hash change", async () => {
		const router = await start()
		await router.navigateByUrl("/projects/1?tab=members#top")
		await router.navigateByUrl("/projects/1?tab=settings")
		await router.navigateByUrl("/projects/1?tab=settings#bottom")
		await stop()

		expect(names().filter((name) => name.startsWith("navigate"))).toEqual([
			"navigate /projects/:id",
			"navigate /projects/:id",
			"navigate /projects/:id",
		])
		expect(exported.map((span) => span.attributes["url.path"]).filter(Boolean)).toEqual([
			"/",
			"/projects/1",
			"/projects/1",
			"/projects/1",
		])
	})

	it("keeps a guard's redirect in one span, named after where it lands", async () => {
		const router = await start()
		await router.navigateByUrl("/old")
		await stop()

		expect(names()).toEqual(["pageload /", "loader /projects/:id", "navigate /projects/:id"])
		expect(named("navigate /projects/:id")?.attributes["url.path"]).toBe("/old")
		expect(named("loader /projects/:id")?.parentSpanContext?.spanId).toBe(
			named("navigate /projects/:id")?.spanContext().spanId,
		)
	})

	it("ends a redirect to the page on screen there, and traces the next navigation", async () => {
		const router = await start()
		await router.navigateByUrl("/projects/1")
		// The guard sends /old to /projects/1, which is already on screen: Angular skips it
		await router.navigateByUrl("/old")
		await router.navigateByUrl("/projects/2")
		await stop()

		const navigations = exported.filter((span) => span.name.startsWith("navigate"))
		expect(navigations.map((span) => [span.name, span.attributes["url.path"]])).toEqual([
			["navigate /projects/:id", "/projects/1"],
			["navigate /projects/:id", "/old"],
			["navigate /projects/:id", "/projects/2"],
		])
		expect(navigations[1]?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("names a resolver's RedirectCommand to a not-found route after that route, and leaves the resolver Ok", async () => {
		const router = await start()
		await router.navigateByUrl("/missing")
		await router.navigateByUrl("/thrown-redirect")
		await stop()

		expect(names()).toEqual([
			"pageload /",
			"loader /missing",
			"navigate /not-found",
			"loader /thrown-redirect",
			"navigate /not-found",
		])
		expect(exported.map((span) => span.status.code)).not.toContain(2)
		expect(exceptions()).toHaveLength(0)
		expect(router.url).toBe("/not-found")
	})

	it("ends a navigation a newer one replaced as interrupted", async () => {
		const router = await start()
		void router.navigateByUrl("/slow")
		await vi.waitFor(() => expect(releaseSlow).toBeDefined())
		await router.navigateByUrl("/projects/1")
		// The replaced navigation's resolver still finishes: Angular ignores its result
		releaseSlow?.()
		await stop()

		const interrupted = exported.find((span) => span.attributes["app.navigation.interrupted"])
		expect(interrupted?.name).toBe("navigate")
		expect(interrupted?.attributes["url.path"]).toBe("/slow")
		expect(names()).toContain("navigate /projects/:id")
		expect(names().filter((name) => name.startsWith("navigate"))).toHaveLength(2)
	})

	it("ends a navigation replaced by a link to the URL on screen as interrupted", async () => {
		const router = await start()
		void router.navigateByUrl("/slow")
		await vi.waitFor(() => expect(releaseSlow).toBeDefined())
		await router.navigateByUrl("/")
		// Ended now: it no longer parents what runs next
		await MapleBrowser.traced("query members", async () => undefined)
		releaseSlow?.()
		await stop()

		const navigation = exported.find((span) => span.name === "navigate")
		expect(navigation?.attributes["app.navigation.interrupted"]).toBe(true)
		expect(named("query members")?.parentSpanContext).toBeUndefined()
		expect(router.url).toBe("/")
	})

	it("starts nothing for a navigation to the URL on screen", async () => {
		const router = await start()
		await router.navigateByUrl("/")
		await stop()

		expect(names()).toEqual(["pageload /"])
	})

	it("ends a navigation a guard rejected, without a route name", async () => {
		const router = await start()
		await router.navigateByUrl("/guarded")
		await stop()

		expect(names()).toEqual(["pageload /", "navigate"])
		expect(exported[1]?.attributes["app.navigation.interrupted"]).toBeUndefined()
	})

	it("names a failed navigation after its route and records the resolver's error once", async () => {
		const router = await start([
			provideMapleTracing(),
			{ provide: ErrorHandler, useClass: MapleErrorHandler },
		])
		vi.spyOn(console, "error").mockImplementation(() => {})
		const failure = await router.navigateByUrl("/broken").catch((error: unknown) => error)
		// What `RouterLink` does with a navigation that failed
		app?.injector.get(ErrorHandler).handleError(failure)
		await stop()

		expect(failure).toBe(loaderError)
		expect(names()).toEqual(["pageload /", "loader /broken", "navigate /broken"])
		expect(named("loader /broken")?.status.code).toBe(2)
		expect(exceptions()).toHaveLength(1)
		expect(exceptions()[0]?.attributes?.["exception.message"]).toBe("loader exploded")
	})

	it("traces back and forward", async () => {
		const router = await start()
		await router.navigateByUrl("/projects/1")
		const location = app?.injector.get(Location)
		location?.back()
		await vi.waitFor(() => expect(router.url).toBe("/"))
		location?.forward()
		await vi.waitFor(() => expect(router.url).toBe("/projects/1"))
		await stop()

		expect(names().filter((name) => name.startsWith("navigate"))).toEqual([
			"navigate /projects/:id",
			"navigate /",
			"navigate /projects/:id",
		])
	})

	it("sees a navigation an app initializer starts", async () => {
		app = await createApplication({
			providers: [
				provideRouter(routes),
				provideLocationMocks(),
				provideAppInitializer(() => void inject(Router).navigateByUrl("/projects/1")),
				provideMapleTracing(),
			],
		})
		const router = app.injector.get(Router)
		await vi.waitFor(() => expect(router.navigated).toBe(true))
		await stop()

		expect(names()).toEqual(["loader /projects/:id", "pageload /projects/:id"])
	})

	it("traces the page load of a bootstrapped app with a blocking initial navigation", async () => {
		// A real bootstrap: the blocking initial navigation finishes once the root component is created
		const Root = Component({
			selector: "app-root",
			template: "<router-outlet />",
			imports: [RouterOutlet],
		})(class {})
		document.body.append(document.createElement("app-root"))
		app = await bootstrapApplication(Root, {
			providers: [
				provideRouter(routes, withEnabledBlockingInitialNavigation()),
				provideLocationMocks(),
				provideMapleTracing(),
			],
		})
		await stop()

		expect(names()).toEqual(["pageload /"])
	})

	it("traces each navigation once when provided twice", async () => {
		const router = await start([provideMapleTracing(), provideMapleTracing()])
		await router.navigateByUrl("/projects/1")
		await stop()

		expect(names()).toEqual(["pageload /", "loader /projects/:id", "navigate /projects/:id"])
	})

	it("does nothing on the server", async () => {
		const router = await start([provideMapleTracing(), { provide: PLATFORM_ID, useValue: "server" }])
		await router.navigateByUrl("/projects/1")
		await stop()

		// The resolver is still traced; no navigation parents it
		expect(names()).toEqual(["loader /projects/:id"])
	})
})

describe("MapleErrorHandler", () => {
	it("reports the error once and still logs it as Angular does", async () => {
		await start([provideMapleTracing(), { provide: ErrorHandler, useClass: MapleErrorHandler }])
		const log = vi.spyOn(console, "error").mockImplementation(() => {})
		const handler = app?.injector.get(ErrorHandler)
		const error = new Error("click handler exploded")
		handler?.handleError(error)
		// `provideBrowserGlobalErrorListeners()` may hand it over again
		handler?.handleError(error)
		await stop()

		expect(handler).toBeInstanceOf(MapleErrorHandler)
		expect(log).toHaveBeenCalledWith("ERROR", error)
		expect(exported.filter((span) => span.name === "angular.error")).toHaveLength(1)
		expect(exceptions()[0]?.attributes?.["exception.message"]).toBe("click handler exploded")
	})
})

describe("reportAngularError", () => {
	it("leaves a window error without an error object, like a cross-origin Script error., to the SDK's own handler", async () => {
		await start([
			provideBrowserGlobalErrorListeners(),
			provideMapleTracing(),
			{ provide: ErrorHandler, useClass: MapleErrorHandler },
		])
		vi.spyOn(console, "error").mockImplementation(() => {})
		window.dispatchEvent(new ErrorEvent("error", { message: "Script error." }))
		await stop()

		expect(names()).toEqual(["pageload /"])
	})

	it("reports a thrown value that isn't an Error", async () => {
		reportAngularError("plain string")
		await stop()

		expect(names()).toEqual(["angular.error"])
	})

	it("skips an error a resolver already recorded", async () => {
		await expect(
			tracedResolver("loader", async () => {
				throw loaderError
			}),
		).rejects.toBe(loaderError)
		reportAngularError(loaderError)
		await stop()

		expect(names()).toEqual(["loader"])
	})
})
