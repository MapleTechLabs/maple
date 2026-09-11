// SAFETY-FILE: the SSE body here is a test fixture, parsed by the provider under test.
/**
 * What the model-call span carries, and who puts it there.
 *
 * Maple used to tee every streamed model response through its own `HttpClient` to recover
 * `gen_ai.response.id` and `gen_ai.response.model`, because the previous provider's protocol
 * dropped them. Both are the identity a broadcasting gateway's own trace of the call shares with
 * ours, and what Agent Sessions collapses the two observations on; without them a call through
 * such a gateway counts twice.
 *
 * The Effect AI providers emit a `response-metadata` part and annotate both onto the span they
 * already open, so the tee was doing the work twice. This is the test that says so — delete it and
 * the tee has to come back.
 */
import { assert, describe, it } from "@effect/vitest"
import { MAPLE_NATIVE_SESSION_ID_ATTR, MAPLE_NATIVE_TURN_ID_ATTR } from "@maple/domain/gen-ai"
import { Effect, Layer, Stream } from "effect"
import type { Exit, Tracer } from "effect"
import { LanguageModel } from "effect/unstable/ai"
import { FetchHttpClient } from "effect/unstable/http"
import { layerLlm, resolveTriageModel } from "./Llm"

/** Two frames, the first naming the response and the model that served it. */
const SSE = [
	": OPENROUTER PROCESSING",
	"",
	'data: {"id":"gen-1","object":"chat.completion.chunk","created":1730000000,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Hi"},"finish_reason":null}]}',
	"",
	'data: {"id":"gen-1","object":"chat.completion.chunk","created":1730000000,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
	"",
	"data: [DONE]",
	"",
].join("\n")

const ENV = { OPENROUTER_API_KEY: "test-key" }

const sseFetch: typeof globalThis.fetch = () =>
	Promise.resolve(new Response(SSE, { status: 200, headers: { "content-type": "text/event-stream" } }))

/** Every span the run opened, in creation order. */
const recordingTracer = () => {
	/** `endedWith` is the attributes as the span ended — what an exporter would actually ship. */
	const spans: Array<Tracer.Span & { readonly endedWith: ReadonlyMap<string, unknown> }> = []
	let next = 0
	const tracer: Tracer.Tracer = {
		span: (options) => {
			const attributes = new Map<string, unknown>()
			const endedWith = new Map<string, unknown>()
			next += 1
			const span: Tracer.Span = {
				_tag: "Span",
				name: options.name,
				spanId: `span-${next}`,
				traceId: "trace-1",
				parent: options.parent,
				annotations: options.annotations,
				status: { _tag: "Started", startTime: options.startTime },
				attributes,
				links: options.links,
				sampled: options.sampled,
				kind: options.kind,
				end: (_endTime: bigint, _exit: Exit.Exit<unknown, unknown>) => {
					for (const [key, value] of attributes) endedWith.set(key, value)
				},
				attribute: (key, value) => {
					attributes.set(key, value)
				},
				event: () => {},
				addLinks: () => {},
			}
			spans.push(Object.assign(span, { endedWith }))
			return span
		},
	}
	return { spans, tracer }
}

describe("the model-call span", () => {
	it.live("carries the served response id and model, from the provider itself", () =>
		Effect.gen(function* () {
			const recorder = recordingTracer()
			const model = resolveTriageModel(ENV)

			yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
				Stream.runDrain,
				Effect.ignore,
				// The model layer needs the client, so they are provided as one stack rather than
				// chained. `Fetch` is a context reference read per request, not a layer requirement, so
				// it has to reach the fiber making the call.
				Effect.provide(Layer.provideMerge(model.layer, layerLlm(ENV))),
				Effect.provideService(FetchHttpClient.Fetch, sseFetch),
				Effect.withTracer(recorder.tracer),
			)

			const modelCall = recorder.spans.find(
				(span) => span.attributes.get("gen_ai.operation.name") === "chat",
			)
			assert.isDefined(modelCall, "no model-call span was opened")
			assert.strictEqual(modelCall?.attributes.get("gen_ai.response.id"), "gen-1")
			assert.strictEqual(modelCall?.attributes.get("gen_ai.response.model"), "z-ai/glm-5.3-flash")
		}),
	)

	/**
	 * The regression that fragmented every chat into one agent session per turn: Effect AI's span
	 * carries no session key, and the gateway files a sessionless trace as a session of its own.
	 */
	it.live("carries the agent session, turn and workflow, before the span ends", () =>
		Effect.gen(function* () {
			const recorder = recordingTracer()
			const model = resolveTriageModel(ENV, {
				surface: "investigation-lens",
				orgId: "org_1",
				sessionId: "org_1:inv-1",
				turnId: "inv_1_h1",
				workflowName: "investigation",
			})

			yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
				Stream.runDrain,
				Effect.ignore,
				Effect.provide(Layer.provideMerge(model.layer, layerLlm(ENV))),
				Effect.provideService(FetchHttpClient.Fetch, sseFetch),
				Effect.withTracer(recorder.tracer),
			)

			const modelCall = recorder.spans.find(
				(span) => span.attributes.get("gen_ai.operation.name") === "chat",
			)
			assert.isDefined(modelCall, "no model-call span was opened")
			assert.strictEqual(modelCall?.endedWith.get(MAPLE_NATIVE_SESSION_ID_ATTR), "org_1:inv-1")
			assert.strictEqual(modelCall?.endedWith.get(MAPLE_NATIVE_TURN_ID_ATTR), "inv_1_h1")
			assert.strictEqual(modelCall?.endedWith.get("gen_ai.workflow.name"), "investigation")
			// Only the model call: the gateway reads the key alone as an agent span.
			const stamped = recorder.spans.filter((span) => span.attributes.has(MAPLE_NATIVE_SESSION_ID_ATTR))
			assert.deepStrictEqual(stamped, [modelCall])
		}),
	)

	/**
	 * The regression from the move onto Effect AI: its providers annotate the model and two token
	 * totals, and every investigation span lost its messages, cache and reasoning tokens and cost.
	 */
	it.live("carries the conversation, the usage buckets, the cost and the timings", () =>
		Effect.gen(function* () {
			const recorder = recordingTracer()
			const env = { ...ENV, MAPLE_TRIAGE_REASONING_EFFORT: "high" }
			const sse = [
				'data: {"id":"gen-2","object":"chat.completion.chunk","created":1730000000,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"Look"},"finish_reason":null}]}',
				"",
				'data: {"id":"gen-2","object":"chat.completion.chunk","created":1730000000,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{"content":"ing"},"finish_reason":null}]}',
				"",
				'data: {"id":"gen-2","object":"chat.completion.chunk","created":1730000000,"model":"z-ai/glm-5.3-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":40,"completion_tokens":12,"total_tokens":52,"cost":0.0042,"prompt_tokens_details":{"cached_tokens":30},"completion_tokens_details":{"reasoning_tokens":5}}}',
				"",
				"data: [DONE]",
				"",
			].join("\n")

			yield* LanguageModel.streamText({
				prompt: [
					{ role: "system", content: "Be brief." },
					{ role: "user", content: [{ type: "text", text: "hi" }] },
				],
			}).pipe(
				Stream.runDrain,
				Effect.ignore,
				Effect.provide(Layer.provideMerge(resolveTriageModel(env).layer, layerLlm(env))),
				Effect.provideService(FetchHttpClient.Fetch, () =>
					Promise.resolve(
						new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } }),
					),
				),
				Effect.withTracer(recorder.tracer),
			)

			const attributes = recorder.spans.find(
				(span) => span.attributes.get("gen_ai.operation.name") === "chat",
			)?.endedWith
			assert.isDefined(attributes, "no model-call span was opened")
			const json = (key: string) => JSON.parse(String(attributes?.get(key)))

			assert.strictEqual(attributes?.get("gen_ai.provider.name"), "openrouter")
			assert.strictEqual(attributes?.get("gen_ai.request.stream"), true)
			assert.strictEqual(attributes?.get("gen_ai.request.reasoning.level"), "high")
			assert.strictEqual(attributes?.get("gen_ai.output.type"), "text")
			assert.deepStrictEqual(json("gen_ai.system_instructions"), [
				{ type: "text", content: "Be brief." },
			])
			assert.deepStrictEqual(json("gen_ai.input.messages"), [
				{ role: "user", parts: [{ type: "text", content: "hi" }] },
			])
			assert.deepStrictEqual(json("gen_ai.output.messages"), [
				{ role: "assistant", parts: [{ type: "text", content: "Looking" }], finish_reason: "stop" },
			])
			assert.deepStrictEqual(attributes?.get("gen_ai.response.finish_reasons"), ["stop"])
			assert.strictEqual(attributes?.get("gen_ai.usage.input_tokens"), 40)
			assert.strictEqual(attributes?.get("gen_ai.usage.output_tokens"), 12)
			assert.strictEqual(attributes?.get("gen_ai.usage.cache_read.input_tokens"), 30)
			assert.strictEqual(attributes?.get("gen_ai.usage.reasoning.output_tokens"), 5)
			assert.strictEqual(attributes?.get("gen_ai.usage.cost"), 0.0042)
			assert.isAtLeast(Number(attributes?.get("gen_ai.response.time_to_first_chunk")), 0)
			assert.isAtLeast(Number(attributes?.get("maple_ai.model_duration_ms")), 0)
		}),
	)

	it.live("carries no session when the caller has none", () =>
		Effect.gen(function* () {
			const recorder = recordingTracer()

			yield* LanguageModel.streamText({ prompt: "hi" }).pipe(
				Stream.runDrain,
				Effect.ignore,
				Effect.provide(Layer.provideMerge(resolveTriageModel(ENV).layer, layerLlm(ENV))),
				Effect.provideService(FetchHttpClient.Fetch, sseFetch),
				Effect.withTracer(recorder.tracer),
			)

			assert.isFalse(recorder.spans.some((span) => span.attributes.has(MAPLE_NATIVE_SESSION_ID_ATTR)))
		}),
	)
})
