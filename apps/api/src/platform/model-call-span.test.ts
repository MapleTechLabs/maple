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
