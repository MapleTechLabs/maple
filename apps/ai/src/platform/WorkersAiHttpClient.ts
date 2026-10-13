/**
 * `HttpClient` shim that routes Cloudflare Workers AI traffic through the Worker's AI Gateway
 * binding (see {@link WorkersAiGateway}) instead of the public REST endpoint.
 *
 * `@effect/ai-openai-compat` posts an OpenAI-compatible chat body to
 * `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions` with an API token.
 * That is a *different billing and rate-limit path* from the binding's `run(...)`, which is keyless and
 * draws on the account's included neuron allocation — the path Maple's chat and triage run on.
 * The `Ai` binding exposes no `fetch`, so intercepting at the `HttpClient` seam
 * is the only way to keep the upstream provider *and* the binding.
 *
 * The translation is *almost* a pass-through. `run(model, inputs, { returnRawResponse: true })`
 * takes the same OpenAI-compatible payload the provider already builds — `messages`, `tools`,
 * `tool_choice`, `stream`, `stream_options`, `max_tokens`, `temperature` — and answers with an
 * OpenAI-format SSE `Response`. Only the `model` field moves, from the body to the first argument.
 *
 * The exception, and the reason `stripNativeTrailer` exists: after the OpenAI-shaped deltas Workers
 * AI appends one frame of its *own* native accounting —
 * `{"response":"","usage":{...,"neurons":260.1}}` — which is not an OpenAI chunk and which the
 * upstream provider rejects with "Invalid ... stream event". Because it arrives last, the whole
 * reply streams successfully and then the turn dies on the final frame. Filtering it here keeps the
 * fix at the Maple seam, which is where provider-specific behaviour belongs.
 *
 * Native `.../ai/run/{model}` calls (the Clef decision model) take the binding too, body unchanged.
 * Every other request falls through to the wrapped client untouched.
 */
import { Context, Effect, Layer, Option, Predicate, Schema } from "effect"
import { HttpClient, HttpClientError, HttpClientResponse, type HttpClientRequest } from "effect/http"

/** The subset of the Cloudflare `Ai` binding this shim uses. */
export interface WorkersAiBinding {
	readonly run: (
		model: string,
		inputs: Record<string, unknown>,
		options: {
			readonly returnRawResponse: true
			readonly signal?: AbortSignal
			readonly gateway?: { readonly id: string }
		},
	) => Promise<Response>
}

/**
 * The Worker's Workers AI binding, already routed through its AI Gateway, or none where the stage
 * has no gateway (dev), in which case model calls go out over REST. Built once in the init from
 * alchemy's `Cloudflare.AI.QueryGateway` client; see `apps/ai/src/worker/bindings.ts`.
 */
export class WorkersAiGateway extends Context.Service<WorkersAiGateway, Option.Option<WorkersAiBinding>>()(
	"@maple/ai/WorkersAiGateway",
) {}

/** A binding whose every call carries the gateway id, so it is logged and metered by the gateway. */
export const viaGateway = (binding: WorkersAiBinding, gatewayId: string): WorkersAiBinding => ({
	run: (model, inputs, options) => binding.run(model, inputs, { ...options, gateway: { id: gatewayId } }),
})

/**
 * Whether `value` is an `Ai` binding this shim can drive.
 *
 * Worth being loud about, because the failure is silent: when this returns false the upstream
 * provider falls through to the REST endpoint with `BINDING_PLACEHOLDER` credentials and 401s at
 * the *end* of a turn, which reads like a model outage rather than a misconfiguration. The init
 * checks the gateway's raw binding with this before wrapping it (`apps/ai/src/worker/bindings.ts`).
 */
export const isWorkersAiBinding = (value: unknown): value is WorkersAiBinding =>
	Predicate.hasProperty(value, "run") && Predicate.isFunction(value.run)

/** Why the shim could not hand a request to the binding: the body was not the JSON it expects. */
export class WorkersAiShimRequestError extends Schema.TaggedError<WorkersAiShimRequestError>()(
	"@maple/ai/WorkersAiShimRequestError",
	{ message: Schema.String, cause: Schema.optionalKey(Schema.Defect()) },
) {}

/** The request path, or none when the URL does not parse. */
const pathnameOf = (url: string): Option.Option<string> =>
	Option.map(Option.fromNullishOr(URL.parse(url)), (parsed) => parsed.pathname)

/**
 * Matches the chat-completions path of the Workers AI REST surface — both the direct
 * `.../accounts/{id}/ai/v1/chat/completions` form and an AI Gateway `.../compat/chat/completions`.
 */
const isWorkersAiChatUrl = (url: string): boolean =>
	Option.exists(
		pathnameOf(url),
		(pathname) =>
			pathname.endsWith("/chat/completions") &&
			(pathname.includes("/ai/v1/") || pathname.includes("/compat/")),
	)

const encodeError = (request: HttpClientRequest.HttpClientRequest, cause: WorkersAiShimRequestError) =>
	new HttpClientError.HttpClientError({
		reason: new HttpClientError.EncodeError({ request, cause, description: cause.message }),
	})

const JsonObjectFromString = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown))

/**
 * Read the already-serialized request body back out as a JSON object. The provider always sets a
 * JSON body, so anything else means the request did not come from where we think it did.
 */
const readJsonBody = (request: HttpClientRequest.HttpClientRequest) => {
	const body = request.body
	const text =
		body._tag === "Uint8Array"
			? new TextDecoder().decode(body.body)
			: body._tag === "Raw" && typeof body.body === "string"
				? body.body
				: undefined
	if (text === undefined) {
		return Effect.fail(
			encodeError(
				request,
				new WorkersAiShimRequestError({
					message: `Workers AI request carries a ${body._tag} body, expected serialized JSON`,
				}),
			),
		)
	}
	return Schema.decodeUnknownEffect(JsonObjectFromString)(text).pipe(
		Effect.map((parsed): Record<string, unknown> => ({ ...parsed })),
		Effect.mapError((cause) =>
			encodeError(
				request,
				new WorkersAiShimRequestError({
					message: "Workers AI request body is not a JSON object",
					cause,
				}),
			),
		),
	)
}

/**
 * Whether an SSE `data:` payload is Workers AI's native accounting trailer rather than an OpenAI
 * chunk.
 *
 * Deliberately narrow. It matches the trailer's exact signature — a `response` string plus a
 * `usage` object carrying `neurons`, and no `choices`/`object` — so a real OpenAI chunk can never
 * be mistaken for it, including the `stream_options: {include_usage: true}` chunk, which carries
 * `choices: []` and `object: "chat.completion.chunk"`.
 */
const isNativeWorkersAiTrailer = (payload: string): boolean =>
	payload !== "[DONE]" &&
	Option.exists(
		Schema.decodeUnknownOption(JsonObjectFromString)(payload),
		(frame) =>
			!("choices" in frame) &&
			!("object" in frame) &&
			typeof frame.response === "string" &&
			Predicate.hasProperty(frame.usage, "neurons"),
	)

/**
 * Drop the native trailer from an SSE body, passing every other byte through unchanged.
 *
 * Frame-aligned rather than line-based: SSE separates events with a blank line, and rewriting at
 * any finer granularity risks corrupting a multi-line `data:` payload.
 */
const stripNativeTrailer = (body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> => {
	const decoder = new TextDecoder()
	const encoder = new TextEncoder()
	let buffer = ""

	const emit = (frame: string, controller: TransformStreamDefaultController<Uint8Array>): void => {
		const payload = frame
			.split("\n")
			.filter((line) => line.startsWith("data:"))
			.map((line) => line.slice(5).trimStart())
			.join("\n")
		if (payload !== "" && isNativeWorkersAiTrailer(payload)) return
		controller.enqueue(encoder.encode(`${frame}\n\n`))
	}

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true })
				const frames = buffer.split("\n\n")
				buffer = frames.pop() ?? ""
				for (const frame of frames) emit(frame, controller)
			},
			flush(controller) {
				buffer += decoder.decode()
				if (buffer.trim() !== "") emit(buffer.replace(/\n+$/, ""), controller)
			},
		}),
	)
}

/**
 * The model a Workers AI REST `.../ai/run/{model}` URL names, for the native (non-OpenAI) models
 * such as the Clef decision model. Undefined for any other URL.
 */
const RUN_MARKER = "/ai/run/"

const workersAiRunModel = (url: string): Option.Option<string> =>
	pathnameOf(url).pipe(
		Option.filter((pathname) => pathname.includes("/accounts/") && pathname.includes(RUN_MARKER)),
		Option.map((pathname) => pathname.slice(pathname.indexOf(RUN_MARKER) + RUN_MARKER.length)),
		Option.flatMap((encoded) => Option.liftThrowable(decodeURIComponent)(encoded)),
		Option.filter((model) => model !== ""),
	)

/**
 * Wrap `fallback` so Workers AI chat completions and native `ai/run` calls go through `binding`.
 * Without a usable binding this returns `fallback` unchanged, so a stage with no binding still
 * works through the REST endpoint as long as a Cloudflare API token is configured.
 */
export const workersAiHttpClient = (
	fallback: HttpClient.HttpClient,
	binding: unknown,
): HttpClient.HttpClient => {
	if (!isWorkersAiBinding(binding)) return fallback
	const ai = binding

	const bindingError = (request: HttpClientRequest.HttpClientRequest, cause: unknown) =>
		new HttpClientError.HttpClientError({
			reason: new HttpClientError.TransportError({
				request,
				cause,
				description: "Cloudflare AI binding call failed",
			}),
		})

	return HttpClient.make((request, _url, signal) => {
		const runModel = request.method === "POST" ? workersAiRunModel(request.url) : Option.none()
		if (Option.isSome(runModel)) {
			// A native model's body is already its `inputs`, and its answer is plain JSON: no trailer.
			return readJsonBody(request).pipe(
				Effect.flatMap((inputs) =>
					Effect.tryPromise({
						try: () => ai.run(runModel.value, inputs, { returnRawResponse: true, signal }),
						catch: (cause) => bindingError(request, cause),
					}),
				),
				Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
			)
		}
		if (request.method !== "POST" || !isWorkersAiChatUrl(request.url)) {
			return fallback.execute(request)
		}
		return readJsonBody(request).pipe(
			Effect.flatMap((body) => {
				const { model, ...inputs } = body
				if (typeof model !== "string") {
					return Effect.fail(
						encodeError(
							request,
							new WorkersAiShimRequestError({
								message: "Workers AI request body has no string `model` field",
							}),
						),
					)
				}
				return Effect.tryPromise({
					try: () => ai.run(model, inputs, { returnRawResponse: true, signal }),
					catch: (cause) => bindingError(request, cause),
				}).pipe(
					Effect.map((response) =>
						response.body === null
							? response
							: new Response(stripNativeTrailer(response.body), {
									status: response.status,
									statusText: response.statusText,
									headers: response.headers,
								}),
					),
				)
			}),
			Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
		)
	})
}

/** Layer form: replaces the `HttpClient` already in context with one that shims Workers AI. */
export const layerWorkersAi = (
	binding: Option.Option<WorkersAiBinding>,
): Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> =>
	Layer.effect(
		HttpClient.HttpClient,
		Effect.map(HttpClient.HttpClient, (fallback) =>
			workersAiHttpClient(fallback, Option.getOrUndefined(binding)),
		),
	)
