/**
 * The org's PlanetScale organization as a cost source. The integration already holds the
 * organization and its OAuth grant, so the `cost_sources` row is all there is to add or remove.
 * The connection is never changed here.
 */
import {
	CloudCostDisabledError,
	IntegrationsConnectionChangedError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	type OrgId,
	PlanetScaleCostReconnectRequiredError,
	type PlanetScaleCostStatus,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, PlanetscaleConnections } from "@maple/db/tables"
import { CostSourceId } from "@maple/primitives"
import { Clock, Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { removePlanetScaleCostSources } from "./planetscale-cost-sources"
import {
	planetScaleCanReadInvoices,
	PlanetScaleCostProvider,
	type PlanetScaleCostReadError,
	RECONNECT_FOR_INVOICES,
} from "./providers/planetscale/PlanetScaleCostProvider"

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"PlanetScale cost source database error",
)

const CONNECTION_CHANGED = "The PlanetScale connection changed while the source was added. Try again."

/**
 * Why the check read was refused, as what the Cost page shows. A grant only a reconnect fixes
 * keeps its reason and its own code, so the page can link to the connection. An outage answers a
 * fixed sentence.
 */
const toAddError = (
	error: PlanetScaleCostReadError,
): PlanetScaleCostReconnectRequiredError | IntegrationsConnectionChangedError | IntegrationsUpstreamError => {
	switch (error.kind) {
		case "reconnect":
			return new PlanetScaleCostReconnectRequiredError({ message: error.message })
		// Disconnected between the service's read of the connection and the adapter's.
		case "no_connection":
			return new IntegrationsConnectionChangedError({ message: CONNECTION_CHANGED })
		case "other":
			return new IntegrationsUpstreamError({ message: error.message })
	}
}

/** `PlanetScaleCostStatus` as plain data. */
export type PlanetScaleCostStatusInfo = typeof PlanetScaleCostStatus.Encoded

export interface PlanetScaleCostSourceServiceApi {
	readonly status: (
		orgId: OrgId,
	) => Effect.Effect<PlanetScaleCostStatusInfo, IntegrationsPersistenceError | CloudCostDisabledError>
	/**
	 * Makes the connected organization a cost source, once PlanetScale has let the grant list its
	 * invoices. `organization` is the one the caller was shown: another one bound since is refused.
	 * `created` is false when it was a source already.
	 */
	readonly add: (
		orgId: OrgId,
		organization: string,
	) => Effect.Effect<
		{ readonly organization: string; readonly created: boolean },
		| CloudCostDisabledError
		| IntegrationsNotConnectedError
		| IntegrationsConnectionChangedError
		| PlanetScaleCostReconnectRequiredError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly remove: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly removed: boolean }, IntegrationsPersistenceError>
}

export class PlanetScaleCostSourceService extends Context.Service<
	PlanetScaleCostSourceService,
	PlanetScaleCostSourceServiceApi
>()("@maple/backend/services/cost/PlanetScaleCostSourceService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const featureFlags = yield* OrganizationFeatureFlagsService
		const psOAuth = yield* PlanetScaleOAuthService
		const provider = yield* PlanetScaleCostProvider
		const dbExecute = makeDbExecute(database, "PlanetScaleCostSourceService", toPersistenceError)

		const requireRollout = (orgId: OrgId) =>
			Effect.gen(function* () {
				const flags = yield* featureFlags.flags(orgId)
				if (!flags.cloudCost) {
					return yield* new CloudCostDisabledError({
						message: "Cloud cost is not enabled for this organization.",
					})
				}
			})

		/** The org's connection and whether it is a cost source, read together. */
		const load = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(PlanetscaleConnections, "c")
						.leftJoin(CostSources, "s", (connection, source) =>
							source.orgId
								.eq(connection.orgId)
								.and(source.provider.eq("planetscale"))
								.and(source.connectionRef.eq(connection.id)),
						)
						.select(($) => ({
							id: $.id,
							organization: $.psOrganization,
							sourceId: $.s.id,
						}))
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** Whether the stored grant can read invoices, as far as it says itself: no request is made. */
		const invoiceAccess = (orgId: OrgId) =>
			Effect.map(
				psOAuth.grantStatus(orgId),
				(grant) =>
					grant.updatedAt !== null &&
					grant.revokedAt === null &&
					planetScaleCanReadInvoices(grant.scopes),
			)

		const status = Effect.fn("PlanetScaleCostSourceService.status")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* requireRollout(orgId)
			const connection = yield* load(orgId)
			if (connection === null) return { organization: null, invoiceAccess: false, added: false }
			return {
				organization: connection.organization,
				invoiceAccess: yield* invoiceAccess(orgId),
				added: connection.sourceId !== null,
			}
		})

		const add = Effect.fn("PlanetScaleCostSourceService.add")(function* (
			orgId: OrgId,
			organization: string,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* requireRollout(orgId)
			const connection = yield* load(orgId)
			if (connection === null) {
				return yield* new IntegrationsNotConnectedError({
					message: "Connect PlanetScale first, then add its organization as a cost source.",
				})
			}
			// The caller saw another organization: this one's invoices are not what they chose to add.
			if (connection.organization !== organization) {
				return yield* new IntegrationsConnectionChangedError({
					message: `The PlanetScale connection now reads another organization (${connection.organization}). Check the organization shown, then add it again.`,
				})
			}
			if (connection.sourceId !== null) return { organization, created: false }
			if (!(yield* invoiceAccess(orgId))) {
				return yield* new PlanetScaleCostReconnectRequiredError({ message: RECONNECT_FOR_INVOICES })
			}
			// One page of the invoice list, read with the grant: a refusal is said now, not by a
			// source that fails its first sync.
			yield* provider.check({ orgId, connectionRef: connection.id }).pipe(Effect.mapError(toAddError))
			const now = yield* Clock.currentTimeMillis
			const added = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// The share lock makes a disconnect or a bind to another organization wait for the insert.
						const [current] = yield* db.run(
							PG.from(PlanetscaleConnections)
								.select("id")
								.where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(connection.id),
									$.psOrganization.eq(organization),
								])
								.limit(1)
								.forShare(),
						)
						if (current === undefined) return null
						const inserted = yield* db.run(
							PG.insertInto(CostSources)
								.values({
									id: CostSourceId.make(randomUUID()),
									orgId,
									provider: "planetscale",
									connectionRef: connection.id,
									accountId: organization,
									createdAt: now,
									updatedAt: now,
								})
								// Another request added it first.
								.onConflictDoNothing()
								.returning(($) => ({ id: $.id })),
						)
						return inserted.length > 0
					}),
				),
			)
			if (added === null) {
				return yield* new IntegrationsConnectionChangedError({ message: CONNECTION_CHANGED })
			}
			return { organization, created: added }
		})

		const remove = Effect.fn("PlanetScaleCostSourceService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const removed = yield* dbExecute((db) => removePlanetScaleCostSources(db, orgId))
			return { removed: removed > 0 }
		})

		return { status, add, remove } satisfies PlanetScaleCostSourceServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				PlanetScaleCostProvider.layer,
				PlanetScaleOAuthService.layer,
				OrganizationFeatureFlagsService.layer,
			),
		),
	)
}
