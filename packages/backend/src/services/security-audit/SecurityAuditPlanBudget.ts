/**
 * An org's monthly security-audit invocation limit, from its plan: the Autumn balance granted for
 * `security_audit_invocations`. What the org has spent against it lives in Postgres
 * (`SecurityAuditStore.orgInvocationsSpent`), where the Workflow reserves it step by step.
 */
import { SECURITY_AUDIT_INVOCATIONS_FEATURE_ID } from "@maple/domain/billing"
import { BillingCustomer } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { securityAuditBudgetPeriod } from "@maple/domain/security-audit"
import { EdgeCacheService } from "@maple/cache"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { decodeUpstream, ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { MAX_LIMIT, securityAuditLimits } from "./limits"

/** Billing could not say what the org's plan includes; a start refuses rather than guess. */
export class SecurityAuditPlanUnavailable extends Schema.TaggedError<SecurityAuditPlanUnavailable>()(
	"@maple/backend/security-audit/PlanUnavailable",
	{ message: Schema.String },
) {}

/**
 * The plan's monthly invocations: the granted balance, the unmetered allowance for an unlimited
 * one, and none for a plan without the feature.
 */
export const planMonthlyInvocations = (customer: BillingCustomer, unmetered: number): number => {
	const balance = customer.balances?.[SECURITY_AUDIT_INVOCATIONS_FEATURE_ID]
	if (balance === undefined) return 0
	if (balance.unlimited === true) return unmetered
	return Math.min(MAX_LIMIT, Math.max(0, Math.floor(balance.granted ?? 0)))
}

/** What the org may spend in its current billing cycle, and when that cycle resets. */
export interface OrgAuditBudget {
	/** Invocations the plan grants per cycle. */
	readonly limit: number
	/**
	 * The key the org's counter uses: `cycle:<ISO start>` from the subscription's own period, so
	 * it resets when Autumn's balance does; the UTC month `YYYY-MM` when billing gives no period.
	 */
	readonly period: string
	/** When the budget resets, epoch ms. */
	readonly resetsAt: number
	/** What Autumn itself says is left this cycle, when it says. */
	readonly autumnRemaining: number | null
}

const utcMonth = (nowMs: number) => {
	const now = new Date(nowMs)
	return {
		period: securityAuditBudgetPeriod(nowMs),
		resetsAt: Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
	}
}

/** The org's budget for the cycle containing `nowMs`; `customer` is null for an unmetered org. */
export const orgAuditBudget = (
	customer: BillingCustomer | null,
	unmetered: number,
	nowMs: number,
): OrgAuditBudget => {
	if (customer === null) return { limit: unmetered, ...utcMonth(nowMs), autumnRemaining: null }
	// The base plan's own period, which is when Autumn resets the feature's balance. Any status
	// counts: a past_due or trialing subscription still has its period, and the key must not flip.
	const covering = customer.subscriptions.filter(
		(sub) =>
			sub.addOn !== true &&
			sub.currentPeriodStart != null &&
			sub.currentPeriodEnd != null &&
			sub.currentPeriodStart <= nowMs &&
			nowMs < sub.currentPeriodEnd,
	)
	const cycle = covering.find((sub) => sub.status === "active") ?? covering[0]
	const window =
		cycle?.currentPeriodStart == null || cycle.currentPeriodEnd == null
			? utcMonth(nowMs)
			: {
					period: `cycle:${new Date(cycle.currentPeriodStart).toISOString()}`,
					resetsAt: cycle.currentPeriodEnd,
				}
	const balance = customer.balances?.[SECURITY_AUDIT_INVOCATIONS_FEATURE_ID]
	const remaining = balance?.unlimited === true ? null : (balance?.remaining ?? null)
	return {
		limit: planMonthlyInvocations(customer, unmetered),
		...window,
		autumnRemaining: remaining === null ? null : Math.max(0, Math.floor(remaining)),
	}
}

export interface SecurityAuditPlanBudgetApi {
	/** The org's budget for the cycle containing `nowMs`. Fails only when billing cannot answer. */
	readonly budget: (
		orgId: OrgId,
		nowMs: number,
	) => Effect.Effect<OrgAuditBudget, SecurityAuditPlanUnavailable>
}

export class SecurityAuditPlanBudget extends Context.Service<
	SecurityAuditPlanBudget,
	SecurityAuditPlanBudgetApi
>()("@maple/backend/services/security-audit/SecurityAuditPlanBudget", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const edgeCache = yield* EdgeCacheService
		const autumn = yield* AutumnClient

		const budget: SecurityAuditPlanBudgetApi["budget"] = Effect.fn("SecurityAuditPlanBudget.budget")(
			function* (orgId, nowMs) {
				const limits = yield* securityAuditLimits
				const unmetered = limits.unmeteredMonthlyInvocations
				// Maple's own org is never metered, as with AI usage, nor is a deployment without
				// billing (self-hosted, local dev). Unmetered is decided here, never from an error.
				if (orgId === env.MAPLE_DEFAULT_ORG_ID || Option.isNone(env.AUTUMN_SECRET_KEY)) {
					return orgAuditBudget(null, unmetered, nowMs)
				}
				const result = yield* readCustomerCached(
					edgeCache,
					orgId,
					autumn.getOrCreateCustomer(orgId, { expand: ["subscriptions.plan"] }),
				).pipe(
					Effect.flatMap(({ result }) => ensureOk(result)),
					Effect.flatMap((body) => decodeUpstream(BillingCustomer, body)),
					Effect.map((customer) => orgAuditBudget(customer, unmetered, nowMs)),
					Effect.catchTags({
						// With a key configured, a refused credential is an outage, not a free plan.
						"@maple/http/errors/BillingNotConfiguredError": (error) =>
							Effect.fail(new SecurityAuditPlanUnavailable({ message: error.message })),
						"@maple/http/errors/BillingUpstreamError": (error) =>
							Effect.fail(new SecurityAuditPlanUnavailable({ message: error.message })),
					}),
				)
				yield* Effect.annotateCurrentSpan({
					"maple.security_audit.monthly_limit": result.limit,
					"maple.security_audit.budget_period": result.period,
				})
				return result
			},
		)

		return { budget } satisfies SecurityAuditPlanBudgetApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(AutumnClient.layer))

	/** A fixed budget for every org (the UTC month, unless given), for tests and harnesses. */
	static readonly fixed = (fixed: Partial<OrgAuditBudget> & { readonly limit: number }) =>
		Layer.succeed(this, {
			budget: (_orgId, nowMs) =>
				Effect.succeed({ ...orgAuditBudget(null, fixed.limit, nowMs), ...fixed }),
		})
}
