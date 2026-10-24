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
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { gcpSetupPlan } from "@maple/domain/gcp"
import { renderGcpAlchemy } from "./gcp/alchemy"
import { gcpLogFilter, renderGcpCleanupScript, renderGcpSetupScript } from "./gcp/setup-scripts"
import { renderGcpTerraform } from "./gcp/terraform"
import {
	deleteSourcesOf,
	createIntegrationSource,
	integrationSourceName,
	reportPoll,
} from "@maple/backend/services/org/integration-sources"

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
			/** What a setup without the script needs beyond the connector: no secret in either. */
			readonly pushEndpoint: string
			readonly logFilter: string
			/** Null on a deployment without a Google identity. */
			readonly mapleServiceAccountEmail: string | null
			readonly terraform: string
			readonly alchemy: string
		},
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
	/**
	 * Records what a setup without the script removed, on the caller's word: nothing reports it.
	 * Only capabilities that are off and still recorded as set up change.
	 */
	readonly confirmRemoval: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
	) => Effect.Effect<GcpConnector, IntegrationsNotFoundError | IntegrationsPersistenceError>
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

export class GcpConnectorService extends Context.Service<GcpConnectorService, GcpConnectorServiceApi>()(
	"@maple/backend/services/GcpConnectorService",
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
				// The connector and the source it sends as land together.
				const [row] = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const sourceId = yield* createIntegrationSource(
								db,
								orgId,
								{ platform: "gcp", name: integrationSourceName.gcp(input) },
								now,
							)
							const inserted = yield* db.run(
								PG.insertInto(GcpConnectors)
									.values({
										id,
										orgId,
										sourceId,
										...input,
										// What is created off is known not to exist; switching it on later resets this to null.
										appliedLogsEnabled: input.logsEnabled ? null : false,
										appliedMetricsEnabled: input.metricsEnabled ? null : false,
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
							)
							// A scope that is already connected keeps no source of its own.
							if (inserted.length === 0) yield* deleteSourcesOf(db, orgId, [{ sourceId }])
							return inserted
						}),
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
							// Switched back on, a capability's last data and error no longer describe it. One
							// reported removed is unknown again, so the first push or metrics read confirms it.
							const changes = {
								...flags,
								...(flags.logsEnabled && !current.logsEnabled
									? {
											lastReceivedAt: null,
											lastError: null,
											...(current.appliedLogsEnabled === false
												? { appliedLogsEnabled: null }
												: undefined),
										}
									: undefined),
								// Only what the card shows: the poller's watermark and lease stay.
								...(flags.metricsEnabled && !current.metricsEnabled
									? {
											lastMetricsReceivedAt: null,
											lastMetricsError: null,
											...(current.appliedMetricsEnabled === false
												? { appliedMetricsEnabled: null }
												: undefined),
										}
									: undefined),
							}
							if (invalid === undefined) {
								yield* db.run(
									PG.update(GcpConnectors)
										.set({ ...changes, updatedAt })
										.where(($) => [$.id.eq(connectorId)]),
								)
								// Metrics switched off: the last read's error no longer describes the source.
								if (current.metricsEnabled && !flags.metricsEnabled) {
									yield* reportPoll(db, current.sourceId, { _tag: "Ok" }, updatedAt)
								}
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
				// Without the script there is no filter to keep: a setup as code sets the recommended one.
				const logFilter = gcpLogFilter(options.applicationLogs ?? [])
				// Without the script Pub/Sub signs each push instead, so the endpoint carries no secret.
				const plan = gcpSetupPlan({ ...target, ...flags, pushEndpoint, logFilter })
				const existing = {
					logs: row.appliedLogsEnabled === true,
					reader: row.appliedMetricsEnabled === true,
				}
				return {
					setupScript: yield* renderGcpSetupScript({ ...target, ...flags }),
					cleanupScript: yield* renderGcpCleanupScript(target),
					pushEndpoint,
					logFilter,
					mapleServiceAccountEmail: mapleServiceAccountEmail ?? null,
					terraform: renderGcpTerraform(plan, existing),
					alchemy: renderGcpAlchemy(plan, existing),
				}
			})

			const confirmRemoval = Effect.fn("GcpConnectorService.confirmRemoval")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const updatedAt = yield* Clock.currentTimeMillis
				// Each write checks its own switch, so an update racing this one can't be undone by it.
				yield* dbExecute((db) =>
					Effect.all([
						db.run(
							PG.update(GcpConnectors)
								.set({ appliedLogsEnabled: false, updatedAt })
								.where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(connectorId),
									$.logsEnabled.eq(false),
									$.appliedLogsEnabled.eq(true),
								]),
						),
						db.run(
							PG.update(GcpConnectors)
								.set({ appliedMetricsEnabled: false, updatedAt })
								.where(($) => [
									$.orgId.eq(orgId),
									$.id.eq(connectorId),
									$.metricsEnabled.eq(false),
									$.appliedMetricsEnabled.eq(true),
								]),
						),
					]),
				)
				const row = yield* selectRow(orgId, connectorId)
				return toConnector(row, (yield* projectCounts([row.id])).get(row.id))
			})

			const deleteConnector = Effect.fn("GcpConnectorService.delete")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				// Its source goes with it.
				const [row] = yield* dbExecute((db) =>
					db.transaction(
						Effect.gen(function* () {
							const deleted = yield* db.run(
								PG.deleteFrom(GcpConnectors)
									.where(($) => [$.orgId.eq(orgId), $.id.eq(connectorId)])
									.returning(),
							)
							yield* deleteSourcesOf(db, orgId, deleted)
							return deleted
						}),
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
				confirmRemoval,
				delete: deleteConnector,
			} satisfies GcpConnectorServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
