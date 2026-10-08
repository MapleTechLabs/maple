import { randomBytes, randomUUID } from "node:crypto"
import { gcpConnectors, hashIngestKey, parseIngestKeyLookupHmacKey, type GcpConnectorRow } from "@maple/db"
import {
	GcpMetricsUnavailableError,
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
import { and, asc, eq } from "drizzle-orm"
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
}

export type CreateGcpConnectorInput = Pick<
	GcpConnector,
	"scopeType" | "scopeId" | "projectId" | "logsEnabled" | "metricsEnabled"
>

type GcpCapabilityError = GcpMetricsUnavailableError | IntegrationsValidationError

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

const toConnector = (row: GcpConnectorRow): GcpConnector => ({
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

			const status = Effect.fn("GcpConnectorService.status")(function* (orgId: OrgId) {
				yield* Effect.annotateCurrentSpan({ orgId })
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(gcpConnectors)
						.where(eq(gcpConnectors.orgId, orgId))
						.orderBy(asc(gcpConnectors.createdAt), asc(gcpConnectors.id)),
				)
				return {
					metricsAvailable: mapleServiceAccountEmail !== undefined,
					connectors: rows.map(toConnector),
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
				return toConnector(outcome.row)
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
