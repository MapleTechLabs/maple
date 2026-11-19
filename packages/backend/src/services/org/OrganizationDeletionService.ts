import type * as Policy from "@maple/domain/policy"
import * as Clerk from "@distilled.cloud/clerk"
import { FetchHttpClient, HttpClient } from "effect/http"
import { UPTIME_MONITORS_FEATURE_ID } from "@maple/domain/billing"
import { trackFeatureUsage } from "@maple/backend/services/billing/autumn-tracker"
import { ownBillingCustomer } from "@maple/backend/services/billing/billing-customer"
import { queueOrgPageRemovals } from "@maple/backend/services/status-pages/outbox"
import {
	DeleteOrganizationResponse,
	OrganizationForbiddenError,
	OrganizationPersistenceError,
	OrganizationProviderError,
	type OrgId,
} from "@maple/domain/http"
import * as Orm from "@maple-dev/effect-orm/database"
import * as PG from "@maple-dev/effect-orm/postgres"
import * as Tables from "@maple/db/tables"
import { Array as Arr, Clock, Context, Effect, Layer, Option } from "effect"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { IntegrationOffboardingService } from "@maple/backend/services/integrations/IntegrationOffboardingService"
import { OrganizationRegionService } from "@maple/backend/services/org/OrganizationRegionService"
import {
	ORG_DELETE_REGISTRY,
	requireOrganizationAdmin,
} from "@maple/backend/services/org/OrganizationService"
import { EnterpriseSsoService } from "@maple/backend/services/org/enterprise-sso/EnterpriseSsoService"
import {
	namesConversations,
	purgeConversationRows,
	queueOrgErasures,
} from "@maple/backend/services/org/org-erasure"
import { clerkModeApi } from "@maple/auth"

const toPersistenceError = (error: unknown) =>
	new OrganizationPersistenceError({
		message: error instanceof Error ? error.message : "Organization persistence failed",
	})

type PurgedTable = (typeof ORG_DELETE_REGISTRY.orgScoped)[number]

export interface OrganizationDeletionServiceApi {
	readonly delete: (
		orgId: OrgId,
		permissions: Policy.Grants,
	) => Effect.Effect<
		DeleteOrganizationResponse,
		OrganizationForbiddenError | OrganizationPersistenceError | OrganizationProviderError
	>
}

/**
 * Deleting an organization: its grants at each vendor, its rows, then the Clerk organization.
 * What it holds outside Postgres is queued for erasure (`org-erasure.ts`) and erased later.
 * Apart from `OrganizationService` because other Workers build that one for its reads, and
 * only the api holds the integrations' credentials this needs.
 */
export class OrganizationDeletionService extends Context.Service<
	OrganizationDeletionService,
	OrganizationDeletionServiceApi
>()("@maple/backend/services/OrganizationDeletionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const dbExecute = makeDbExecute(database, "OrganizationDeletionService", toPersistenceError)
		const env = yield* Env
		const regions = yield* OrganizationRegionService
		const sso = yield* EnterpriseSsoService
		const offboarding = yield* IntegrationOffboardingService
		const httpClient = yield* HttpClient.HttpClient

		const purgeOrgScopedRows = Effect.fn("OrganizationDeletionService.purgeOrgScopedRows")(function* (
			orgId: OrgId,
		) {
			// Public pages live on at the edge until the publisher drains these.
			yield* dbExecute((db) => queueOrgPageRemovals(db, orgId))
			// What the org holds outside Postgres is erased later by a cron, so a slow store never
			// holds up the delete. Conversations are queued as the rows naming them are deleted.
			const now = yield* Clock.currentTimeMillis
			yield* dbExecute((db) => queueOrgErasures(db, orgId, now))
			const purge = (column: "org_id" | "approved_org_id", tables: ReadonlyArray<PurgedTable>) =>
				Effect.forEach(
					tables,
					(table) =>
						dbExecute((db) =>
							column === "org_id" && namesConversations(table)
								? Effect.asVoid(purgeConversationRows(db, table, orgId, now))
								: Effect.asVoid(
										db.run(
											PG.deleteFrom(table).where(() => [
												PG.dynamicColumn(column).eq(orgId),
											]),
										),
									),
						),
					{ discard: true },
				)
			yield* purge("org_id", ORG_DELETE_REGISTRY.orgScoped)
			yield* purge("approved_org_id", ORG_DELETE_REGISTRY.approvedOrgScoped)
		})

		const deleteClerkOrganization = Effect.fn("OrganizationDeletionService.deleteClerkOrganization")(
			function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan("orgId", orgId)
				// Not in Clerk auth mode: there is no directory to delete from.
				const clerk = Option.fromUndefinedOr(clerkModeApi(env))
				if (Option.isNone(clerk)) return

				yield* clerk.value
					.run(Clerk.deleteOrganization({ organization_id: orgId }))
					.pipe(
						Effect.mapError((error) => new OrganizationProviderError({ message: error.message })),
					)
			},
		)

		const deleteOrganization = Effect.fn("OrganizationDeletionService.delete")(function* (
			orgId: OrgId,
			permissions: Policy.Grants,
		) {
			yield* Effect.annotateCurrentSpan("orgId", orgId)
			yield* requireOrganizationAdmin(permissions)
			// Under the link lock, like every link write and monitor create or delete: the member
			// check, the monitor count and the link's removal see one state. Once the link is gone,
			// monitors made before the purge bill to the org itself.
			const { link, monitorCount } = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.execute(
							Orm.sql`select pg_advisory_xact_lock(hashtext('org_billing_links'))`,
						)
						// Its members would be left billed to a customer nobody can reach.
						const members = yield* db.run(
							PG.from(Tables.OrgBillingLinks)
								.select(($) => ({ orgId: $.orgId }))
								.where(($) => [$.billingOrgId.eq(orgId)])
								.limit(1),
						)
						if (members.length > 0) {
							return yield* new OrganizationForbiddenError({
								message:
									"Other organizations are billed through this one. Unlink them in billing settings before deleting it.",
							})
						}
						// A member's monitors count against its billing org; purging them must give the count back.
						const [current] = yield* db.run(
							PG.from(Tables.OrgBillingLinks)
								.select(($) => ({ billingOrgId: $.billingOrgId }))
								.where(($) => [$.orgId.eq(orgId)])
								.limit(1),
						)
						if (current === undefined) return { link: current, monitorCount: 0 }
						const [counted] = yield* db.run(
							PG.from(Tables.UptimeMonitors)
								.select(() => ({ count: PG.count() }))
								.where(($) => [$.orgId.eq(orgId)]),
						)
						yield* db.run(PG.deleteFrom(Tables.OrgBillingLinks).where(($) => [$.orgId.eq(orgId)]))
						return { link: current, monitorCount: Number(counted?.count ?? 0) }
					}),
				),
			)
			// Before the purge: a failed purge retried finds no link and could not give the count back.
			if (link !== undefined && monitorCount > 0) {
				yield* trackFeatureUsage({
					customerId: ownBillingCustomer(link.billingOrgId),
					featureId: UPTIME_MONITORS_FEATURE_ID,
					value: -monitorCount,
					idempotencyKey: `org_delete:${orgId}:uptime_monitors`,
				}).pipe(Effect.provideService(HttpClient.HttpClient, httpClient))
			}
			// Before the purge, which drops the ids: a connection left in Clerk would keep claiming the
			// org's domains. A failure stops here, with the rows intact for a retry.
			yield* sso.removeForDeletedOrganization(orgId).pipe(
				Effect.mapError(
					(error) =>
						new OrganizationProviderError({
							message: `Could not remove the organization's single sign-on: ${error.message}`,
						}),
				),
			)
			// Before the purge, which drops the tokens and ids each vendor is asked with. Best effort:
			// a vendor that is down keeps its grant, and never keeps the organization.
			const teardowns = yield* offboarding.teardown(orgId)
			const incompleteTeardowns = Arr.map(
				Arr.filter(teardowns, (teardown) => teardown.outcome !== "ok"),
				(teardown) => teardown.provider,
			)
			yield* purgeOrgScopedRows(orgId)
			yield* deleteClerkOrganization(orgId)
			// A cached "served here" would outlive the organization by up to an hour.
			yield* regions.forget(orgId)
			return new DeleteOrganizationResponse({
				deleted: true,
				...(incompleteTeardowns.length === 0 ? undefined : { incompleteTeardowns }),
			})
		})

		return { delete: deleteOrganization } satisfies OrganizationDeletionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(IntegrationOffboardingService.layer),
		Layer.provide(EnterpriseSsoService.layer),
		Layer.provide(OrganizationRegionService.layer),
		Layer.provide(FetchHttpClient.layer),
	)
}
