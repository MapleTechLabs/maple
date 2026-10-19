/**
 * Vercel integration: an org saves a Vercel access token for one team, and Maple creates a log
 * drain and a trace drain on that team pointing at the ingest gateway (Bearer org ingest key).
 * The alerting cron keeps the team's project and deployment inventory, checks the drains still
 * exist, and re-keys them when the org's ingest key changes. Telemetry itself flows through the
 * drains; nothing here reads logs or traces.
 */
import { randomUUID } from "node:crypto"
import {
	IntegrationsNotConnectedError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
	type OrgId,
	UserId,
	VercelDeploymentSummary,
	VercelDiscoverResponse,
	VercelDrainStatus,
	VercelIntegrationStatus,
	VercelProjectStatus,
	VercelTeam,
	type VercelConnectRequest,
	type VercelDrainState,
	type VercelProjectScope,
	type VercelSettingsRequest,
} from "@maple/domain/http"
import { hashIngestKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import * as PG from "@maple-dev/effect-orm/postgres"
import {
	VercelConnections,
	VercelDeployments,
	VercelProjects,
	type VercelConnectionRow,
	type VercelDeploymentRow,
} from "@maple/db/tables"
import { Cause, Clock, Context, Duration, Effect, Layer, Option, Redacted, Ref, Result, Schema } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { summarizeCause } from "@maple/backend/platform/describe-cause"
import { Env } from "@maple/backend/platform/Env"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import {
	createDrain,
	deleteDrain,
	getDrain,
	listDeployments,
	listProjects,
	listTeams,
	updateDrain,
	VercelApiError,
	type VercelDeploymentInfo,
	type VercelDrainBody,
	type VercelDrainInfo,
	type VercelProjectListing,
	type VercelTeamInfo,
} from "./vercel/api"

const DISCOVERY_TTL_MS = 60 * 60_000
const LEASE_MS = 4 * 60_000
/** One org's pass must end inside its lease; what is left resumes next tick. */
const POLL_BUDGET = Duration.seconds(150)
const RATE_LIMIT_HOLD_MS = 15 * 60_000
/** Deployment state changes after creation, so each read re-covers the last hour. */
const DEPLOYMENT_LOOKBACK_MS = 60 * 60_000
const INITIAL_DEPLOYMENTS_MS = 7 * 24 * 60 * 60_000
const DEPLOYMENT_PAGES_PER_TICK = 5
const DEPLOYMENTS_KEPT_PER_PROJECT = 50
const ORG_CONCURRENCY = 3
/** Connect and sync run one poll inline; what does not finish is left to the cron. */
const SYNC_NOW_TIMEOUT = Duration.seconds(20)

const decodeUserId = Schema.decodeUnknownSync(UserId)
const SYSTEM_USER_ID = decodeUserId("system-vercel-integration")

const toPersistenceError = makePersistenceErrorMapper(IntegrationsPersistenceError, "Vercel database error")

/** Binds each ciphertext to its org so a row copied across orgs fails to decrypt. */
const tokenAad = (orgId: OrgId) => Buffer.from(`vercel-token:${orgId}`)

type DrainKind = "logs" | "traces"

/** What the drains forward: the part of the connection a drain body is built from. */
export interface VercelForwarding {
	readonly projectScope: VercelProjectScope
	readonly projectIds: ReadonlyArray<string>
	readonly samplingRate: number
	readonly logsEnabled: boolean
	readonly tracesEnabled: boolean
}

interface DrainSet {
	readonly logDrainId: string | null
	readonly traceDrainId: string | null
	readonly logDrainState: VercelDrainState | null
	readonly traceDrainState: VercelDrainState | null
}

interface DrainOutcome {
	readonly id: string | null
	readonly state: VercelDrainState | null
	/** Created in this call, so a failed connect deletes it again. */
	readonly created: boolean
}

const drainState = (drain: VercelDrainInfo): VercelDrainState => {
	const status =
		drain.status === "enabled" || drain.status === "disabled" || drain.status === "errored"
			? drain.status
			: "unknown"
	return { status, lastError: status === "enabled" ? null : drain.disabledReason }
}

const isNotFound = (error: VercelApiError) => error.kind === "not_found"
/** Failures that end the pass instead of being recorded on one drain. */
const isFatal = (error: VercelApiError) => error.kind === "unauthorized" || error.kind === "rate_limited"
/** A token that cannot list its own team's projects or deployments has lost access. */
const isTokenRejection = (error: VercelApiError) =>
	error.kind === "unauthorized" || error.kind === "forbidden"

const tokenRejected = () =>
	new IntegrationsValidationError({
		message:
			"Vercel rejected this token. Create one at vercel.com/account/settings/tokens with access to the team.",
	})

const toListError = (error: VercelApiError) =>
	isTokenRejection(error)
		? tokenRejected()
		: new IntegrationsUpstreamError({
				message: error.message,
				...(error.status === undefined ? undefined : { status: error.status }),
			})

const toDrainError = (error: VercelApiError) =>
	error.kind === "unauthorized"
		? tokenRejected()
		: error.kind === "forbidden"
			? new IntegrationsValidationError({
					message: `Vercel refused the drain (drains need a Pro or Enterprise team). ${error.message}`,
				})
			: error.status !== undefined && error.status >= 400 && error.status < 500 && error.status !== 429
				? new IntegrationsValidationError({ message: `Vercel refused the drain. ${error.message}` })
				: new IntegrationsUpstreamError({
						message: error.message,
						...(error.status === undefined ? undefined : { status: error.status }),
					})

const validateForwarding = (forwarding: VercelForwarding) =>
	forwarding.projectScope === "some" && forwarding.projectIds.length === 0
		? Effect.fail(
				new IntegrationsValidationError({ message: "Pick at least one Vercel project to forward." }),
			)
		: Effect.void

const toSummary = (row: VercelDeploymentRow) =>
	new VercelDeploymentSummary({
		id: row.deploymentId,
		url: row.url,
		target: row.target,
		state: row.state,
		branch: row.branch,
		commitSha: row.commitSha,
		commitMessage: row.commitMessage,
		creator: row.creator,
		createdAt: row.createdAtVercel,
		readyAt: row.readyAt,
		inspectorUrl: row.inspectorUrl,
	})

export interface VercelPollOrgSummary {
	readonly orgId: OrgId
	readonly skipped: string | null
	readonly deploymentsUpserted: number
	readonly drainsRepaired: number
	readonly failures: number
}

export interface VercelPollAllOrgsSummary {
	readonly orgs: number
	readonly deploymentsUpserted: number
	readonly drainsRepaired: number
	readonly failures: number
	readonly skipped: number
}

export interface VercelIntegrationServiceApi {
	readonly getStatus: (orgId: OrgId) => Effect.Effect<VercelIntegrationStatus, IntegrationsPersistenceError>
	/** The teams a token sees, and the projects of `teamId` (or of the only team). Stores nothing. */
	readonly discover: (
		token: string,
		teamId: string | undefined,
	) => Effect.Effect<VercelDiscoverResponse, IntegrationsValidationError | IntegrationsUpstreamError>
	readonly connect: (
		orgId: OrgId,
		userId: UserId,
		request: VercelConnectRequest,
	) => Effect.Effect<
		VercelIntegrationStatus,
		IntegrationsValidationError | IntegrationsUpstreamError | IntegrationsPersistenceError
	>
	/** Saves what the drains forward and re-applies them on Vercel. */
	readonly updateSettings: (
		orgId: OrgId,
		request: VercelSettingsRequest,
	) => Effect.Effect<
		VercelIntegrationStatus,
		| IntegrationsNotConnectedError
		| IntegrationsValidationError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	readonly sync: (orgId: OrgId) => Effect.Effect<VercelIntegrationStatus, IntegrationsPersistenceError>
	/** Deletes the drains on Vercel (best effort), then every row. */
	readonly disconnect: (
		orgId: OrgId,
	) => Effect.Effect<
		{ readonly disconnected: boolean; readonly drainsRemoved: boolean },
		IntegrationsPersistenceError
	>
	readonly deployments: (
		orgId: OrgId,
		projectId: string,
		limit: number,
	) => Effect.Effect<ReadonlyArray<VercelDeploymentSummary>, IntegrationsPersistenceError>
	readonly pollOrg: (orgId: OrgId) => Effect.Effect<VercelPollOrgSummary, IntegrationsPersistenceError>
	readonly pollAllOrgs: () => Effect.Effect<VercelPollAllOrgsSummary, IntegrationsPersistenceError>
}

export class VercelIntegrationService extends Context.Service<
	VercelIntegrationService,
	VercelIntegrationServiceApi
>()("@maple/api/services/VercelIntegrationService", {
	make: Effect.gen(function* () {
		const database = yield* Database
		const env = yield* Env
		const httpClient = yield* HttpClient.HttpClient
		const ingestKeys = yield* OrgIngestKeysService
		const toConfigError = (message: string) => new IntegrationsPersistenceError({ message })
		const encryptionKey = yield* parseBase64Aes256GcmKey(
			Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
			toConfigError,
		)
		const lookupHmacKey = yield* parseIngestKeyLookupHmacKey(
			Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
			toConfigError,
		)
		const ingestUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")
		const dbExecute = makeDbExecute(database, "VercelIntegrationService", toPersistenceError)

		const loadConnection = (orgId: OrgId) =>
			dbExecute((db) =>
				db.run(
					PG.from(VercelConnections)
						.select()
						.where(($) => [$.orgId.eq(orgId)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		const updateConnection = (connectionId: string, set: PG.UpdateSetOf<typeof VercelConnections>) =>
			dbExecute((db) =>
				db.run(
					PG.update(VercelConnections)
						.set(set)
						.where(($) => [$.id.eq(connectionId)]),
				),
			)

		const decryptToken = (connection: VercelConnectionRow) =>
			decryptAes256Gcm(
				{ ciphertext: connection.tokenCiphertext, iv: connection.tokenIv, tag: connection.tokenTag },
				encryptionKey,
				() => new IntegrationsPersistenceError({ message: "Failed to decrypt the Vercel token" }),
				tokenAad(connection.orgId),
			)

		/** The org's private ingest key for the drains' Authorization header, and its lookup hash. */
		const drainKey = (orgId: OrgId, userId: UserId) =>
			ingestKeys.getOrCreate(orgId, userId).pipe(
				Effect.map((keys) => ({
					key: keys.privateKey,
					hash: hashIngestKey(keys.privateKey, lookupHmacKey),
				})),
				Effect.mapError(
					(error) =>
						new IntegrationsPersistenceError({
							message: `Ingest key unavailable: ${error.message}`,
						}),
				),
			)

		const drainBody = (
			kind: DrainKind,
			forwarding: VercelForwarding,
			ingestKey: string,
			update: boolean,
		): VercelDrainBody => {
			const headers = { authorization: `Bearer ${ingestKey}` }
			const sampling =
				forwarding.samplingRate < 1
					? [{ type: "head_sampling" as const, rate: forwarding.samplingRate }]
					: // An update must clear a rate set earlier; a create leaves it out.
						update
						? []
						: undefined
			return {
				name: kind === "logs" ? "Maple logs" : "Maple traces",
				projects: forwarding.projectScope,
				...(forwarding.projectScope === "some" ? { projectIds: forwarding.projectIds } : undefined),
				schemas: kind === "logs" ? { log: { version: "v1" } } : { trace: { version: "v1" } },
				delivery:
					kind === "logs"
						? {
								type: "http",
								endpoint: `${ingestUrl}/v1/logpush/vercel`,
								encoding: "ndjson",
								compression: "none",
								headers,
							}
						: {
								type: "otlphttp",
								endpoint: { traces: `${ingestUrl}/v1/traces` },
								encoding: "proto",
								headers,
							},
				...(sampling === undefined ? undefined : { sampling }),
				// Re-applying the settings also turns a disabled drain back on.
				...(update ? { status: "enabled" as const } : undefined),
			}
		}

		/**
		 * Brings one drain in line with the settings. `apply` writes it (connect, settings, re-key);
		 * `check` reads it and recreates it when Vercel no longer has it.
		 */
		const reconcileDrain = Effect.fn("VercelIntegrationService.reconcileDrain")(function* (
			kind: DrainKind,
			teamId: string,
			token: string,
			forwarding: VercelForwarding,
			drainId: string | null,
			ingestKey: string,
			mode: "apply" | "check",
		) {
			yield* Effect.annotateCurrentSpan({
				"maple.vercel.drain_kind": kind,
				"maple.vercel.drain_mode": mode,
			})
			const enabled = kind === "logs" ? forwarding.logsEnabled : forwarding.tracesEnabled
			if (!enabled) {
				if (drainId !== null) yield* deleteDrain(httpClient, token, teamId, drainId)
				return { id: null, state: null, created: false } satisfies DrainOutcome
			}
			const create = createDrain(
				httpClient,
				token,
				teamId,
				drainBody(kind, forwarding, ingestKey, false),
			).pipe(
				Effect.map((drain): DrainOutcome => ({
					id: drain.id,
					state: drainState(drain),
					created: true,
				})),
			)
			if (drainId === null) return yield* create
			if (mode === "apply") {
				return yield* updateDrain(
					httpClient,
					token,
					teamId,
					drainId,
					drainBody(kind, forwarding, ingestKey, true),
				).pipe(
					Effect.map((drain): DrainOutcome => ({
						id: drainId,
						state: drainState(drain),
						created: false,
					})),
					Effect.catchIf(isNotFound, () => create),
				)
			}
			const found = yield* getDrain(httpClient, token, teamId, drainId).pipe(
				Effect.map(Option.some),
				Effect.catchIf(isNotFound, () => Effect.succeed(Option.none<VercelDrainInfo>())),
			)
			if (Option.isSome(found)) {
				return { id: drainId, state: drainState(found.value), created: false } satisfies DrainOutcome
			}
			yield* Effect.annotateCurrentSpan("maple.vercel.drain_missing", true)
			return yield* create.pipe(
				Effect.catchIf(
					(error) => !isFatal(error),
					(error) =>
						Effect.succeed<DrainOutcome>({
							id: null,
							state: { status: "missing", lastError: error.message },
							created: false,
						}),
				),
			)
		})

		/** Writes both drains, failing fast; a drain this call created is deleted again on failure. */
		const applyDrains = Effect.fn("VercelIntegrationService.applyDrains")(function* (
			teamId: string,
			token: string,
			forwarding: VercelForwarding,
			current: { readonly logDrainId: string | null; readonly traceDrainId: string | null },
			ingestKey: string,
		) {
			const logs = yield* reconcileDrain(
				"logs",
				teamId,
				token,
				forwarding,
				current.logDrainId,
				ingestKey,
				"apply",
			)
			const traces = yield* reconcileDrain(
				"traces",
				teamId,
				token,
				forwarding,
				current.traceDrainId,
				ingestKey,
				"apply",
			).pipe(
				Effect.tapError(() =>
					logs.created && logs.id !== null
						? deleteDrain(httpClient, token, teamId, logs.id).pipe(Effect.ignore)
						: Effect.void,
				),
			)
			return {
				logDrainId: logs.id,
				traceDrainId: traces.id,
				logDrainState: logs.state,
				traceDrainState: traces.state,
			} satisfies DrainSet
		})

		/**
		 * Upserts the discovered projects. Deletes the ones (and their deployments) that are gone,
		 * but only from a complete listing: a capped one never saw the projects past the cap.
		 */
		const reconcileProjects = Effect.fn("VercelIntegrationService.reconcileProjects")(function* (
			connection: Pick<VercelConnectionRow, "id" | "orgId">,
			{ projects, complete }: VercelProjectListing,
			now: number,
		) {
			yield* Effect.annotateCurrentSpan("maple.vercel.projects", projects.length)
			if (projects.length > 0) {
				yield* dbExecute((db) =>
					db.run(
						PG.insertInto(VercelProjects)
							.values(
								projects.map((project) => ({
									id: randomUUID(),
									orgId: connection.orgId,
									connectionId: connection.id,
									projectId: project.id,
									name: project.name,
									framework: project.framework,
									productionDeploymentId: project.productionDeploymentId,
									createdAt: now,
									updatedAt: now,
								})),
							)
							.onConflictDoUpdate({
								target: ["orgId", "projectId"],
								set: (_, excluded) => ({
									connectionId: excluded.connectionId,
									name: excluded.name,
									framework: excluded.framework,
									productionDeploymentId: excluded.productionDeploymentId,
									updatedAt: excluded.updatedAt,
								}),
							}),
					),
				)
			}
			if (!complete) return
			const seen = projects.map((project) => project.id)
			yield* dbExecute((db) =>
				Effect.all([
					db.run(
						PG.deleteFrom(VercelProjects).where(($) => [
							$.orgId.eq(connection.orgId),
							$.projectId.notIn(...seen),
						]),
					),
					db.run(
						PG.deleteFrom(VercelDeployments).where(($) => [
							$.orgId.eq(connection.orgId),
							$.projectId.notIn(...seen),
						]),
					),
				]),
			)
		})

		/** Upserts deployments, then keeps the newest {@link DEPLOYMENTS_KEPT_PER_PROJECT} per project. */
		const storeDeployments = Effect.fn("VercelIntegrationService.storeDeployments")(function* (
			connection: Pick<VercelConnectionRow, "id" | "orgId">,
			deployments: ReadonlyArray<VercelDeploymentInfo>,
			now: number,
		) {
			if (deployments.length === 0) return
			yield* dbExecute((db) =>
				db.run(
					PG.insertInto(VercelDeployments)
						.values(
							deployments.map((d) => ({
								id: randomUUID(),
								orgId: connection.orgId,
								connectionId: connection.id,
								projectId: d.projectId,
								deploymentId: d.id,
								url: d.url,
								target: d.target,
								state: d.state,
								branch: d.branch,
								commitSha: d.commitSha,
								commitMessage: d.commitMessage,
								creator: d.creator,
								errorCode: d.errorCode,
								createdAtVercel: d.createdAt,
								readyAt: d.readyAt,
								inspectorUrl: d.inspectorUrl,
								updatedAt: now,
							})),
						)
						.onConflictDoUpdate({
							target: ["orgId", "deploymentId"],
							set: (_, excluded) => ({
								connectionId: excluded.connectionId,
								projectId: excluded.projectId,
								url: excluded.url,
								target: excluded.target,
								state: excluded.state,
								errorCode: excluded.errorCode,
								readyAt: excluded.readyAt,
								inspectorUrl: excluded.inspectorUrl,
								updatedAt: excluded.updatedAt,
							}),
						}),
				),
			)
			const touched = [...new Set(deployments.map((d) => d.projectId))]
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(VercelDeployments)
						.select("id", "projectId")
						.where(($) => [$.orgId.eq(connection.orgId), $.projectId.in_(...touched)])
						.orderBy(($) => [[$.createdAtVercel, "desc"]]),
				),
			)
			const kept = new Map<string, number>()
			const stale = rows
				.filter((row) => {
					const count = (kept.get(row.projectId) ?? 0) + 1
					kept.set(row.projectId, count)
					return count > DEPLOYMENTS_KEPT_PER_PROJECT
				})
				.map((row) => row.id)
			if (stale.length > 0) {
				yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(VercelDeployments).where(($) => [
							$.orgId.eq(connection.orgId),
							$.id.in_(...stale),
						]),
					),
				)
			}
		})

		const getStatus = Effect.fn("VercelIntegrationService.getStatus")(function* (orgId: OrgId) {
			const connection = yield* loadConnection(orgId)
			if (connection === null) {
				return new VercelIntegrationStatus({
					connected: false,
					team: null,
					projectScope: "all",
					projectIds: [],
					samplingRate: 1,
					logsEnabled: true,
					tracesEnabled: true,
					drains: { logs: null, traces: null },
					projects: [],
					authFailed: false,
					connectedAt: null,
					lastSuccessAt: null,
					lastError: null,
				})
			}
			const [projects, latest] = yield* dbExecute((db) =>
				Effect.all([
					db.run(
						PG.from(VercelProjects)
							.select()
							.where(($) => [$.orgId.eq(orgId)]),
					),
					db.run(
						PG.from(VercelDeployments)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.distinctOn("projectId")
							.orderBy(["projectId", "asc"], ["createdAtVercel", "desc"]),
					),
				]),
			)
			const productionIds = projects.flatMap((project) =>
				project.productionDeploymentId === null ? [] : [project.productionDeploymentId],
			)
			const production =
				productionIds.length === 0
					? []
					: yield* dbExecute((db) =>
							db.run(
								PG.from(VercelDeployments)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.deploymentId.in_(...productionIds)]),
							),
						)
			const latestByProject = new Map(latest.map((row) => [row.projectId, row]))
			const byDeploymentId = new Map(production.map((row) => [row.deploymentId, row]))
			const drainStatus = (id: string | null, state: VercelDrainState | null) =>
				id === null && state === null
					? null
					: new VercelDrainStatus({
							id,
							status: state?.status ?? "unknown",
							lastError: state?.lastError ?? null,
						})
			return new VercelIntegrationStatus({
				connected: true,
				team: new VercelTeam({
					id: connection.teamId,
					slug: connection.teamSlug,
					name: connection.teamName,
				}),
				projectScope: connection.projectScope,
				projectIds: connection.projectIds,
				samplingRate: connection.samplingRate,
				logsEnabled: connection.logsEnabled,
				tracesEnabled: connection.tracesEnabled,
				drains: {
					logs: drainStatus(connection.logDrainId, connection.logDrainState),
					traces: drainStatus(connection.traceDrainId, connection.traceDrainState),
				},
				projects: [...projects]
					.sort((a, b) => a.name.localeCompare(b.name))
					.map((project) => {
						const productionRow =
							project.productionDeploymentId === null
								? undefined
								: byDeploymentId.get(project.productionDeploymentId)
						const latestRow = latestByProject.get(project.projectId)
						return new VercelProjectStatus({
							id: project.projectId,
							name: project.name,
							framework: project.framework,
							forwarded:
								connection.projectScope === "all" ||
								connection.projectIds.includes(project.projectId),
							productionDeployment:
								productionRow === undefined ? null : toSummary(productionRow),
							latestDeployment: latestRow === undefined ? null : toSummary(latestRow),
						})
					}),
				authFailed: connection.authFailedAt !== null,
				connectedAt: connection.createdAt,
				lastSuccessAt: connection.lastSuccessAt,
				lastError: connection.lastError,
			})
		})

		const discover = Effect.fn("VercelIntegrationService.discover")(function* (
			token: string,
			teamId: string | undefined,
		) {
			const teams = yield* listTeams(httpClient, token).pipe(Effect.mapError(toListError))
			const team =
				teamId === undefined
					? teams.length === 1
						? teams[0]
						: undefined
					: teams.find((t) => t.id === teamId)
			if (teamId !== undefined && team === undefined) {
				return yield* new IntegrationsValidationError({
					message: "This token cannot see that Vercel team.",
				})
			}
			const projects =
				team === undefined
					? []
					: (yield* listProjects(httpClient, token, team.id).pipe(Effect.mapError(toListError)))
							.projects
			return new VercelDiscoverResponse({
				teams: teams.map((t) => new VercelTeam(t)),
				projects: projects
					.map((project) => ({ id: project.id, name: project.name, framework: project.framework }))
					.sort((a, b) => a.name.localeCompare(b.name)),
			})
		})

		const findTeam = (teams: ReadonlyArray<VercelTeamInfo>, teamId: string) =>
			Option.fromNullishOr(teams.find((team) => team.id === teamId)).pipe(
				Option.match({
					onNone: () =>
						Effect.fail(
							new IntegrationsValidationError({
								message: "This token cannot see that Vercel team.",
							}),
						),
					onSome: Effect.succeed,
				}),
			)

		/**
		 * A poll's writes to the connection row land only while it still holds the lease it claimed:
		 * a settings change, reconnect or disconnect takes the lease, so a stale pass writes nothing.
		 */
		const updateLeased = (
			connectionId: string,
			leaseUntil: number,
			set: PG.UpdateSetOf<typeof VercelConnections>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(VercelConnections)
						.set(set)
						.where(($) => [$.id.eq(connectionId), $.leaseUntil.eq(leaseUntil)])
						.returning("id"),
				),
			).pipe(Effect.map((rows) => rows.length > 0))

		const holdsLease = (connectionId: string, leaseUntil: number) =>
			dbExecute((db) =>
				db.run(
					PG.from(VercelConnections)
						.select("id")
						.where(($) => [$.id.eq(connectionId), $.leaseUntil.eq(leaseUntil)])
						.limit(1),
				),
			).pipe(Effect.map((rows) => rows.length > 0))

		const claimLease = (connectionId: string, now: number) =>
			dbExecute((db) =>
				db.run(
					PG.update(VercelConnections)
						.set({ leaseUntil: now + LEASE_MS, updatedAt: now })
						.where(($) => [
							$.id.eq(connectionId),
							PG.or(
								$.leaseUntil.isNull(),
								$.leaseUntil.lt(now),
								// A bogus far-future lease (clock jump, crashed writer) must not wedge the org.
								$.leaseUntil.gt(now + 2 * RATE_LIMIT_HOLD_MS),
							),
						])
						.returning(),
				),
			).pipe(Effect.map((rows) => rows[0] ?? null))

		/** Compare-and-set on our own claim so a late release never clears a successor's lease. */
		const releaseLease = (connectionId: string, claimedUntil: number, holdUntilMs: number | null) =>
			Clock.currentTimeMillis.pipe(
				Effect.flatMap((now) =>
					updateLeased(connectionId, claimedUntil, { leaseUntil: holdUntilMs, updatedAt: now }),
				),
				Effect.ignore,
			)

		/**
		 * Takes the lease from any poll in flight, for a write that changes the drains. The new value
		 * is above the old one, so a poll claimed in the same millisecond still loses it.
		 */
		const takeLease = Effect.fn("VercelIntegrationService.takeLease")(function* (orgId: OrgId) {
			for (;;) {
				const connection = yield* loadConnection(orgId)
				if (connection === null) return null
				const now = yield* Clock.currentTimeMillis
				const leaseUntil = Math.max(now + LEASE_MS, (connection.leaseUntil ?? 0) + 1)
				const [taken] = yield* dbExecute((db) =>
					db.run(
						PG.update(VercelConnections)
							.set({ leaseUntil, updatedAt: now })
							.where(($) => [
								$.id.eq(connection.id),
								connection.leaseUntil === null
									? $.leaseUntil.isNull()
									: $.leaseUntil.eq(connection.leaseUntil),
							])
							.returning(),
					),
				)
				// Lost to a concurrent claim or release: read the row again.
				if (taken !== undefined) return { connection: taken, leaseUntil }
			}
		})

		/** Runs `write` holding the lease; `connection` is null when the org has none yet. */
		const underLease = <A, E, R>(
			orgId: OrgId,
			write: (connection: VercelConnectionRow | null) => Effect.Effect<A, E, R>,
		) =>
			takeLease(orgId).pipe(
				Effect.flatMap((taken) =>
					taken === null
						? write(null)
						: write(taken.connection).pipe(
								Effect.ensuring(releaseLease(taken.connection.id, taken.leaseUntil, null)),
							),
				),
			)

		/** Deletes each drain on its own so one failure does not skip the other; true when all are gone. */
		const removeDrains = Effect.fn("VercelIntegrationService.removeDrains")(function* (
			connection: VercelConnectionRow,
		) {
			const drainIds = [connection.logDrainId, connection.traceDrainId].filter(
				(id): id is string => id !== null,
			)
			if (drainIds.length === 0) return true
			const context = { orgId: connection.orgId, teamId: connection.teamId }
			const token = yield* Effect.result(decryptToken(connection))
			if (Result.isFailure(token)) {
				yield* Effect.logWarning("vercel drain removal failed", {
					...context,
					error: token.failure.message,
				})
				return false
			}
			const removed = yield* Effect.forEach(drainIds, (drainId) =>
				deleteDrain(httpClient, token.success, connection.teamId, drainId).pipe(
					Effect.as(true),
					Effect.catch((error) =>
						Effect.logWarning("vercel drain removal failed", {
							...context,
							drainId,
							error: error.message,
						}).pipe(Effect.as(false)),
					),
				),
			)
			return removed.every(Boolean)
		})

		const connect = Effect.fn("VercelIntegrationService.connect")(function* (
			orgId: OrgId,
			userId: UserId,
			request: VercelConnectRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId, "maple.vercel.team_id": request.teamId })
			yield* validateForwarding(request)
			const token = request.token
			const team = yield* listTeams(httpClient, token).pipe(
				Effect.mapError(toListError),
				Effect.flatMap((teams) => findTeam(teams, request.teamId)),
			)
			const projects = yield* listProjects(httpClient, token, team.id).pipe(
				Effect.mapError(toListError),
			)
			yield* underLease(orgId, (existing) =>
				Effect.gen(function* () {
					const sameTeam = existing !== null && existing.teamId === team.id
					const ingestKey = yield* drainKey(orgId, userId)
					const drains = yield* applyDrains(
						team.id,
						token,
						request,
						{
							logDrainId: sameTeam ? existing.logDrainId : null,
							traceDrainId: sameTeam ? existing.traceDrainId : null,
						},
						ingestKey.key,
					).pipe(Effect.mapError(toDrainError))
					const encrypted = yield* encryptAes256Gcm(
						token,
						encryptionKey,
						(message) => new IntegrationsPersistenceError({ message }),
						tokenAad(orgId),
					)
					const now = yield* Clock.currentTimeMillis
					const fields = {
						teamId: team.id,
						teamSlug: team.slug,
						teamName: team.name,
						tokenCiphertext: encrypted.ciphertext,
						tokenIv: encrypted.iv,
						tokenTag: encrypted.tag,
						connectedByUserId: userId,
						projectScope: request.projectScope,
						projectIds: request.projectIds,
						samplingRate: request.samplingRate,
						logsEnabled: request.logsEnabled,
						tracesEnabled: request.tracesEnabled,
						...drains,
						drainKeyHash: ingestKey.hash,
						authFailedAt: null,
						discoveredAt: now,
						leaseUntil: null,
						lastError: null,
						lastErrorAt: null,
						updatedAt: now,
					}
					const [connection] = yield* dbExecute((db) =>
						db.run(
							PG.insertInto(VercelConnections)
								.values({ id: randomUUID(), orgId, ...fields, createdAt: now })
								.onConflictDoUpdate({
									target: ["orgId"],
									// A new team starts its deployment history over.
									set: () =>
										sameTeam ? fields : { ...fields, deploymentsWatermarkAt: null },
								})
								.returning(),
						),
					)
					if (connection === undefined) {
						return yield* new IntegrationsPersistenceError({
							message: "Failed to save the Vercel connection",
						})
					}
					yield* reconcileProjects(connection, projects, now)
					// The old team's drains go only once the new connection is saved, with the old token.
					if (existing !== null && !sameTeam) yield* removeDrains(existing)
				}),
			)
			yield* pollNow(orgId)
			return yield* getStatus(orgId)
		})

		const updateSettings = Effect.fn("VercelIntegrationService.updateSettings")(function* (
			orgId: OrgId,
			request: VercelSettingsRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* underLease(orgId, (connection) =>
				Effect.gen(function* () {
					if (connection === null) {
						return yield* new IntegrationsNotConnectedError({
							message: "Vercel is not connected",
						})
					}
					const forwarding: VercelForwarding = {
						projectScope: request.projectScope ?? connection.projectScope,
						projectIds: request.projectIds ?? connection.projectIds,
						samplingRate: request.samplingRate ?? connection.samplingRate,
						logsEnabled: request.logsEnabled ?? connection.logsEnabled,
						tracesEnabled: request.tracesEnabled ?? connection.tracesEnabled,
					}
					yield* validateForwarding(forwarding)
					const token = yield* decryptToken(connection)
					const ingestKey = yield* drainKey(orgId, SYSTEM_USER_ID)
					const drains = yield* applyDrains(
						connection.teamId,
						token,
						forwarding,
						connection,
						ingestKey.key,
					).pipe(Effect.mapError(toDrainError))
					const now = yield* Clock.currentTimeMillis
					yield* updateConnection(connection.id, {
						...forwarding,
						...drains,
						drainKeyHash: ingestKey.hash,
						leaseUntil: null,
						updatedAt: now,
					})
				}),
			)
			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("VercelIntegrationService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			return yield* underLease(orgId, (connection) =>
				Effect.gen(function* () {
					if (connection === null) return { disconnected: false, drainsRemoved: true }
					const drainsRemoved = yield* removeDrains(connection)
					yield* Effect.annotateCurrentSpan("maple.vercel.drains_removed", drainsRemoved)
					yield* dbExecute((db) =>
						Effect.all([
							db.run(PG.deleteFrom(VercelDeployments).where(($) => [$.orgId.eq(orgId)])),
							db.run(PG.deleteFrom(VercelProjects).where(($) => [$.orgId.eq(orgId)])),
							db.run(PG.deleteFrom(VercelConnections).where(($) => [$.orgId.eq(orgId)])),
						]),
					)
					return { disconnected: true, drainsRemoved }
				}),
			)
		})

		const deployments = Effect.fn("VercelIntegrationService.deployments")(function* (
			orgId: OrgId,
			projectId: string,
			limit: number,
		) {
			const rows = yield* dbExecute((db) =>
				db.run(
					PG.from(VercelDeployments)
						.select()
						.where(($) => [$.orgId.eq(orgId), $.projectId.eq(projectId)])
						.orderBy(["createdAtVercel", "desc"])
						.limit(limit),
				),
			)
			return rows.map(toSummary)
		})

		const pollOrg = Effect.fn("VercelIntegrationService.pollOrg")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const skip = (reason: string): VercelPollOrgSummary => ({
				orgId,
				skipped: reason,
				deploymentsUpserted: 0,
				drainsRepaired: 0,
				failures: 0,
			})
			const connection = yield* loadConnection(orgId)
			if (connection === null) return skip("not connected")
			if (connection.authFailedAt !== null) return skip("token rejected")
			const now = yield* Clock.currentTimeMillis
			const claimed = yield* claimLease(connection.id, now)
			if (claimed === null) return skip("lease held")
			const lease = now + LEASE_MS
			yield* Effect.annotateCurrentSpan("maple.vercel.team_id", claimed.teamId)

			const write = (set: PG.UpdateSetOf<typeof VercelConnections>) =>
				updateLeased(claimed.id, lease, { ...set, updatedAt: now })
			const leaseLost = skip("lease lost")
			const holdUntilRef = yield* Ref.make<number | null>(null)
			const errorsRef = yield* Ref.make<ReadonlyArray<string>>([])
			const recordError = (message: string) => Ref.update(errorsRef, (errors) => [...errors, message])

			/** Ends the pass for a token or rate-limit failure; returns whether it did. */
			const stopFor = (error: VercelApiError) =>
				Effect.gen(function* () {
					if (isTokenRejection(error)) {
						yield* write({ authFailedAt: now, lastError: error.message, lastErrorAt: now })
						return true
					}
					if (error.kind === "rate_limited") {
						yield* Ref.set(holdUntilRef, now + RATE_LIMIT_HOLD_MS)
						yield* write({ lastError: error.message, lastErrorAt: now })
						return true
					}
					return false
				})

			const body = Effect.gen(function* () {
				const token = yield* decryptToken(claimed)

				if (claimed.discoveredAt === null || now - claimed.discoveredAt >= DISCOVERY_TTL_MS) {
					const projects = yield* Effect.result(listProjects(httpClient, token, claimed.teamId))
					if (Result.isSuccess(projects)) {
						if (!(yield* holdsLease(claimed.id, lease))) return leaseLost
						yield* reconcileProjects(claimed, projects.success, now)
						yield* write({ discoveredAt: now })
					} else if (yield* stopFor(projects.failure)) {
						return { ...skip(projects.failure.kind), failures: 1 }
					} else {
						yield* recordError(projects.failure.message)
					}
				}

				const since =
					claimed.deploymentsWatermarkAt === null
						? now - INITIAL_DEPLOYMENTS_MS
						: claimed.deploymentsWatermarkAt - DEPLOYMENT_LOOKBACK_MS
				let deploymentsUpserted = 0
				const listed = yield* Effect.result(
					listDeployments(httpClient, token, claimed.teamId, since, DEPLOYMENT_PAGES_PER_TICK),
				)
				if (Result.isSuccess(listed)) {
					if (!(yield* holdsLease(claimed.id, lease))) return leaseLost
					yield* storeDeployments(claimed, listed.success, now)
					deploymentsUpserted = listed.success.length
					const newest = Math.max(
						claimed.deploymentsWatermarkAt ?? 0,
						...listed.success.map((d) => d.createdAt),
					)
					if (newest > 0) yield* write({ deploymentsWatermarkAt: newest })
				} else if (yield* stopFor(listed.failure)) {
					return { ...skip(listed.failure.kind), failures: 1 }
				} else {
					yield* recordError(listed.failure.message)
				}

				const ingestKey = yield* Effect.result(drainKey(orgId, SYSTEM_USER_ID))
				let drainsRepaired = 0
				let drainsHealthy = false
				if (Result.isFailure(ingestKey)) {
					yield* recordError(ingestKey.failure.message)
				} else {
					// A rotated ingest key means every drain still sends the old one: rewrite them.
					const rekey = claimed.drainKeyHash !== ingestKey.success.hash
					yield* Effect.annotateCurrentSpan("maple.vercel.rekey", rekey)
					drainsHealthy = true
					for (const kind of ["logs", "traces"] as const) {
						const drainId = kind === "logs" ? claimed.logDrainId : claimed.traceDrainId
						const previous = kind === "logs" ? claimed.logDrainState : claimed.traceDrainState
						if (!(yield* holdsLease(claimed.id, lease))) return leaseLost
						const result = yield* Effect.result(
							reconcileDrain(
								kind,
								claimed.teamId,
								token,
								claimed,
								drainId,
								ingestKey.success.key,
								rekey ? "apply" : "check",
							),
						)
						let outcome: DrainOutcome
						if (Result.isFailure(result)) {
							drainsHealthy = false
							// A drain 403 is the team's plan, not the token: only these two end the pass.
							if (isFatal(result.failure) && (yield* stopFor(result.failure))) {
								return { ...skip(result.failure.kind), failures: 1 }
							}
							yield* recordError(result.failure.message)
							outcome = {
								id: drainId,
								state: {
									status: previous?.status ?? "unknown",
									lastError: result.failure.message,
								},
								created: false,
							}
						} else {
							outcome = result.success
							if (outcome.created || (rekey && outcome.id !== null)) drainsRepaired++
							if (outcome.state?.status === "missing") drainsHealthy = false
						}
						// Saved at once so a pass that ends early still keeps a drain it re-created.
						const saved = yield* write(
							kind === "logs"
								? { logDrainId: outcome.id, logDrainState: outcome.state }
								: { traceDrainId: outcome.id, traceDrainState: outcome.state },
						)
						if (!saved) {
							// A settings change or disconnect took over; the drain made here is not on record.
							if (outcome.created && outcome.id !== null) {
								yield* deleteDrain(httpClient, token, claimed.teamId, outcome.id).pipe(
									Effect.catch((error) =>
										Effect.logWarning("vercel orphan drain removal failed", {
											orgId,
											drainId: outcome.id,
											error: error.message,
										}),
									),
								)
							}
							return leaseLost
						}
					}
				}

				const errors = yield* Ref.get(errorsRef)
				yield* write({
					// Only once every enabled drain carries the current key; otherwise retry next tick.
					...(drainsHealthy && Result.isSuccess(ingestKey)
						? { drainKeyHash: ingestKey.success.hash }
						: undefined),
					...(errors.length === 0
						? { lastSuccessAt: now, lastError: null, lastErrorAt: null }
						: { lastError: (errors[0] ?? "").slice(0, 500), lastErrorAt: now }),
				})
				yield* Effect.annotateCurrentSpan({
					"maple.vercel.deployments_upserted": deploymentsUpserted,
					"maple.vercel.drains_repaired": drainsRepaired,
					"maple.vercel.failures": errors.length,
				})
				return {
					orgId,
					skipped: null,
					deploymentsUpserted,
					drainsRepaired,
					failures: errors.length,
				} satisfies VercelPollOrgSummary
			})

			return yield* body.pipe(
				Effect.timeoutOrElse({
					duration: POLL_BUDGET,
					orElse: () =>
						write({
							lastError: "The Vercel sync ran out of time; it resumes on the next tick.",
							lastErrorAt: now,
						}).pipe(Effect.as({ ...skip("timed out"), failures: 1 })),
				}),
				Effect.ensuring(
					Ref.get(holdUntilRef).pipe(
						Effect.flatMap((holdUntil) => releaseLease(claimed.id, lease, holdUntil)),
					),
				),
			)
		})

		const pollAllOrgs = Effect.fn("VercelIntegrationService.pollAllOrgs")(function* () {
			const connections = yield* dbExecute((db) =>
				db.run(
					PG.from(VercelConnections)
						.select("orgId")
						.where(($) => [$.authFailedAt.isNull()]),
				),
			)
			const summaries = yield* Effect.forEach(
				connections,
				(row) =>
					pollOrg(row.orgId).pipe(
						Effect.catchCause((cause) =>
							Cause.hasInterruptsOnly(cause)
								? Effect.interrupt
								: Effect.logWarning("vercel org poll failed", {
										orgId: row.orgId,
										error: summarizeCause(cause),
									}).pipe(
										Effect.as<VercelPollOrgSummary>({
											orgId: row.orgId,
											skipped: "org poll failed",
											deploymentsUpserted: 0,
											drainsRepaired: 0,
											failures: 1,
										}),
									),
						),
					),
				{ concurrency: ORG_CONCURRENCY },
			)
			return {
				orgs: connections.length,
				deploymentsUpserted: summaries.reduce((sum, s) => sum + s.deploymentsUpserted, 0),
				drainsRepaired: summaries.reduce((sum, s) => sum + s.drainsRepaired, 0),
				failures: summaries.reduce((sum, s) => sum + s.failures, 0),
				skipped: summaries.filter((s) => s.skipped !== null).length,
			} satisfies VercelPollAllOrgsSummary
		})

		/** Best effort: a failed or slow poll still leaves the connection for the cron to catch up. */
		const pollNow = (orgId: OrgId) =>
			pollOrg(orgId).pipe(
				Effect.timeoutOption(SYNC_NOW_TIMEOUT),
				Effect.catchCause((cause) =>
					Cause.hasInterruptsOnly(cause)
						? Effect.interrupt
						: Effect.logWarning("vercel on-demand poll failed", {
								orgId,
								error: summarizeCause(cause),
							}),
				),
				Effect.asVoid,
			)

		const sync = Effect.fn("VercelIntegrationService.sync")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			yield* pollNow(orgId)
			return yield* getStatus(orgId)
		})

		return {
			getStatus,
			discover,
			connect,
			updateSettings,
			sync,
			disconnect,
			deployments,
			pollOrg,
			pollAllOrgs,
		} satisfies VercelIntegrationServiceApi
	}),
}) {
	static readonly layer = Layer.effect(this, this.make).pipe(
		Layer.provide(FetchHttpClient.layer),
		Layer.provide(OrgIngestKeysService.layer),
	)
}
