import { randomBytes, randomUUID } from "node:crypto"
import {
	gcpConnectors,
	gcpResources,
	hashIngestKey,
	parseIngestKeyLookupHmacKey,
	type GcpConnectorRow,
} from "@maple/db"
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
	type GcpLogFilter,
	type GcpProjectId,
	type GcpResourceNumber,
	type GcpScopeType,
	type OrgId,
	type UserId,
} from "@maple/domain/primitives"
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm"
import { Clock, Context, Effect, Layer, Option, Redacted } from "effect"
import { decryptAes256Gcm, encryptAes256Gcm, parseBase64Aes256GcmKey } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { makeDbExecute, makePersistenceErrorMapper } from "@maple/backend/platform/db-execute"
import { Env } from "@maple/backend/platform/Env"
import { dateToMs, msToDate } from "@maple/backend/platform/time"
import { renderGcpCleanupScript, renderGcpSetupScript } from "./gcp/setup-scripts"

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
		options: { readonly logFilter: GcpLogFilter },
	) => Effect.Effect<
		{ readonly setupScript: string; readonly cleanupScript: string },
		IntegrationsNotFoundError | IntegrationsPersistenceError
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
	createdAt: dateToMs(row.createdAt),
	lastLogReceivedAt: dateToMs(row.lastReceivedAt),
	lastLogError: row.lastError,
	appliedLogsEnabled: row.appliedLogsEnabled,
	appliedMetricsEnabled: row.appliedMetricsEnabled,
	setupReportedAt: dateToMs(row.setupReportedAt),
	lastMetricsReceivedAt: dateToMs(row.lastMetricsReceivedAt),
	lastMetricsError: row.lastMetricsError,
	discoveredProjectCount,
	lastResourcesError: row.lastResourcesError,
})

const notFound = () => new IntegrationsNotFoundError({ message: "No such Google Cloud connector." })

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
			const lookupHmacKey = yield* Effect.try({
				try: () => parseIngestKeyLookupHmacKey(Redacted.value(env.MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY)),
				catch: () =>
					new IntegrationsPersistenceError({
						message: "MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY is required",
					}),
			})
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
					db
						.select()
						.from(gcpConnectors)
						.where(and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.id, connectorId)))
						.limit(1),
				).pipe(
					Effect.flatMap(([row]) =>
						row === undefined ? Effect.fail(notFound()) : Effect.succeed(row),
					),
				)

			/** Projects in each connector's inventory. One the poller has not synced yet is absent. */
			const projectCounts = (connectorIds: ReadonlyArray<GcpConnectorId>) =>
				dbExecute((db) =>
					db
						.select({ connectorId: gcpResources.connectorId, count: sql<number>`count(*)::int` })
						.from(gcpResources)
						.where(
							and(
								inArray(gcpResources.connectorId, [...connectorIds]),
								eq(gcpResources.assetType, GCP_PROJECT_ASSET_TYPE),
							),
						)
						.groupBy(gcpResources.connectorId),
				).pipe(Effect.map((rows) => new Map(rows.map((row) => [row.connectorId, row.count]))))

			const status = Effect.fn("GcpConnectorService.status")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(gcpConnectors)
						.where(eq(gcpConnectors.orgId, orgId))
						.orderBy(asc(gcpConnectors.createdAt), asc(gcpConnectors.id)),
				)
				// An empty `IN ()` is not valid SQL.
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
				const ofOrg = and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.metricsEnabled, true))
				const counts = yield* dbExecute((db) =>
					db
						.select({
							assetType: gcpResources.assetType,
							projectId: gcpResources.projectId,
							count: sql<number>`count(distinct ${gcpResources.name})::int`,
						})
						.from(gcpResources)
						.innerJoin(gcpConnectors, eq(gcpResources.connectorId, gcpConnectors.id))
						.where(ofOrg)
						.groupBy(gcpResources.assetType, gcpResources.projectId),
				)
				const rows = yield* dbExecute((db) =>
					db
						.selectDistinctOn([gcpResources.assetType, gcpResources.name], {
							name: gcpResources.name,
							assetType: gcpResources.assetType,
							projectId: gcpResources.projectId,
							location: gcpResources.location,
							displayName: gcpResources.displayName,
							state: gcpResources.state,
							labels: gcpResources.labels,
						})
						.from(gcpResources)
						.innerJoin(gcpConnectors, eq(gcpResources.connectorId, gcpConnectors.id))
						.where(
							and(
								ofOrg,
								filter.assetType === undefined
									? undefined
									: eq(gcpResources.assetType, filter.assetType),
								filter.projectId === undefined
									? undefined
									: eq(gcpResources.projectId, filter.projectId),
							),
						)
						.orderBy(
							asc(gcpResources.assetType),
							asc(gcpResources.name),
							desc(gcpResources.lastSeenAt),
						)
						.limit(GCP_RESOURCES_LIMIT),
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
					total,
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
				const now = msToDate(yield* Clock.currentTimeMillis)
				const [row] = yield* dbExecute((db) =>
					db
						.insert(gcpConnectors)
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
						.onConflictDoNothing({
							target: [gcpConnectors.orgId, gcpConnectors.scopeType, gcpConnectors.scopeId],
						})
						.returning(),
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
				const updatedAt = msToDate(yield* Clock.currentTimeMillis)
				const outcome = yield* dbExecute((db) =>
					db.transaction((tx) =>
						Effect.gen(function* () {
							// The row lock keeps one capability on when two updates race.
							const [current] = yield* tx
								.select()
								.from(gcpConnectors)
								.where(and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.id, connectorId)))
								.limit(1)
								.for("update")
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
								yield* tx
									.update(gcpConnectors)
									.set({ ...changes, updatedAt })
									.where(eq(gcpConnectors.id, connectorId))
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
				options: { readonly logFilter: GcpLogFilter },
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
				const target = {
					connectorId,
					scopeType: row.scopeType,
					scopeId: row.scopeId,
					projectId: row.projectId,
					mapleUrl,
					pushEndpoint: `${ingestBaseUrl}/v1/logpush/gcp/${connectorId}?secret=${secret}`,
				}
				return {
					setupScript: yield* renderGcpSetupScript({
						...target,
						mapleServiceAccountEmail,
						logsEnabled: row.logsEnabled,
						metricsEnabled: row.metricsEnabled,
						logFilter: options.logFilter,
					}),
					cleanupScript: yield* renderGcpCleanupScript(target),
				}
			})

			const deleteConnector = Effect.fn("GcpConnectorService.delete")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const [row] = yield* dbExecute((db) =>
					db
						.delete(gcpConnectors)
						.where(and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.id, connectorId)))
						.returning(),
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
				delete: deleteConnector,
			} satisfies GcpConnectorServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
