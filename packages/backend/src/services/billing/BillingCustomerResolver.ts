import {
	BillingAccountPersistenceError,
	type BillingCustomerId,
	BillingManagedByBillingOrgError,
	OrgId,
} from "@maple/domain/http"
import { EdgeCacheService } from "@maple/cache"
import { OrgBillingLinks } from "@maple/db/tables"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Context, Effect, Layer, Option, Schema } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"

/**
 * Which Autumn customer an org bills to. A member org keeps its own data, but every Autumn call
 * it makes goes to its billing org's customer: one plan, one usage pool, one invoice. An org
 * with no `org_billing_links` row bills as itself, which is every org until one is linked.
 */
export const BILLING_ORG_CACHE_BUCKET = "billing-org"
// Short: a link written in one colo reaches the others within this window.
const BILLING_ORG_CACHE_TTL_SECONDS = 60

export const toBillingAccountPersistenceError = makePersistenceErrorMapper(
	BillingAccountPersistenceError,
	"Billing link persistence failure",
)

export interface BillingCustomerResolverApi {
	/** The org that pays for `orgId`: its billing org, else itself. */
	readonly billingOrgId: (orgId: OrgId) => Effect.Effect<OrgId, BillingAccountPersistenceError>
	/** The Autumn customer `orgId` bills to: its billing org's, else its own. */
	readonly customerFor: (orgId: OrgId) => Effect.Effect<BillingCustomerId, BillingAccountPersistenceError>
	/**
	 * The org's own customer, for billing writes. Fails for a member org, whose plan, payment
	 * details and invoices are its billing org's.
	 */
	readonly requireOwnBilling: (
		orgId: OrgId,
	) => Effect.Effect<BillingCustomerId, BillingManagedByBillingOrgError | BillingAccountPersistenceError>
	/**
	 * The org's billing org straight from Postgres, `None` when it bills as itself. For decisions
	 * made right after a link changes, which the cache may not have seen yet.
	 */
	readonly readLink: (orgId: OrgId) => Effect.Effect<Option.Option<OrgId>, BillingAccountPersistenceError>
	/** Drops the cached answer for `orgId`, after its link changed. */
	readonly forget: (orgId: OrgId) => Effect.Effect<void>
}

export class BillingCustomerResolver extends Context.Service<
	BillingCustomerResolver,
	BillingCustomerResolverApi
>()("@maple/backend/services/billing/BillingCustomerResolver", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const edgeCache = yield* EdgeCacheService
		const dbExecute = makeDbExecute(database, "BillingCustomerResolver", toBillingAccountPersistenceError)

		const readLink = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(OrgBillingLinks)
						.select(($) => ({ billingOrgId: $.billingOrgId }))
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0]?.billingOrgId ?? null))

		const billingOrgId = Effect.fn("BillingCustomerResolver.billingOrgId")(function* (orgId: OrgId) {
			const { value, hit } = yield* edgeCache.getOrCompute(
				{
					bucket: BILLING_ORG_CACHE_BUCKET,
					key: orgId,
					ttlSeconds: BILLING_ORG_CACHE_TTL_SECONDS,
					schema: Schema.NullOr(OrgId),
				},
				readLink(orgId),
			)
			yield* Effect.annotateCurrentSpan({
				orgId,
				"cache.hit": hit,
				"maple.billing.linked": value !== null,
				...(value === null ? undefined : { "maple.billing_org_id": value }),
			})
			return value ?? orgId
		})

		const requireOwnBilling = Effect.fn("BillingCustomerResolver.requireOwnBilling")(function* (
			orgId: OrgId,
		) {
			const payer = yield* billingOrgId(orgId)
			if (payer === orgId) return ownBillingCustomer(orgId)
			return yield* new BillingManagedByBillingOrgError({
				message: "This organization is billed through another organization",
				billingOrgId: payer,
			})
		})

		return {
			billingOrgId,
			customerFor: (orgId) => billingOrgId(orgId).pipe(Effect.map(ownBillingCustomer)),
			requireOwnBilling,
			readLink: (orgId) => readLink(orgId).pipe(Effect.map(Option.fromNullishOr)),
			forget: (orgId) => edgeCache.invalidate({ bucket: BILLING_ORG_CACHE_BUCKET, key: orgId }),
		} satisfies BillingCustomerResolverApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make)

	/** Every org bills as itself, for tests and harnesses without Postgres. */
	static readonly standalone = Layer.succeed(this, {
		billingOrgId: (orgId) => Effect.succeed(orgId),
		customerFor: (orgId) => Effect.succeed(ownBillingCustomer(orgId)),
		requireOwnBilling: (orgId) => Effect.succeed(ownBillingCustomer(orgId)),
		readLink: () => Effect.succeed(Option.none()),
		forget: () => Effect.void,
	})
}
