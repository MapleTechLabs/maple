import {
	BILLING_SUB_ORGS_FEATURE_ID,
	customerHasFlag,
	UPTIME_MONITORS_FEATURE_ID,
} from "@maple/domain/billing"
import {
	type AutumnFailure,
	BillingAccount,
	BillingAccountOrg,
	BillingAccountPersistenceError,
	BillingCustomer,
	BillingForbiddenError,
	type BillingLinkRejection,
	BillingLinkRejectedError,
	type OrgId,
	type RoleName,
	type UserId,
} from "@maple/domain/http"
import { EdgeCacheService } from "@maple/cache"
import { OrgBillingLinks, type OrgBillingLinkRow, UptimeMonitors } from "@maple/db/tables"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import { Clock, Context, Effect, Layer, Option } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database, type DatabaseClient } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { isAdmin } from "@maple/backend/services/auth/auth"
import { OrgMembershipService } from "@maple/backend/services/auth/OrgMembershipService"
import {
	CUSTOMER_CACHE_BUCKET,
	classifyAutumn,
	decodeUpstream,
	ensureOk,
} from "@maple/backend/services/billing/autumn-client"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { trackFeatureUsage } from "@maple/backend/services/billing/autumn-tracker"
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"
import {
	BillingCustomerResolver,
	toBillingAccountPersistenceError,
} from "@maple/backend/services/billing/BillingCustomerResolver"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"

const LINK_REJECTION_MESSAGES = {
	same_org: "An organization cannot be billed through itself.",
	already_linked: "This organization is already billed through another organization. Unlink it first.",
	billing_org_is_member:
		"That organization is itself billed through another organization. Pick the organization that pays.",
	org_is_billing_org:
		"Other organizations are billed through this one. Unlink them before billing it through another organization.",
	not_admin_of_billing_org: "You need to be an admin of the organization that will pay.",
	region_mismatch: "Both organizations need to be in the same data region.",
	not_enabled:
		"That organization's plan does not include billing for other organizations. Contact us to turn it on.",
	not_a_member: "That organization is not billed through this one.",
} satisfies Record<BillingLinkRejection, string>

const reject = (reason: BillingLinkRejection) =>
	Effect.fail(new BillingLinkRejectedError({ reason, message: LINK_REJECTION_MESSAGES[reason] }))

export interface LinkBillingOrgInput {
	/** The org being linked; the caller's active org. */
	readonly orgId: OrgId
	readonly userId: UserId
	readonly roles: ReadonlyArray<RoleName>
	readonly billingOrgId: OrgId
}

export interface UnlinkBillingOrgInput {
	/** The caller's active org: the member leaving, or the billing org removing it. */
	readonly orgId: OrgId
	readonly roles: ReadonlyArray<RoleName>
	readonly memberOrgId: OrgId
}

export interface BillingOrgServiceApi {
	/** The orgs billed through `billingOrgId`, oldest link first. */
	readonly members: (
		billingOrgId: OrgId,
	) => Effect.Effect<ReadonlyArray<OrgBillingLinkRow>, BillingAccountPersistenceError>
	readonly account: (orgId: OrgId) => Effect.Effect<BillingAccount, BillingAccountPersistenceError>
	readonly link: (
		input: LinkBillingOrgInput,
	) => Effect.Effect<
		BillingAccount,
		BillingForbiddenError | BillingLinkRejectedError | BillingAccountPersistenceError | AutumnFailure
	>
	readonly unlink: (
		input: UnlinkBillingOrgInput,
	) => Effect.Effect<
		BillingAccount,
		BillingForbiddenError | BillingLinkRejectedError | BillingAccountPersistenceError
	>
}

export class BillingOrgService extends Context.Service<BillingOrgService, BillingOrgServiceApi>()(
	"@maple/backend/services/billing/BillingOrgService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const edgeCache = yield* EdgeCacheService
			const autumn = yield* AutumnClient
			const memberships = yield* OrgMembershipService
			const regions = yield* OrganizationRegionService
			const organizations = yield* OrganizationService
			const httpClient = yield* HttpClient.HttpClient
			const resolver = yield* BillingCustomerResolver
			const dbExecute = makeDbExecute(database, "BillingOrgService", toBillingAccountPersistenceError)

			const linkQuery = (orgId: OrgId) =>
				PG.from(OrgBillingLinks)
					.select()
					.where(($) => [$.orgId.eq(orgId)])
					.limit(1)
			const membersQuery = (billingOrgId: OrgId) =>
				PG.from(OrgBillingLinks)
					.select()
					.where(($) => [$.billingOrgId.eq(billingOrgId)])
					.orderBy(["createdAt", "asc"])

			const linkOf = (orgId: OrgId) =>
				dbExecute((db) => db.run(linkQuery(orgId))).pipe(
					Effect.map((rows) => Option.fromUndefinedOr(rows[0])),
				)

			const members = Effect.fn("BillingOrgService.members")(function* (billingOrgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ "maple.billing_org_id": billingOrgId })
				const rows = yield* dbExecute((db) => db.run(membersQuery(billingOrgId)))
				yield* Effect.annotateCurrentSpan({ "maple.billing.member_count": rows.length })
				return rows
			})

			// A name is display-only: an unreachable directory shows the org without one.
			const describeOrg = (orgId: OrgId, linkedAt?: number) =>
				organizations.retrieve(orgId).pipe(
					Effect.map((org) => ({ name: org.name, imageUrl: org.imageUrl })),
					Effect.orElseSucceed(() => ({ name: null, imageUrl: null })),
					Effect.map(
						(info) =>
							new BillingAccountOrg({
								orgId,
								...info,
								...(linkedAt === undefined ? undefined : { linkedAt }),
							}),
					),
				)

			const account = Effect.fn("BillingOrgService.account")(function* (orgId: OrgId) {
				const link = yield* linkOf(orgId)
				if (Option.isSome(link)) {
					return new BillingAccount({
						orgId,
						role: "member",
						billingOrg: yield* describeOrg(link.value.billingOrgId),
						members: [],
					})
				}
				const rows = yield* members(orgId)
				const [self, memberOrgs] = yield* Effect.all(
					[
						describeOrg(orgId),
						Effect.forEach(rows, (row) => describeOrg(row.orgId, row.createdAt), {
							concurrency: 5,
						}),
					],
					{ concurrency: "unbounded" },
				)
				return new BillingAccount({
					orgId,
					role: rows.length > 0 ? "billing_org" : "standalone",
					billingOrg: self,
					members: memberOrgs,
				})
			})

			const forgetOrg = (orgId: OrgId) =>
				Effect.all(
					[
						resolver.forget(orgId),
						// The org's own customer read is stale either way: it now reads another
						// org's customer, or its own again.
						edgeCache.invalidate({ bucket: CUSTOMER_CACHE_BUCKET, key: orgId }),
					],
					{ discard: true },
				)

			/**
			 * The structural rules, checked before the plan flag and again under the lock. Answers the
			 * existing link when it is already this one, so a retry finishes what the first try began.
			 */
			const checkLinkable = (db: DatabaseClient, orgId: OrgId, payer: OrgId) =>
				Effect.gen(function* () {
					const [ownLink] = yield* db.run(linkQuery(orgId))
					if (ownLink !== undefined) {
						return ownLink.billingOrgId === payer ? ownLink : yield* reject("already_linked")
					}
					const [payerLink] = yield* db.run(linkQuery(payer))
					if (payerLink !== undefined) return yield* reject("billing_org_is_member")
					const [ownMember] = yield* db.run(membersQuery(orgId).limit(1))
					if (ownMember !== undefined) return yield* reject("org_is_billing_org")
					return null
				})

			/**
			 * The org's own subscriptions stop at the end of the period it already paid for. Usage
			 * from before the link stays on that final invoice; usage after it is the billing org's.
			 */
			const cancelOwnSubscriptions = Effect.fn("BillingOrgService.cancelOwnSubscriptions")(function* (
				orgId: OrgId,
			) {
				const customer = yield* autumn
					.getOrCreateCustomer(ownBillingCustomer(orgId), { expand: [] })
					.pipe(
						Effect.flatMap(ensureOk),
						Effect.flatMap((response) => decodeUpstream(BillingCustomer, response)),
					)
				const running = customer.subscriptions.filter(
					// An auto-enabled free plan is Autumn's default, not something the org bought.
					(sub) =>
						(sub.status === "active" || sub.status === "trialing") &&
						sub.canceledAt == null &&
						sub.autoEnable !== true,
				)
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.billing.cancelled_plans": running.map((sub) => sub.planId).join(","),
				})
				yield* Effect.forEach(
					running,
					(sub) =>
						autumn
							.cancelAtPeriodEnd(ownBillingCustomer(orgId), { planId: sub.planId })
							.pipe(Effect.flatMap(classifyAutumn)),
					{ discard: true },
				)
			})

			/**
			 * `uptime_monitors` is continuous use: monitors that exist count against whoever pays now.
			 * Their count moves with the org, keyed by the link so a retry moves them once.
			 */
			const moveUptimeMonitors = Effect.fn("BillingOrgService.moveUptimeMonitors")(function* (
				orgId: OrgId,
				move: { readonly from: OrgId; readonly to: OrgId; readonly key: string },
			) {
				const count = yield* dbExecute((db) =>
					db.run(
						PG.from(UptimeMonitors)
							.select(() => ({ count: PG.count() }))
							.where(($) => [$.orgId.eq(orgId)]),
					),
				).pipe(Effect.map((rows) => Number(rows[0]?.count ?? 0)))
				yield* Effect.annotateCurrentSpan({ orgId, "maple.uptime.monitor_count": count })
				if (count === 0) return
				yield* Effect.all(
					[
						trackFeatureUsage({
							customerId: ownBillingCustomer(move.from),
							featureId: UPTIME_MONITORS_FEATURE_ID,
							value: -count,
							idempotencyKey: `${move.key}:uptime_monitors:out`,
						}),
						trackFeatureUsage({
							customerId: ownBillingCustomer(move.to),
							featureId: UPTIME_MONITORS_FEATURE_ID,
							value: count,
							idempotencyKey: `${move.key}:uptime_monitors:in`,
						}),
					],
					{ concurrency: "unbounded", discard: true },
				).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
			})

			const link = Effect.fn("BillingOrgService.link")(function* (input: LinkBillingOrgInput) {
				const { orgId, billingOrgId: payer } = input
				yield* Effect.annotateCurrentSpan({ orgId, "maple.billing_org_id": payer })
				if (!isAdmin(input.roles)) {
					return yield* new BillingForbiddenError({
						message: "Only org admins can change who pays for the organization",
					})
				}
				if (orgId === payer) return yield* reject("same_org")

				// The caller speaks for both sides: admin here (above) and admin of the org that pays.
				const membership = yield* memberships.verify(input.userId, payer).pipe(
					Effect.mapError(
						(error) =>
							new BillingAccountPersistenceError({
								message: `Membership check failed: ${error.message}`,
							}),
					),
				)
				if (Option.isNone(membership) || !isAdmin([membership.value.role])) {
					return yield* reject("not_admin_of_billing_org")
				}
				// Usage meters and Postgres rows live per region; a link cannot span two.
				if ((yield* regions.servedHere(payer)) !== "here") return yield* reject("region_mismatch")

				const existing = yield* dbExecute((db) => checkLinkable(db, orgId, payer))
				if (existing === null) {
					const payerCustomer = yield* autumn
						.getOrCreateCustomer(ownBillingCustomer(payer), { expand: [] })
						.pipe(Effect.flatMap(ensureOk))
					if (!customerHasFlag(payerCustomer, BILLING_SUB_ORGS_FEATURE_ID)) {
						return yield* reject("not_enabled")
					}
				}

				const now = yield* Clock.currentTimeMillis
				const row = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// One lock for every link write keeps the one-level rule true under races.
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext('org_billing_links'))`,
							)
							const current = yield* checkLinkable(db, orgId, payer)
							if (current !== null) return current
							const [inserted] = yield* db.run(
								PG.insertInto(OrgBillingLinks)
									.values({
										orgId,
										billingOrgId: payer,
										linkedBy: input.userId,
										createdAt: now,
									})
									.returning(),
							)
							return inserted ?? null
						}),
					),
				)
				if (row === null) {
					return yield* new BillingAccountPersistenceError({
						message: "Billing link was not written",
					})
				}
				yield* forgetOrg(orgId)

				// After the link commits, so a refused link never cancels anything. Both steps are safe
				// to repeat: a retry of the same link lands here again and finishes them. A link this
				// call wrote is taken back when the cancel fails, so the org is never billed twice.
				yield* cancelOwnSubscriptions(orgId).pipe(
					Effect.tapError(() =>
						row.createdAt === now
							? dbExecute((db) =>
									db.run(
										PG.deleteFrom(OrgBillingLinks).where(($) => [
											$.orgId.eq(orgId),
											$.createdAt.eq(now),
										]),
									),
								).pipe(
									Effect.andThen(forgetOrg(orgId)),
									Effect.catch((error) =>
										Effect.logError("Could not take back a half-made billing link").pipe(
											Effect.annotateLogs({
												orgId,
												billingOrgId: payer,
												error: error.message,
											}),
										),
									),
								)
							: Effect.void,
					),
				)
				yield* moveUptimeMonitors(orgId, {
					from: orgId,
					to: payer,
					key: `billing_link:${orgId}:${row.createdAt}`,
				})
				yield* Effect.logInfo("Org billing linked").pipe(
					Effect.annotateLogs({ orgId, billingOrgId: payer, userId: input.userId }),
				)
				return yield* account(orgId)
			})

			const unlink = Effect.fn("BillingOrgService.unlink")(function* (input: UnlinkBillingOrgInput) {
				const { orgId, memberOrgId } = input
				yield* Effect.annotateCurrentSpan({ orgId, "maple.billing.member_org_id": memberOrgId })
				if (!isAdmin(input.roles)) {
					return yield* new BillingForbiddenError({
						message: "Only org admins can change who pays for the organization",
					})
				}
				const row = yield* linkOf(memberOrgId)
				// The member may leave, and the billing org may let it go; nobody else may touch it.
				if (Option.isNone(row) || (orgId !== memberOrgId && orgId !== row.value.billingOrgId)) {
					return yield* reject("not_a_member")
				}
				yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// The same lock as link writes and the uptime pool count.
							yield* db.execute(
								Orm.sql`select pg_advisory_xact_lock(hashtext('org_billing_links'))`,
							)
							yield* db.run(
								PG.deleteFrom(OrgBillingLinks).where(($) => [$.orgId.eq(memberOrgId)]),
							)
						}),
					),
				)
				// Only once the link is gone, so the payer is never short monitors it still pays for.
				// Keyed by the link: a repeat of this unlink moves the count once.
				yield* moveUptimeMonitors(memberOrgId, {
					from: row.value.billingOrgId,
					to: memberOrgId,
					key: `billing_unlink:${memberOrgId}:${row.value.createdAt}`,
				})
				yield* forgetOrg(memberOrgId)
				yield* Effect.logInfo("Org billing unlinked").pipe(
					Effect.annotateLogs({
						orgId: memberOrgId,
						billingOrgId: row.value.billingOrgId,
						by: orgId,
					}),
				)
				return yield* account(orgId)
			})

			return {
				members,
				account,
				link,
				unlink,
			} satisfies BillingOrgServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				AutumnClient.layer,
				OrgMembershipService.layer,
				OrganizationRegionService.layer,
				OrganizationService.layer,
				BillingCustomerResolver.layer,
				FetchHttpClient.layer,
			),
		),
	)
}
