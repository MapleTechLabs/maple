/**
 * Maple's seam onto Effect AI's providers.
 *
 * Everything Maple-specific about talking to a model lives here, never in a wrapper around the
 * provider packages: client wiring, the Workers AI binding shim, provider/model selection from env,
 * context-window limits, and the mapping from Effect AI's `AiError` onto a Maple domain error.
 *
 * Two provider paths stay live at once and `MAPLE_LLM_PROVIDER` picks between them per deploy:
 * OpenRouter through `@effect/ai-openrouter`, and Cloudflare Workers AI through
 * `@effect/ai-openai-compat` pointed at the account's OpenAI-compatible base URL. Both post to
 * `/chat/completions`, which is what lets one shim serve the binding path.
 */
import { OpenAiClient, OpenAiEmbeddingModel, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { OpenRouterClient, OpenRouterDecisionModel, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { MAPLE_NATIVE_SESSION_ID_ATTR, MAPLE_NATIVE_TURN_ID_ATTR } from "@maple/domain/gen-ai"
import { FindingEmbedder, PrReviewEmbeddingError } from "@maple/backend/services/pr-review/FindingEmbedder"
import { Effect, Layer, Option, Redacted, Schema } from "effect"
import type * as DecisionModel from "effect/unstable/ai/DecisionModel"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"
import * as AiModel from "effect/unstable/ai/Model"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { type ModelCallTelemetry, instrumentLanguageModel } from "./genai-spans"
import { layerWorkersAi } from "./WorkersAiHttpClient"

/** Default triage/chat model on OpenRouter — the provider agents run on by default. */
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash:nitro"

/**
 * Default model for pull request reviews and replies, which run on their own model rather than the
 * triage default: glm-5.3-flash leaked 1.2% of its tool calls as text, which ended 8 of 14 early
 * reviews by 2026-09-24. Changing chat's model would have retuned investigations with it.
 *
 * `:nitro` routes to the fastest provider. Default routing picks the cheapest, which served a
 * 12-call review at ~50 tok/s and took 13 minutes; `:nitro` measured ~190 tok/s at twice the price.
 */
export const DEFAULT_REVIEW_MODEL = "deepseek/deepseek-v4.1-flash:nitro"

/**
 * Default decision model: TypeSafe's Jev, reached through OpenRouter.
 *
 * A decision model answers a bounded question — pick one of these labels, rate this, how likely is
 * that — and returns the whole distribution. It is not a language model and does not replace one:
 * it is what a gate should ask when the answer is a choice rather than prose.
 *
 * The `~` alias tracks the latest Jev; `typesafe/jev-1.13` pins one, through
 * `MAPLE_DECISION_MODEL`, if a gate ever needs a fixed judge.
 */
export const DEFAULT_DECISION_MODEL = "~typesafe/jev-latest"

/**
 * OpenRouter app attribution. `HTTP-Referer` is the header that actually creates the app page — a
 * title on its own does nothing — so both are sent together or not at all. One URL for every
 * surface on purpose: a second referer would mint a second app entry and split the rankings.
 */
const OPENROUTER_APP_URL = "https://maple.dev"
const OPENROUTER_APP_TITLE = "Maple"

/**
 * OpenRouter's API, which serves chat, `/embeddings` and the decisions endpoint. The EU instance
 * goes through OpenRouter's in-region endpoint instead: requests are decrypted and served only by
 * providers inside the EU, and a model with no EU provider is a 404 rather than a silent hop to the
 * US. It needs a Business or Enterprise account; the key, body and model ids are unchanged.
 */
const OPENROUTER_API_URLS = {
	us: "https://openrouter.ai/api/v1",
	eu: "https://eu.openrouter.ai/api/v1",
} as const satisfies Record<OpenRouterRegion, string>

/** `us` is OpenRouter's global catalogue, not its US in-region endpoint, which serves fewer models. */
type OpenRouterRegion = "us" | "eu"

const openRouterRegion = (env: LlmEnv): OpenRouterRegion =>
	readString(env, "MAPLE_REGION")?.toLowerCase() === "eu" ? "eu" : "us"

export const openRouterApiUrl = (env: LlmEnv): string => OPENROUTER_API_URLS[openRouterRegion(env)]

/**
 * The EU catalogue is a subset (66 models on 2026-09-25) and serves none of the US defaults, so
 * the EU instance runs chat, triage and reviews on one model that has an EU provider.
 */
const EU_DEFAULT_OPENROUTER_MODEL = "openai/gpt-6-luna"
const EU_DEFAULT_REVIEW_MODEL = "openai/gpt-6-luna"

/**
 * Default embedding model for the review's feedback filter. Changing it starts the filter from an
 * empty history: stored vectors are only compared with vectors from the same model.
 */
export const DEFAULT_EMBEDDING_MODEL = "openai/text-embedding-3-small"

/**
 * Where a model call came from and what it is running for.
 *
 * OpenRouter surfaces three of these in different places: `user` shows up on the activity page and
 * in usage exports, `session_id` groups a conversation (and makes OpenRouter route the whole session
 * to one provider, so prompt caches actually hit), and `trace` is forwarded to any configured
 * Broadcast destination.
 *
 * The session, turn and workflow also go on Maple's own model-call span, on either provider — see
 * {@link instrumentedModel}. One set of tags feeds both, so a call and its Broadcast twin cannot
 * be filed under different sessions.
 */
export interface LlmCallTags {
	/** `bot` is the chat-platform bot, which shares the engine and the Durable Object with `chat`. */
	readonly surface: "chat" | "bot"
	readonly orgId: string
	/** Groups one conversation or investigation. OpenRouter caps this at 256 characters. */
	readonly sessionId?: string
	/** One turn (a chat message, an investigation pass) inside the session. */
	readonly turnId?: string
	/** The workflow the call runs inside (`gen_ai.workflow.name`); attended chat has none. */
	readonly workflowName?: string
}

/**
 * Default triage/chat model on Workers AI. Carried over unchanged from the chat backend that
 * preceded this one, so a backend swap never silently changes the model at the same time.
 */
export const DEFAULT_WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6"

/**
 * The two provider paths agents can run on. Both stay wired at all times — flipping between them is
 * one env var and no code change, because `layerLlm` builds the same stack either way.
 */
export type LlmProvider = "openrouter" | "workers-ai"

export const DEFAULT_LLM_PROVIDER: LlmProvider = "openrouter"

/**
 * `gen_ai.provider.name` for a provider path. Cloudflare has no well-known value in the convention,
 * so it takes the convention's `vendor.product` shape (`aws.bedrock`, `gcp.vertex_ai`).
 */
export const genAiProviderName = (provider: LlmProvider): string => GEN_AI_PROVIDER_NAMES[provider]

const GEN_AI_PROVIDER_NAMES = {
	openrouter: "openrouter",
	"workers-ai": "cloudflare.workers_ai",
} as const satisfies Record<LlmProvider, string>

/**
 * Workers AI has no per-request API key when reached through the `AI` binding, but the client still
 * wants an account id for its base URL and a token for the `Authorization` header. Both are inert
 * once `layerWorkersAi` intercepts the request — the binding authenticates itself.
 */
const BINDING_PLACEHOLDER = "workers-ai-binding"

export interface LlmEnv extends Record<string, unknown> {
	readonly AI?: unknown
	readonly CLOUDFLARE_ACCOUNT_ID?: string
	readonly CLOUDFLARE_API_KEY?: string
	readonly MAPLE_LLM_PROVIDER?: string
	/** The instance this Worker runs in. `eu` sends every OpenRouter call to its EU endpoint. */
	readonly MAPLE_REGION?: string
	readonly MAPLE_TRIAGE_MODEL_OPENROUTER?: string
	readonly MAPLE_TRIAGE_MODEL_WORKERS_AI?: string
	/** OpenRouter model id for pull request reviews and replies, overriding {@link DEFAULT_REVIEW_MODEL}. */
	readonly MAPLE_REVIEW_MODEL_OPENROUTER?: string
	/** Context window in tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_CONTEXT?: string
	/** Max completion tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_OUTPUT?: string
	/** `low` | `medium` | `high` | `off`. See {@link ReasoningEffort}. */
	readonly MAPLE_TRIAGE_REASONING_EFFORT?: string
	readonly OPENROUTER_API_KEY?: string
	/** Decision model id, overriding {@link DEFAULT_DECISION_MODEL}. */
	readonly MAPLE_DECISION_MODEL?: string
	/** Embedding model id, overriding {@link DEFAULT_EMBEDDING_MODEL}. */
	readonly MAPLE_EMBEDDING_MODEL?: string
}

/**
 * How hard the model should think before answering.
 *
 * The other dial. Maple tiers spend by swapping model *ids*, but on a frontier model the reasoning
 * budget moves cost and latency at least as much, without changing whose judgement you get.
 *
 * `off` omits the field entirely rather than sending a zero budget: a model that does not support
 * reasoning must see no `reasoning` key at all.
 */
export type ReasoningEffort = "low" | "medium" | "high" | "off"

const REASONING_EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "off"])

const readReasoningEffort = (env: LlmEnv, key: keyof LlmEnv): ReasoningEffort | undefined => {
	const raw = readString(env, key)?.toLowerCase()
	// An unrecognized value falls through to the caller's default rather than throwing. This is read
	// on a request path in a Worker; a typo'd env var must not take the agent down.
	return raw !== undefined && REASONING_EFFORTS.has(raw) ? (raw as ReasoningEffort) : undefined
}

/**
 * Context windows for the models Maple configures.
 *
 * Providers do not report their context window, and Maple needs it to know when a transcript is
 * approaching the wall, so it is kept here in a side table keyed by model name.
 *
 * Conservative on purpose. A limit set too low compacts early, which costs a summarization call; a
 * limit set too high overflows, which costs the whole turn. When in doubt, go low.
 */
const MODEL_LIMITS: Record<string, { readonly context: number; readonly output: number }> = {
	"openai/gpt-5.6-luna": { context: 1_050_000, output: 128_000 },
	// Verified against OpenRouter's catalogue: context_length 1_310_720, max_completion_tokens
	// 131_072. Held a notch under, same conservative margin as the other rows.
	"z-ai/glm-5.3-flash:nitro": { context: 1_000_000, output: 128_000 },
	// OpenRouter's catalogue: context_length 1_048_576, max_completion_tokens 131_072.
	"deepseek/deepseek-v4.1-flash": { context: 1_000_000, output: 128_000 },
	"deepseek/deepseek-v4.1-flash:nitro": { context: 1_000_000, output: 128_000 },
	// OpenRouter's catalogue: context_length 1_048_576, max_completion_tokens 131_072.
	"xiaomi/mimo-v2.6-pro": { context: 1_000_000, output: 128_000 },
	// The EU default. OpenRouter's EU catalogue: context_length 1_050_000, max_completion_tokens 128_000.
	"openai/gpt-6-luna": { context: 1_000_000, output: 128_000 },
	// Moonshot's own kimi-k2.6 is 262_144, but Cloudflare does not publish the window its Workers AI
	// deployment actually serves. Held at the conservative default until someone measures it.
	"@cf/moonshotai/kimi-k2.6": { context: 128_000, output: 8_000 },
} satisfies Record<string, { readonly context: number; readonly output: number }>

/** For a model not in the table at all. Low enough that an unknown model compacts rather than fails. */
const DEFAULT_MODEL_LIMITS = { context: 128_000, output: 8_000 } as const

const readPositiveInt = (env: LlmEnv, key: keyof LlmEnv): number | undefined => {
	const raw = readString(env, key)
	if (raw === undefined) return undefined
	const value = Number(raw)
	return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

const readString = (env: LlmEnv, key: keyof LlmEnv): string | undefined => {
	const value = env[key]
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined
}

/** The client services a resolved model needs. `layerLlm` provides both, so either branch runs. */
export type LlmClients = OpenRouterClient.OpenRouterClient | OpenAiClient.OpenAiClient

/** The services a resolved model provides to a run. */
type ModelServices = LanguageModel.LanguageModel | AiModel.ProviderName | AiModel.ModelName

/**
 * A model Maple resolved, with the facts callers need alongside it.
 *
 * `layer` is the native model Layer, and it is meant to be bound to an agent definition with
 * `Agent.withModel` rather than provided around a run: the engine then builds it fresh per model
 * call and leaves its client in the run's requirements, where `layerLlm` answers it.
 *
 * Typed as a `Layer` rather than as an `AiModel.Model` on purpose. `Model` is invariant in its
 * requirements, so a model needing one client is not assignable to a model needing either; `Layer`
 * is covariant there, which is what lets both provider branches share one field.
 */
export interface ResolvedModel {
	readonly provider: LlmProvider
	/** The provider's own model id, as sent on the wire. */
	readonly name: string
	readonly layer: Layer.Layer<ModelServices, never, LlmClients>
	readonly limits: { readonly context: number; readonly output: number }
	/** The tags the model was resolved with, so a caller can stamp its own span to match. */
	readonly tags?: LlmCallTags
}

/** The triage overrides describe the triage model, so a review model reads only the table. */
const limitsFor = (
	env: LlmEnv,
	name: string,
	overridable = true,
): { readonly context: number; readonly output: number } => {
	const known = MODEL_LIMITS[name] ?? DEFAULT_MODEL_LIMITS
	if (!overridable) return known
	return {
		context: readPositiveInt(env, "MAPLE_TRIAGE_MODEL_CONTEXT") ?? known.context,
		output: readPositiveInt(env, "MAPLE_TRIAGE_MODEL_OUTPUT") ?? known.output,
	}
}

/**
 * Which provider agents run on. Model overrides are deliberately provider-scoped: a model id is
 * only meaningful to one provider, so a single shared `MAPLE_TRIAGE_MODEL` would send `@cf/…` to
 * OpenRouter the moment someone flipped the switch.
 */
export const resolveLlmProvider = (env: LlmEnv): LlmProvider =>
	readString(env, "MAPLE_LLM_PROVIDER")?.toLowerCase() === "workers-ai"
		? "workers-ai"
		: DEFAULT_LLM_PROVIDER

/**
 * Per-request body fields for the OpenRouter branch.
 *
 * `reasoning`, `user`, `session_id` and `trace` are all first-class fields on OpenRouter's chat
 * request, so they ride as model config rather than as a hand-built body. `usage` is the one
 * exception, spliced per call by {@link withPerCallFields} together with the span ids.
 */
const openRouterConfig = (effort: ReasoningEffort | undefined, tags: LlmCallTags | undefined) => ({
	...(effort === undefined || effort === "off" ? undefined : { reasoning: { effort } }),
	...(tags === undefined
		? undefined
		: {
				user: tags.orgId,
				...(tags.sessionId === undefined ? undefined : { session_id: sessionIdFor(tags) }),
				trace: { trace_name: tags.surface },
			}),
})

/** The session as OpenRouter accepts it. The span carries the same value, so the two never diverge. */
const sessionIdFor = (tags: LlmCallTags): string | undefined => tags.sessionId?.slice(0, 256)

/**
 * The agent-session identity as span attributes: the session, the turn and the workflow.
 *
 * The ingest gateway files a GenAI span under a session only when the span carries
 * `maple_ai.session.id` (its `maple` vendor), and takes the key alone as proof of an agent span.
 * So it goes on exactly two spans: every model-call span the model opens (see
 * {@link instrumentedModel}) and the span that roots the turn — a pass, in a workflow — which the
 * session view partitions turns by, walking each span up to its nearest tagged ancestor. Nothing
 * wider: an `Effect.annotateSpans` over the run would file every HTTP and database span as one.
 * Empty without a session.
 */
export const agentSessionSpanAttributes = (
	tags: LlmCallTags | undefined,
): Readonly<Record<string, string>> => {
	const sessionId = tags === undefined ? undefined : sessionIdFor(tags)
	if (tags === undefined || sessionId === undefined) return {}
	return {
		[MAPLE_NATIVE_SESSION_ID_ATTR]: sessionId,
		...(tags.turnId === undefined ? undefined : { [MAPLE_NATIVE_TURN_ID_ATTR]: tags.turnId }),
		...(tags.workflowName === undefined ? undefined : { "gen_ai.workflow.name": tags.workflowName }),
	}
}

/**
 * A provider's language model, with every model-call span carrying the full Gen-AI content.
 *
 * Effect AI's own span carries the model, the response id and two token totals. The rest — messages,
 * system instructions, cache and reasoning tokens, cost, time to first chunk — and the agent-session
 * identity are written by `./genai-spans.ts`. The session key matters most: without it every trace
 * became a session of its own (`trace:<TraceId>`), one per chat turn and one per investigation pass.
 * The session list reads a trace's session off any one of its spans, so the model-call span is enough
 * to file the tool and engine spans around it too.
 *
 * Built with `AiModel.make` exactly as the providers' own `model()` constructors are, so the only
 * difference is the wrapped service.
 *
 * The provider string passed to `AiModel.make` does not matter, on either path. It only fills
 * `AiModel.ProviderName`, which nothing in Maple reads; effect-agent only copies it into usage
 * summaries Maple never looks at. Span `gen_ai.provider.name` comes from `telemetry.providerName`.
 */
const instrumentedModel = <R>(
	name: string,
	make: Effect.Effect<LanguageModel.LanguageModel, never, R>,
	telemetry: ModelCallTelemetry,
	options: { readonly coalesceDeltas?: boolean } = {},
): Layer.Layer<ModelServices, never, R> =>
	AiModel.make(
		"openrouter",
		name,
		Layer.effect(LanguageModel.LanguageModel, instrumentLanguageModel(make, telemetry, options)),
	)

const openRouterModel = (
	env: LlmEnv,
	name: string,
	effortKey: keyof LlmEnv,
	fallbackEffort: ReasoningEffort | undefined,
	tags: LlmCallTags | undefined,
	overridableLimits = true,
	/** Nobody watches the run stream, so its deltas are joined; see `coalesceDeltas`. */
	unattended = false,
): ResolvedModel => {
	const effort = readReasoningEffort(env, effortKey) ?? fallbackEffort
	return {
		provider: "openrouter",
		name,
		layer: instrumentedModel(
			name,
			OpenRouterLanguageModel.make({ model: name, config: openRouterConfig(effort, tags) }),
			{
				providerName: genAiProviderName("openrouter"),
				...(effort === undefined || effort === "off" ? undefined : { reasoningLevel: effort }),
				sessionAttributes: agentSessionSpanAttributes(tags),
			},
			{ coalesceDeltas: unattended },
		),
		limits: limitsFor(env, name, overridableLimits),
		tags,
	}
}

const workersAiModel = (env: LlmEnv, name: string, tags: LlmCallTags | undefined): ResolvedModel => ({
	provider: "workers-ai",
	name,
	layer: instrumentedModel(name, OpenAiLanguageModel.make({ model: name }), {
		providerName: genAiProviderName("workers-ai"),
		sessionAttributes: agentSessionSpanAttributes(tags),
	}),
	limits: limitsFor(env, name),
	tags,
})

/**
 * The model the triage/chat agents run on.
 *
 * Attribution headers ride on every OpenRouter call regardless; the per-call tags become
 * request-body defaults, so every call made with the returned model carries them. The Workers AI
 * branch sends none of them — they are OpenRouter's fields and mean nothing to Cloudflare — but both
 * branches stamp the session onto their model-call spans.
 */
export const resolveTriageModel = (env: LlmEnv, tags?: LlmCallTags): ResolvedModel =>
	resolveLlmProvider(env) === "workers-ai"
		? workersAiModel(
				env,
				readString(env, "MAPLE_TRIAGE_MODEL_WORKERS_AI") ?? DEFAULT_WORKERS_AI_MODEL,
				tags,
			)
		: openRouterModel(
				env,
				readString(env, "MAPLE_TRIAGE_MODEL_OPENROUTER") ??
					(openRouterRegion(env) === "eu" ? EU_DEFAULT_OPENROUTER_MODEL : DEFAULT_OPENROUTER_MODEL),
				"MAPLE_TRIAGE_REASONING_EFFORT",
				// No default. This resolver serves chat, AI triage *and* the validator, so a number
				// picked here would retune three stages with different shapes at once.
				undefined,
				tags,
			)

/**
 * The model pull request reviews and replies run on. OpenRouter only: the id is an OpenRouter id,
 * so a Workers AI deployment reviews on its triage model rather than sending it one.
 */
export const resolveReviewModel = (env: LlmEnv, tags?: LlmCallTags): ResolvedModel =>
	resolveLlmProvider(env) === "workers-ai"
		? resolveTriageModel(env, tags)
		: openRouterModel(
				env,
				readString(env, "MAPLE_REVIEW_MODEL_OPENROUTER") ??
					(openRouterRegion(env) === "eu" ? EU_DEFAULT_REVIEW_MODEL : DEFAULT_REVIEW_MODEL),
				"MAPLE_TRIAGE_REASONING_EFFORT",
				undefined,
				tags,
				false,
				true,
			)

/**
 * Splice the per-call fields into every outgoing OpenRouter chat request.
 *
 * `usage: { include: true }` is the one field Maple needs that OpenRouter's generated request
 * schema does not declare, and a closed `Schema.Struct` drops what it does not know. Without it the
 * response carries no `cost`, and `gen_ai.usage.cost` is the only way Maple ever reports spend: the
 * provider's own bill, never a price table.
 *
 * `trace.trace_id` / `trace.parent_span_id` are the current span's W3C ids. OpenRouter's Broadcast
 * exporter uses them verbatim, so the `LLM Generation` trace it emits (provider attempts, fallbacks,
 * router latency) nests under the span that made the call instead of arriving as a twin trace that
 * only shares a session id. The model config cannot carry them — it is built once per layer, and the
 * ids are per call — which is why they ride here with `usage`.
 */
const withPerCallFields = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.mapRequestEffect(client, (request) =>
		splicePerCallFields(request).pipe(Effect.orElseSucceed(() => request)),
	)

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const splicePerCallFields = (
	request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest, Schema.SchemaError | HttpBody.HttpBodyError> =>
	Effect.gen(function* () {
		const body = request.body
		if (body._tag !== "Uint8Array") return request
		const decoded = yield* decodeJsonBody(new TextDecoder().decode(body.body))
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return request
		const span = yield* Effect.option(Effect.currentParentSpan)
		const trace = {
			...("trace" in decoded && typeof decoded.trace === "object" ? decoded.trace : undefined),
			...(Option.isSome(span)
				? { trace_id: span.value.traceId, parent_span_id: span.value.spanId }
				: undefined),
		}
		return yield* HttpClientRequest.bodyJson(request, {
			...decoded,
			usage: { include: true },
			...(Object.keys(trace).length === 0 ? undefined : { trace }),
		})
	})

/** The HTTP client every OpenRouter call goes out on, with the app-attribution headers. */
const openRouterHttp = Layer.effect(HttpClient.HttpClient)(
	Effect.map(HttpClient.HttpClient, (client) =>
		HttpClient.mapRequest(
			client,
			HttpClientRequest.setHeaders({
				"HTTP-Referer": OPENROUTER_APP_URL,
				"X-Title": OPENROUTER_APP_TITLE,
			}),
		),
	),
)

/**
 * The runnable LLM stack — both provider clients, so the switch stays a pure env flip.
 *
 * The Workers AI shim sits in the stack unconditionally: it only intercepts POSTs to the Workers AI
 * chat URL, so it is inert for OpenRouter traffic. `env` supplies the `AI` binding; when it is
 * absent the shim is a no-op and Workers AI requests go out over `fetch` to the REST endpoint.
 */
export const layerLlm = (env: LlmEnv): Layer.Layer<LlmClients> => {
	const accountId = readString(env, "CLOUDFLARE_ACCOUNT_ID") ?? BINDING_PLACEHOLDER
	// The binding shim wraps `fetch`: a Workers AI call the shim answers from the `AI` binding never
	// reaches it, and everything else goes out over the network as usual.
	const http = layerWorkersAi(env).pipe(Layer.provide(FetchHttpClient.layer))
	return Layer.mergeAll(
		OpenRouterClient.layer({
			apiKey: Redacted.make(readString(env, "OPENROUTER_API_KEY") ?? ""),
			apiUrl: openRouterApiUrl(env),
			transformClient: withPerCallFields,
		}).pipe(Layer.provide(openRouterHttp.pipe(Layer.provide(http)))),
		// The URL the shim already matches: `.../ai/v1/chat/completions`.
		OpenAiClient.layer({
			apiKey: Redacted.make(readString(env, "CLOUDFLARE_API_KEY") ?? BINDING_PLACEHOLDER),
			apiUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
		}).pipe(Layer.provide(http)),
	)
}

/**
 * The decision model, over the same OpenRouter client as everything else.
 *
 * OpenRouter serves Jev from a separate endpoint (`/alpha/decisions`, not chat completions), which
 * is why this is its own layer rather than another entry in {@link resolveTriageModel}. It is not
 * its own provider though: one key, one set of app-attribution headers, and decision spend lands in
 * the same account as model spend. `layerLlm` answers the client it requires.
 */
export const layerDecisionModel = (
	env: LlmEnv,
): Layer.Layer<DecisionModel.DecisionModel, never, OpenRouterClient.OpenRouterClient> =>
	// The fallback only fills the layer: with no EU decision model the triage route never calls it.
	OpenRouterDecisionModel.layer({ model: resolveDecisionModel(env) ?? DEFAULT_DECISION_MODEL })

/**
 * The decision model this deploy asks, so a verdict can record what answered it. Undefined in the
 * EU unless configured: Jev has no EU provider, and the gate reads no verdict as "investigate".
 */
export const resolveDecisionModel = (env: LlmEnv): string | undefined =>
	readString(env, "MAPLE_DECISION_MODEL") ??
	(openRouterRegion(env) === "eu" ? undefined : DEFAULT_DECISION_MODEL)

/**
 * The embedder the PR review's feedback filter compares findings with, on OpenRouter whichever
 * provider the agents run on: Workers AI's binding shim only answers chat. Its `OpenAiClient` is
 * private to this layer, so it never replaces the Workers AI one `layerLlm` provides. Without an
 * OpenRouter key there is no embedder, and the filter is off.
 */
export const layerFindingEmbedder = (env: LlmEnv): Layer.Layer<FindingEmbedder> | Layer.Layer<never> => {
	const apiKey = readString(env, "OPENROUTER_API_KEY")
	if (apiKey === undefined) return Layer.empty
	const model = readString(env, "MAPLE_EMBEDDING_MODEL") ?? DEFAULT_EMBEDDING_MODEL
	return Layer.effect(FindingEmbedder)(
		Effect.map(OpenAiEmbeddingModel.make({ model }), (embeddings) => ({
			model,
			embed: (inputs: ReadonlyArray<string>) =>
				embeddings.embedMany(inputs).pipe(
					Effect.map((response) => response.embeddings.map((embedding) => embedding.vector)),
					Effect.mapError(
						(error) =>
							new PrReviewEmbeddingError({ message: error.message, model, cause: error }),
					),
				),
		})),
	).pipe(
		Layer.provide(
			OpenAiClient.layer({ apiKey: Redacted.make(apiKey), apiUrl: openRouterApiUrl(env) }).pipe(
				Layer.provide(openRouterHttp.pipe(Layer.provide(FetchHttpClient.layer))),
			),
		),
	)
}
