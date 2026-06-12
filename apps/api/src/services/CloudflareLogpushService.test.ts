import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { hashCloudflareLogpushSecret } from "@maple/db"
import {
	CloudflareLogpushNotFoundError,
	CloudflareLogpushValidationError,
	OrgId,
	UserId,
} from "@maple/domain/http"
import { Env } from "../lib/Env"
import { CloudflareLogpushService } from "./CloudflareLogpushService"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "../lib/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

const makeConfig = (ingestPublicUrl = "https://ingest.example.com") =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
			MAPLE_INGEST_PUBLIC_URL: ingestPublicUrl,
		}),
	)

const makeLayer = (testDb: TestDb, ingestPublicUrl?: string) =>
	CloudflareLogpushService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(ingestPublicUrl)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

describe("CloudflareLogpushService", () => {
	it.effect("creates a connector with encrypted secret and generated setup", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const result = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})

			assert.strictEqual(result.connector.serviceName, "cloudflare/example.com")
			assert.strictEqual(result.connector.dataset, "http_requests")
			assert.isTrue(
				result.setup.destinationConf.startsWith(
					`https://ingest.example.com/v1/logpush/cloudflare/http_requests/${result.connector.id}?secret=maple_cf_`,
				),
			)

			const row = yield* Effect.promise(() =>
				queryFirstRow<{
					secret_ciphertext: string
					secret_hash: string
				}>(
					testDb,
					"SELECT secret_ciphertext, secret_hash FROM cloudflare_logpush_connectors WHERE id = $1",
					[result.connector.id],
				),
			)

			const secret = new URL(result.setup.destinationConf).searchParams.get("secret")!
			assert.isDefined(row)
			assert.notStrictEqual(row?.secret_ciphertext, secret)
			assert.strictEqual(
				row?.secret_hash,
				hashCloudflareLogpushSecret(secret, "maple-test-lookup-secret"),
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lists connectors without exposing secrets", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})

			const result = yield* service.list(asOrgId("org_a"))

			assert.strictEqual(result.connectors.length, 1)
			assert.strictEqual("secret" in result.connectors[0]!, false)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("returns deterministic setup payload for an existing connector", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const created = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})
			const setup = yield* service.getSetup(asOrgId("org_a"), created.connector.id)

			assert.strictEqual(setup.destinationConf, created.setup.destinationConf)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rotates only the secret", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const created = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})
			const rotated = yield* service.rotateSecret(
				asOrgId("org_a"),
				created.connector.id,
				asUserId("user_b"),
			)
			const connector = yield* service.list(asOrgId("org_a")).pipe(
				Effect.map((rows) => rows.connectors[0]!),
			)

			assert.notStrictEqual(rotated.destinationConf, created.setup.destinationConf)
			assert.strictEqual(connector.name, created.connector.name)
			assert.strictEqual(connector.zoneName, created.connector.zoneName)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("updates metadata without changing the secret", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const created = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})
			const updated = yield* service.update(
				asOrgId("org_a"),
				created.connector.id,
				asUserId("user_b"),
				{
					name: "Zone A",
					zoneName: "zone-a.example.com",
					serviceName: "cloudflare/zone-a",
					enabled: false,
				},
			)
			const setup = yield* service.getSetup(asOrgId("org_a"), created.connector.id)

			assert.strictEqual(updated.name, "Zone A")
			assert.strictEqual(updated.zoneName, "zone-a.example.com")
			assert.strictEqual(updated.serviceName, "cloudflare/zone-a")
			assert.strictEqual(updated.enabled, false)
			assert.strictEqual(setup.destinationConf, created.setup.destinationConf)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("deletes a connector", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const created = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})
			yield* service.delete(asOrgId("org_a"), created.connector.id)
			const result = yield* service.list(asOrgId("org_a"))

			assert.deepStrictEqual(result.connectors, [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("isolates connectors by org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const created = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: "Edge requests",
				zoneName: "example.com",
			})

			const missing = yield* service.getSetup(asOrgId("org_b"), created.connector.id).pipe(
				Effect.flip,
			)

			assert.instanceOf(missing, CloudflareLogpushNotFoundError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects blank names and zone names", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const service = yield* CloudflareLogpushService
			const result = yield* service.create(asOrgId("org_a"), asUserId("user_a"), {
				name: " ",
				zoneName: " ",
			}).pipe(Effect.flip)

			assert.instanceOf(result, CloudflareLogpushValidationError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
