// Supabase integration: binds the one Supabase organization a grant (SupabaseOAuthService) covers,
// owns its source, and discovers its projects on demand and hourly from the alerting cron.
import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	type OrgId,
	SupabaseIntegrationStatus,
	SupabaseOrganizationSummary,
	SupabaseProjectStatus,
	type SupabaseProjectUpdateRequest,
	type UserId,
} from "@maple/domain/http"
import { SupabaseConnectionId, SupabaseProjectId, type SupabaseProjectRef } from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import { SupabaseConnections, SupabaseProjects, type SupabaseConnectionRow } from "@maple/db/tables"
import { Cause, Clock, Context, Duration, Effect, Layer, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import {
	deleteSourcesOf,
	integrationSourceName,
	type PollOutcome,
	reportPoll,
	upsertWithSource,
} from "@maple/backend/services/org/integration-sources"
import { listProjects, type SupabaseOrganization, type SupabaseProject } from "./supabase/api"

/** A discovery holds its lease this long; a crashed run frees the org after it. */
const LEASE_MS = 5 * 60_000
/** The cron skips connections discovered more recently than this (it fires hourly). */
const DISCOVERY_INTERVAL_MS = 50 * 60_000
const DISCOVERY_TIMEOUT = Duration.seconds(60)
/** Sync runs discovery inline; what does not finish is left to the cron. */
const DISCOVER_NOW_TIMEOUT = Duration.seconds(20)
/** Floor for a 429 hold, so a missing reset header still backs off. */
const RATE_LIMIT_HOLD_MS = 60_000
/** Bounds the hourly lane: no org starts after this. */
const TICK_BUDGET_MS = 10 * 60_000
const ORG_CONCURRENCY = 3

/** Statuses Supabase reports for a project that needs attention. */
const UNHEALTHY_STATUSES: ReadonlySet<string> = new Set([
	"ACTIVE_UNHEALTHY",
	"INIT_FAILED",
	"RESTORE_FAILED",
	"PAUSE_FAILED",
])

const REVOKED_REASON = "Supabase no longer accepts this authorization. Reconnect Supabase."

const decodeConnectionId = Schema.decodeUnknownSync(SupabaseConnectionId)
const decodeProjectId = Schema.decodeUnknownSync(SupabaseProjectId)

const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Supabase database error")

export interface SupabaseDiscoverySummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly projects: number
	readonly removed: number
	readonly error: string | null
}

export interface SupabaseDiscoverAllSummary {
	readonly orgs: number
	readonly discovered: number
	readonly skipped: number
	readonly failures: number
}

/** Whether a listed project belongs to the granted organization (`organization_id`, slug as fallback). */
const belongsToOrganization = (
	project: SupabaseProject,
	connection: Pick<SupabaseConnectionRow, "supabaseOrganizationId" | "supabaseOrganizationSlug">,
) =>
	project.organization_id === connection.supabaseOrganizationId ||
	(project.organization_slug !== undefined &&
		project.organization_slug === connection.supabaseOrganizationSlug)

export interface SupabaseConnectionServiceApi {
	readonly getStatus: (
		orgId: OrgId,
	) => Effect.Effect<SupabaseIntegrationStatus, IntegrationsPersistenceError>
	/**
	 * Bind a freshly exchanged grant's organization. Called by the callback, which must stay fast:
	 * the first discovery runs from `sync` (the dashboard, after the popup reports) or the hourly cron.
	 */
	readonly finalizeConnect: (
		orgId: OrgId,
		userId: UserId,
		organization: SupabaseOrganization,
	) => Effect.Effect<SupabaseIntegrationStatus, IntegrationsPersistenceError>
	/** Discovers now instead of waiting for the hourly cron. */
	readonly sync: (
		orgId: OrgId,
	) => Effect.Effect<
		SupabaseIntegrationStatus,
		IntegrationsNotConnectedError | IntegrationsPersistenceError
	>
	readonly updateProject: (
		orgId: OrgId,
		ref: SupabaseProjectRef,
		request: SupabaseProjectUpdateRequest,
	) => Effect.Effect<SupabaseIntegrationStatus, IntegrationsNotFoundError | IntegrationsPersistenceError>
	/** Revoke the grant, then drop the connection, its projects and its source. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<{ readonly disconnected: boolean }, IntegrationsPersistenceError>
	readonly discoverOrg: (
		orgId: OrgId,
	) => Effect.Effect<SupabaseDiscoverySummary, IntegrationsPersistenceError>
	readonly discoverAllOrgs: () => Effect.Effect<SupabaseDiscoverAllSummary, IntegrationsPersistenceError>
}

export class SupabaseConnectionService extends Context.Service<
	SupabaseConnectionService,
	SupabaseConnectionServiceApi
>()("@maple/api/services/SupabaseConnectionService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const oauth = yield* SupabaseOAuthService
		const httpClient = yield* HttpClient.HttpClient
		const dbExecute = makeDbExecute(database, "SupabaseConnectionService", toPersistenceError)

		const loadConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(SupabaseConnections)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const loadProjects = (connectionId: SupabaseConnectionId) =>
			dbExecute((db) =>
				db.run(
					PG.from(SupabaseProjects)
						.select()
						.where(($) => [$.connectionId.eq(connectionId)]),
				),
			)

		const updateConnection = (
			connectionId: SupabaseConnectionId,
			set: PG.UpdateSetOf<typeof SupabaseConnections>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseConnections)
						.set(set)
						.where(($) => [$.id.eq(connectionId)]),
				),
			)

		/** Best effort: a failed health report must not fail the discovery it describes. */
		const reportTick = (connection: SupabaseConnectionRow, outcome: PollOutcome, now: number) =>
			dbExecute((db) => reportPoll(db, connection.sourceId, outcome, now)).pipe(
				Effect.catchTag("@maple/http/errors/IntegrationsPersistenceError", (error) =>
					Effect.logWarning("supabase source health report failed").pipe(
						Effect.annotateLogs({ sourceId: connection.sourceId, error: error.message }),
					),
				),
			)

		const getStatus = Effect.fn("SupabaseConnectionService.getStatus")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* loadConnection(orgId)
			const grantUsable = yield* oauth.isGrantUsable(orgId)
			if (connection === null) {
				return new SupabaseIntegrationStatus({
					configured: oauth.isConfigured,
					connected: false,
					organization: null,
					connectedByUserId: null,
					connectedAt: null,
					revoked: false,
					lastDiscoveryAt: null,
					lastDiscoveryError: null,
					projects: [],
				})
			}
			const projects = yield* loadProjects(connection.id)
			return new SupabaseIntegrationStatus({
				configured: oauth.isConfigured,
				connected: true,
				organization: new SupabaseOrganizationSummary({
					id: connection.supabaseOrganizationId,
					slug: connection.supabaseOrganizationSlug,
					name: connection.supabaseOrganizationName,
				}),
				connectedByUserId: connection.connectedByUserId,
				connectedAt: connection.createdAt,
				// A connection whose grant row vanished cannot discover either.
				revoked: !grantUsable,
				lastDiscoveryAt: connection.lastDiscoveryAt,
				lastDiscoveryError: connection.lastDiscoveryError,
				projects: projects
					.filter((row) => row.removedAt === null)
					.sort((a, b) => a.name.localeCompare(b.name) || a.projectRef.localeCompare(b.projectRef))
					.map(
						(row) =>
							new SupabaseProjectStatus({
								ref: row.projectRef,
								name: row.name,
								region: row.region,
								status: row.status,
								metricsEnabled: row.metricsEnabled,
								logDrainEnabled: row.logDrainEnabled,
								lastSeenAt: row.lastSeenAt,
							}),
					),
			})
		})

		/**
		 * Upsert the organization's listed projects; stamp `removedAt` on the ones that disappeared.
		 * An incomplete listing (`skipped > 0`) cannot prove absence, so it removes nothing.
		 */
		const reconcileProjects = Effect.fn("SupabaseConnectionService.reconcileProjects")(function* (
			connection: SupabaseConnectionRow,
			listed: ReadonlyArray<SupabaseProject>,
			skipped: number,
			now: number,
		) {
			const projects = listed.filter((project) => belongsToOrganization(project, connection))
			const existing = yield* loadProjects(connection.id)
			yield* Effect.forEach(
				projects,
				(project) =>
					dbExecute((db) =>
						db.run(
							PG.insertInto(SupabaseProjects)
								.values({
									id: decodeProjectId(randomUUID()),
									orgId: connection.orgId,
									connectionId: connection.id,
									projectRef: project.ref,
									name: project.name,
									region: project.region,
									status: project.status,
									lastSeenAt: now,
									createdAt: now,
									updatedAt: now,
								})
								.onConflictDoUpdate({
									target: ["connectionId", "projectRef"],
									set: () => ({
										name: project.name,
										region: project.region,
										status: project.status,
										lastSeenAt: now,
										removedAt: null,
										updatedAt: now,
									}),
								}),
						),
					),
				{ discard: true },
			)
			const seen = new Set<string>(projects.map((project) => project.ref))
			const complete = skipped === 0
			const gone = complete
				? existing.filter((row) => row.removedAt === null && !seen.has(row.projectRef))
				: []
			if (!complete) {
				yield* Effect.logWarning("supabase project listing incomplete; skipping removals", {
					orgId: connection.orgId,
					skipped,
				})
			}
			yield* Effect.forEach(
				gone,
				(row) =>
					dbExecute((db) =>
						db.run(
							PG.update(SupabaseProjects)
								.set({ removedAt: now, updatedAt: now })
								.where(($) => [$.id.eq(row.id)]),
						),
					),
				{ discard: true },
			)
			const unhealthy = projects.filter((project) => UNHEALTHY_STATUSES.has(project.status)).length
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.projects": projects.length,
				"maple.supabase.projects_removed": gone.length,
				"maple.supabase.projects_other_org": listed.length - projects.length,
				"maple.supabase.projects_undecodable": skipped,
				"maple.supabase.removal_skipped": !complete,
			})
			return { projects: projects.length, removed: gone.length, unhealthy }
		})

		const claimLease = (connectionId: SupabaseConnectionId, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseConnections)
						.set({ discoveryLeaseUntil: now + LEASE_MS, updatedAt: now })
						.where(($) => [
							$.id.eq(connectionId),
							PG.or(
								$.discoveryLeaseUntil.isNull(),
								$.discoveryLeaseUntil.lt(now),
								// A bogus far-future lease (clock jump, crashed writer) must not wedge the org.
								$.discoveryLeaseUntil.gt(now + 2 * 60 * 60_000),
							),
						])
						.returning(),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** Compare-and-set on our own claim so a late run never clears a successor's lease. */
		const releaseLease = (connection: SupabaseConnectionRow, holdUntil: number | null) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseConnections)
						.set({ discoveryLeaseUntil: holdUntil })
						.where(($) => [
							$.id.eq(connection.id),
							connection.discoveryLeaseUntil === null
								? $.discoveryLeaseUntil.isNull()
								: $.discoveryLeaseUntil.eq(connection.discoveryLeaseUntil),
						]),
				),
			)

		const discoverOrg = Effect.fn("SupabaseConnectionService.discoverOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const skip = (reason: string): SupabaseDiscoverySummary => ({
				orgId,
				skipped: reason,
				projects: 0,
				removed: 0,
				error: null,
			})
			const connection = yield* loadConnection(orgId)
			if (connection === null) return skip("not connected")
			const now = yield* Clock.currentTimeMillis
			if (!(yield* oauth.isGrantUsable(orgId))) {
				yield* reportTick(connection, { _tag: "Disconnected", reason: REVOKED_REASON }, now)
				return skip("grant revoked")
			}
			const claimed = yield* claimLease(connection.id, now)
			if (claimed === null) return skip("lease held")

			const holdUntilRef = yield* Ref.make<number | null>(null)
			return yield* Effect.gen(function* () {
				const listed = yield* Effect.result(
					oauth
						.withAccessToken(orgId, (accessToken) =>
							listProjects(httpClient, oauth.apiBaseUrl, accessToken),
						)
						.pipe(
							Effect.timeoutOrElse({
								duration: DISCOVERY_TIMEOUT,
								orElse: () =>
									Effect.fail(
										new IntegrationsUpstreamError({
											message: "Supabase project discovery timed out",
										}),
									),
							}),
						),
				)
				if (listed._tag === "Success") {
					const result = yield* reconcileProjects(
						claimed,
						listed.success.projects,
						listed.success.skipped,
						now,
					)
					yield* updateConnection(claimed.id, {
						lastDiscoveryAt: now,
						lastDiscoveryError: null,
						updatedAt: now,
					})
					yield* reportTick(
						claimed,
						{ _tag: "Ok", resources: { total: result.projects, unhealthy: result.unhealthy } },
						now,
					)
					return {
						orgId,
						skipped: null,
						projects: result.projects,
						removed: result.removed,
						error: null,
					} satisfies SupabaseDiscoverySummary
				}
				const failure = listed.failure
				const revoked = failure._tag === "@maple/http/errors/IntegrationsRevokedError"
				if (failure._tag === "@maple/supabase/SupabaseApiError" && failure.kind === "rate_limited") {
					const retryMs = (failure.retryAfterSeconds ?? 0) * 1000
					yield* Ref.set(holdUntilRef, now + Math.max(retryMs, RATE_LIMIT_HOLD_MS))
				}
				const error = (revoked ? REVOKED_REASON : failure.message).slice(0, 500)
				yield* Effect.logWarning("supabase discovery failed", { orgId, tag: failure._tag, error })
				yield* updateConnection(claimed.id, { lastDiscoveryError: error, updatedAt: now })
				yield* reportTick(
					claimed,
					revoked ? { _tag: "Disconnected", reason: REVOKED_REASON } : { _tag: "Failed", error },
					now,
				)
				return {
					orgId,
					skipped: null,
					projects: 0,
					removed: 0,
					error,
				} satisfies SupabaseDiscoverySummary
			}).pipe(
				Effect.ensuring(
					Ref.get(holdUntilRef).pipe(
						Effect.flatMap((holdUntil) => releaseLease(claimed, holdUntil)),
						Effect.ignore,
					),
				),
			)
		})

		/** Best effort: a failed or slow discovery still leaves the connection for the cron. */
		const discoverNow = (orgId: OrgId) =>
			discoverOrg(orgId).pipe(
				Effect.timeoutOption(DISCOVER_NOW_TIMEOUT),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("supabase on-demand discovery failed", {
								orgId,
								error: summarizeCause(cause),
							}),
				),
				Effect.asVoid,
			)

		const finalizeConnect = Effect.fn("SupabaseConnectionService.finalizeConnect")(function* (
			orgId: OrgId,
			userId: UserId,
			organization: SupabaseOrganization,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.organization": organization.slug })
			const now = yield* Clock.currentTimeMillis
			const binding = {
				supabaseOrganizationId: organization.id,
				supabaseOrganizationSlug: organization.slug,
				supabaseOrganizationName: organization.name,
				connectedByUserId: userId,
			}
			// A reconnect keeps the connection id and so its source and project toggles.
			const connection = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const [existing] = yield* db.run(
							PG.from(SupabaseConnections)
								.select("id", "sourceId", "supabaseOrganizationId")
								.where(($) => [$.orgId.eq(orgId)])
								.limit(1)
								// Held until the upsert, so a concurrent disconnect cannot delete the reused source.
								.forUpdate(),
						)
						const organizationChanged =
							existing !== undefined && existing.supabaseOrganizationId !== organization.id
						// The old organization's projects are no longer granted.
						if (organizationChanged) {
							yield* db.run(
								PG.update(SupabaseProjects)
									.set({ removedAt: now, updatedAt: now })
									.where(($) => [$.connectionId.eq(existing.id), $.removedAt.isNull()]),
							)
						}
						const rebind = { ...binding, lastDiscoveryError: null, updatedAt: now }
						return yield* upsertWithSource(
							db,
							orgId,
							{ platform: "supabase", name: integrationSourceName.supabase(organization) },
							now,
							Effect.succeed(existing?.sourceId ?? null),
							(sourceId) =>
								db
									.run(
										PG.insertInto(SupabaseConnections)
											.values({
												id: decodeConnectionId(randomUUID()),
												orgId,
												sourceId,
												...binding,
												createdAt: now,
												updatedAt: now,
											})
											.onConflictDoUpdate({
												target: ["orgId"],
												// A new organization is due for the next cron tick's discovery.
												set: () =>
													organizationChanged
														? { ...rebind, lastDiscoveryAt: null }
														: rebind,
											})
											.returning(),
									)
									.pipe(Effect.map(([row]) => row)),
						)
					}),
				),
			)
			if (connection === undefined) {
				return yield* new IntegrationsPersistenceError({
					message: "Failed to save the Supabase connection",
				})
			}
			return yield* getStatus(orgId)
		})

		const sync = Effect.fn("SupabaseConnectionService.sync")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			if ((yield* loadConnection(orgId)) === null) {
				return yield* new IntegrationsNotConnectedError({
					message: "Supabase is not connected for this organization",
				})
			}
			yield* discoverNow(orgId)
			return yield* getStatus(orgId)
		})

		const updateProject = Effect.fn("SupabaseConnectionService.updateProject")(function* (
			orgId: OrgId,
			ref: SupabaseProjectRef,
			request: SupabaseProjectUpdateRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": ref })
			const now = yield* Clock.currentTimeMillis
			const changes: PG.UpdateSetOf<typeof SupabaseProjects> =
				request.metricsEnabled === undefined ? {} : { metricsEnabled: request.metricsEnabled }
			const updated = yield* dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjects)
						.set({ ...changes, updatedAt: now })
						.where(($) => [$.orgId.eq(orgId), $.projectRef.eq(ref), $.removedAt.isNull()])
						.returning("id"),
				),
			)
			if (updated.length === 0) {
				return yield* new IntegrationsNotFoundError({
					message: `No Supabase project ${ref} is connected to this organization`,
				})
			}
			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("SupabaseConnectionService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			// Revoke first: it needs the stored refresh token.
			const grant = yield* oauth.disconnect(orgId)
			// The connection's source goes with it, and its projects through the cascade.
			const deleted = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						yield* db.run(PG.deleteFrom(SupabaseProjects).where(($) => [$.orgId.eq(orgId)]))
						const rows = yield* db.run(
							PG.deleteFrom(SupabaseConnections)
								.where(($) => [$.orgId.eq(orgId)])
								.returning("id", "sourceId"),
						)
						yield* deleteSourcesOf(db, orgId, rows)
						return rows
					}),
				),
			)
			return { disconnected: deleted.length > 0 || grant.disconnected }
		})

		const discoverAllOrgs = Effect.fn("SupabaseConnectionService.discoverAllOrgs")(function* () {
			const started = yield* Clock.currentTimeMillis
			const due = yield* dbExecute((db) =>
				db.run(
					PG.from(SupabaseConnections)
						.select("orgId")
						.where(($) => [
							PG.or(
								$.lastDiscoveryAt.isNull(),
								$.lastDiscoveryAt.lt(started - DISCOVERY_INTERVAL_MS),
							),
						]),
				),
			)
			const summaries = yield* Effect.forEach(
				due,
				(row) =>
					Effect.gen(function* () {
						const orgId = row.orgId
						if ((yield* Clock.currentTimeMillis) - started >= TICK_BUDGET_MS) {
							return { orgId, skipped: "tick budget", projects: 0, removed: 0, error: null }
						}
						return yield* discoverOrg(orgId)
					}).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("supabase org discovery failed", {
										orgId: row.orgId,
										error: summarizeCause(cause),
									}).pipe(
										Effect.as<SupabaseDiscoverySummary>({
											orgId: row.orgId,
											skipped: null,
											projects: 0,
											removed: 0,
											error: "org discovery failed",
										}),
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)
			const summary = {
				orgs: due.length,
				discovered: summaries.filter((item) => item.skipped === null && item.error === null).length,
				skipped: summaries.filter((item) => item.skipped !== null).length,
				failures: summaries.filter((item) => item.error !== null).length,
			} satisfies SupabaseDiscoverAllSummary
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.orgs": summary.orgs,
				"maple.supabase.discovered": summary.discovered,
				"maple.supabase.failures": summary.failures,
			})
			return summary
		})

		return {
			getStatus,
			finalizeConnect,
			sync,
			updateProject,
			disconnect,
			discoverOrg,
			discoverAllOrgs,
		} satisfies SupabaseConnectionServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(SupabaseOAuthService.layer),
	)
}
