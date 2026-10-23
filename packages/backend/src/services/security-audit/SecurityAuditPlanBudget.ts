/**
 * An org's monthly security-audit invocation limit, from its plan: the Autumn balance granted for
 * `security_audit_invocations`. What the org has spent against it lives in Postgres
 * (`SecurityAuditStore.orgInvocationsSpent`), where the Workflow reserves it step by step.
 */
import { SECURITY_AUDIT_INVOCATIONS_FEATURE_ID } from "@maple/domain/billing"
import { BillingCustomer } from "@maple/domain/http"
import type { OrgId } from "@maple/domain/primitives"
import { EdgeCacheService } from "@maple/cache"
import { Context, Effect, Layer, Schema } from "effect"
import { Env } from "@maple/backend/platform/Env"
import { decodeUpstream, ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { securityAuditLimits } from "./limits"

/** Billing could not say what the org's plan includes; a start refuses rather than guess. */
export class SecurityAuditPlanUnavailable extends Schema.TaggedError<SecurityAuditPlanUnavailable>()(
	"@maple/backend/security-audit/PlanUnavailable",
	{ message: Schema.String },
) {}

/** Postgres `int4`: the reservation compares against the limit in SQL. */
const MAX_LIMIT = 2_147_483_647

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

export interface SecurityAuditPlanBudgetApi {
	/** The org's monthly invocation limit. Fails only when billing cannot answer. */
	readonly monthlyLimit: (orgId: OrgId) => Effect.Effect<number, SecurityAuditPlanUnavailable>
}

export class SecurityAuditPlanBudget extends Context.Service<
	SecurityAuditPlanBudget,
	SecurityAuditPlanBudgetApi
>()("@maple/backend/services/security-audit/SecurityAuditPlanBudget", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const edgeCache = yield* EdgeCacheService
		const autumn = yield* AutumnClient

		const monthlyLimit: SecurityAuditPlanBudgetApi["monthlyLimit"] = Effect.fn(
			"SecurityAuditPlanBudget.monthlyLimit",
		)(function* (orgId) {
			const limits = yield* securityAuditLimits
			// Maple's own org is never metered, as with AI usage.
			if (orgId === env.MAPLE_DEFAULT_ORG_ID) return limits.unmeteredMonthlyInvocations
			const limit = yield* readCustomerCached(
				edgeCache,
				orgId,
				autumn.getOrCreateCustomer(orgId, { expand: ["subscriptions.plan"] }),
			).pipe(
				Effect.flatMap(({ result }) => ensureOk(result)),
				Effect.flatMap((body) => decodeUpstream(BillingCustomer, body)),
				Effect.map((customer) =>
					planMonthlyInvocations(customer, limits.unmeteredMonthlyInvocations),
				),
				Effect.catchTags({
					// Billing that is not configured (self-hosted, local dev) meters nothing.
					"@maple/http/errors/BillingNotConfiguredError": () =>
						Effect.succeed(limits.unmeteredMonthlyInvocations),
					"@maple/http/errors/BillingUpstreamError": (error) =>
						Effect.fail(new SecurityAuditPlanUnavailable({ message: error.message })),
				}),
			)
			yield* Effect.annotateCurrentSpan({ "maple.security_audit.monthly_limit": limit })
			return limit
		})

		return { monthlyLimit } satisfies SecurityAuditPlanBudgetApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(AutumnClient.layer))

	/** A fixed limit for every org, for tests and harnesses. */
	static readonly fixed = (limit: number) =>
		Layer.succeed(this, { monthlyLimit: () => Effect.succeed(limit) })
}
