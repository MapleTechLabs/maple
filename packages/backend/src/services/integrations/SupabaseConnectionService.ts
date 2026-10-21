// Supabase integration: binds the one Supabase organization a grant (SupabaseOAuthService) covers,
// owns its source, discovers its projects and keeps one managed scrape target per project. Discovery
// also lists each project's log drains; an opt-in drain sends OTLP logs to the ingest gateway as its
// own logs-only `maple_src_` token source.
import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsPlanRequiredError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	SupabaseIntegrationStatus,
	type SupabaseLogDrainSummary,
	SupabaseOrganizationSummary,
	SupabaseProjectStatus,
	type SupabaseProjectUpdateRequest,
	type UserId,
} from "@maple/domain/http"
import {
	type SourceId,
	SupabaseConnectionId,
	SupabaseProjectId,
	type SupabaseProjectRef,
} from "@maple/domain/primitives"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	Sources,
	SupabaseConnections,
	SupabaseProjects,
	type SupabaseConnectionRow,
	type SupabaseProjectRow,
} from "@maple/db/tables"
import { Cause, Clock, Context, Duration, Effect, Layer, Redacted, Ref, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import {
	type SupabaseAccessTokenError,
	SupabaseOAuthService,
} from "@maple/backend/services/auth/SupabaseOAuthService"
import { toUpstreamError } from "@maple/backend/services/auth/oauth/connection-helpers"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import {
	deleteSourcesOf,
	integrationSourceName,
	type PollOutcome,
	reportPoll,
	upsertWithSource,
} from "@maple/backend/services/org/integration-sources"
import {
	createLogDrain,
	deleteLogDrain,
	listLogDrains,
	listProjects,
	logDrainDestination,
	type SupabaseApiError,
	type SupabaseLogDrain,
	type SupabaseOrganization,
	type SupabaseProject,
} from "./supabase/api"
import { deleteSupabaseScrapeTargets, reconcileSupabaseScrapeTargets } from "./supabase/scrape-targets"

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
export const UNHEALTHY_STATUSES: ReadonlySet<string> = new Set([
	"ACTIVE_UNHEALTHY",
	"INIT_FAILED",
	"RESTORE_FAILED",
	"PAUSE_FAILED",
])

const REVOKED_REASON = "Supabase no longer accepts this authorization. Reconnect Supabase."

const DRAIN_MISSING = "The log drain was removed in Supabase. Turn it off and on again to recreate it."
const DRAIN_SOURCE_DELETED =
	"The Maple source this log drain sends as was deleted. Turn it off and on again to recreate it."
const DRAIN_CONCURRENCY = 3
/**
 * Marks the drains one Maple org on one deployment creates, so a drain it lost track of is never
 * taken for a hand-made one, and another org's or deployment's drain is never taken for its own.
 */
export const mapleDrainDescription = (orgId: string, ingestHost: string | null) =>
	`OpenTelemetry logs to Maple, managed by the Maple Supabase integration (${orgId} via ${ingestHost ?? "unknown"}).`

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

/** What toggling a project can fail with; drain toggles reach Supabase and mint a token source. */
export type SupabaseProjectUpdateError =
	| IntegrationsNotFoundError
	| IntegrationsPersistenceError
	| IntegrationsPlanRequiredError
	| IntegrationsValidationError
	| SupabaseAccessTokenError

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
	/**
	 * Metrics and log drain switches; polled logs are SupabaseLogsService's. Turning a drain on
	 * turns polling off, so a project's logs arrive once.
	 */
	readonly updateProject: (
		orgId: OrgId,
		userId: UserId,
		ref: SupabaseProjectRef,
		request: SupabaseProjectUpdateRequest,
	) => Effect.Effect<SupabaseIntegrationStatus, SupabaseProjectUpdateError>
	/** Delete Maple's log drains (best effort), revoke the grant, then drop the connection, its projects and sources. */
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
		const sources = yield* SourcesService
		const env = yield* Env
		const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")
		const ingestLogsUrl = `${ingestBaseUrl}/v1/logs`
		const ingestHost = URL.canParse(ingestBaseUrl) ? new URL(ingestBaseUrl).host : null
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

		/** Converge the connection's managed scrape targets on its projects, in one transaction. */
		const reconcileTargets = Effect.fn("SupabaseConnectionService.reconcileTargets")(function* (
			connection: SupabaseConnectionRow,
			now: number,
		) {
			const summary = yield* dbExecute((db) =>
				db.transaction(reconcileSupabaseScrapeTargets(db, connection, oauth.apiBaseUrl, now)),
			)
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.targets_created": summary.created,
				"maple.supabase.targets_updated": summary.updated,
				"maple.supabase.targets_deleted": summary.deleted,
			})
			return summary
		})

		const toUpstream = (error: SupabaseApiError) => toUpstreamError(error.message, error.status)

		/** Run one Management API call with the org's token; Supabase failures become domain errors. */
		const withSupabase = <A>(
			orgId: OrgId,
			use: (accessToken: string) => Effect.Effect<A, SupabaseApiError>,
		) =>
			oauth
				.withAccessToken(orgId, use)
				.pipe(
					Effect.catchTag("@maple/supabase/SupabaseApiError", (error) =>
						Effect.fail(toUpstream(error)),
					),
				)

		const updateProjectRow = (
			projectId: SupabaseProjectId,
			set: PG.UpdateSetOf<typeof SupabaseProjects>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjects)
						.set(set)
						.where(($) => [$.id.eq(projectId)]),
				),
			)

		/** Drain token sources are `token` kind, so the integration source sweep never reaches them. */
		const deleteDrainSource = (orgId: OrgId, sourceId: SourceId) =>
			dbExecute((db) =>
				db.run(
					PG.deleteFrom(Sources).where(($) => [
						$.orgId.eq(orgId),
						$.id.eq(sourceId),
						$.kind.eq("token"),
					]),
				),
			).pipe(Effect.asVoid)

		/** Cleanup on a path that already failed or is best effort: log, never fail. */
		const bestEffort = (what: string, orgId: OrgId, ref: string) =>
			Effect.catchCause((cause: Cause.Cause<unknown>) =>
				Cause.hasInterruptsOnly(cause)
					? Effect.interrupt
					: Effect.logWarning(`supabase ${what} failed`, {
							orgId,
							ref,
							error: summarizeCause(cause),
						}),
			)

		const deleteUpstreamDrain = (orgId: OrgId, ref: SupabaseProjectRef, drainId: string) =>
			withSupabase(orgId, (accessToken) =>
				deleteLogDrain(httpClient, oauth.apiBaseUrl, accessToken, ref, drainId),
			)

		const listDrains = (orgId: OrgId, ref: SupabaseProjectRef) =>
			withSupabase(orgId, (accessToken) =>
				listLogDrains(httpClient, oauth.apiBaseUrl, accessToken, ref),
			)

		/** A listed drain without its secrets; `toMaple` compares the destination host with our ingest. */
		const isOurs = (orgId: OrgId, drain: SupabaseLogDrain) =>
			drain.attributes.description === mapleDrainDescription(orgId, ingestHost)

		const summarizeDrain = (
			orgId: OrgId,
			drain: SupabaseLogDrain,
			managedDrainId: string | null,
		): SupabaseLogDrainSummary => {
			const destination = logDrainDestination(drain)
			const backendType = drain.attributes.backend_type
			const managedByMaple = drain.id === managedDrainId || isOurs(orgId, drain)
			return {
				id: drain.id,
				name: drain.attributes.name,
				backendType,
				destination,
				toMaple:
					managedByMaple ||
					((backendType === "otlp" || backendType === "webhook") &&
						ingestHost !== null &&
						destination === ingestHost),
				managedByMaple,
			}
		}

		/** Delete the drain at Supabase (a 404 is fine), then its source, then clear the row. */
		const teardownDrain = Effect.fn("SupabaseConnectionService.teardownDrain")(function* (
			orgId: OrgId,
			project: SupabaseProjectRow,
			now: number,
			options: { readonly deleteUpstream: boolean } = { deleteUpstream: true },
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": project.projectRef })
			const drainId = project.logDrainId
			if (drainId !== null && options.deleteUpstream) {
				yield* deleteUpstreamDrain(orgId, project.projectRef, drainId)
			}
			if (project.logDrainSourceId !== null) yield* deleteDrainSource(orgId, project.logDrainSourceId)
			// Only clears the drain it tore down: a concurrent enable's new drain stays recorded.
			yield* dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjects)
						.set({
							logDrainEnabled: false,
							logDrainId: null,
							logDrainSourceId: null,
							logDrainError: null,
							logDrainsJson: project.logDrainsJson.filter((drain) => drain.id !== drainId),
							updatedAt: now,
						})
						.where(($) => [
							$.id.eq(project.id),
							drainId === null ? $.logDrainId.isNull() : $.logDrainId.eq(drainId),
						]),
				),
			)
		})

		/**
		 * Delete this org's marked drains that no row records (a timed-out create, a failed retire).
		 * The recorded id is re-read first, so a concurrent enable's drain is never deleted. Best effort.
		 */
		const deleteOrphanDrains = (project: SupabaseProjectRow, candidates: ReadonlyArray<string>) =>
			Effect.gen(function* () {
				if (candidates.length === 0) return
				const [current] = yield* dbExecute((db) =>
					db.run(
						PG.from(SupabaseProjects)
							.select("logDrainId")
							.where(($) => [$.id.eq(project.id)])
							.limit(1),
					),
				)
				const recorded = current?.logDrainId ?? null
				yield* Effect.forEach(
					candidates.filter((drainId) => drainId !== recorded),
					(drainId) => deleteUpstreamDrain(project.orgId, project.projectRef, drainId),
					{ discard: true },
				)
			}).pipe(bestEffort("orphan drain delete", project.orgId, project.projectRef))

		/**
		 * Mint the project's token source, then create the drain at Supabase. A failed drain deletes
		 * the source again; the row records both only once the drain exists. A drain to Maple set up
		 * by hand blocks this: two drains would store every log twice.
		 */
		const enableDrain = Effect.fn("SupabaseConnectionService.enableDrain")(function* (
			orgId: OrgId,
			userId: UserId,
			project: SupabaseProjectRow,
			now: number,
		) {
			const ref = project.projectRef
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": ref })
			const healthy =
				project.logDrainEnabled &&
				project.logDrainError === null &&
				project.logDrainId !== null &&
				project.logDrainSourceId !== null
			if (healthy) return
			const existing = (yield* listDrains(orgId, ref)).map((drain) =>
				summarizeDrain(orgId, drain, project.logDrainId),
			)
			const manual = existing.find((drain) => drain.toMaple && !drain.managedByMaple)
			if (manual !== undefined) {
				return yield* new IntegrationsValidationError({
					message: `This project already sends logs to Maple through the drain "${manual.name}" set up in Supabase. Keep using it, or delete it in Supabase before letting Maple manage one.`,
				})
			}
			// What is left of a drain flagged broken goes first, so a re-enable never leaves two.
			yield* teardownDrain(orgId, project, now)
			yield* deleteOrphanDrains(
				project,
				existing.filter((drain) => drain.managedByMaple).map((drain) => drain.id),
			)
			const minted = yield* sources
				.create(orgId, userId, {
					name: `Supabase logs: ${project.name}`.slice(0, 100),
					platform: "supabase",
					description: `Log drain of Supabase project ${ref}, created by the Supabase integration.`,
					allowedSignals: ["logs"],
					resourceAttributes: [
						{ key: "supabase.project.ref", value: ref, mode: "set" },
						{ key: "supabase.project.name", value: project.name, mode: "set" },
						{ key: "service.name", value: "supabase", mode: "default" },
					],
				})
				.pipe(
					Effect.catchTags({
						"@maple/http/errors/SourceValidationError": (error) =>
							Effect.fail(new IntegrationsValidationError({ message: error.message })),
						"@maple/http/errors/SourcePersistenceError": (error) =>
							Effect.fail(new IntegrationsPersistenceError({ message: error.message })),
					}),
				)
			const sourceId = minted.source.id
			const token = Redacted.make(minted.secret)
			yield* Effect.annotateCurrentSpan({ "maple.source.id": sourceId })
			const removeSource = deleteDrainSource(orgId, sourceId).pipe(
				bestEffort("drain source rollback", orgId, ref),
			)
			const drain = yield* oauth
				.withAccessToken(orgId, (accessToken) =>
					createLogDrain(httpClient, oauth.apiBaseUrl, accessToken, ref, {
						name: "Maple",
						description: mapleDrainDescription(orgId, ingestHost),
						endpoint: ingestLogsUrl,
						token,
					}),
				)
				.pipe(
					Effect.catchTags({
						"@maple/supabase/SupabasePlanRequiredError": (error) =>
							Effect.fail(new IntegrationsPlanRequiredError({ message: error.message })),
						"@maple/supabase/SupabaseApiError": (error) => Effect.fail(toUpstream(error)),
					}),
					// A timeout or 5xx may still have stored the drain; sweep it so it is not billed unrecorded.
					Effect.onError(() =>
						removeSource.pipe(
							Effect.andThen(
								listDrains(orgId, ref).pipe(
									Effect.flatMap((listed) =>
										deleteOrphanDrains(
											project,
											listed
												.filter((drain) => isOurs(orgId, drain))
												.map((drain) => drain.id),
										),
									),
									bestEffort("orphan drain sweep", orgId, ref),
								),
							),
						),
					),
				)
			yield* Effect.annotateCurrentSpan({ "maple.supabase.log_drain_id": drain.id })
			const undo = deleteUpstreamDrain(orgId, ref, drain.id).pipe(
				Effect.andThen(deleteDrainSource(orgId, sourceId)),
				bestEffort("drain rollback", orgId, ref),
			)
			// Conditional on no drain recorded, so a concurrent enable cannot leave a second one behind.
			// Polling stops in the same write: the drain now delivers this project's logs.
			const stored = yield* dbExecute((db) =>
				db.run(
					PG.update(SupabaseProjects)
						.set({
							logDrainEnabled: true,
							logDrainId: drain.id,
							logDrainSourceId: sourceId,
							logDrainError: null,
							logDrainsJson: [
								// The teardown above deleted any earlier managed drain.
								...existing.filter((item) => !item.managedByMaple && item.id !== drain.id),
								summarizeDrain(orgId, drain, drain.id),
							],
							logDrainsCheckedAt: now,
							logsEnabled: false,
							logsError: null,
							updatedAt: now,
						})
						.where(($) => [$.id.eq(project.id), $.logDrainId.isNull()])
						.returning("id"),
				),
			).pipe(Effect.onError(() => undo))
			if (stored.length === 0) yield* undo
		})

		/**
		 * List every live project's drains and store their summaries, and flag an enabled managed
		 * drain that stopped delivering (gone upstream, or its source deleted). Never recreates; that
		 * waits for the user. A failed listing keeps the previous snapshot.
		 */
		const inspectDrains = Effect.fn("SupabaseConnectionService.inspectDrains")(function* (
			connection: SupabaseConnectionRow,
			now: number,
		) {
			const orgId = connection.orgId
			const live = (yield* loadProjects(connection.id)).filter((row) => row.removedAt === null)
			const failures = yield* Ref.make(0)
			yield* Effect.forEach(
				live,
				(row) =>
					Effect.gen(function* () {
						const drains = (yield* listDrains(orgId, row.projectRef)).map((drain) =>
							summarizeDrain(orgId, drain, row.logDrainId),
						)
						const drainError = !row.logDrainEnabled
							? null
							: row.logDrainSourceId === null
								? DRAIN_SOURCE_DELETED
								: drains.some((drain) => drain.id === row.logDrainId)
									? null
									: DRAIN_MISSING
						// Skipped if an enable or disable landed since the read: its write is newer.
						yield* dbExecute((db) =>
							db.run(
								PG.update(SupabaseProjects)
									.set({
										logDrainsJson: drains,
										logDrainsCheckedAt: now,
										logDrainError: drainError,
										updatedAt: now,
									})
									.where(($) => [
										$.id.eq(row.id),
										$.logDrainEnabled.eq(row.logDrainEnabled),
										row.logDrainId === null
											? $.logDrainId.isNull()
											: $.logDrainId.eq(row.logDrainId),
									]),
							),
						)
					}).pipe(
						// Free-plan or paused projects may refuse the listing; that is not a discovery failure.
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Ref.update(failures, (n) => n + 1).pipe(
										Effect.andThen(
											Effect.logDebug("supabase log drain listing failed", {
												orgId,
												ref: row.projectRef,
												error: summarizeCause(cause),
											}),
										),
									),
						),
					),
				{ concurrency: DRAIN_CONCURRENCY, discard: true },
			)
			yield* Effect.annotateCurrentSpan({
				"maple.supabase.log_drain_projects": live.length,
				"maple.supabase.log_drain_failures": yield* Ref.get(failures),
			})
		})

		/** Best effort: delete these projects' managed drains upstream and their sources, and clear the rows. */
		const retireDrains = Effect.fn("SupabaseConnectionService.retireDrains")(function* (
			orgId: OrgId,
			projects: ReadonlyArray<SupabaseProjectRow>,
			now: number,
		) {
			const drained = projects.filter((row) => row.logDrainId !== null || row.logDrainSourceId !== null)
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.log_drains": drained.length })
			yield* Effect.forEach(
				drained,
				(row) =>
					Effect.gen(function* () {
						const drainId = row.logDrainId
						// A failed delete leaves a marked drain the next enable sweeps up.
						if (drainId !== null) {
							yield* deleteUpstreamDrain(orgId, row.projectRef, drainId).pipe(
								bestEffort("log drain delete", orgId, row.projectRef),
							)
						}
						yield* teardownDrain(orgId, row, now, { deleteUpstream: false })
					}).pipe(bestEffort("log drain retire", orgId, row.projectRef)),
				{ concurrency: DRAIN_CONCURRENCY, discard: true },
			)
		})

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
								logDrainError: row.logDrainEnabled ? row.logDrainError : null,
								logDrainSourceId: row.logDrainSourceId,
								logDrains: row.logDrainsJson,
								logDrainsCheckedAt: row.logDrainsCheckedAt,
								logsEnabled: row.logsEnabled,
								logsLastPolledAt: row.logsLastPolledAt,
								logsError: row.logsError,
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
			// A deleted project's drain went with it; its source and any upstream remnant follow.
			yield* retireDrains(connection.orgId, gone, now)
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
					yield* reconcileTargets(claimed, now)
					yield* inspectDrains(claimed, now)
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
						const connection = yield* upsertWithSource(
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
						// Drop the old organization's targets with its projects, in this transaction.
						if (organizationChanged && connection !== undefined) {
							yield* reconcileSupabaseScrapeTargets(db, connection, oauth.apiBaseUrl, now)
						}
						return connection
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
			userId: UserId,
			ref: SupabaseProjectRef,
			request: SupabaseProjectUpdateRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.supabase.project_ref": ref })
			if (request.logDrainEnabled === true && request.logsEnabled === true) {
				return yield* new IntegrationsValidationError({
					message: "A project's logs come from either a log drain or polling, not both.",
				})
			}
			const now = yield* Clock.currentTimeMillis
			const connection = yield* loadConnection(orgId)
			const project =
				connection === null
					? undefined
					: (yield* loadProjects(connection.id)).find(
							(row) => row.projectRef === ref && row.removedAt === null,
						)
			if (connection === null || project === undefined) {
				return yield* new IntegrationsNotFoundError({
					message: `No Supabase project ${ref} is connected to this organization`,
				})
			}
			// Refused before any write, so a request never half-applies on this precondition.
			if (
				request.logsEnabled === true &&
				request.logDrainEnabled !== false &&
				project.logDrainEnabled
			) {
				return yield* new IntegrationsValidationError({
					message: `Supabase project ${ref} delivers its logs through a log drain. Turn the drain off to poll instead.`,
				})
			}
			// The drain goes first: it is the write that can fail upstream.
			if (request.logDrainEnabled === true) yield* enableDrain(orgId, userId, project, now)
			if (request.logDrainEnabled === false) yield* teardownDrain(orgId, project, now)
			if (request.metricsEnabled !== undefined) {
				yield* updateProjectRow(project.id, {
					metricsEnabled: request.metricsEnabled,
					updatedAt: now,
				})
				yield* reconcileTargets(connection, now)
			}
			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("SupabaseConnectionService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const now = yield* Clock.currentTimeMillis
			// Drains go before the revoke, which ends the access token their deletes need.
			const existing = yield* loadConnection(orgId)
			if (existing !== null) yield* retireDrains(orgId, yield* loadProjects(existing.id), now)
			// Revoke next: it needs the stored refresh token.
			const grant = yield* oauth.disconnect(orgId)
			// The connection's source goes with it, and its projects through the cascade.
			const deleted = yield* dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const connections = yield* db.run(
							PG.from(SupabaseConnections)
								.select("id", "orgId")
								.where(($) => [$.orgId.eq(orgId)]),
						)
						yield* Effect.forEach(
							connections,
							(connection) => deleteSupabaseScrapeTargets(db, connection),
							{
								discard: true,
							},
						)
						// Drain sources a failed retire left behind go with their projects.
						const drainSources = yield* db.run(
							PG.deleteFrom(SupabaseProjects)
								.where(($) => [$.orgId.eq(orgId)])
								.returning("logDrainSourceId"),
						)
						const drainSourceIds = drainSources.flatMap((row) =>
							row.logDrainSourceId === null ? [] : [row.logDrainSourceId],
						)
						if (drainSourceIds.length > 0) {
							yield* db.run(
								PG.deleteFrom(Sources).where(($) => [
									$.orgId.eq(orgId),
									PG.inList($.id, drainSourceIds),
									$.kind.eq("token"),
								]),
							)
						}
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
		Layer.provide(SourcesService.layer),
	)
}
