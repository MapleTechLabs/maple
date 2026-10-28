/**
 * How many uptime monitors an org's plan allows, and the Autumn meter that counts them. The
 * `uptime_monitors` feature is continuous use: +1 on create, -1 on delete.
 */
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { UPTIME_MONITORS_FEATURE_ID } from "@maple/domain/billing"
import {
	BillingCustomer,
	UptimeMonitorLimitReachedError,
	UptimeMonitorPersistenceError,
} from "@maple/domain/http"
import type { OrgId, UptimeMonitorId } from "@maple/domain/primitives"
import { EdgeCacheService } from "@maple/cache"
import { Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { decodeUpstream, ensureOk, readCustomerCached } from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { trackFeatureUsage } from "@maple/backend/services/billing/autumn-tracker"

/** The plan's monitor allowance; None when it has no cap (unlimited or overage allowed). */
export const uptimeMonitorLimit = (customer: BillingCustomer): Option.Option<number> => {
	const balance = customer.balances?.[UPTIME_MONITORS_FEATURE_ID]
	if (balance === undefined) return Option.some(0)
	if (balance.unlimited === true || balance.overageAllowed === true) return Option.none()
	return Option.some(balance.granted ?? 0)
}

/** The 402 a create past the plan's allowance fails with, in the words the API returns. */
export const limitReached = (limit: number) =>
	new UptimeMonitorLimitReachedError({
		message:
			limit === 0
				? "This organization's plan doesn't include uptime monitors."
				: `This organization already has ${limit} uptime monitors, the most its plan allows. Delete one or upgrade to add more.`,
		limit,
	})

/** Succeeds when an org holding `existing` monitors may create one more under `limit`. */
export const ensureWithinLimit = (
	limit: Option.Option<number>,
	existing: number,
): Effect.Effect<void, UptimeMonitorLimitReachedError> =>
	Option.isSome(limit) && existing >= limit.value ? Effect.fail(limitReached(limit.value)) : Effect.void

export interface UptimeMonitorAllowanceApi {
	/** The org's monitor cap; None when uncapped. Count against it with `ensureWithinLimit`. */
	readonly limit: (orgId: OrgId) => Effect.Effect<Option.Option<number>, UptimeMonitorPersistenceError>
	/** Meters a created (+1) or deleted (-1) monitor. Never fails: a dropped event is logged. */
	readonly track: (orgId: OrgId, monitorId: UptimeMonitorId, delta: 1 | -1) => Effect.Effect<void>
}

export class UptimeMonitorAllowance extends Context.Service<
	UptimeMonitorAllowance,
	UptimeMonitorAllowanceApi
>()("@maple/backend/services/uptime/UptimeMonitorAllowance", {
	make: Effect.gen(function* () {
		const env = yield* Env
		const edgeCache = yield* EdgeCacheService
		const autumn = yield* AutumnClient
		const billingCustomers = yield* BillingCustomerResolver
		const httpClient = yield* HttpClient.HttpClient
		// Maple's own org and deployments without billing (self-hosted, local dev) are uncapped.
		const unmetered = (orgId: OrgId) =>
			orgId === env.MAPLE_DEFAULT_ORG_ID || Option.isNone(env.AUTUMN_SECRET_KEY)

		const limit: UptimeMonitorAllowanceApi["limit"] = Effect.fn("UptimeMonitorAllowance.limit")(
			function* (orgId) {
				if (unmetered(orgId)) return Option.none<number>()
				// A member org's monitors count against the plan of the org that pays for it.
				const cap = yield* billingCustomers.customerFor(orgId).pipe(
					Effect.flatMap((customerId) =>
						readCustomerCached(
							edgeCache,
							customerId,
							autumn.getOrCreateCustomer(customerId, { expand: ["subscriptions.plan"] }),
						),
					),
					Effect.flatMap(({ result }) => ensureOk(result)),
					Effect.flatMap((body) => decodeUpstream(BillingCustomer, body)),
					Effect.map(uptimeMonitorLimit),
					// With a key configured, billing being down is an outage, not a free plan.
					Effect.mapError(
						(error) =>
							new UptimeMonitorPersistenceError({
								message: `Could not read the plan's uptime monitor allowance: ${error.message}`,
								cause: error,
							}),
					),
				)
				yield* Effect.annotateCurrentSpan(
					"maple.uptime.monitor_limit",
					Option.getOrElse(cap, () => -1),
				)
				return cap
			},
		)

		const track: UptimeMonitorAllowanceApi["track"] = (orgId, monitorId, delta) =>
			billingCustomers.customerFor(orgId).pipe(
				Effect.flatMap((customerId) =>
					trackFeatureUsage({
						customerId,
						featureId: UPTIME_MONITORS_FEATURE_ID,
						value: delta,
						idempotencyKey: `uptime_monitor:${monitorId}:${delta > 0 ? "created" : "deleted"}`,
					}),
				),
				// Infallible, like the meter itself: a lookup failure drops this one event.
				Effect.catchTag("@maple/http/errors/BillingAccountPersistenceError", (error) =>
					Effect.logWarning("Uptime monitor usage not tracked").pipe(
						Effect.annotateLogs({ orgId, monitorId, error: error.message }),
					),
				),
				Effect.provideService(HttpClient.HttpClient, httpClient),
			)

		return { limit, track } satisfies UptimeMonitorAllowanceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(AutumnClient.layer, FetchHttpClient.layer, BillingCustomerResolver.layer),
		),
	)

	/** No cap and no meter, for tests and harnesses. */
	static readonly unmetered = Layer.succeed(this, {
		limit: () => Effect.succeed(Option.none<number>()),
		track: () => Effect.void,
	})
}
