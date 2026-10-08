import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { hashIngestKey } from "@maple/db"
import { gcpConnectorResourceNames } from "@maple/domain/gcp"
import { GcpProjectId, OrgId, UserId } from "@maple/domain/primitives"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { GcpConnectorService, type GcpConnector } from "./GcpConnectorService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const LOOKUP_HMAC_KEY = "maple-test-lookup-secret"
const MAPLE_ACCOUNT = "collector@maple-prod.iam.gserviceaccount.com"

// A fresh layer per call: one test builds the service twice, under two configurations.
const makeLayer = (testDb: TestDb, mapleServiceAccount?: string) =>
	Layer.effect(GcpConnectorService, GcpConnectorService.make).pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3472",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
					// Padded: the gateway trims this key before hashing, so the API must too.
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: ` ${LOOKUP_HMAC_KEY} `,
					MAPLE_INGEST_PUBLIC_URL: "https://ingest.test/",
					...(mapleServiceAccount === undefined
						? undefined
						: { MAPLE_GCP_SERVICE_ACCOUNT_EMAIL: mapleServiceAccount }),
				}),
			),
		),
	)

const orgId = Schema.decodeUnknownSync(OrgId)("org_gcp")
const otherOrgId = Schema.decodeUnknownSync(OrgId)("org_other")
const userId = Schema.decodeUnknownSync(UserId)("user_1")
const projectId = Schema.decodeUnknownSync(GcpProjectId)

interface StoredConnector {
	readonly secret_ciphertext: string
	readonly secret_hash: string
	readonly created_by: string
}

describe("GcpConnectorService", () => {
	it.effect("stores a connector whose secret hash is the one the ingest gateway computes", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectId("acme-prod"))
			assert.strictEqual(connector.projectId, "acme-prod")
			assert.isNull(connector.lastLogReceivedAt)
			assert.isNull(connector.lastLogError)

			const { setupScript } = yield* gcp.scripts(orgId, connector.id, {
				excludeGkeContainerLogs: false,
			})
			const endpoint = /PUSH_ENDPOINT='([^']+)'/.exec(setupScript)?.[1]
			assert.isDefined(endpoint)
			const url = new URL(endpoint!)
			assert.strictEqual(
				url.origin + url.pathname,
				`https://ingest.test/v1/logpush/gcp/${connector.id}`,
			)
			const secret = url.searchParams.get("secret")!
			assert.match(secret, /^maple_gcp_[A-Za-z0-9_-]{32}$/)

			const row = yield* Effect.promise(() =>
				queryFirstRow<StoredConnector>(testDb, "SELECT * FROM gcp_connectors WHERE id = $1", [
					connector.id,
				]),
			)
			assert.strictEqual(row!.secret_hash, hashIngestKey(secret, LOOKUP_HMAC_KEY))
			assert.notInclude(row!.secret_ciphertext, secret)
			assert.strictEqual(row!.created_by, userId)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a project the organization already connected, but not another organization's", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			yield* gcp.create(orgId, userId, projectId("acme-prod"))
			const duplicate = yield* Effect.flip(gcp.create(orgId, userId, projectId("acme-prod")))
			assert.strictEqual(duplicate._tag, "@maple/http/errors/GcpProjectAlreadyConnectedError")

			yield* gcp.create(otherOrgId, userId, projectId("acme-prod"))
			assert.lengthOf((yield* gcp.status(orgId)).connectors, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reports the gateway's last push and renders metrics steps only with a Google identity", () => {
		const testDb = createTestDb(trackedDbs)
		const withoutMetrics = Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectId("acme-prod"))
			// What the ingest gateway writes after a rejected push.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"UPDATE gcp_connectors SET last_received_at = $1, last_error = $2 WHERE id = $3",
					["2026-10-08T09:12:00.000Z", "payload was not a LogEntry", connector.id],
				),
			)
			const status = yield* gcp.status(orgId)
			assert.isFalse(status.metricsAvailable)
			assert.deepStrictEqual(status.connectors, [
				{
					...connector,
					lastLogReceivedAt: Date.parse("2026-10-08T09:12:00.000Z"),
					lastLogError: "payload was not a LogEntry",
				},
			])
			const scripts = yield* gcp.scripts(orgId, connector.id, { excludeGkeContainerLogs: true })
			assert.notInclude(scripts.setupScript, "service-accounts")
			assert.include(scripts.setupScript, 'NOT resource.type="k8s_container"')
			return connector
		}).pipe(Effect.provide(makeLayer(testDb)))

		const withMetrics = Effect.fnUntraced(function* (connectorId: GcpConnector["id"]) {
			const gcp = yield* GcpConnectorService
			assert.isTrue((yield* gcp.status(orgId)).metricsAvailable)
			const scripts = yield* gcp.scripts(orgId, connectorId, { excludeGkeContainerLogs: false })
			assert.include(scripts.setupScript, `MAPLE_SERVICE_ACCOUNT='${MAPLE_ACCOUNT}'`)
			assert.notInclude(scripts.cleanupScript, "maple_gcp_")
		})

		return withoutMetrics.pipe(
			Effect.flatMap((connector) =>
				withMetrics(connector.id).pipe(Effect.provide(makeLayer(testDb, MAPLE_ACCOUNT))),
			),
		)
	})

	it.effect("refuses to render a secret that was moved onto another connector's row", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const source = yield* gcp.create(orgId, userId, projectId("acme-prod"))
			const target = yield* gcp.create(orgId, userId, projectId("acme-staging"))
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE gcp_connectors AS t
					 SET secret_ciphertext = s.secret_ciphertext, secret_iv = s.secret_iv, secret_tag = s.secret_tag
					 FROM gcp_connectors AS s WHERE s.id = $1 AND t.id = $2`,
					[source.id, target.id],
				),
			)
			const error = yield* Effect.flip(
				gcp.scripts(orgId, target.id, { excludeGkeContainerLogs: false }),
			)
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsPersistenceError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("scopes scripts and deletion to the owning organization", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const gcp = yield* GcpConnectorService
			const connector = yield* gcp.create(orgId, userId, projectId("acme-prod"))

			const options = { excludeGkeContainerLogs: false }
			const foreignScripts = yield* Effect.flip(gcp.scripts(otherOrgId, connector.id, options))
			assert.strictEqual(foreignScripts._tag, "@maple/http/errors/IntegrationsNotFoundError")
			const foreignDelete = yield* Effect.flip(gcp.delete(otherOrgId, connector.id))
			assert.strictEqual(foreignDelete._tag, "@maple/http/errors/IntegrationsNotFoundError")

			const deleted = yield* gcp.delete(orgId, connector.id)
			assert.strictEqual(deleted.projectId, "acme-prod")
			assert.include(deleted.cleanupScript, gcpConnectorResourceNames(connector.id).sink)
			assert.deepStrictEqual((yield* gcp.status(orgId)).connectors, [])
			const again = yield* Effect.flip(gcp.delete(orgId, connector.id))
			assert.strictEqual(again._tag, "@maple/http/errors/IntegrationsNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
