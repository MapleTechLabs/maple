// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
/**
 * Wire-level proof that OpenRouter calls are attributed and tagged.
 *
 * `LLMClient.prepare` is deliberately not used here: it returns the *protocol* body, which is built
 * before `http.body` is overlaid onto it, so it cannot see the tags at all. The only place the tags
 * and the attribution headers exist together is the outgoing HTTP request — so the test swaps
 * `FetchHttpClient.Fetch` for a capture and reads what would have gone over the wire.
 *
 * The fake responds 400, which the provider classifies as a non-retryable invalid request. That
 * keeps the run to a single request with no backoff; the resulting failure is expected and ignored.
 */
import { Effect, Layer, Schema, Stream } from "effect"
import { LanguageModel, Tool, Toolkit } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { describe, it } from "@effect/vitest"
import { expect } from "vitest"
import {
	layerLlm,
	resolveLensModel,
	resolveTriageModel,
	type LlmCallTags,
	type LlmEnv,
	type ResolvedModel,
} from "./Llm"

interface CapturedRequest {
	readonly url: string
	readonly headers: Record<string, string>
	readonly body: Record<string, unknown>
}

/**
 * Run one `LLM.generate` against a fetch that records the request instead of sending it.
 *
 * `resolve` picks which resolver builds the model, because the lens stage differs from triage in its
 * defaults and the only honest way to check a default is to watch what leaves.
 */
const captureRequest = (
	env: LlmEnv,
	tags?: LlmCallTags,
	resolve: (env: LlmEnv, tags?: LlmCallTags) => ResolvedModel = resolveTriageModel,
): Effect.Effect<CapturedRequest> =>
	Effect.gen(function* () {
		let captured: CapturedRequest | undefined

		const fakeFetch: typeof globalThis.fetch = async (input, init) => {
			const headers: Record<string, string> = {}
			new Headers(init?.headers).forEach((value, key) => {
				headers[key.toLowerCase()] = value
			})
			// The body arrives as bytes, not a string — `Response` is the cheapest correct decoder.
			const bodyText = await new Response(init?.body ?? "{}").text()
			captured = {
				url: String(input),
				headers,
				body: JSON.parse(bodyText) as Record<string, unknown>,
			}
			return new Response(JSON.stringify({ error: "captured" }), { status: 400 })
		}

		const model = resolve(env, tags)

		yield* LanguageModel.generateText({ prompt: "hi", system: "You are concise." }).pipe(
			Effect.provide(model.layer),
			Effect.ignore,
			Effect.provide(layerLlm(env)),
			// `Fetch` is a context Reference read per request rather than a Layer requirement, so it
			// has to reach the fiber running the call, not the layer that built the client.
			Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
		)

		if (captured === undefined) return yield* Effect.die("no request reached the transport")
		return captured
	})

const openRouterEnv: LlmEnv = { OPENROUTER_API_KEY: "test-key" }

/** `DEFAULT_MODEL_LIMITS.context` in Llm.ts — what a model absent from the table falls back to. */
const DEFAULT_MODEL_LIMITS_CONTEXT = 128_000

const tags: LlmCallTags = { surface: "chat", orgId: "org_123", sessionId: "chat_abc" }

describe("resolveTriageModel — OpenRouter attribution", () => {
	it.live("sends the app-attribution headers on every OpenRouter call", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv)

			expect(captured.url).toContain("openrouter.ai")
			// `HTTP-Referer` is what creates the app page — a title alone does nothing.
			expect(captured.headers["http-referer"]).toBe("https://maple.dev")
			expect(captured.headers["x-title"]).toBe("Maple")
		}),
	)

	it.live("tags the request body with surface, org and session", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, tags)

			expect(captured.body).toMatchObject({
				user: "org_123",
				session_id: "chat_abc",
				trace: { trace_name: "chat" },
			})
		}),
	)

	it.live("omits session_id when the caller has no session to group by", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, { surface: "ai-triage", orgId: "org_123" })

			expect(captured.body).toMatchObject({ user: "org_123", trace: { trace_name: "ai-triage" } })
			expect(captured.body).not.toHaveProperty("session_id")
		}),
	)

	it.live("truncates an over-long session id to OpenRouter's 256-character limit", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, { ...tags, sessionId: "s".repeat(400) })

			expect(captured.body.session_id).toHaveLength(256)
		}),
	)

	it.live("stamps the calling span's ids on the trace field so Broadcast nests under it", () =>
		Effect.gen(function* () {
			const span = yield* Effect.currentSpan
			const captured = yield* captureRequest(openRouterEnv, tags)

			// OpenRouter's exporter uses these verbatim as the W3C ids of the trace it emits.
			expect(captured.body.trace).toMatchObject({ trace_name: "chat", trace_id: span.traceId })
			// The parent is whichever span is innermost at the transport — the model's, not ours —
			// but it must be a real 16-hex span id that lives in our trace.
			expect((captured.body.trace as { parent_span_id: string }).parent_span_id).toMatch(
				/^[0-9a-f]{16}$/,
			)
			expect(captured.body.usage).toEqual({ include: true })
		}).pipe(Effect.withSpan("chat")),
	)

	it.live("keeps the headers and tags off the Workers AI path", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ MAPLE_LLM_PROVIDER: "workers-ai", CLOUDFLARE_API_KEY: "test-key" },
				tags,
			)

			expect(captured.url).not.toContain("openrouter.ai")
			expect(captured.headers).not.toHaveProperty("http-referer")
			expect(captured.headers).not.toHaveProperty("x-title")
			// These are OpenRouter's body fields; Cloudflare must never be sent them.
			expect(captured.body).not.toHaveProperty("user")
			expect(captured.body).not.toHaveProperty("session_id")
			expect(captured.body).not.toHaveProperty("trace")
		}),
	)
})

describe("reasoning effort", () => {
	it.live("sends no reasoning field for triage unless one is configured", () =>
		Effect.gen(function* () {
			// This resolver serves chat, AI triage and the validator at once. Adding the knob must not
			// retune three stages as a side effect.
			const captured = yield* captureRequest(openRouterEnv, tags)

			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)

	it.live("sends the configured triage effort", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_TRIAGE_REASONING_EFFORT: "high" },
				tags,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "high" } })
		}),
	)

	it.live("defaults a lens pass to low, because a fan-out of five multiplies whatever it spends", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(openRouterEnv, tags, resolveLensModel)

			expect(captured.body).toMatchObject({ reasoning: { effort: "low" } })
		}),
	)

	it.live("lets a lens be raised past the default", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "medium" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "medium" } })
		}),
	)

	it.live("omits the field entirely on `off`, rather than sending a zero budget", () =>
		Effect.gen(function* () {
			// The escape hatch: a model that does not support reasoning must see no `reasoning` key.
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "off" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)

	it.live("falls back to the default on an unrecognized value rather than failing the call", () =>
		Effect.gen(function* () {
			// Read on a request path in a Worker: a typo'd env var must not take the agent down.
			const captured = yield* captureRequest(
				{ ...openRouterEnv, MAPLE_LENS_REASONING_EFFORT: "maximum" },
				tags,
				resolveLensModel,
			)

			expect(captured.body).toMatchObject({ reasoning: { effort: "low" } })
		}),
	)

	it.live("keeps reasoning off the Workers AI path", () =>
		Effect.gen(function* () {
			const captured = yield* captureRequest(
				{ MAPLE_LLM_PROVIDER: "workers-ai", CLOUDFLARE_API_KEY: "test-key" },
				tags,
				resolveLensModel,
			)

			// `reasoning` is OpenRouter's field, namespaced under its own provider options.
			expect(captured.body).not.toHaveProperty("reasoning")
		}),
	)
})

describe("resolveTriageModel — context limits", () => {
	it("attaches the configured model's window, which upstream leaves unstated", () => {
		// Providers do not report their context window, so without this table nothing could tell
		// when a transcript was near the wall.
		//
		// The model is NAMED rather than left to the default: this asserts that a model in the table
		// gets that table's window, which is a fact about the mechanism. Reading it off whatever
		// `DEFAULT_OPENROUTER_MODEL` happens to be made a routine model swap fail here instead —
		// which is exactly what happened when the default moved to glm-5.3-flash.
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_OPENROUTER: "openai/gpt-5.6-luna",
		})

		expect(model.limits.context).toBe(1_050_000)
		expect(model.limits.output).toBe(128_000)
	})

	it("attaches the default model's window without it having to be named", () => {
		// The pair above and below pin a model on purpose; this one is the check that
		// DEFAULT_OPENROUTER_MODEL is itself in the table. A default that is missing from it silently
		// takes DEFAULT_MODEL_LIMITS and compacts earlier than it needs to.
		const model = resolveTriageModel(openRouterEnv)

		expect(model.limits.context).not.toBe(DEFAULT_MODEL_LIMITS_CONTEXT)
	})

	it("falls back to a conservative window for a model it does not know", () => {
		// Too low costs a summarization call; too high costs the whole turn. Unknown means low.
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_OPENROUTER: "some/model-shipped-after-this-table",
		})

		expect(model.limits.context).toBe(128_000)
	})

	it("lets the environment override the table", () => {
		const model = resolveTriageModel({
			...openRouterEnv,
			MAPLE_TRIAGE_MODEL_CONTEXT: "64000",
			MAPLE_TRIAGE_MODEL_OUTPUT: "4000",
		})

		expect(model.limits.context).toBe(64_000)
		expect(model.limits.output).toBe(4_000)
	})

	it("ignores an unparseable or nonsensical override rather than trusting it", () => {
		// A zero or negative window would make every turn look overflowed on its first step.
		// Model named for the same reason as above — the assertion is that the bad override is
		// discarded in favour of the TABLE, not that the default happens to be this model.
		for (const bad of ["", "not-a-number", "0", "-5", "1.5"]) {
			const model = resolveTriageModel({
				...openRouterEnv,
				MAPLE_TRIAGE_MODEL_OPENROUTER: "openai/gpt-5.6-luna",
				MAPLE_TRIAGE_MODEL_CONTEXT: bad,
			})
			expect(model.limits.context).toBe(1_050_000)
		}
	})
})

/**
 * The usage block of a streamed completion, as an upstream that keeps reasoning tokens *outside*
 * `completion_tokens` reports it. Numbers are from a real failing chat turn.
 */
const disjointReasoningUsage = {
	prompt_tokens: 21_435,
	completion_tokens: 293,
	total_tokens: 21_728,
	prompt_tokens_details: { cached_tokens: 16_128, cache_write_tokens: 0 },
	completion_tokens_details: { reasoning_tokens: 321 },
}

/**
 * A streamed completion, as chunks on the wire.
 *
 * `chunks` are the content chunks; `terminal` is the last one, which is where OpenRouter puts the
 * usage block. Both are overridable because the two things these tests pin — how a usage block is
 * folded, and whether the terminal chunk is recognised as terminal at all — are facts about
 * different chunks.
 */
const sseBody = (
	usage: Record<string, unknown>,
	options: {
		readonly chunks?: ReadonlyArray<Record<string, unknown>>
		readonly terminalChoices?: ReadonlyArray<Record<string, unknown>>
		/** Send the stream through to `[DONE]` with no usage block on any chunk. */
		readonly omitUsage?: boolean
	} = {},
): string => {
	const envelope = {
		id: "gen-1",
		object: "chat.completion.chunk",
		created: 1_789_056_870,
		model: "z-ai/glm-5.3-flash",
	}
	const chunks = options.chunks ?? [
		{ choices: [{ index: 0, delta: { role: "assistant", content: "hi" } }] },
	]
	return [
		...chunks.flatMap((chunk) => [`data: ${JSON.stringify({ ...envelope, ...chunk })}`, ""]),
		`data: ${JSON.stringify({
			...envelope,
			choices: options.terminalChoices ?? [{ index: 0, delta: {}, finish_reason: "stop" }],
			...(options.omitUsage === true ? undefined : { usage }),
		})}`,
		"",
		"data: [DONE]",
		"",
	].join("\n")
}

/**
 * The one tool the streaming fixtures declare. A `tool-call` part is decoded against the toolkit
 * the call declared, so a stream that returns one is only readable with the tool in hand.
 */
const listServices = Tool.make("list_services", { parameters: Schema.Struct({}) })

/** Stream one completion off a fake transport and return every part it emitted. */
const streamParts = (usage: Record<string, unknown>, options?: Parameters<typeof sseBody>[1]) =>
	Effect.gen(function* () {
		const fakeFetch: typeof globalThis.fetch = async () =>
			new Response(sseBody(usage, options), {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			})

		const model = resolveTriageModel(openRouterEnv)
		return yield* LanguageModel.streamText({
			prompt: "hi",
			toolkit: Toolkit.make(listServices),
			// What the agent engine sends: the run owns tool execution, the model call only reports
			// the calls it was asked for.
			disableToolCallResolution: true,
		}).pipe(
			Stream.runCollect,
			// One provide, not a chain: the model layer needs the clients the LLM stack builds, so
			// they go in as a single merged layer rather than two lifecycles stacked on each other.
			Effect.provide(Layer.provide(model.layer, layerLlm(openRouterEnv))),
			Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
		)
	})

/** Stream one completion off a fake transport and return the run's `finish` part. */
const streamFinishPart = (usage: Record<string, unknown>, options?: Parameters<typeof sseBody>[1]) =>
	Effect.gen(function* () {
		const parts = yield* streamParts(usage, options)
		const finish = parts.find((part) => part.type === "finish")
		if (finish === undefined) return yield* Effect.die("the stream carried no finish part")
		return finish
	})

/**
 * Guards the `@effect/ai-openrouter` patch in `patches/`.
 *
 * The package derives the output text component as `completion_tokens - reasoning_tokens`, which
 * assumes reasoning tokens are counted inside the completion total. Some OpenRouter upstreams
 * report them side by side, so the derived component goes negative and the agent engine — which
 * decodes every usage field as a natural number — throws away a response the model already
 * produced. The patch folds the two together when they are disjoint; this is what proves it is
 * still applied, since a `bun install` that dropped it would leave the numbers below negative.
 */
describe("streamed usage — reasoning tokens reported outside the completion total", () => {
	it.live("folds them back into the completion total", () =>
		Effect.gen(function* () {
			// Unpatched, this is what fails the turn: text would be 293 - 321.
			const finish = yield* streamFinishPart(disjointReasoningUsage)

			expect(finish.usage.outputTokens.text).toBe(293)
			expect(finish.usage.outputTokens.reasoning).toBe(321)
			expect(finish.usage.outputTokens.total).toBe(614)
			// The input side is already coherent and must come through unchanged.
			expect(finish.usage.inputTokens.total).toBe(21_435)
			expect(finish.usage.inputTokens.cacheRead).toBe(16_128)
		}),
	)

	it.live("does the same for cached tokens reported outside the prompt total", () =>
		Effect.gen(function* () {
			const finish = yield* streamFinishPart({
				...disjointReasoningUsage,
				prompt_tokens: 5_000,
				prompt_tokens_details: { cached_tokens: 16_128, cache_write_tokens: 0 },
			})

			expect(finish.usage.inputTokens.total).toBe(21_128)
			expect(finish.usage.inputTokens.uncached).toBe(5_000)
		}),
	)

	it.live("leaves a provider that already nests reasoning inside the completion untouched", () =>
		Effect.gen(function* () {
			const finish = yield* streamFinishPart({
				...disjointReasoningUsage,
				completion_tokens: 614,
				completion_tokens_details: { reasoning_tokens: 321 },
			})

			expect(finish.usage.outputTokens.total).toBe(614)
			expect(finish.usage.outputTokens.text).toBe(293)
		}),
	)
})

/**
 * Guards the second `@effect/ai-openrouter` patch in `patches/`.
 *
 * The stream decoder emits the turn's `finish` part — and with it the tool calls the model
 * declared, `reasoning-end` and `text-end` — only from a chunk carrying a `usage` block. OpenRouter
 * does not always send one, and a stream that ends without it produced no finish part at all: the
 * agent engine then rejects the turn with `ModelProtocolError: Model response ended without a
 * finish part` after the model has already answered, and the model-call span records no usage, no
 * cost and no assistant output — which is what an Agent Session shows as a call that cost nothing
 * and said nothing.
 *
 * Measured in production between 2026-09-10 and 2026-09-12: 518 of 539 failed investigation passes
 * died on exactly that error, and OpenRouter's own Broadcast trace for the same
 * `gen_ai.response.id` recorded the generation as complete, `finish_reason: tool_calls`, with a
 * full token count. The patch appends a synthetic terminal chunk when the stream ends without one,
 * so the flush runs exactly once either way.
 */
describe("streamed completion — a stream that ends without a usage block", () => {
	it.live("still emits the finish part, carrying the reason the stream declared", () =>
		Effect.gen(function* () {
			const finish = yield* streamFinishPart(disjointReasoningUsage, { omitUsage: true })

			expect(finish.reason).toBe("stop")
			// Nothing reported usage, and nothing may invent it: the reader takes every field as
			// optional, and a zero would be indistinguishable from a free call.
			expect(finish.usage.inputTokens.total).toBeUndefined()
			expect(finish.usage.outputTokens.total).toBeUndefined()
		}),
	)

	it.live("flushes the tool calls the turn declared", () =>
		Effect.gen(function* () {
			// The tool calls are only forwarded by the same flush, so losing it loses the turn's
			// answer as well as its accounting.
			const parts = yield* streamParts(disjointReasoningUsage, {
				omitUsage: true,
				chunks: [
					{
						choices: [
							{
								index: 0,
								delta: {
									role: "assistant",
									tool_calls: [
										{
											index: 0,
											id: "call-1",
											type: "function",
											function: { name: "list_services", arguments: "{}" },
										},
									],
								},
							},
						],
					},
				],
				terminalChoices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
			})

			expect(parts.find((part) => part.type === "tool-call")).toMatchObject({
				name: "list_services",
				params: {},
			})
			expect(parts.find((part) => part.type === "finish")?.reason).toBe("tool-calls")
		}),
	)

	it.live("emits exactly one finish part when the usage block does arrive", () =>
		Effect.gen(function* () {
			const parts = yield* streamParts(disjointReasoningUsage)

			expect(parts.filter((part) => part.type === "finish")).toHaveLength(1)
		}),
	)
})

