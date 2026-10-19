import { describe, expect, it } from "@effect/vitest"
import { Effect, Layer, Tracer } from "effect"
import { makeSpanBuffer, type OtlpSpan } from "../shared/flushable-tracer.js"
import { makeArgsScrubber, REDACTED } from "./args.js"
import { makeFoldkitTracing, NAVIGATION_ARG, nowNanos } from "./tracer.js"

const setup = (
	options: { readonly keepCommands?: ReadonlyArray<string>; readonly startGraceMs?: number } = {},
) => {
	const buffer = makeSpanBuffer()
	const tracing = makeFoldkitTracing({
		keepCommands: new Set(options.keepCommands ?? []),
		sampleRates: {},
		navigationSampleRate: 1,
		navigationQuietMs: 0,
		navigationStartGraceMs: options.startGraceMs ?? 1_000,
		navigationMaxMs: 30_000,
	})
	const layer = Layer.effect(Tracer.Tracer, Effect.map(Effect.tracer, tracing.wrap)).pipe(
		Layer.provideMerge(buffer.tracerLayer),
	)
	// What Foldkit's runtime does with every Command.
	const runCommand = <A, E>(name: string, args: Record<string, unknown>, effect: Effect.Effect<A, E>) => {
		tracing.registerCommand(name)
		return Effect.runPromiseExit(
			effect.pipe(Effect.withSpan(name, { attributes: args }), Effect.provide(layer)),
		)
	}
	return { buffer, tracing, runCommand }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5))
const byName = (spans: ReadonlyArray<OtlpSpan>, name: string) => spans.find((span) => span.name === name)
const attribute = (span: OtlpSpan | undefined, key: string) =>
	span?.attributes.find((kv) => kv.key === key)?.value

describe("Foldkit command tracing", () => {
	it("drops a Command that finished without a child span", async () => {
		const { buffer, runCommand } = setup()
		await runCommand("FocusMenuItem", {}, Effect.void)
		expect(buffer.drain()).toEqual([])
	})

	it("exports a Command with its child span nested under it", async () => {
		const { buffer, runCommand } = setup()
		await runCommand(
			"SendMessage",
			{ channelId: "ch_1" },
			Effect.void.pipe(Effect.withSpan("RpcClient.message.create")),
		)
		const spans = buffer.drain()
		const command = byName(spans, "SendMessage")
		expect(byName(spans, "RpcClient.message.create")?.parentSpanId).toBe(command?.spanId)
		expect(attribute(command, "channelId")).toEqual({ stringValue: "ch_1" })
	})

	it("exports a failed Command even without a child span", async () => {
		const { buffer, runCommand } = setup()
		await runCommand("SaveDraft", {}, Effect.fail("disk full"))
		expect(buffer.drain().map((span) => span.name)).toEqual(["SaveDraft"])
	})

	it("exports a kept Command without a child span", async () => {
		const { buffer, runCommand } = setup({ keepCommands: ["VerifyTotp"] })
		await runCommand("VerifyTotp", {}, Effect.void)
		expect(buffer.drain().map((span) => span.name)).toEqual(["VerifyTotp"])
	})

	it("parents navigation Commands under one navigation span that ends after the last", async () => {
		const { buffer, tracing, runCommand } = setup()
		const id = tracing.startNavigation({
			kind: "navigate",
			route: "/chat/:id",
			path: "/chat/1",
			startTime: nowNanos(),
		})
		const child = Effect.void.pipe(Effect.withSpan("RpcClient.load"))
		await Promise.all([
			runCommand("LoadMessages", { [NAVIGATION_ARG]: id }, child),
			runCommand("LoadMembers", { [NAVIGATION_ARG]: id }, child),
			runCommand("FocusComposer", { [NAVIGATION_ARG]: id }, Effect.void),
		])
		await settle()
		const spans = buffer.drain()
		const navigation = byName(spans, "navigate /chat/:id")
		expect(spans.map((span) => span.name).sort()).toEqual(
			["LoadMembers", "LoadMessages", "RpcClient.load", "RpcClient.load", "navigate /chat/:id"].sort(),
		)
		expect(navigation?.parentSpanId).toBeUndefined()
		expect(byName(spans, "LoadMessages")?.parentSpanId).toBe(navigation?.spanId)
		expect(byName(spans, "LoadMembers")?.traceId).toBe(navigation?.traceId)
		expect(attribute(navigation, "url.path")).toEqual({ stringValue: "/chat/1" })
		expect(spans.some((span) => attribute(span, NAVIGATION_ARG) !== undefined)).toBe(false)
	})

	it("exports nothing for a navigation whose Commands were all UI work", async () => {
		const { buffer, tracing, runCommand } = setup()
		const id = tracing.startNavigation({
			kind: "navigate",
			route: "/settings",
			path: "/settings",
			startTime: nowNanos(),
		})
		await runCommand("FocusTab", { [NAVIGATION_ARG]: id }, Effect.void)
		await settle()
		expect(buffer.drain()).toEqual([])
	})
})

describe("Foldkit phase spans", () => {
	it("records a phase reported before the tracer existed once it does", async () => {
		const { buffer, tracing, runCommand } = setup()
		const end = nowNanos()
		tracing.recordPhase("foldkit.view", end - 2_000_000n, end, { "maple.foldkit.phase": "View" })
		// The first Command builds the layer, which is when Foldkit hands over the tracer.
		await runCommand("FocusSearch", {}, Effect.void)
		const view = byName(buffer.drain(), "foldkit.view")
		expect(view?.endTimeUnixNano).toBe(end.toString())
	})

	it("ends a navigation that started no Command at its last phase span", async () => {
		const { buffer, tracing, runCommand } = setup({ startGraceMs: 5 })
		await runCommand("FocusSearch", {}, Effect.void)
		tracing.startNavigation({
			kind: "navigate",
			route: "/settings",
			path: "/settings",
			startTime: nowNanos(),
		})
		const end = nowNanos()
		tracing.recordPhase("foldkit.view", end - 1_000_000n, end, { "maple.foldkit.phase": "View" })
		await new Promise((resolve) => setTimeout(resolve, 20))
		const spans = buffer.drain()
		const navigation = byName(spans, "navigate /settings")
		expect(byName(spans, "foldkit.view")?.parentSpanId).toBe(navigation?.spanId)
		expect(navigation?.endTimeUnixNano).toBe(end.toString())
		expect(attribute(navigation, "app.navigation.interrupted")).toBeUndefined()
	})
})

describe("Command args", () => {
	it("keeps ids and flags and redacts every other value by default", () => {
		const scrub = makeArgsScrubber()
		expect(
			scrub({
				channelId: "ch_1",
				attachmentIds: ["a_1"],
				restoreContent: true,
				replyToMessageId: null,
				content: "hello there",
				token: "secret",
				draft: { text: "nested" },
			}),
		).toEqual({
			channelId: "ch_1",
			attachmentIds: ["a_1"],
			restoreContent: true,
			replyToMessageId: null,
			content: REDACTED,
			token: REDACTED,
		})
	})

	it("exports allowed keys as-is", () => {
		expect(makeArgsScrubber({ allow: ["provider"] })({ provider: "linear", token: "secret" })).toEqual({
			provider: "linear",
			token: REDACTED,
		})
	})
})
