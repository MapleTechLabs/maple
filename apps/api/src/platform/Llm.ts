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
import { LlmCallError } from "@maple/domain/llm"
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat"
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter"
import { Effect, Layer, Predicate, Redacted, Schema } from "effect"
import type { AiError } from "effect/unstable/ai"
import type * as LanguageModel from "effect/unstable/ai/LanguageModel"
import type * as AiModel from "effect/unstable/ai/Model"
import { FetchHttpClient, HttpBody, HttpClient, HttpClientRequest } from "effect/unstable/http"
import { layerResponseIdentity } from "./ResponseIdentityHttpClient"
import { layerWorkersAi } from "./WorkersAiHttpClient"

/** Default triage/chat model on OpenRouter — the provider agents run on by default. */
export const DEFAULT_OPENROUTER_MODEL = "z-ai/glm-5.3-flash:nitro"

/**
 * OpenRouter app attribution. `HTTP-Referer` is the header that actually creates the app page — a
 * title on its own does nothing — so both are sent together or not at all. One URL for every
 * surface on purpose: a second referer would mint a second app entry and split the rankings.
 */
const OPENROUTER_APP_URL = "https://maple.dev"
const OPENROUTER_APP_TITLE = "Maple"

/**
 * Where a model call came from and what it is running for.
 *
 * OpenRouter surfaces these three in different places: `user` shows up on the activity page and in
 * usage exports, `session_id` groups a conversation (and makes OpenRouter route the whole session
 * to one provider, so prompt caches actually hit), and `trace` is forwarded to any configured
 * Broadcast destination.
 */
export interface LlmCallTags {
	readonly surface: "chat" | "ai-triage" | "investigation-lens" | "investigation-validator"
	readonly orgId: string
	/** Groups one conversation or investigation. OpenRouter caps this at 256 characters. */
	readonly sessionId?: string
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
	readonly MAPLE_TRIAGE_MODEL_OPENROUTER?: string
	readonly MAPLE_TRIAGE_MODEL_WORKERS_AI?: string
	/** Context window in tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_CONTEXT?: string
	/** Max completion tokens, overriding {@link MODEL_LIMITS} for the configured model. */
	readonly MAPLE_TRIAGE_MODEL_OUTPUT?: string
	/** Cheaper model for the fan-out lens passes; falls back to the triage model. */
	readonly MAPLE_LENS_MODEL_OPENROUTER?: string
	readonly MAPLE_LENS_MODEL_WORKERS_AI?: string
	/** `low` | `medium` | `high` | `off`. See {@link ReasoningEffort}. */
	readonly MAPLE_TRIAGE_REASONING_EFFORT?: string
	readonly MAPLE_LENS_REASONING_EFFORT?: string
	readonly OPENROUTER_API_KEY?: string
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
 * Supplies the model to an Effect.
 *
 * A function rather than the Layer itself, because the two branches produce Layers that need
 * different clients and a `Model` requiring one is not assignable to a `Model` requiring either.
 * Closing over the concrete Layer at resolution keeps that union out of every call site.
 */
export type ProvideModel = <A, E, R>(
	effect: Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, Exclude<R, ModelServices> | LlmClients>

/**
 * A model Maple resolved, with the facts callers need alongside it.
 *
 * Effect AI models are Layers, not values, so the context window can no longer hang off the model
 * instance the way it did when a model was a record. It travels here instead, which also means a
 * caller cannot hold a model without holding its limits.
 */
export interface ResolvedModel {
	readonly provider: LlmProvider
	/** The provider's own model id, as sent on the wire. */
	readonly name: string
	readonly provide: ProvideModel
	readonly limits: { readonly context: number; readonly output: number }
}

const limitsFor = (env: LlmEnv, name: string): { readonly context: number; readonly output: number } => {
	const known = MODEL_LIMITS[name] ?? DEFAULT_MODEL_LIMITS
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
 * exception and is injected by {@link withUsageAccounting}.
 */
const openRouterConfig = (effort: ReasoningEffort | undefined, tags: LlmCallTags | undefined) => ({
	...(effort === undefined || effort === "off" ? undefined : { reasoning: { effort } }),
	...(tags === undefined
		? undefined
		: {
				user: tags.orgId,
				...(tags.sessionId === undefined ? undefined : { session_id: tags.sessionId.slice(0, 256) }),
				trace: { trace_name: tags.surface },
			}),
})

const openRouterModel = (env: LlmEnv, name: string, effortKey: keyof LlmEnv, fallbackEffort: ReasoningEffort | undefined, tags: LlmCallTags | undefined): ResolvedModel => ({
	provider: "openrouter",
	name,
	// The model Layer is composed at the caller's entry point; this only applies it, which is the
	// whole reason `provide` is a function rather than the Layer itself.
	provide: (effect) =>
		// oxlint-disable-next-line effecttsgo/strict-effect-provide
		Effect.provide(
			effect,
			OpenRouterLanguageModel.model(
				name,
				openRouterConfig(readReasoningEffort(env, effortKey) ?? fallbackEffort, tags),
			),
		),
	limits: limitsFor(env, name),
})

const workersAiModel = (env: LlmEnv, name: string): ResolvedModel => ({
	provider: "workers-ai",
	name,
	// See the OpenRouter branch above.
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	provide: (effect) => Effect.provide(effect, OpenAiLanguageModel.model(name)),
	limits: limitsFor(env, name),
})

/**
 * The model the triage/chat agents run on.
 *
 * `tags` is OpenRouter-only. Attribution headers ride on every OpenRouter call regardless; the
 * per-call tags become request-body defaults, so every call made with the returned model carries
 * them. The Workers AI branch ignores them — they are OpenRouter's fields and mean nothing to
 * Cloudflare.
 */
export const resolveTriageModel = (env: LlmEnv, tags?: LlmCallTags): ResolvedModel =>
	resolveLlmProvider(env) === "workers-ai"
		? workersAiModel(env, readString(env, "MAPLE_TRIAGE_MODEL_WORKERS_AI") ?? DEFAULT_WORKERS_AI_MODEL)
		: openRouterModel(
				env,
				readString(env, "MAPLE_TRIAGE_MODEL_OPENROUTER") ?? DEFAULT_OPENROUTER_MODEL,
				"MAPLE_TRIAGE_REASONING_EFFORT",
				// No default. This resolver serves chat, AI triage *and* the validator, so a number
				// picked here would retune three stages with different shapes at once.
				undefined,
				tags,
			)

/**
 * The model a fan-out *lens* runs on.
 *
 * Lenses gather evidence through one narrow framing; the validator does the reasoning about which
 * candidate explains the incident. So the spend belongs on the validator, and a fan-out of five
 * otherwise multiplies the expensive model by five for work a cheaper one does adequately.
 *
 * The reasoning budget is that argument in its other form, and it is the part that is **not**
 * opt-in: `low` by default, because a narrow framing does not need a long think and the fan-out
 * multiplies whatever it does need by five.
 */
export const resolveLensModel = (env: LlmEnv, tags?: LlmCallTags): ResolvedModel =>
	resolveLlmProvider(env) === "workers-ai"
		? workersAiModel(
				env,
				readString(env, "MAPLE_LENS_MODEL_WORKERS_AI") ??
					readString(env, "MAPLE_TRIAGE_MODEL_WORKERS_AI") ??
					DEFAULT_WORKERS_AI_MODEL,
			)
		: openRouterModel(
				env,
				readString(env, "MAPLE_LENS_MODEL_OPENROUTER") ??
					readString(env, "MAPLE_TRIAGE_MODEL_OPENROUTER") ??
					DEFAULT_OPENROUTER_MODEL,
				"MAPLE_LENS_REASONING_EFFORT",
				"low",
				tags,
			)

/**
 * Add OpenRouter's `usage: { include: true }` to every outgoing chat request.
 *
 * It is the only field Maple needs that OpenRouter's generated request schema does not declare, and
 * a closed `Schema.Struct` drops what it does not know — so it is spliced into the encoded body
 * here instead. Without it the response carries no `cost`, and `gen_ai.usage.cost` is the only way
 * Maple ever reports spend: the provider's own bill, never a price table.
 */
const withUsageAccounting = (client: HttpClient.HttpClient): HttpClient.HttpClient =>
	HttpClient.mapRequestEffect(client, (request) =>
		spliceUsageAccounting(request).pipe(Effect.orElseSucceed(() => request)),
	)

const decodeJsonBody = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))

const spliceUsageAccounting = (
	request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<HttpClientRequest.HttpClientRequest, Schema.SchemaError | HttpBody.HttpBodyError> =>
	Effect.gen(function* () {
		const body = request.body
		if (body._tag !== "Uint8Array") return request
		const decoded = yield* decodeJsonBody(new TextDecoder().decode(body.body))
		if (typeof decoded !== "object" || decoded === null || Array.isArray(decoded)) return request
		return yield* HttpClientRequest.bodyJson(request, { ...decoded, usage: { include: true } })
	})

/**
 * The runnable LLM stack — both provider clients, so the switch stays a pure env flip.
 *
 * The Workers AI shim sits in the stack unconditionally: it only intercepts POSTs to the Workers AI
 * chat URL, so it is inert for OpenRouter traffic. `env` supplies the `AI` binding; when it is
 * absent the shim is a no-op and Workers AI requests go out over `fetch` to the REST endpoint.
 */
export const layerLlm = (env: LlmEnv): Layer.Layer<LlmClients> => {
	const accountId = readString(env, "CLOUDFLARE_ACCOUNT_ID") ?? BINDING_PLACEHOLDER
	// Response identity wraps the binding shim, which wraps `fetch` — so a model call that goes out
	// over `fetch` stamps its span with the served response's id and model, and one the shim answers
	// from the `AI` binding never reaches `fetch` and is not stamped.
	const http = layerResponseIdentity.pipe(
		Layer.provide(layerWorkersAi(env)),
		Layer.provide(FetchHttpClient.layer),
	)
	return Layer.mergeAll(
		OpenRouterClient.layer({
			apiKey: Redacted.make(readString(env, "OPENROUTER_API_KEY") ?? ""),
			transformClient: withUsageAccounting,
		}).pipe(
			Layer.provide(
				Layer.effect(HttpClient.HttpClient)(
					Effect.map(HttpClient.HttpClient, (client) =>
						HttpClient.mapRequest(
							client,
							HttpClientRequest.setHeaders({
								"HTTP-Referer": OPENROUTER_APP_URL,
								"X-Title": OPENROUTER_APP_TITLE,
							}),
						),
					),
				).pipe(Layer.provide(http)),
			),
		),
		// The URL the shim already matches: `.../ai/v1/chat/completions`.
		OpenAiClient.layer({
			apiKey: Redacted.make(readString(env, "CLOUDFLARE_API_KEY") ?? BINDING_PLACEHOLDER),
			apiUrl: `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/v1`,
		}).pipe(Layer.provide(http)),
	)
}

/**
 * Reasons worth sending again unchanged. Effect AI carries this as `isRetryable` on the error
 * itself, so the judgement upstream makes is the one Maple uses.
 */
const isRetryable = (error: AiError.AiError): boolean => error.isRetryable

/**
 * Whether a failure is the context window rather than anything else.
 *
 * Effect AI has no dedicated tag for it, so this reads the provider's own wording off an
 * `InvalidRequestError`. Deliberately narrow: a false positive here shrinks a transcript that did
 * not need shrinking, which is cheap, but a false positive on a *different* invalid request would
 * loop the caller shrinking forever.
 */
const CONTEXT_OVERFLOW_PATTERN = /context (?:length|window)|maximum context|too many tokens|prompt is too long/i

const isContextOverflow = (error: AiError.AiError): boolean =>
	error.reason._tag === "InvalidRequestError" && CONTEXT_OVERFLOW_PATTERN.test(error.message)

/**
 * Map Effect AI's `AiError` onto Maple's domain error, promoting context overflow to a first-class,
 * inspectable signal — the case a triage retry must handle differently (shrink the transcript) from
 * a transport blip (retry as-is).
 */
export const toLlmCallError = (operation: string, error: AiError.AiError): LlmCallError => {
	// A failing provider response carries its offending payload. It is the only thing that makes
	// provider drift diagnosable, but it is upstream text, so it goes to the log, never to the client.
	const body = Predicate.hasProperty(error.reason, "body") ? error.reason.body : undefined
	if (typeof body === "string" && body !== "") {
		console.error(`[llm] ${operation}: ${error.message}; body=${body.slice(0, 500)}`)
	}
	return new LlmCallError({
		operation,
		reason: error.reason._tag,
		message: error.message,
		retryable: isRetryable(error),
		contextOverflow: isContextOverflow(error),
	})
}
