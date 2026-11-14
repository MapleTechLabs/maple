/**
 * Fire-and-forget Autumn usage tracking for every AI surface Maple bills:
 * autonomous triage, an attended chat turn, and the
 * chat-platform bot. The source names the surface inside the idempotency key,
 * so two surfaces that legitimately key on the same id can never collide, and a
 * retry of any of them bills once. Infallible by type, because every caller
 * reaches it from a place where a failure must not propagate.
 *
 * Two meters run side by side while AI credits roll out: {@link trackAiCredits}
 * charges dollars per model through Autumn's AI credit system, and
 * {@link trackTokenUsage} keeps the legacy raw token counts for comparison.
 */
import { Config, Duration, Effect, Option, Redacted, Array as Arr, String as Str } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { AI_CREDITS_FEATURE_ID, type AiCreditSource, aiCreditsUsd } from "@maple/domain/billing"
import type { BillingCustomerId } from "@maple/domain/http"
import {
	AUTUMN_TRACK_PATH,
	AUTUMN_TRACK_TOKENS_PATH,
	autumnPost,
	DEFAULT_AUTUMN_API_URL,
} from "@maple/backend/services/billing/autumn-api"

/**
 * Ceiling on one track call.
 *
 * Every caller awaits this from somewhere that is holding something open — a chat
 * turn holds the session's turn slot until it resolves, so an unbounded stall would
 * leave a finished conversation unable to accept the next message. A dropped meter
 * event is the cheaper failure, and it is already the failure mode for a non-2xx.
 */
const TRACK_TIMEOUT = Duration.seconds(5)

/** The AI surfaces that run as chat turns. */
export type AiUsageSource = Exclude<AiCreditSource, "security_audit">

/** Every billing usage source: the AI surfaces, and the security audit's agents. */
export type BillingUsageSource = AiCreditSource

export interface TrackTokenUsageOptions {
	/** The org that pays; resolve it with `BillingCustomerResolver.customerFor`. */
	readonly customerId: BillingCustomerId
	readonly inputTokens: number
	readonly outputTokens: number
	readonly idempotencyKey: string
	readonly source: AiUsageSource
}

/**
 * One AI credit charge: a model call, or consecutive calls to one model, in Autumn's exclusive token pools: `inputTokens` excludes cache
 * reads and writes, `outputTokens` excludes reasoning. Autumn prices each pool at the model's rate.
 */
export interface AiModelSpend {
	/** `<models.dev provider>/<model>`, e.g. `openrouter/z-ai/glm-5.3-flash`. */
	readonly modelId: string
	readonly inputTokens: number
	readonly outputTokens: number
	readonly cacheReadTokens: number
	readonly cacheWriteTokens: number
	readonly reasoningTokens: number
	/**
	 * What the provider billed for these calls, in microdollars, when it reported it. A charge that
	 * has it is billed at that cost plus the AI credit markup, not from Autumn's price table.
	 */
	readonly providerCostMicrousd?: number
}

export interface TrackAiCreditsOptions {
	/** The org that pays; resolve it with `BillingCustomerResolver.customerFor`. */
	readonly customerId: BillingCustomerId
	/** In call order: a charge's position is part of its idempotency key. */
	readonly spends: ReadonlyArray<AiModelSpend>
	readonly idempotencyKey: string
	readonly source: AiUsageSource
}

interface UsageRequest {
	readonly path: string
	readonly body: Record<string, unknown>
	/** Sent as the `Idempotency-Key` header, which Autumn honours on every route. */
	readonly idempotencyKey?: string
	/** What the warning logs name: a feature id or a model id. */
	readonly label: string
}

/** A setting that is absent, blank or malformed reads as unset, as the raw-env version did. */
const optional = <A>(config: Config.Config<A>) =>
	Config.option(config).pipe(Config.orElse(() => Config.succeed(Option.none<A>())))

const notBlank = (value: string) => Str.trim(value) !== ""

const trackerConfig = Config.all({
	secretKey: optional(Config.Redacted("AUTUMN_SECRET_KEY")).pipe(
		Config.map(Option.filter((key) => notBlank(Redacted.value(key)))),
	),
	defaultOrgId: optional(Config.String("MAPLE_DEFAULT_ORG_ID")).pipe(Config.map(Option.filter(notBlank))),
	apiUrl: optional(Config.String("AUTUMN_API_URL")).pipe(Config.map(Option.filter(notBlank))),
})

/** The tracker's settings, or `undefined` when this org must not be metered. */
const resolveTracker = Effect.fn("AutumnTracker.resolveTracker")(function* (orgId: string) {
	const config = yield* trackerConfig.pipe(Effect.orElseSucceed(() => undefined))
	if (config === undefined || Option.isNone(config.secretKey)) return undefined
	if (Option.contains(config.defaultOrgId, orgId)) return undefined
	return {
		apiUrl: Str.replace(/\/+$/, "")(Option.getOrElse(config.apiUrl, () => DEFAULT_AUTUMN_API_URL)),
		secretKey: config.secretKey.value,
	}
})

const postUsage = (
	client: HttpClient.HttpClient,
	tracker: { readonly apiUrl: string; readonly secretKey: Redacted.Redacted },
	request: UsageRequest,
) =>
	client
		.execute(
			autumnPost(tracker.apiUrl, Redacted.value(tracker.secretKey), request.path).pipe(
				request.idempotencyKey === undefined
					? (req) => req
					: HttpClientRequest.setHeader("Idempotency-Key", request.idempotencyKey),
				HttpClientRequest.bodyJsonUnsafe(request.body),
			),
		)
		.pipe(
			Effect.flatMap((response) =>
				// 409 is Autumn refusing a key it already counted: the retry this key exists for.
				(response.status >= 200 && response.status < 300) || response.status === 409
					? Effect.void
					: response.text.pipe(
							Effect.orElseSucceed(() => ""),
							Effect.flatMap((body) =>
								Effect.logWarning("autumn track failed").pipe(
									Effect.annotateLogs({
										status: response.status,
										path: request.path,
										feature: request.label,
										body,
									}),
								),
							),
						),
			),
			Effect.timeout(TRACK_TIMEOUT),
			Effect.catchCause((cause) =>
				Effect.logWarning("autumn track error", cause).pipe(
					Effect.annotateLogs({ path: request.path, feature: request.label }),
				),
			),
			// Named like `autumn-http.ts`'s span so every Autumn call reads as one dependency.
			Effect.withSpan("autumn.request", {
				kind: "client",
				attributes: { "maple.autumn.route": request.path, "peer.service": "autumn" },
			}),
		)

const postAll = (customerId: BillingCustomerId, requests: ReadonlyArray<UsageRequest>) =>
	Effect.gen(function* () {
		if (requests.length === 0) return
		const tracker = yield* resolveTracker(customerId)
		if (tracker === undefined) return
		const client = yield* HttpClient.HttpClient
		yield* Effect.forEach(requests, (request) => postUsage(client, tracker, request), {
			concurrency: 8,
			discard: true,
		})
	})

/** Legacy raw token counts, kept beside {@link trackAiCredits} until the credit system is trusted. */
export const trackTokenUsage = Effect.fn("AutumnTracker.trackTokenUsage")(function* ({
	customerId,
	inputTokens,
	outputTokens,
	idempotencyKey,
	source,
}: TrackTokenUsageOptions) {
	const counts = Arr.filter(
		[
			{ featureId: "ai_input_tokens", value: inputTokens, suffix: "input" },
			{ featureId: "ai_output_tokens", value: outputTokens, suffix: "output" },
		],
		(count) => count.value > 0,
	)
	yield* postAll(
		customerId,
		Arr.map(counts, (count) => ({
			path: AUTUMN_TRACK_PATH,
			label: count.featureId,
			body: {
				customer_id: customerId,
				feature_id: count.featureId,
				value: count.value,
				idempotency_key: `${idempotencyKey}:${source}:${count.suffix}`,
			},
		})),
	)
})

const spendsAnything = (spend: AiModelSpend) =>
	spend.inputTokens +
		spend.outputTokens +
		spend.cacheReadTokens +
		spend.cacheWriteTokens +
		spend.reasoningTokens >
	0

/** One charge as the request that bills it: the provider's cost when known, else its tokens. */
const creditRequest = (
	customerId: BillingCustomerId,
	source: AiUsageSource,
	spend: AiModelSpend,
	key: string,
): ReadonlyArray<UsageRequest> => {
	if (spend.providerCostMicrousd !== undefined) {
		const providerUsd = spend.providerCostMicrousd / 1_000_000
		if (!(providerUsd > 0)) return []
		return [
			{
				path: AUTUMN_TRACK_PATH,
				label: spend.modelId,
				idempotencyKey: key,
				body: {
					customer_id: customerId,
					feature_id: AI_CREDITS_FEATURE_ID,
					value: aiCreditsUsd(providerUsd),
					idempotency_key: key,
					properties: {
						source,
						model: spend.modelId,
						provider_usd: providerUsd,
						input_tokens: spend.inputTokens,
						output_tokens: spend.outputTokens,
						cache_read_tokens: spend.cacheReadTokens,
						cache_write_tokens: spend.cacheWriteTokens,
						reasoning_tokens: spend.reasoningTokens,
					},
				},
			},
		]
	}
	return [
		{
			path: AUTUMN_TRACK_TOKENS_PATH,
			label: spend.modelId,
			idempotencyKey: key,
			body: {
				customer_id: customerId,
				feature_id: AI_CREDITS_FEATURE_ID,
				model_id: spend.modelId,
				input_tokens: spend.inputTokens,
				output_tokens: spend.outputTokens,
				cache_read_tokens: spend.cacheReadTokens,
				cache_write_tokens: spend.cacheWriteTokens,
				reasoning_tokens: spend.reasoningTokens,
				properties: { source },
			},
		},
	]
}

/**
 * Charge a turn's model calls to the org's AI credits, one track call per charge.
 *
 * A charge the provider priced bills that cost plus the AI credit markup: Autumn's per-model rate
 * table follows models.dev, which has billed an OpenRouter model at a fraction of its real price.
 * A charge without one (Workers AI) falls back to `track_tokens` and Autumn's rates. The default
 * overage behaviour is kept on purpose: `overflow` would ignore the org's spend limit.
 */
export const trackAiCredits = Effect.fn("AutumnTracker.trackAiCredits")(function* ({
	customerId,
	spends,
	idempotencyKey,
	source,
}: TrackAiCreditsOptions) {
	yield* postAll(
		customerId,
		Arr.flatMap(spends, (spend, index) =>
			spendsAnything(spend)
				? creditRequest(customerId, source, spend, `${idempotencyKey}:${source}:credits:${index}`)
				: [],
		),
	)
})

/** What a security-audit charge pays for: an agent's sandbox, or its model calls. */
export type SecurityAuditChargeKind = "sandbox" | "model"

export interface TrackSecurityAuditChargeOptions {
	/** The org that pays; resolve it with `BillingCustomerResolver.customerFor`. */
	readonly customerId: BillingCustomerId
	readonly runId: string
	/** The invocation's agent id: one charge per agent and kind, however often its step is retried. */
	readonly agentId: string
	readonly kind: SecurityAuditChargeKind
	/** US dollars, already marked up: one AI credit is one dollar. */
	readonly usd: number
}

/**
 * Charge one security-audit agent's sandbox fee or model cost to the org's AI credits. A plain
 * track, not `track_tokens`: the model cost is OpenRouter's own bill, marked up by the caller.
 */
export const trackSecurityAuditCharge = Effect.fn("AutumnTracker.trackSecurityAuditCharge")(function* ({
	customerId,
	runId,
	agentId,
	kind,
	usd,
}: TrackSecurityAuditChargeOptions) {
	if (!(usd > 0)) return
	const source: BillingUsageSource = "security_audit"
	const idempotencyKey = `${runId}:${agentId}:${source}:${kind}`
	yield* postAll(customerId, [
		{
			path: AUTUMN_TRACK_PATH,
			label: AI_CREDITS_FEATURE_ID,
			idempotencyKey,
			body: {
				customer_id: customerId,
				feature_id: AI_CREDITS_FEATURE_ID,
				value: usd,
				idempotency_key: idempotencyKey,
				properties: { source, kind, run_id: runId, agent_id: agentId },
			},
		},
	])
})

export interface TrackFeatureUsageOptions {
	/** The org that pays; resolve it with `BillingCustomerResolver.customerFor`. */
	readonly customerId: BillingCustomerId
	readonly featureId: string
	/** Negative for continuous-use features giving a unit back, e.g. a deleted monitor. */
	readonly value: number
	readonly idempotencyKey: string
}

export const trackFeatureUsage = Effect.fn("AutumnTracker.trackFeatureUsage")(function* ({
	customerId,
	featureId,
	value,
	idempotencyKey,
}: TrackFeatureUsageOptions) {
	if (value === 0) return
	yield* postAll(customerId, [
		{
			path: AUTUMN_TRACK_PATH,
			label: featureId,
			idempotencyKey,
			body: { customer_id: customerId, feature_id: featureId, value, idempotency_key: idempotencyKey },
		},
	])
})
