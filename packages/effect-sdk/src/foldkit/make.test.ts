// SAFETY-FILE: JSON in this test is the OTLP body the SDK under test posted, parsed before its fields are asserted.
import { describe, it } from "@effect/vitest"
import { Effect, Layer, Option } from "effect"
import { afterEach, expect, vi } from "vitest"
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
		if (url.endsWith("/v1/traces") && typeof init?.body === "string") bodies.push(JSON.parse(init.body))
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
		bodies.flatMap((body) =>
			(body.resourceSpans ?? []).flatMap((resource) =>
				resource.scopeSpans.flatMap((scope) => scope.spans),
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
			commands.map((command) =>
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
		const names = spans().map((span) => span.name)
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
			commands.map((command) =>
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
			Object.fromEntries(
				(spans().find((span) => span.name === name)?.attributes ?? []).map((a) => [a.key, a.value]),
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
			commands.map((command) =>
				Effect.runPromise(
					command.effect.pipe(
						Effect.withSpan(command.name, { attributes: command.args }),
						Effect.provide(app.resources),
					),
				),
			),
		)
		await maple.dispose()
		expect(spans().map((span) => span.name)).toContain("pageload /services")
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
		const [loaded] = await Promise.all(commands.map(run))
		const followUps = app.update({ filter: "" }, loaded).commands
		await Promise.all(followUps.map(run))
		await maple.dispose()
		const pageload = spans().find((span) => span.name === "pageload /services")
		const loadAlerts = spans().find((span) => span.name === "LoadAlerts")
		expect(loadAlerts?.traceId).toBe(pageload?.traceId)
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
		const crash = spans().find((span) =>
			span.attributes.some(
				(kv) =>
					kv.key === "maple.exception.source" && JSON.stringify(kv.value).includes("foldkit.crash"),
			),
		)
		const attribute = (key: string) => crash?.attributes.find((kv) => kv.key === key)?.value
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
		const messages = spans()
			.filter((span) => span.name === "foldkit.update")
			.flatMap((span) => span.attributes.filter((a) => a.key === "maple.foldkit.message"))
			.map((a) => a.value)
		expect(messages).toEqual([{ stringValue: "ClickedSave" }])
		await maple.dispose()
	})
})
