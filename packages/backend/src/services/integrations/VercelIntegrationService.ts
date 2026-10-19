/**
 * Vercel integration: an org saves a Vercel access token for one team, and Maple keeps a log
 * drain and a trace drain on that team pointing at the ingest gateway (Bearer org ingest key).
 * Each drain's endpoint carries `maple_org=<orgId>`, so Maple finds its own drains in the team's
 * list. Every write and every poll tick reconciles that list against the saved settings
 * (create, patch, delete duplicates), which makes the drains converge after any race or
 * interrupted request. Telemetry itself flows through the drains; nothing here reads it.
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
import type { MapleDb } from "@maple/db/client"
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
	listDeployments,
	listDrains,
	listProjects,
	listTeams,
	updateDrain,
	VercelApiError,
	type VercelDeploymentInfo,
	type VercelDrainBody,
	type VercelDrainInfo,
	type VercelListedDrain,
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
const DRAIN_KINDS: ReadonlyArray<DrainKind> = ["logs", "traces"]
const drainSchema = (kind: DrainKind) => (kind === "logs" ? "log" : "trace")

/** What the drains forward: the part of the connection a drain body is built from. */
export interface VercelForwarding {
	readonly projectScope: VercelProjectScope
	readonly projectIds: ReadonlyArray<string>
	readonly samplingRate: number
	readonly logsEnabled: boolean
	readonly tracesEnabled: boolean
}

/** The connection fields a reconcile reads. */
type DrainOwner = Pick<VercelConnectionRow, "orgId" | "teamId" | "logDrainId" | "traceDrainId">

interface DrainOutcome {
	readonly id: string | null
	readonly state: VercelDrainState | null
	/** Created, patched or deleted something on this run. */
	readonly changed: boolean
	readonly error: VercelApiError | null
}

interface DrainOutcomes {
	readonly logs: DrainOutcome
	readonly traces: DrainOutcome
}

const firstError = (outcomes: DrainOutcomes) => outcomes.logs.error ?? outcomes.traces.error

const drainState = (drain: VercelDrainInfo): VercelDrainState => {
	const status =
		drain.status === "enabled" || drain.status === "disabled" || drain.status === "errored"
			? drain.status
			: "unknown"
	return { status, lastError: status === "enabled" ? null : drain.disabledReason }
}

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

const sameIds = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) =>
	a.length === b.length && [...a].sort().join("\n") === [...b].sort().join("\n")

/** One entry per id; listings that page by time can repeat an item at a page edge. */
const uniqueById = <A extends { readonly id: string }>(items: ReadonlyArray<A>) => [
	...new Map(items.map((item) => [item.id, item])).values(),
]

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
	/** Deletes Maple's drains on Vercel (best effort), then every row. */
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

		/** Writes the org's connection while it is still on `teamId`; false when it is gone or moved. */
		const updateConnection = (
			orgId: OrgId,
			teamId: string,
			set: PG.UpdateSetOf<typeof VercelConnections>,
		) =>
			dbExecute((db) =>
				db.run(
					PG.update(VercelConnections)
						.set(set)
						.where(($) => [$.orgId.eq(orgId), $.teamId.eq(teamId)])
						.returning("id"),
				),
			).pipe(Effect.map((rows) => rows.length > 0))

		/**
		 * Runs `write` only while the org is connected to `teamId`. The share lock makes a concurrent
		 * disconnect wait for it, and a disconnect that ran first leaves nothing to lock.
		 */
		const whileConnected = <A, E, R>(
			orgId: OrgId,
			teamId: string,
			write: (db: MapleDb, connectionId: string) => Effect.Effect<A, E, R>,
		) =>
			dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						const [row] = yield* db.run(
							PG.from(VercelConnections)
								.select("id")
								.where(($) => [$.orgId.eq(orgId), $.teamId.eq(teamId)])
								.limit(1)
								.forShare(),
						)
						if (row === undefined) return false
						yield* write(db, row.id)
						return true
					}),
				),
			)

		const deleteRows = (orgId: OrgId) =>
			dbExecute((db) =>
				db.transaction(
					Effect.gen(function* () {
						// The connection row goes first: a poll holding its share lock finishes before this.
						yield* db.run(PG.deleteFrom(VercelConnections).where(($) => [$.orgId.eq(orgId)]))
						yield* db.run(PG.deleteFrom(VercelDeployments).where(($) => [$.orgId.eq(orgId)]))
						yield* db.run(PG.deleteFrom(VercelProjects).where(($) => [$.orgId.eq(orgId)]))
					}),
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

		/** The delivery URL of the org's drain; the `maple_org` marker is how Maple finds it again. */
		const drainEndpoint = (kind: DrainKind, orgId: OrgId) =>
			`${ingestUrl}${kind === "logs" ? "/v1/logpush/vercel" : "/v1/traces"}?maple_org=${encodeURIComponent(orgId)}`

		const drainBody = (
			kind: DrainKind,
			orgId: OrgId,
			forwarding: VercelForwarding,
			ingestKey: string,
			update: boolean,
			reenable: boolean,
		): VercelDrainBody => {
			const headers = { authorization: `Bearer ${ingestKey}` }
			const endpoint = drainEndpoint(kind, orgId)
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
				...(forwarding.projectScope === "some"
					? { projectIds: forwarding.projectIds }
					: update
						? { projectIds: null }
						: undefined),
				schemas: { [drainSchema(kind)]: { version: "v1" } },
				delivery:
					kind === "logs"
						? { type: "http", endpoint, encoding: "ndjson", compression: "none", headers }
						: { type: "otlphttp", endpoint: { traces: endpoint }, encoding: "proto", headers },
				...(sampling === undefined ? undefined : { sampling }),
				// Saving the settings turns a disabled drain back on; the poll leaves the owner's choice alone.
				...(update && reenable ? { status: "enabled" as const } : undefined),
			}
		}

		/** The listed drain differs from the settings in something a PATCH sets. */
		const drifted = (
			kind: DrainKind,
			orgId: OrgId,
			drain: VercelListedDrain,
			forwarding: VercelForwarding,
			reenable: boolean,
		) => {
			const [rule, ...more] = drain.sampling
			const samplingMatches =
				forwarding.samplingRate < 1
					? rule !== undefined &&
						more.length === 0 &&
						rule.type === "head_sampling" &&
						Math.abs(rule.rate - forwarding.samplingRate) < 1e-6 &&
						rule.env === undefined &&
						rule.requestPath === undefined
					: rule === undefined
			return (
				drain.endpoint !== drainEndpoint(kind, orgId) ||
				(reenable && drain.status === "disabled") ||
				!samplingMatches ||
				!sameIds(drain.projectIds, forwarding.projectScope === "some" ? forwarding.projectIds : [])
			)
		}

		/** Maple's drains of one kind for this org: by endpoint marker, plus the id on record. */
		const ownDrains = (
			drains: ReadonlyArray<VercelListedDrain>,
			kind: DrainKind,
			owner: DrainOwner,
		) => {
			const storedId = kind === "logs" ? owner.logDrainId : owner.traceDrainId
			return drains.filter(
				(drain) =>
					drain.schemas.includes(drainSchema(kind)) &&
					(drain.endpoint === drainEndpoint(kind, owner.orgId) || drain.id === storedId),
			)
		}

		/** Deletes each drain on its own so one failure does not skip the rest; the first failure. */
		const deleteEach = (token: string, teamId: string, drainIds: ReadonlyArray<string>) =>
			Effect.forEach(drainIds, (drainId) =>
				deleteDrain(httpClient, token, teamId, drainId).pipe(
					Effect.as(null),
					Effect.catch((error) => Effect.succeed(error)),
				),
			).pipe(Effect.map((errors) => errors.find((error) => error !== null) ?? null))

		const reconcileDrain = Effect.fn("VercelIntegrationService.reconcileDrain")(function* (
			kind: DrainKind,
			drains: ReadonlyArray<VercelListedDrain>,
			owner: DrainOwner & Pick<VercelConnectionRow, "drainKeyHash">,
			token: string,
			forwarding: VercelForwarding,
			ingestKey: { readonly key: string; readonly hash: string },
			reenable: boolean,
		) {
			const own = ownDrains(drains, kind, owner)
			const enabled = kind === "logs" ? forwarding.logsEnabled : forwarding.tracesEnabled
			yield* Effect.annotateCurrentSpan({
				"maple.vercel.drain_kind": kind,
				"maple.vercel.drains_found": own.length,
			})
			if (!enabled) {
				const error = yield* deleteEach(
					token,
					owner.teamId,
					own.map((drain) => drain.id),
				)
				return { id: null, state: null, changed: own.length > 0, error } satisfies DrainOutcome
			}
			const storedId = kind === "logs" ? owner.logDrainId : owner.traceDrainId
			const kept =
				own.find((drain) => drain.id === storedId) ??
				own.reduce<VercelListedDrain | undefined>(
					(newest, drain) =>
						newest === undefined || drain.createdAt > newest.createdAt ? drain : newest,
					undefined,
				)
			const extras = own.filter((drain) => drain !== kept).map((drain) => drain.id)
			const extraError = yield* deleteEach(token, owner.teamId, extras)
			// Vercel may redact headers in the listing, so the stored key hash says whether they are current.
			const rekey = owner.drainKeyHash !== ingestKey.hash
			const write =
				kept === undefined
					? createDrain(
							httpClient,
							token,
							owner.teamId,
							drainBody(kind, owner.orgId, forwarding, ingestKey.key, false, reenable),
						)
					: rekey || drifted(kind, owner.orgId, kept, forwarding, reenable)
						? updateDrain(
								httpClient,
								token,
								owner.teamId,
								kept.id,
								drainBody(kind, owner.orgId, forwarding, ingestKey.key, true, reenable),
							).pipe(Effect.map((drain) => ({ ...drain, id: kept.id })))
						: undefined
			if (write === undefined) {
				return {
					id: kept?.id ?? null,
					state: kept === undefined ? null : drainState(kept),
					changed: extras.length > 0,
					error: extraError,
				} satisfies DrainOutcome
			}
			const written = yield* Effect.result(write)
			if (Result.isFailure(written)) {
				return {
					id: kept?.id ?? null,
					state: {
						status: kept === undefined ? "missing" : drainState(kept).status,
						lastError: written.failure.message,
					},
					changed: extras.length > 0,
					error: written.failure,
				} satisfies DrainOutcome
			}
			return {
				id: written.success.id,
				state: drainState(written.success),
				changed: true,
				error: extraError,
			} satisfies DrainOutcome
		})

		/**
		 * Brings Maple's drains for the org on the team in line with `forwarding`: keeps one per
		 * enabled kind (the one on record, else the newest), deletes the rest, patches drift or a
		 * rotated key, creates what is missing. Two runs racing leave duplicates the next run deletes.
		 */
		const reconcileDrains = Effect.fn("VercelIntegrationService.reconcileDrains")(function* (
			owner: DrainOwner & Pick<VercelConnectionRow, "drainKeyHash">,
			token: string,
			forwarding: VercelForwarding,
			ingestKey: { readonly key: string; readonly hash: string },
			/** Settings saves turn disabled drains back on; the poll does not. */
			reenable: boolean,
		) {
			const drains = yield* listDrains(httpClient, token, owner.teamId)
			const logs = yield* reconcileDrain("logs", drains, owner, token, forwarding, ingestKey, reenable)
			const traces = yield* reconcileDrain("traces", drains, owner, token, forwarding, ingestKey, reenable)
			return { logs, traces } satisfies DrainOutcomes
		})

		/** Deletes every drain Maple made for the org on the team; true when none is left. */
		const removeDrains = Effect.fn("VercelIntegrationService.removeDrains")(function* (
			owner: DrainOwner,
			token: string,
		) {
			const removed = yield* listDrains(httpClient, token, owner.teamId).pipe(
				Effect.flatMap((drains) =>
					deleteEach(
						token,
						owner.teamId,
						DRAIN_KINDS.flatMap((kind) => ownDrains(drains, kind, owner).map((drain) => drain.id)),
					),
				),
				Effect.flatMap((error) => (error === null ? Effect.succeed(true) : Effect.fail(error))),
				Effect.catch((error) =>
					Effect.logWarning("vercel drain removal failed", {
						orgId: owner.orgId,
						teamId: owner.teamId,
						error: error.message,
					}).pipe(Effect.as(false)),
				),
			)
			yield* Effect.annotateCurrentSpan("maple.vercel.drains_removed", removed)
			return removed
		})

		/** Records what a reconcile found; the key hash only once every drain carries the key. */
		const saveOutcomes = (
			owner: DrainOwner,
			outcomes: DrainOutcomes,
			keyHash: string,
			now: number,
		) =>
			updateConnection(owner.orgId, owner.teamId, {
				logDrainId: outcomes.logs.id,
				logDrainState: outcomes.logs.state,
				traceDrainId: outcomes.traces.id,
				traceDrainState: outcomes.traces.state,
				...(firstError(outcomes) === null ? { drainKeyHash: keyHash } : undefined),
				updatedAt: now,
			})

		/**
		 * Upserts the discovered projects. Deletes the ones (and their deployments) that are gone,
		 * but only from a complete listing: a capped one never saw the projects past the cap.
		 */
		const storeProjects = Effect.fn("VercelIntegrationService.storeProjects")(function* (
			orgId: OrgId,
			teamId: string,
			listing: VercelProjectListing,
			now: number,
		) {
			const projects = uniqueById(listing.projects)
			yield* Effect.annotateCurrentSpan("maple.vercel.projects", projects.length)
			return yield* whileConnected(orgId, teamId, (db, connectionId) =>
				Effect.gen(function* () {
					if (projects.length > 0) {
						yield* db.run(
							PG.insertInto(VercelProjects)
								.values(
									projects.map((project) => ({
										id: randomUUID(),
										orgId,
										connectionId,
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
						)
					}
					if (!listing.complete) return
					const seen = projects.map((project) => project.id)
					yield* db.run(
						PG.deleteFrom(VercelProjects).where(($) => [
							$.orgId.eq(orgId),
							$.projectId.notIn(...seen),
						]),
					)
					yield* db.run(
						PG.deleteFrom(VercelDeployments).where(($) => [
							$.orgId.eq(orgId),
							$.projectId.notIn(...seen),
						]),
					)
				}),
			)
		})

		/** Upserts deployments, then keeps the newest {@link DEPLOYMENTS_KEPT_PER_PROJECT} per project. */
		const storeDeployments = Effect.fn("VercelIntegrationService.storeDeployments")(function* (
			orgId: OrgId,
			teamId: string,
			listed: ReadonlyArray<VercelDeploymentInfo>,
			now: number,
		) {
			const deployments = uniqueById(listed)
			if (deployments.length === 0) return
			yield* whileConnected(orgId, teamId, (db, connectionId) =>
				Effect.gen(function* () {
					yield* db.run(
						PG.insertInto(VercelDeployments)
							.values(
								deployments.map((d) => ({
									id: randomUUID(),
									orgId,
									connectionId,
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
					)
					const touched = [...new Set(deployments.map((d) => d.projectId))]
					const rows = yield* db.run(
						PG.from(VercelDeployments)
							.select("id", "projectId")
							.where(($) => [$.orgId.eq(orgId), $.projectId.in_(...touched)])
							.orderBy(($) => [[$.createdAtVercel, "desc"]]),
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
						yield* db.run(
							PG.deleteFrom(VercelDeployments).where(($) => [
								$.orgId.eq(orgId),
								$.id.in_(...stale),
							]),
						)
					}
				}),
			)
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
							.where(($) => [$.orgId.eq(orgId), $.connectionId.eq(connection.id)]),
					),
					db.run(
						PG.from(VercelDeployments)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.connectionId.eq(connection.id)])
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
					dbExecute((db) =>
						db.run(
							PG.update(VercelConnections)
								.set({ leaseUntil: holdUntilMs, updatedAt: now })
								.where(($) => [$.id.eq(connectionId), $.leaseUntil.eq(claimedUntil)]),
						),
					),
				),
				Effect.ignore,
			)

		/**
		 * Saves the connection before touching a drain, so a request cut short after a create still
		 * leaves a row whose next poll finds that drain by its marker.
		 */
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
			const existing = yield* loadConnection(orgId)
			const sameTeam = existing !== null && existing.teamId === team.id
			// The old team's drains go with the old token, best effort: the new team is saved regardless.
			const previousTeamCleared =
				existing === null || sameTeam
					? true
					: yield* decryptToken(existing).pipe(
							Effect.flatMap((oldToken) => removeDrains(existing, oldToken)),
							Effect.catch((error) =>
								Effect.logWarning("vercel drain removal failed", {
									orgId,
									teamId: existing.teamId,
									error: error.message,
								}).pipe(Effect.as(false)),
							),
						)
			const ingestKey = yield* drainKey(orgId, userId)
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
				authFailedAt: null,
				discoveredAt: now,
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
							// A new team starts its drains and deployment history over.
							set: () =>
								sameTeam
									? fields
									: {
											...fields,
											logDrainId: null,
											traceDrainId: null,
											logDrainState: null,
											traceDrainState: null,
											drainKeyHash: null,
											deploymentsWatermarkAt: null,
										},
						})
						.returning(),
				),
			)
			if (connection === undefined) {
				return yield* new IntegrationsPersistenceError({
					message: "Failed to save the Vercel connection",
				})
			}
			yield* storeProjects(orgId, team.id, projects, now)
			const reconciled = yield* Effect.result(reconcileDrains(connection, token, request, ingestKey, true))
			if (Result.isSuccess(reconciled)) {
				yield* saveOutcomes(connection, reconciled.success, ingestKey.hash, now)
			}
			const failure = Result.isFailure(reconciled) ? reconciled.failure : firstError(reconciled.success)
			if (failure !== null) {
				// A first connect Vercel refuses leaves nothing behind; an existing one keeps its row.
				if (existing === null) {
					yield* removeDrains(connection, token)
					yield* deleteRows(orgId)
				}
				return yield* toDrainError(failure)
			}
			yield* pollNow(orgId)
			const status = yield* getStatus(orgId)
			return previousTeamCleared || existing === null
				? status
				: new VercelIntegrationStatus({
						...status,
						lastError: `Maple could not delete its drains on the previous team (${existing.teamSlug}); remove them in that team's drain settings.`,
					})
		})

		const updateSettings = Effect.fn("VercelIntegrationService.updateSettings")(function* (
			orgId: OrgId,
			request: VercelSettingsRequest,
		) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* loadConnection(orgId)
			if (connection === null) {
				return yield* new IntegrationsNotConnectedError({ message: "Vercel is not connected" })
			}
			const forwarding: VercelForwarding = {
				projectScope: request.projectScope ?? connection.projectScope,
				projectIds: request.projectIds ?? connection.projectIds,
				samplingRate: request.samplingRate ?? connection.samplingRate,
				logsEnabled: request.logsEnabled ?? connection.logsEnabled,
				tracesEnabled: request.tracesEnabled ?? connection.tracesEnabled,
			}
			yield* validateForwarding(forwarding)
			const now = yield* Clock.currentTimeMillis
			// Saved first: whatever the drains end up as, the next poll converges them on this.
			yield* updateConnection(orgId, connection.teamId, { ...forwarding, updatedAt: now })
			const token = yield* decryptToken(connection)
			const ingestKey = yield* drainKey(orgId, SYSTEM_USER_ID)
			const outcomes = yield* reconcileDrains(connection, token, forwarding, ingestKey, true).pipe(
				Effect.mapError(toDrainError),
			)
			yield* saveOutcomes(connection, outcomes, ingestKey.hash, now)
			const failure = firstError(outcomes)
			if (failure !== null) return yield* toDrainError(failure)
			return yield* getStatus(orgId)
		})

		const disconnect = Effect.fn("VercelIntegrationService.disconnect")(function* (orgId: OrgId) {
			yield* Effect.annotateCurrentSpan({ orgId })
			const connection = yield* loadConnection(orgId)
			if (connection === null) return { disconnected: false, drainsRemoved: true }
			const drainsRemoved = yield* decryptToken(connection).pipe(
				Effect.flatMap((token) => removeDrains(connection, token)),
				Effect.catch((error) =>
					Effect.logWarning("vercel drain removal failed", { orgId, error: error.message }).pipe(
						Effect.as(false),
					),
				),
			)
			yield* deleteRows(orgId)
			return { disconnected: true, drainsRemoved }
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

			// Lands only while the org is still on the claimed team: a reconnect elsewhere is not overwritten.
			const write = (set: PG.UpdateSetOf<typeof VercelConnections>) =>
				updateConnection(orgId, claimed.teamId, { ...set, updatedAt: now })
			const holdUntilRef = yield* Ref.make<number | null>(null)
			const errorsRef = yield* Ref.make<ReadonlyArray<string>>([])
			const recordError = (message: string) => Ref.update(errorsRef, (errors) => [...errors, message])

			/** Ends the pass for a token or rate-limit failure; returns whether it did. */
			const stopFor = (error: VercelApiError) =>
				Effect.gen(function* () {
					if (isTokenRejection(error)) {
						// Only against the token that failed: a token saved meanwhile is not paused.
						yield* dbExecute((db) =>
							db.run(
								PG.update(VercelConnections)
									.set({
										authFailedAt: now,
										lastError: error.message,
										lastErrorAt: now,
										updatedAt: now,
									})
									.where(($) => [
										$.orgId.eq(orgId),
										$.tokenCiphertext.eq(claimed.tokenCiphertext),
									]),
							),
						)
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
				let forwarding: VercelForwarding = claimed

				if (claimed.discoveredAt === null || now - claimed.discoveredAt >= DISCOVERY_TTL_MS) {
					const projects = yield* Effect.result(listProjects(httpClient, token, claimed.teamId))
					if (Result.isSuccess(projects)) {
						yield* storeProjects(orgId, claimed.teamId, projects.success, now)
						// Vercel drops a deleted project from the drain; forget it too, or the drain reads as drifted forever.
						const listed = new Set(projects.success.projects.map((project) => project.id))
						const kept = claimed.projectIds.filter((id) => listed.has(id))
						const prune =
							projects.success.complete && kept.length > 0 && kept.length < claimed.projectIds.length
						if (prune) forwarding = { ...claimed, projectIds: kept }
						yield* write(prune ? { discoveredAt: now, projectIds: kept } : { discoveredAt: now })
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
					yield* storeDeployments(orgId, claimed.teamId, listed.success, now)
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

				let drainsRepaired = 0
				const ingestKey = yield* Effect.result(drainKey(orgId, SYSTEM_USER_ID))
				if (Result.isFailure(ingestKey)) {
					yield* recordError(ingestKey.failure.message)
				} else {
					const reconciled = yield* Effect.result(
						reconcileDrains(claimed, token, forwarding, ingestKey.success, false),
					)
					if (Result.isFailure(reconciled)) {
						// A drain 403 is the team's plan, not the token: only these two end the pass.
						if (isFatal(reconciled.failure) && (yield* stopFor(reconciled.failure))) {
							return { ...skip(reconciled.failure.kind), failures: 1 }
						}
						yield* recordError(reconciled.failure.message)
					} else {
						const outcomes = reconciled.success
						if (!(yield* saveOutcomes(claimed, outcomes, ingestKey.success.hash, now))) {
							// Disconnected or moved team while this ran: take back what it may have created.
							yield* removeDrains(claimed, token)
							return skip("disconnected")
						}
						drainsRepaired = [outcomes.logs, outcomes.traces].filter((o) => o.changed).length
						for (const outcome of [outcomes.logs, outcomes.traces]) {
							if (outcome.error === null) continue
							if (isFatal(outcome.error) && (yield* stopFor(outcome.error))) {
								return { ...skip(outcome.error.kind), drainsRepaired, failures: 1 }
							}
							yield* recordError(outcome.error.message)
						}
					}
				}

				const errors = yield* Ref.get(errorsRef)
				yield* write(
					errors.length === 0
						? { lastSuccessAt: now, lastError: null, lastErrorAt: null }
						: { lastError: (errors[0] ?? "").slice(0, 500), lastErrorAt: now },
				)
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
