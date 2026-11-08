/**
 * Whether an org may spend AI credits on new work: audits, chat, investigations, PR reviews, the bot.
 * Autumn enforces a spend limit only by not deducting past it, so Maple refuses the work itself
 * once the org is out of credits or at its paid-overage cap.
 */
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { AI_CREDITS_FEATURE_ID } from "@maple/domain/billing"
import { BillingCustomer } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { EdgeCacheService } from "@maple/cache"
import { Array as Arr, Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { decodeUpstream, ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient, type AutumnResult } from "@maple/backend/services/billing/autumn-http"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"

/** Billing could not say what the org's plan includes; each caller decides whether to run anyway. */
export class AiCreditsUnavailable extends Schema.TaggedError<AiCreditsUnavailable>()(
	"@maple/backend/billing/AiCreditsUnavailable",
	{ message: Schema.String },
) {}

export const AiCreditsRefusal = Schema.Literals(["no_credits", "used_up", "cap_reached"])
export type AiCreditsRefusal = typeof AiCreditsRefusal.Type

/**
 * The org may not spend AI credits: its plan includes none (`resetsAt` null), it spent them with no
 * overage allowed, or its paid overage reached the cap an admin set. `resetsAt` is epoch ms.
 */
export class AiCreditsExhausted extends Schema.TaggedError<AiCreditsExhausted>()(
	"@maple/backend/billing/AiCreditsExhausted",
	{ message: Schema.String, reason: AiCreditsRefusal, resetsAt: Schema.NullOr(Schema.Number) },
) {}

/** When spent credits come back: the balance's own reset, else the plan's cycle, else the UTC month. */
const creditsResetAt = (customer: BillingCustomer, nextResetAt: number | null | undefined, nowMs: number) => {
	if (nextResetAt != null) return nextResetAt
	const cycleEnd = Option.flatMap(
		Arr.findFirst(
			customer.subscriptions,
			(sub) => sub.addOn !== true && sub.currentPeriodEnd != null && sub.currentPeriodEnd > nowMs,
		),
		(sub) => Option.fromNullishOr(sub.currentPeriodEnd),
	)
	if (Option.isSome(cycleEnd)) return cycleEnd.value
	const now = new Date(nowMs)
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
}

/** Why `customer` may not spend AI credits now, or None when it may. */
export const missingAiCredits = (
	customer: BillingCustomer,
	nowMs: number,
): Option.Option<AiCreditsExhausted> => {
	const balance = customer.balances?.[AI_CREDITS_FEATURE_ID]
	if (balance === undefined) {
		return Option.some(
			new AiCreditsExhausted({
				message:
					"Maple's AI features run on AI credits or the organization's own OpenRouter key, and this organization has neither.",
				reason: "no_credits",
				resetsAt: null,
			}),
		)
	}
	if (balance.unlimited === true) return Option.none()
	if ((balance.remaining ?? 0) > 0) return Option.none()
	const resetsAt = creditsResetAt(customer, balance.nextResetAt, nowMs)
	if (balance.overageAllowed !== true) {
		return Option.some(
			new AiCreditsExhausted({
				message: "This organization has used all of its AI credits for this billing period.",
				reason: "used_up",
				resetsAt,
			}),
		)
	}
	// Overage is billed up to the cap an admin set, in credits past the grant.
	const cap = Arr.findFirst(
		customer.billingControls?.spendLimits ?? [],
		(limit) =>
			limit.featureId === AI_CREDITS_FEATURE_ID &&
			limit.enabled &&
			// A percentage limit is not in credits; Maple writes absolute ones.
			(limit.limitType ?? "absolute") === "absolute" &&
			limit.overageLimit !== undefined,
	).pipe(Option.flatMap((limit) => Option.fromUndefinedOr(limit.overageLimit)))
	if (Option.isNone(cap)) return Option.none()
	const overage = (balance.usage ?? 0) - (balance.granted ?? 0)
	if (overage < cap.value) return Option.none()
	return Option.some(
		new AiCreditsExhausted({
			message:
				"This organization has reached its AI spending cap for this billing period. An admin can raise it under Settings > Billing.",
			reason: "cap_reached",
			resetsAt,
		}),
	)
}

export interface AiCreditsApi {
	/**
	 * Succeeds when the org may spend AI credits. Maple's own org, unbilled deployments and orgs on
	 * their own OpenRouter key always may; pass `ownKey` when the caller already resolved the key.
	 */
	readonly ensure: (
		orgId: OrgId,
		options?: { readonly ownKey?: boolean },
	) => Effect.Effect<void, AiCreditsExhausted | AiCreditsUnavailable>
}

export class AiCredits extends Context.Service<AiCredits, AiCreditsApi>()(
	"@maple/backend/services/billing/AiCredits",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const edgeCache = yield* EdgeCacheService
			const autumn = yield* AutumnClient
			const billingCustomers = yield* BillingCustomerResolver
			const orgKeys = yield* OrgOpenRouterKeyService

			const ensure: AiCreditsApi["ensure"] = Effect.fn("AiCredits.ensure")(function* (orgId, options) {
				// Maple's own org is never metered, nor is a deployment without billing (self-hosted,
				// local dev). Unmetered is decided here, never from an error.
				if (orgId === env.MAPLE_DEFAULT_ORG_ID || Option.isNone(env.AUTUMN_SECRET_KEY)) return
				const ownKey =
					options?.ownKey ?? (yield* orgKeys.resolveForRun(orgId).pipe(Effect.map(Option.isSome)))
				yield* Effect.annotateCurrentSpan("maple.llm.byok", ownKey)
				if (ownKey) return
				const nowMs = yield* Clock.currentTimeMillis
				// A member org spends the credits of the org that pays for it.
				const missing = yield* billingCustomers.customerFor(orgId).pipe(
					Effect.flatMap((customerId) => {
						const fresh = autumn.getOrCreateCustomer(customerId, {
							expand: ["subscriptions.plan"],
						})
						const judge = (result: AutumnResult) =>
							ensureOk(result).pipe(
								Effect.flatMap((body) => decodeUpstream(BillingCustomer, body)),
								Effect.map((customer) => missingAiCredits(customer, nowMs)),
							)
						return readCustomerCached(edgeCache, customerId, fresh).pipe(
							Effect.flatMap(({ result, hit }) =>
								judge(result).pipe(
									// A cached refusal may predate a raised cap or a new plan: confirm it first.
									Effect.filterOrElse(
										(verdict) => !hit || Option.isNone(verdict),
										() =>
											Effect.annotateCurrentSpan(
												"maple.ai_credits.rechecked",
												true,
											).pipe(Effect.andThen(fresh), Effect.flatMap(judge)),
									),
								),
							),
						)
					}),
					Effect.catchTags({
						// With a key configured, a refused credential is an outage, not a free plan.
						"@maple/http/errors/BillingNotConfiguredError": (error) =>
							Effect.fail(new AiCreditsUnavailable({ message: error.message })),
						"@maple/http/errors/BillingUpstreamError": (error) =>
							Effect.fail(new AiCreditsUnavailable({ message: error.message })),
						"@maple/http/errors/BillingAccountPersistenceError": (error) =>
							Effect.fail(new AiCreditsUnavailable({ message: error.message })),
					}),
				)
				yield* Effect.annotateCurrentSpan("maple.ai_credits.allowed", Option.isNone(missing))
				if (Option.isSome(missing)) {
					yield* Effect.annotateCurrentSpan("maple.ai_credits.reason", missing.value.reason)
					return yield* missing.value
				}
			})

			return { ensure } satisfies AiCreditsApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(AutumnClient.layer, OrgOpenRouterKeyService.layer, BillingCustomerResolver.layer),
		),
	)

	/** Every org may spend, for tests and harnesses. */
	static readonly unmetered = Layer.succeed(this, { ensure: () => Effect.void })
}
