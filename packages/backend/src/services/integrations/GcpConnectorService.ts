import { randomBytes, randomUUID } from "node:crypto"
import * as PG from "@maple-dev/effect-orm/postgres"
import { hashIngestKey, parseIngestKeyLookupHmacKey } from "@maple/db"
import { GcpConnectors, GcpResources, type GcpConnectorRow } from "@maple/db/tables"
import { GCP_PROJECT_ASSET_TYPE } from "@maple/domain/gcp-metrics"
import {
	GCP_RESOURCES_LIMIT,
	GcpMetricsUnavailableError,
	type GcpResource,
	GcpScopeAlreadyConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
	IntegrationsUpstreamError,
	IntegrationsValidationError,
} from "@maple/domain/http"
import {
	GcpConnectorId,
	type GcpLogRuntime,
	type GcpProjectId,
	type GcpResourceNumber,
	type GcpScopeType,
	type OrgId,
	type UserId,
} from "@maple/domain/primitives"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { FetchHttpClient, HttpClient } from "effect/http"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { renderGcpAlchemy } from "./gcp/alchemy"
import {
	fetchMapleAccessToken,
	type GcpApiError,
	importServiceAccountKey,
	impersonateReader,
	searchOneProject,
} from "./gcp/api"
import { gcpReaderPlan, gcpSetupPlan, type GcpReaderPlan, type GcpSetupPlan } from "./gcp/setup-plan"
import { renderGcpCleanupScript, renderGcpSetupScript } from "./gcp/setup-scripts"
import { renderGcpTerraform } from "./gcp/terraform"

export interface GcpConnector {
	readonly id: GcpConnectorId
	readonly scopeType: GcpScopeType
	/** The project id, or the numeric folder / organization id. */
	readonly scopeId: GcpProjectId | GcpResourceNumber
	/** The host project, where Maple's own resources live. Equals `scopeId` for a project scope. */
	readonly projectId: GcpProjectId
	readonly logsEnabled: boolean
	/** Covers metrics and resource collection. */
	readonly metricsEnabled: boolean
	readonly createdAt: number
	/** Last log push the ingest gateway accepted from this connector. Null until the first one. */
	readonly lastLogReceivedAt: number | null
	readonly lastLogError: string | null
	/** What the latest setup script run reported it set up in Google Cloud. Null until one reports. */
	readonly appliedLogsEnabled: boolean | null
	readonly appliedMetricsEnabled: boolean | null
	readonly setupReportedAt: number | null
	/** Last poll that read the scope's metrics. Null until the first one. */
	readonly lastMetricsReceivedAt: number | null
	readonly lastMetricsError: string | null
	/** Projects the last inventory sync found in the scope. */
	readonly discoveredProjectCount: number
	readonly lastResourcesError: string | null
}

export type CreateGcpConnectorInput = Pick<
	GcpConnector,
	"scopeType" | "scopeId" | "projectId" | "logsEnabled" | "metricsEnabled"
>

type GcpCapabilityError = GcpMetricsUnavailableError | IntegrationsValidationError

export interface GcpResourceFilter {
	readonly assetType?: string | undefined
	readonly projectId?: string | undefined
	/** The last segment of the full resource name. */
	readonly name?: string | undefined
}

export interface GcpResourceInventory {
	/** The first `GCP_RESOURCES_LIMIT` resources matching the filter, by asset type and name. */
	readonly resources: ReadonlyArray<GcpResource>
	/** How many resources match the filter. */
	readonly total: number
	/** The whole inventory by asset type. */
	readonly types: ReadonlyArray<{ readonly assetType: string; readonly count: number }>
	/** Every project with a resource. */
	readonly projects: ReadonlyArray<string>
}

export interface GcpConnectorServiceApi {
	readonly status: (orgId: OrgId) => Effect.Effect<
		{
			/** False when this deployment has no Google identity to read metrics with. */
			readonly metricsAvailable: boolean
			readonly connectors: ReadonlyArray<GcpConnector>
		},
		IntegrationsPersistenceError
	>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		input: CreateGcpConnectorInput,
	) => Effect.Effect<
		GcpConnector,
		GcpScopeAlreadyConnectedError | GcpCapabilityError | IntegrationsPersistenceError
	>
	/** Omitted flags are unchanged. Google Cloud only follows once the setup script is re-run. */
	readonly update: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
		patch: { readonly logsEnabled?: boolean | undefined; readonly metricsEnabled?: boolean | undefined },
	) => Effect.Effect<
		GcpConnector,
		IntegrationsNotFoundError | GcpCapabilityError | IntegrationsPersistenceError
	>
	readonly scripts: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
		options: { readonly applicationLogs: ReadonlyArray<GcpLogRuntime> | null },
	) => Effect.Effect<
		{
			readonly setupScript: string
			readonly cleanupScript: string
			/** The same setup without a script, and as Terraform and Alchemy. */
			readonly plan: GcpSetupPlan
			readonly terraform: string
			readonly alchemy: string | null
		},
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
	/**
	 * Reads one project of the scope as the read-only account. Success records the account as in
	 * place, as a script's report does: a setup without the script sends none.
	 */
	readonly checkAccess: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
	) => Effect.Effect<
		{ readonly ok: boolean; readonly message: string | null },
		| IntegrationsNotFoundError
		| IntegrationsValidationError
		| GcpMetricsUnavailableError
		| IntegrationsUpstreamError
		| IntegrationsPersistenceError
	>
	/** What the latest inventory syncs of the org's connectors found. */
	readonly resources: (
		orgId: OrgId,
		filter: GcpResourceFilter,
	) => Effect.Effect<GcpResourceInventory, IntegrationsPersistenceError>
	/** Deleting the row is the disconnect: the ingest gateway stops accepting the connector's pushes. */
	readonly delete: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
	) => Effect.Effect<
		{ readonly connector: GcpConnector; readonly cleanupScript: string },
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
}

const toPersistenceError = makePersistenceErrorMapper(
	IntegrationsPersistenceError,
	"Google Cloud connector database error",
)

// Binds the ciphertext to its row, so a stored secret cannot be moved onto another connector.
const secretAad = (connectorId: string) => Buffer.from(`gcp_connectors:v1:${connectorId}`, "utf8")

const toConnector = (row: GcpConnectorRow, discoveredProjectCount = 0): GcpConnector => ({
	id: row.id,
	scopeType: row.scopeType,
	scopeId: row.scopeId,
	projectId: row.projectId,
	logsEnabled: row.logsEnabled,
	metricsEnabled: row.metricsEnabled,
	createdAt: row.createdAt,
	lastLogReceivedAt: row.lastReceivedAt,
	lastLogError: row.lastError,
	appliedLogsEnabled: row.appliedLogsEnabled,
	appliedMetricsEnabled: row.appliedMetricsEnabled,
	setupReportedAt: row.setupReportedAt,
	lastMetricsReceivedAt: row.lastMetricsReceivedAt,
	lastMetricsError: row.lastMetricsError,
	discoveredProjectCount,
	lastResourcesError: row.lastResourcesError,
})

const notFound = () => new IntegrationsNotFoundError({ message: "No such Google Cloud connector." })

/** Why the access check failed and what to do about it, however the setup was made. */
const explainAccessError = (error: GcpApiError, row: GcpConnectorRow, reader: GcpReaderPlan) => {
	const host = `${row.scopeType === "project" ? "project" : "host project"} ${row.projectId}`
	if (error.api === "IAM Credentials" && (error.kind === "denied" || error.kind === "not_found")) {
		return `Maple can't sign in as ${reader.serviceAccountEmail}: the account does not exist, or ${reader.mapleServiceAccountEmail} lacks Service Account Token Creator on it. Google can take a few minutes to accept a new grant.`
	}
	if (error.reason === "BILLING_DISABLED") {
		return `The ${host} has no active billing account. Link one: https://console.cloud.google.com/billing/linkedaccount?project=${row.projectId}`
	}
	if (error.reason === "SERVICE_DISABLED") {
		return `The ${error.api} API is switched off in the ${host}. Switch it on and check again.`
	}
	if (error.kind === "denied" || error.kind === "not_found") {
		return `Google denied the read of ${row.scopeType} ${row.scopeId} as ${reader.serviceAccountEmail}. It needs ${reader.scopeRoles.join(" and ")} on the ${row.scopeType}, and ${reader.projectRoles.join(" and ")} on the ${host}. A new grant can take a few minutes.`
	}
	return `Google's ${error.api} API did not answer. Try again in a minute.`
}

export class GcpConnectorService extends Context.Service<GcpConnectorService, GcpConnectorServiceApi>()(
	"@maple/api/services/GcpConnectorService",
	{
		make: Effect.gen(function* () {
			const database = yield* Database
			const env = yield* Env
			const encryptionKey = yield* parseBase64Aes256GcmKey(
				Redacted.value(env.MAPLE_INGEST_KEY_ENCRYPTION_KEY),
				(message) => new IntegrationsPersistenceError({ message }),
			)
			// The ingest gateway hashes a pushed secret with this key and looks the row up by it.
			const lookupHmacKey = yield* parseIngestKeyLookupHmacKey(
				Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY),
				(message) => new IntegrationsPersistenceError({ message }),
			)
			const ingestBaseUrl = env.MAPLE_INGEST_PUBLIC_URL.replace(/\/+$/, "")
			const mapleServiceAccountEmail = Option.getOrUndefined(env.MAPLE_GCP_SERVICE_ACCOUNT_EMAIL)
			const httpClient = yield* HttpClient.HttpClient
			const mapleUrl = `${env.MAPLE_APP_BASE_URL.replace(/\/+$/, "")}/integrations?integration=gcp`
			const dbExecute = makeDbExecute(database, "GcpConnectorService", toPersistenceError)

			const capabilityError = (
				flags: { readonly logsEnabled: boolean; readonly metricsEnabled: boolean },
				turningMetricsOn: boolean,
			): GcpCapabilityError | undefined => {
				if (!flags.logsEnabled && !flags.metricsEnabled) {
					return new IntegrationsValidationError({
						message:
							"At least one of logs_enabled and metrics_enabled must be on. Delete the connector to disconnect.",
					})
				}
				if (turningMetricsOn && mapleServiceAccountEmail === undefined) {
					return new GcpMetricsUnavailableError({
						message: "Metrics and resource collection is not available on this Maple deployment.",
					})
				}
				return undefined
			}

			const selectRow = (orgId: OrgId, connectorId: GcpConnectorId) =>
				dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select()
							.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)])
							.limit(1),
					),
				).pipe(
					Effect.flatMap(([row]) =>
						row === undefined ? Effect.fail(notFound()) : Effect.succeed(row),
					),
				)

			/** Projects in each connector's inventory. One the poller has not synced yet is absent. */
			const projectCounts = (connectorIds: ReadonlyArray<GcpConnectorId>) =>
				dbExecute((db) =>
					db.run(
						PG.from(GcpResources)
							.select(($) => ({ connectorId: $.connectorId, count: PG.count() }))
							.where(($) => [
								$.connectorId.in_(...connectorIds),
								$.assetType.eq(GCP_PROJECT_ASSET_TYPE),
							])
							.groupBy("connectorId"),
					),
				).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.connectorId, row.count]))))

			const status = Effect.fn("GcpConnectorService.status")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db.run(
						PG.from(GcpConnectors)
							.select()
							.where(($) => [$.orgId.eq(orgId)])
							.orderBy(["createdAt", "asc"], ["id", "asc"]),
					),
				)
				// No connectors, nothing to count.
				const counts =
					rows.length === 0
						? new Map<GcpConnectorId, number>()
						: yield* projectCounts(rows.map((row) => row.id))
				return {
					metricsAvailable: mapleServiceAccountEmail !== undefined,
					connectors: rows.map((row) => toConnector(row, counts.get(row.id))),
				}
			})

			const resources = Effect.fn("GcpConnectorService.resources")(function* (
				orgId: OrgId,
				filter: GcpResourceFilter,
			) {
				yield* Effect.annotateCurrentSpan({ orgId })
				// Reached through the org's connectors, which is what the primary key covers. One
				// that stopped collecting keeps its last inventory, which is left out. Overlapping
				// scopes list a resource once per connector: it counts and shows once.
				const ofOrg = PG.from(GcpResources)
					.innerJoin(GcpConnectors, "c", (resource, connector) =>
						resource.connectorId.eq(connector.id),
					)
					.where(($) => [$.c.orgId.eq(orgId), $.c.metricsEnabled.eq(true)])
				const counts = yield* dbExecute((db) =>
					db.run(
						ofOrg
							.select(($) => ({
								assetType: $.assetType,
								projectId: $.projectId,
								count: PG.countDistinct($.name),
							}))
							.groupBy("assetType", "projectId"),
					),
				)
				// The counts are by type and project: a name is counted on its own, uncapped.
				const named =
					filter.name === undefined
						? []
						: yield* dbExecute((db) =>
								db.run(
									ofOrg
										.select(($) => ({
											assetType: $.assetType,
											count: PG.countDistinct($.name),
										}))
										.where(($) => [
											filter.assetType === undefined
												? undefined
												: $.assetType.eq(filter.assetType),
											filter.projectId === undefined
												? undefined
												: $.projectId.eq(filter.projectId),
											filter.name === undefined
												? undefined
												: PG.sql
														.cond`split_part(${$.name}, '/', -1) = ${filter.name}`,
										])
										.groupBy("assetType"),
								),
							)
				const rows = yield* dbExecute((db) =>
					db.run(
						ofOrg
							.select(($) => ({
								name: $.name,
								assetType: $.assetType,
								projectId: $.projectId,
								location: $.location,
								displayName: $.displayName,
								state: $.state,
								labels: $.labels,
								details: $.details,
							}))
							.distinctOn("assetType", "name")
							.where(($) => [
								filter.assetType === undefined ? undefined : $.assetType.eq(filter.assetType),
								filter.projectId === undefined ? undefined : $.projectId.eq(filter.projectId),
								filter.name === undefined
									? undefined
									: PG.sql.cond`split_part(${$.name}, '/', -1) = ${filter.name}`,
							])
							.orderBy(($) => [
								[$.assetType, "asc"],
								[$.name, "asc"],
								[$.lastSeenAt, "desc"],
							])
							.limit(GCP_RESOURCES_LIMIT),
					),
				)
				const byType = new Map<string, number>()
				let total = 0
				for (const { assetType, projectId, count } of counts) {
					byType.set(assetType, (byType.get(assetType) ?? 0) + count)
					if (
						(filter.assetType === undefined || filter.assetType === assetType) &&
						(filter.projectId === undefined || filter.projectId === projectId)
					) {
						total += count
					}
				}
				return {
					resources: rows,
					total:
						filter.name === undefined ? total : named.reduce((sum, { count }) => sum + count, 0),
					types: [...byType]
						.map(([assetType, count]) => ({ assetType, count }))
						.sort((a, b) => a.assetType.localeCompare(b.assetType)),
					projects: [...new Set(counts.map((row) => row.projectId))].sort(),
				}
			})

			const create = Effect.fn("GcpConnectorService.create")(function* (
				orgId: OrgId,
				userId: UserId,
				input: CreateGcpConnectorInput,
			) {
				yield* Effect.annotateCurrentSpan({
					orgId,
					"maple.gcp.scope_type": input.scopeType,
					"maple.gcp.scope_id": input.scopeId,
				})
				const invalid = capabilityError(input, input.metricsEnabled)
				if (invalid !== undefined) return yield* Effect.fail(invalid)
				const id = GcpConnectorId.make(randomUUID())
				const secret = `maple_gcp_${randomBytes(24).toString("base64url")}`
				const encrypted = yield* encryptAes256Gcm(
					secret,
					encryptionKey,
					(message) => new IntegrationsPersistenceError({ message }),
					secretAad(id),
				)
				const now = yield* Clock.currentTimeMillis
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.insertInto(GcpConnectors)
							.values({
								id,
								orgId,
								...input,
								secretCiphertext: encrypted.ciphertext,
								secretIv: encrypted.iv,
								secretTag: encrypted.tag,
								secretHash: hashIngestKey(secret, lookupHmacKey),
								createdBy: userId,
								createdAt: now,
								updatedAt: now,
							})
							.onConflictDoNothing({ target: ["orgId", "scopeType", "scopeId"] })
							.returning(),
					),
				)
				if (row === undefined) {
					return yield* new GcpScopeAlreadyConnectedError({
						scopeType: input.scopeType,
						scopeId: input.scopeId,
						message: `The Google Cloud ${input.scopeType} ${input.scopeId} is already connected.`,
					})
				}
				return toConnector(row)
			})

			const update = Effect.fn("GcpConnectorService.update")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
				patch: {
					readonly logsEnabled?: boolean | undefined
					readonly metricsEnabled?: boolean | undefined
				},
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const updatedAt = yield* Clock.currentTimeMillis
				const outcome = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							// The row lock keeps one capability on when two updates race.
							const [current] = yield* db.run(
								PG.from(GcpConnectors)
									.select()
									.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)])
									.limit(1)
									.forUpdate(),
							)
							if (current === undefined) return undefined
							const flags = {
								logsEnabled: patch.logsEnabled ?? current.logsEnabled,
								metricsEnabled: patch.metricsEnabled ?? current.metricsEnabled,
							}
							const invalid = capabilityError(flags, patch.metricsEnabled === true)
							// Switched back on, a capability has nothing set up in Google Cloud until the
							// script is re-run: what it last reported no longer describes the connection.
							const changes = {
								...flags,
								...(flags.logsEnabled && !current.logsEnabled
									? { lastReceivedAt: null, lastError: null }
									: undefined),
								// Only what the card shows: the poller's watermark and lease stay.
								...(flags.metricsEnabled && !current.metricsEnabled
									? { lastMetricsReceivedAt: null, lastMetricsError: null }
									: undefined),
							}
							if (invalid === undefined) {
								yield* db.run(
									PG.update(GcpConnectors)
										.set({ ...changes, updatedAt })
										.where(($) => [$.id.eq(connectorId)]),
								)
							}
							return { row: { ...current, ...changes }, invalid }
						}),
					),
				)
				if (outcome === undefined) return yield* notFound()
				if (outcome.invalid !== undefined) return yield* Effect.fail(outcome.invalid)
				const { row } = outcome
				return toConnector(row, (yield* projectCounts([row.id])).get(row.id))
			})

			const scripts = Effect.fn("GcpConnectorService.scripts")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
				options: { readonly applicationLogs: ReadonlyArray<GcpLogRuntime> | null },
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const row = yield* selectRow(orgId, connectorId)
				const secret = yield* decryptAes256Gcm(
					{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
					encryptionKey,
					() =>
						new IntegrationsPersistenceError({
							message: "Failed to decrypt the Google Cloud connector secret",
						}),
					secretAad(row.id),
				)
				const pushEndpoint = `${ingestBaseUrl}/v1/logpush/gcp/${connectorId}`
				const target = {
					connectorId,
					scopeType: row.scopeType,
					scopeId: row.scopeId,
					projectId: row.projectId,
					mapleUrl,
					pushEndpoint: `${pushEndpoint}?secret=${secret}`,
				}
				const flags = {
					mapleServiceAccountEmail,
					logsEnabled: row.logsEnabled,
					metricsEnabled: row.metricsEnabled,
					applicationLogs: options.applicationLogs,
				}
				// Without the script Pub/Sub signs each push instead, so the endpoint carries no secret.
				const plan = gcpSetupPlan({ ...target, ...flags, pushEndpoint })
				return {
					setupScript: yield* renderGcpSetupScript({ ...target, ...flags }),
					cleanupScript: yield* renderGcpCleanupScript(target),
					plan,
					terraform: renderGcpTerraform(plan),
					alchemy: renderGcpAlchemy(plan),
				}
			})

			const checkAccess = Effect.fn("GcpConnectorService.checkAccess")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const row = yield* selectRow(orgId, connectorId)
				if (!row.metricsEnabled) {
					return yield* new IntegrationsValidationError({
						message:
							"Metrics and resources are off for this connection, so it has no read-only account to check.",
					})
				}
				const key = Option.getOrUndefined(env.MAPLE_GCP_SERVICE_ACCOUNT_KEY)
				if (mapleServiceAccountEmail === undefined || key === undefined) {
					return yield* new GcpMetricsUnavailableError({
						message: "Metrics and resource collection is not available on this Maple deployment.",
					})
				}
				const reader = gcpReaderPlan(row.id, row.projectId, mapleServiceAccountEmail)
				const now = yield* Clock.currentTimeMillis
				// Maple's own sign-in failing is no fault of the connection.
				const mapleToken = yield* importServiceAccountKey(key).pipe(
					Effect.flatMap((signer) => fetchMapleAccessToken(httpClient, signer, now)),
					Effect.tapError((error) =>
						Effect.logError("gcp sign-in as Maple failed", { error: error.message }),
					),
					Effect.mapError(
						() =>
							new IntegrationsUpstreamError({
								message: "Maple could not sign in to Google Cloud",
							}),
					),
				)
				// The id is validated when the connector is created; encoding keeps it inside the path.
				const scope = `${row.scopeType}s/${encodeURIComponent(row.scopeId)}`
				const failure = yield* impersonateReader(httpClient, mapleToken, row).pipe(
					Effect.flatMap((signedIn) => searchOneProject(httpClient, signedIn, scope)),
					Effect.as(null),
					Effect.catchTag("@maple/api/integrations/GcpApiError", (error) =>
						Effect.succeed(`${explainAccessError(error, row, reader)} (${error.message})`),
					),
				)
				if (failure !== null) return { ok: false, message: failure }
				yield* dbExecute((db) =>
					db.run(
						PG.update(GcpConnectors)
							.set({ appliedMetricsEnabled: true, setupReportedAt: now, updatedAt: now })
							.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)]),
					),
				)
				return { ok: true, message: null }
			})

			const deleteConnector = Effect.fn("GcpConnectorService.delete")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const [row] = yield* dbExecute((db) =>
					db.run(
						PG.deleteFrom(GcpConnectors)
							.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)])
							.returning(),
					),
				)
				if (row === undefined) return yield* notFound()
				return {
					connector: toConnector(row),
					// The connector is gone: its script has nothing to report to and carries no secret.
					cleanupScript: yield* renderGcpCleanupScript({
						connectorId,
						scopeType: row.scopeType,
						scopeId: row.scopeId,
						projectId: row.projectId,
						mapleUrl,
						pushEndpoint: undefined,
					}),
				}
			})

			return {
				status,
				resources,
				create,
				update,
				scripts,
				checkAccess,
				delete: deleteConnector,
			} satisfies GcpConnectorServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make).pipe(Layer.provide(FetchHttpClient.layer))
}
