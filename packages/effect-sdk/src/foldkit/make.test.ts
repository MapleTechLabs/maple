// SAFETY-FILE: JSON in this test is the OTLP body the SDK under test posted, parsed before its fields are asserted.
import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Option, pipe, Array as Arr, Record as Rec, String as Str } from "effect"
import { afterEach, expect, onTestFinished, vi } from "vitest"
import { make } from "./make.js"

interface OtlpBody {
	readonly resourceSpans?: ReadonlyArray<{
		readonly scopeSpans: ReadonlyArray<{
			readonly spans: ReadonlyArray<{
				readonly name: string
				readonly traceId: string
				readonly parentSpanId?: string
				readonly attributes: ReadonlyArray<{ readonly key: string; readonly value: unknown }>
			}>
		}>
	}>
}

interface TestModel {
	readonly filter: string
}

const setup = () => {
	// One target standing in for `window`: `make` and the flush both listen on `globalThis`.
	const target = new EventTarget()
	vi.stubGlobal("addEventListener", target.addEventListener.bind(target))
	vi.stubGlobal("removeEventListener", target.removeEventListener.bind(target))
	const bodies: Array<OtlpBody> = []
	vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		if (Str.endsWith("/v1/traces")(url) && typeof init?.body === "string")
			bodies.push(JSON.parse(init.body))
		return new Response(null, { status: 200 })
	})
	const maple = make({
		serviceName: "foldkit-test",
		endpoint: "http://ingest.test",
		autoFlushInterval: false,
		replay: { enabled: false },
		emitSessionMeta: false,
		captureGlobalErrors: false,
	})
	const spans = () =>
		Arr.flatMap(bodies, (body) =>
			Arr.flatMap(body.resourceSpans ?? [], (resource) =>
				Arr.flatMap(resource.scopeSpans, (scope) => scope.spans),
			),
		)
	return { target, maple, spans }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

describe("MapleFoldkit.make", () => {
	afterEach(() => {
		vi.unstubAllGlobals()
	})

	it("ends the open page load before the unload flush sends the buffer", async () => {
		const { target, maple, spans } = setup()
		const app = maple.instrument({
			resources: Layer.empty,
			init: (_flags: undefined, _url: { readonly pathname: string }) => ({
				model: {},
				commands: [
					{
						name: "LoadServices",
						args: { environmentId: "env_1" },
						effect: Effect.succeed({ _tag: "LoadedServices" }).pipe(
							Effect.withSpan("http.client GET"),
						),
					},
				],
			}),
		})
		const { commands } = app.init(undefined, { pathname: "/services" })
		// What Foldkit's runtime does with each Command.
		await Promise.all(
			Arr.map(commands, (command) =>
				Effect.runPromise(
					command.effect.pipe(
						Effect.withSpan(command.name, { attributes: command.args }),
						Effect.provide(app.resources),
					),
				),
			),
		)
		// The tab closes before the navigation's quiet period ends it.
		target.dispatchEvent(new Event("pagehide"))
		await settle()
		const names = Arr.map(spans(), (span) => span.name)
		expect(names).toContain("pageload /services")
		expect(names).toContain("LoadServices")
		await maple.dispose()
	})

	it("exports a Command's args under its own namespace and marks a page load cut short", async () => {
		const { target, maple, spans } = setup()
		const app = maple.instrument({
			resources: Layer.empty,
			init: (_flags: undefined, _url: { readonly pathname: string }) => ({
				model: {},
				commands: [
					{
						name: "LoadServices",
						args: { orgId: "org_1", filter: "checkout" },
						effect: Effect.succeed({ _tag: "LoadedServices" }).pipe(
							Effect.withSpan("http.client GET"),
						),
					},
				],
			}),
		})
		const { commands } = app.init(undefined, { pathname: "/services" })
		await Promise.all(
			Arr.map(commands, (command) =>
				Effect.runPromise(
					command.effect.pipe(
						Effect.withSpan(command.name, { attributes: command.args }),
						Effect.provide(app.resources),
					),
				),
			),
		)
		target.dispatchEvent(new Event("pagehide"))
		await settle()
		const attributesOf = (name: string) =>
			Rec.fromEntries(
				Arr.map(
					Option.match(
						Arr.findFirst(spans(), (span) => span.name === name),
						{ onNone: () => [], onSome: (span) => span.attributes },
					),
					(a): readonly [string, unknown] => [a.key, a.value],
				),
			)
		const command = attributesOf("LoadServices")
		expect(command["maple.foldkit.arg.orgId"]).toEqual({ stringValue: "org_1" })
		expect(command["maple.foldkit.arg.filter"]).toEqual({ stringValue: "[redacted]" })
		expect(command["orgId"]).toBeUndefined()
		expect(attributesOf("pageload /services")["maple.navigation.interrupted"]).toEqual({
			boolValue: true,
		})
		await maple.dispose()
	})

	it("puts the document's timing and the app's init time on the page load", async () => {
		const navigationEntry = {
			name: "https://app.test/services",
			entryType: "navigation",
			startTime: 0,
			duration: 0,
			toJSON: () => ({}),
			responseStart: 40.4,
			responseEnd: 52.6,
		}
		const { target, maple, spans } = setup()
		// A property stub, not `vi.spyOn`: web-vitals' typings overload `getEntriesByType` per entry type.
		Object.defineProperty(performance, "getEntriesByType", {
			value: () => [navigationEntry],
			configurable: true,
		})
		onTestFinished(() => {
			Reflect.deleteProperty(performance, "getEntriesByType")
		})
		vi.spyOn(performance, "now").mockReturnValue(812.3)
		const app = maple.instrument({
			resources: Layer.empty,
			init: (_flags: undefined, _url: { readonly pathname: string }) => ({
				model: {},
				commands: [
					{
						name: "LoadServices",
						args: {},
						effect: Effect.succeed({ _tag: "LoadedServices" }).pipe(
							Effect.withSpan("http.client GET"),
						),
					},
				],
			}),
		})
		const { commands } = app.init(undefined, { pathname: "/services" })
		vi.restoreAllMocks()
		await Promise.all(
			Arr.map(commands, (command) =>
				Effect.runPromise(
					command.effect.pipe(
						Effect.withSpan(command.name, { attributes: command.args }),
						Effect.provide(app.resources),
					),
				),
			),
		)
		target.dispatchEvent(new Event("pagehide"))
		await settle()
		const pageload = Rec.fromEntries(
			Arr.map(
				Option.getOrThrow(Arr.findFirst(spans(), (span) => span.name === "pageload /services"))
					.attributes,
				(a): readonly [string, unknown] => [a.key, a.value],
			),
		)
		expect(pageload["maple.pageload.response_start_ms"]).toEqual({ intValue: 40 })
		expect(pageload["maple.pageload.response_end_ms"]).toEqual({ intValue: 53 })
		expect(pageload["maple.pageload.init_ms"]).toEqual({ intValue: 812 })
		await maple.dispose()
	})

	it("sends a navigation still open at dispose with the final flush", async () => {
		const { maple, spans } = setup()
		const app = maple.instrument({
			resources: Layer.empty,
			init: (_flags: undefined, _url: { readonly pathname: string }) => ({
				model: {},
				commands: [
					{
						name: "LoadServices",
						args: { environmentId: "env_1" },
						effect: Effect.succeed({ _tag: "LoadedServices" }).pipe(
							Effect.withSpan("http.client GET"),
						),
					},
				],
			}),
		})
		const { commands } = app.init(undefined, { pathname: "/services" })
		await Promise.all(
			Arr.map(commands, (command) =>
				Effect.runPromise(
					command.effect.pipe(
						Effect.withSpan(command.name, { attributes: command.args }),
						Effect.provide(app.resources),
					),
				),
			),
		)
		await maple.dispose()
		expect(Arr.map(spans(), (span) => span.name)).toContain("pageload /services")
	})

	it("puts the Commands a page load's result Message starts in the page load's trace", async () => {
		const { maple, spans } = setup()
		const app = maple.instrument({
			resources: Layer.empty,
			init: (_flags: undefined, _url: { readonly pathname: string }) => ({
				model: {},
				commands: [
					{
						name: "LoadServices",
						args: {},
						effect: Effect.succeed({ _tag: "LoadedServices" }).pipe(
							Effect.withSpan("http.client GET"),
						),
					},
				],
			}),
			update: (model: TestModel, message: { readonly _tag: string }) => ({
				model,
				commands:
					message._tag === "LoadedServices"
						? [
								{
									name: "LoadAlerts",
									args: {},
									effect: Effect.succeed({ _tag: "LoadedAlerts" }).pipe(
										Effect.withSpan("http.client GET"),
									),
								},
							]
						: [],
			}),
		})
		// What Foldkit's runtime does: run each Command, then feed its Message to update.
		const run = (command: (typeof commands)[number]) =>
			Effect.runPromise(
				command.effect.pipe(
					Effect.withSpan(command.name, { attributes: command.args }),
					Effect.provide(app.resources),
				),
			)
		const { commands } = app.init(undefined, { pathname: "/services" })
		const [loaded] = await Promise.all(Arr.map(commands, run))
		assert.isDefined(loaded)
		const followUps = app.update({ filter: "" }, loaded).commands
		await Promise.all(Arr.map(followUps, run))
		await maple.dispose()
		const pageload = Option.getOrThrow(
			Arr.findFirst(spans(), (span) => span.name === "pageload /services"),
		)
		const loadAlerts = Option.getOrThrow(Arr.findFirst(spans(), (span) => span.name === "LoadAlerts"))
		expect(loadAlerts.traceId).toBe(pageload.traceId)
	})

	it("reports a crash with the Message that caused it and the recent Messages", async () => {
		const { maple, spans } = setup()
		const app = maple.instrument({
			resources: Layer.empty,
			update: (model: TestModel, _message: { readonly _tag: string }) => ({ model }),
			crash: { report: (_context: unknown) => undefined },
		})
		app.update({ filter: "" }, { _tag: "ChangedFilter" })
		app.update({ filter: "api" }, { _tag: "ClickedSave" })
		app.crash.report({ error: new Error("view threw"), message: Option.some({ _tag: "ClickedSave" }) })
		await settle()
		const crash = Option.getOrThrow(
			Arr.findFirst(spans(), (span) =>
				Arr.some(
					span.attributes,
					(kv) =>
						kv.key === "maple.exception.source" &&
						Str.includes("foldkit.crash")(JSON.stringify(kv.value)),
				),
			),
		)
		const attribute = (key: string) =>
			Option.getOrUndefined(
				Option.map(
					Arr.findFirst(crash.attributes, (kv) => kv.key === key),
					(kv) => kv.value,
				),
			)
		expect(attribute("maple.foldkit.message")).toEqual({ stringValue: "ClickedSave" })
		expect(JSON.stringify(attribute("maple.foldkit.recent_messages"))).toContain("ChangedFilter")
		await maple.dispose()
	})

	it("reports slow phases from a visible tab and drops them from a hidden one", async () => {
		const { target, maple, spans } = setup()
		const visibility = { state: "visible" }
		vi.stubGlobal("document", {
			get visibilityState() {
				return visibility.state
			},
		})
		const app = maple.instrument({ resources: Layer.empty, slow: { onSlow: (_context: unknown) => {} } })
		// Phases wait for the runtime's first traced Command to learn the tracer.
		await Effect.runPromise(
			Effect.void.pipe(Effect.withSpan("FocusSearch"), Effect.provide(app.resources)),
		)
		const onSlow = app.slow.onSlow
		onSlow({ _tag: "Update", durationMs: 40, thresholdMs: 16, message: { _tag: "ClickedSave" } })
		visibility.state = "hidden"
		onSlow({ _tag: "Update", durationMs: 8000, thresholdMs: 16, message: { _tag: "ElapsedPoll" } })
		target.dispatchEvent(new Event("pagehide"))
		await settle()
		const messages = pipe(
			spans(),
			Arr.filter((span) => span.name === "foldkit.update"),
			Arr.flatMap((span) => Arr.filter(span.attributes, (a) => a.key === "maple.foldkit.message")),
			Arr.map((a) => a.value),
		)
		expect(messages).toEqual([{ stringValue: "ClickedSave" }])
		await maple.dispose()
	})
})
