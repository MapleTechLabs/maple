/**
 * Whether an org can pay for a security audit. An org on its own OpenRouter key pays OpenRouter
 * directly; otherwise audits are paid in AI credits (model cost marked up, plus a sandbox fee per
 * agent), so a start needs a plan that includes them and credits to spend.
 */
import { AI_CREDITS_FEATURE_ID } from "@maple/domain/billing"
import { BillingCustomer } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { EdgeCacheService } from "@maple/cache"
import { Clock, Context, Effect, Layer, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { decodeUpstream, ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"

/** Billing could not say what the org's plan includes; a start refuses rather than guess. */
export class SecurityAuditCreditsUnavailable extends Schema.TaggedError<SecurityAuditCreditsUnavailable>()(
	"@maple/backend/security-audit/CreditsUnavailable",
	{ message: Schema.String },
) {}

/**
 * The org's plan includes no AI credits (`resetsAt` null), or it has spent them and may not go
 * over until they reset at `resetsAt` (epoch ms).
 */
export class SecurityAuditNoCredits extends Schema.TaggedError<SecurityAuditNoCredits>()(
	"@maple/backend/security-audit/NoCredits",
	{ message: Schema.String, resetsAt: Schema.NullOr(Schema.Number) },
) {}

/** When spent credits come back: the balance's own reset, else the plan's cycle, else the UTC month. */
const creditsResetAt = (customer: BillingCustomer, nextResetAt: number | null | undefined, nowMs: number) => {
	if (nextResetAt != null) return nextResetAt
	const cycleEnd = customer.subscriptions.find(
		(sub) => sub.addOn !== true && sub.currentPeriodEnd != null && sub.currentPeriodEnd > nowMs,
	)?.currentPeriodEnd
	if (cycleEnd != null) return cycleEnd
	const now = new Date(nowMs)
	return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
}

/** Why `customer` cannot pay for an audit, or None when it can. */
export const missingCredits = (
	customer: BillingCustomer,
	nowMs: number,
): Option.Option<SecurityAuditNoCredits> => {
	const balance = customer.balances?.[AI_CREDITS_FEATURE_ID]
	if (balance === undefined) {
		return Option.some(
			new SecurityAuditNoCredits({
				message:
					"Security audits run on AI credits or the organization's own OpenRouter key, and this organization has neither.",
				resetsAt: null,
			}),
		)
	}
	if (balance.unlimited === true || balance.overageAllowed === true) return Option.none()
	if ((balance.remaining ?? 0) > 0) return Option.none()
	return Option.some(
		new SecurityAuditNoCredits({
			message: "This organization has used all of its AI credits for this billing period.",
			resetsAt: creditsResetAt(customer, balance.nextResetAt, nowMs),
		}),
	)
}

export interface SecurityAuditCreditsApi {
	/**
	 * Succeeds when the org may start an audit; Maple's own org, unbilled deployments and orgs on
	 * their own OpenRouter key always may.
	 */
	readonly ensure: (
		orgId: OrgId,
	) => Effect.Effect<void, SecurityAuditNoCredits | SecurityAuditCreditsUnavailable>
}

export class SecurityAuditCredits extends Context.Service<SecurityAuditCredits, SecurityAuditCreditsApi>()(
	"@maple/backend/services/security-audit/SecurityAuditCredits",
	{
		make: Effect.gen(function* () {
			const env = yield* Env
			const edgeCache = yield* EdgeCacheService
			const autumn = yield* AutumnClient
			const orgKeys = yield* OrgOpenRouterKeyService

			const ensure: SecurityAuditCreditsApi["ensure"] = Effect.fn("SecurityAuditCredits.ensure")(
				function* (orgId) {
					// Maple's own org is never metered, as with AI usage, nor is a deployment without
					// billing (self-hosted, local dev). Unmetered is decided here, never from an error.
					if (orgId === env.MAPLE_DEFAULT_ORG_ID || Option.isNone(env.AUTUMN_SECRET_KEY)) return
					const ownKey = Option.isSome(yield* orgKeys.resolveForRun(orgId))
					yield* Effect.annotateCurrentSpan("maple.llm.byok", ownKey)
					if (ownKey) return
					const nowMs = yield* Clock.currentTimeMillis
					const missing = yield* readCustomerCached(
						edgeCache,
						orgId,
						autumn.getOrCreateCustomer(orgId, { expand: ["subscriptions.plan"] }),
					).pipe(
						Effect.flatMap(({ result }) => ensureOk(result)),
						Effect.flatMap((body) => decodeUpstream(BillingCustomer, body)),
						Effect.map((customer) => missingCredits(customer, nowMs)),
						Effect.catchTags({
							// With a key configured, a refused credential is an outage, not a free plan.
							"@maple/http/errors/BillingNotConfiguredError": (error) =>
								Effect.fail(new SecurityAuditCreditsUnavailable({ message: error.message })),
							"@maple/http/errors/BillingUpstreamError": (error) =>
								Effect.fail(new SecurityAuditCreditsUnavailable({ message: error.message })),
						}),
					)
					yield* Effect.annotateCurrentSpan(
						"maple.security_audit.has_credits",
						Option.isNone(missing),
					)
					if (Option.isSome(missing)) return yield* missing.value
				},
			)

			return { ensure } satisfies SecurityAuditCreditsApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(AutumnClient.layer, OrgOpenRouterKeyService.layer)),
	)

	/** Every org may start, for tests and harnesses. */
	static readonly unmetered = Layer.succeed(this, { ensure: () => Effect.void })
}
