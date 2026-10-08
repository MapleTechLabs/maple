import { randomBytes, randomUUID } from "node:crypto"
import { gcpConnectors, hashIngestKey, parseIngestKeyLookupHmacKey, type GcpConnectorRow } from "@maple/db"
import {
	GcpProjectAlreadyConnectedError,
	IntegrationsNotFoundError,
	IntegrationsPersistenceError,
} from "@maple/domain/http"
import { GcpConnectorId, type GcpProjectId, type OrgId, type UserId } from "@maple/domain/primitives"
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
	readonly projectId: GcpProjectId
	readonly createdAt: number
	/** Last log push the ingest gateway accepted from this project. Null until the first one. */
	readonly lastLogReceivedAt: number | null
	readonly lastLogError: string | null
}

export interface GcpConnectorServiceApi {
	readonly status: (orgId: OrgId) => Effect.Effect<
		{
			/** False when this deployment has no Google identity, so connectors are logs-only. */
			readonly metricsAvailable: boolean
			readonly connectors: ReadonlyArray<GcpConnector>
		},
		IntegrationsPersistenceError
	>
	readonly create: (
		orgId: OrgId,
		userId: UserId,
		projectId: GcpProjectId,
	) => Effect.Effect<GcpConnector, GcpProjectAlreadyConnectedError | IntegrationsPersistenceError>
	readonly scripts: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
		options: { readonly excludeGkeContainerLogs: boolean },
	) => Effect.Effect<
		{ readonly setupScript: string; readonly cleanupScript: string },
		IntegrationsNotFoundError | IntegrationsPersistenceError
	>
	/** Deleting the row is the disconnect: the ingest gateway stops accepting the project's pushes. */
	readonly delete: (
		orgId: OrgId,
		connectorId: GcpConnectorId,
	) => Effect.Effect<
		{ readonly projectId: GcpProjectId; readonly cleanupScript: string },
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
	projectId: row.projectId,
	createdAt: dateToMs(row.createdAt),
	lastLogReceivedAt: dateToMs(row.lastReceivedAt),
	lastLogError: row.lastError,
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
			const dbExecute = makeDbExecute(database, "GcpConnectorService", toPersistenceError)

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
				projectId: GcpProjectId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.project_id": projectId })
				const id = GcpConnectorId.make(randomUUID())
				const secret = `maple_gcp_${randomBytes(24).toString("base64url")}`
				const encrypted = yield* encryptAes256Gcm(
					secret,
					encryptionKey,
					(message) => new IntegrationsPersistenceError({ message }),
					secretAad(id),
				)
				const now = msToDate(yield* Clock.currentTimeMillis)
				const rows = yield* dbExecute((db) =>
					db
						.insert(gcpConnectors)
						.values({
							id,
							orgId,
							projectId,
							secretCiphertext: encrypted.ciphertext,
							secretIv: encrypted.iv,
							secretTag: encrypted.tag,
							secretHash: hashIngestKey(secret, lookupHmacKey),
							createdBy: userId,
							createdAt: now,
							updatedAt: now,
						})
						.onConflictDoNothing({ target: [gcpConnectors.orgId, gcpConnectors.projectId] })
						.returning(),
				)
				const row = rows[0]
				if (row === undefined) {
					return yield* new GcpProjectAlreadyConnectedError({
						projectId,
						message: `Google Cloud project ${projectId} is already connected.`,
					})
				}
				return toConnector(row)
			})

			const scripts = Effect.fn("GcpConnectorService.scripts")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
				options: { readonly excludeGkeContainerLogs: boolean },
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const rows = yield* dbExecute((db) =>
					db
						.select()
						.from(gcpConnectors)
						.where(and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.id, connectorId)))
						.limit(1),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound()
				const secret = yield* decryptAes256Gcm(
					{ ciphertext: row.secretCiphertext, iv: row.secretIv, tag: row.secretTag },
					encryptionKey,
					() =>
						new IntegrationsPersistenceError({
							message: "Failed to decrypt the Google Cloud connector secret",
						}),
					secretAad(row.id),
				)
				return {
					setupScript: renderGcpSetupScript({
						connectorId,
						projectId: row.projectId,
						pushEndpoint: `${ingestBaseUrl}/v1/logpush/gcp/${connectorId}?secret=${secret}`,
						mapleServiceAccountEmail,
						excludeGkeContainerLogs: options.excludeGkeContainerLogs,
					}),
					cleanupScript: renderGcpCleanupScript(connectorId, row.projectId),
				}
			})

			const deleteConnector = Effect.fn("GcpConnectorService.delete")(function* (
				orgId: OrgId,
				connectorId: GcpConnectorId,
			) {
				yield* Effect.annotateCurrentSpan({ orgId, "maple.gcp.connector_id": connectorId })
				const rows = yield* dbExecute((db) =>
					db
						.delete(gcpConnectors)
						.where(and(eq(gcpConnectors.orgId, orgId), eq(gcpConnectors.id, connectorId)))
						.returning({ projectId: gcpConnectors.projectId }),
				)
				const row = rows[0]
				if (row === undefined) return yield* notFound()
				return {
					projectId: row.projectId,
					cleanupScript: renderGcpCleanupScript(connectorId, row.projectId),
				}
			})

			return { status, create, scripts, delete: deleteConnector } satisfies GcpConnectorServiceApi
		}),
	},
) {
	static readonly layer = Layer.effect(this, this.make)
}
