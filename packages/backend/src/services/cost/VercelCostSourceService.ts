/**
 * The org's Vercel team as a cost source. The integration already holds the team and its token,
 * so the `cost_sources` row is all there is to add or remove. The connection is never changed here.
 */
import {
	CloudCostDisabledError,
	IntegrationsConnectionChangedError,
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	type VercelCostStatus,
	type VercelCostTeam,
} from "@maple/domain/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { CostSources, VercelConnections } from "@maple/db/tables"
import { CostSourceId } from "@maple/primitives"
import { Clock, Context, Effect, Layer } from "effect"
import { randomUUID } from "node:crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { CostProviderError } from "./CostProvider"
import {
	VERCEL_NO_CONNECTION,
	VERCEL_TOKEN_REJECTED,
	VercelCostProvider,
} from "./providers/vercel/VercelCostProvider"
import { addDays, utcToday } from "./sync-plan"
import { removeVercelCostSources } from "./vercel-cost-sources"

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Vercel cost source database error",
)

const CONNECTION_CHANGED = "The Vercel connection changed while the source was added. Try again."

/**
 * Why the check read was refused, as what the Cost page shows. A token or a role Vercel refuses is
 * the org's to fix and keeps its reason. Anything else (an outage, a secret key Maple cannot use)
 * is not, and answers the upstream error's fixed sentence.
 */
const toAddError = (
	error: CostProviderError,
): IntegrationsValidationError | IntegrationsConnectionChangedError | IntegrationsUpstreamError => {
	if (error.reason === "not_ready" || error.message === VERCEL_TOKEN_REJECTED) {
		return new IntegrationsValidationError({ message: error.message })
	}
	// Disconnected between the service's read of the connection and the adapter's.
	return error.message === VERCEL_NO_CONNECTION
		? new IntegrationsConnectionChangedError({ message: CONNECTION_CHANGED })
		: new IntegrationsUpstreamError({ message: error.message })
}

/** `VercelCostStatus` as plain data. */
export type VercelCostStatusInfo = typeof VercelCostStatus.Encoded

export interface VercelCostSourceServiceApi {
	readonly status: (
		orgId: OrgId,
	) => Effect.Effect<VercelCostStatusInfo, IntegrationsPersistenceError | CloudCostDisabledError>
	/**
	 * Makes the connected team a cost source, once Vercel has let its token read the billing.
	 * `created` is false when it was one already.
	 */
	readonly add: (
		orgId: OrgId,
	) => Effect.Effect<
		{ readonly team: VercelCostTeam; readonly created: boolean },
		| CloudCostDisabledError
		| IntegrationsNotConnectedError
		| IntegrationsConnectionChangedError
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly remove: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly removed: boolean }, IntegrationsPersistenceError>
}

export class VercelCostSourceService extends Context.Service<
	VercelCostSourceService,
	VercelCostSourceServiceApi
>()("@maple/backend/services/cost/VercelCostSourceService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const featureFlags = yield* OrganizationFeatureFlagsService
		const provider = yield* VercelCostProvider
		const dbExecute = makeDbExecute(database, "VercelCostSourceService", toPersistenceError)

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
					PG.from(VercelConnections, "c")
						.leftJoin(CostSources, "s", (connection, source) =>
							source.orgId
								.eq(connection.orgId)
								.and(source.provider.eq("vercel"))
								.and(source.connectionRef.eq(connection.id)),
						)
						.select(($) => ({
							id: $.id,
							teamId: $.teamId,
							teamSlug: $.teamSlug,
							teamName: $.teamName,
							authFailedAt: $.authFailedAt,
							sourceId: $.s.id,
						}))
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const status = Effect.fn("VercelCostSourceService.status")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* requireRollout(orgId)
			const connection = yield* load(orgId)
			return connection === null
				? { team: null, authFailed: false, added: false }
				: {
						team: { name: connection.teamName, slug: connection.teamSlug },
						authFailed: connection.authFailedAt !== null,
						added: connection.sourceId !== null,
					}
		})

		const add = Effect.fn("VercelCostSourceService.add")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* requireRollout(orgId)
			const connection = yield* load(orgId)
			if (connection === null) {
				return yield* new IntegrationsNotConnectedError({
					message: "Connect a Vercel team first, then add it as a cost source.",
				})
			}
			const team = { name: connection.teamName, slug: connection.teamSlug }
			if (connection.sourceId !== null) return { team, created: false }
			// Yesterday and today, read with the stored token: a token or role Vercel refuses is said
			// now, not by a source that fails its first sync. Through today, as every head pull asks.
			const now = yield* Clock.currentTimeMillis
			const today = utcToday(now)
			yield* provider
				.pull(
					{ orgId, connectionRef: connection.id },
					{ startDay: addDays(today, -1), endDay: today },
				)
				.pipe(Effect.mapError(toAddError))
			const added = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// The share lock makes a disconnect or a move to another team wait for the insert.
						const [current] = yield* db.run(
							PG.from(VercelConnections)
								.select("id")
								.where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(connection.id),
									$.teamId.eq(connection.teamId),
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
									provider: "vercel",
									connectionRef: connection.id,
									accountId: connection.teamSlug,
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
			return { team, created: added }
		})

		const remove = Effect.fn("VercelCostSourceService.remove")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const removed = yield* dbExecute((db) => removeVercelCostSources(db, orgId))
			return { removed: removed > 0 }
		})

		return { status, add, remove } satisfies VercelCostSourceServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(Layer.mergeAll(VercelCostProvider.layer, OrganizationFeatureFlagsService.layer)),
	)
}
