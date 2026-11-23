import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { OrgId, UserId } from "@maple/domain/http"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { IngestSetupService } from "./IngestSetupService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		MAPLE_INGEST_PUBLIC_URL: "https://ingest.eu.maple.test/",
		MAPLE_APP_BASE_URL: "https://app.eu.maple.test",
	}),
)

const orgId = Schema.decodeSync(OrgId)("org_setup")
const userId = Schema.decodeSync(UserId)("user_setup")

describe("IngestSetupService", () => {
	it.effect("returns a public key another isolate rolled, not this isolate's memoized one", () => {
		const testDb = createTestDb(trackedDbs)
		const base = Layer.mergeAll(testDb.layer, Env.layer.pipe(Layer.provide(config)))
		// Two key-service instances on one database: this isolate's (inside the setup service) and the API's.
		const setupLayer = IngestSetupService.layer.pipe(Layer.provide(base))
		const apiKeysLayer = Layer.fresh(OrgIngestKeysService.layer).pipe(Layer.provide(base))

		return Effect.gen(function* () {
			const setup = yield* IngestSetupService
			const first = yield* setup.forOrg(orgId, userId)
			assert.strictEqual(first.ingestEndpoint, "https://ingest.eu.maple.test")
			assert.strictEqual(first.dashboardUrl, "https://app.eu.maple.test")
			// A read of the existing row is what fills this isolate's memo.
			const warmed = yield* setup.forOrg(orgId, userId)
			assert.strictEqual(warmed.publicIngestKey, first.publicIngestKey)

			const rolled = yield* Effect.provide(
				Effect.gen(function* () {
					const keys = yield* OrgIngestKeysService
					return yield* keys.rerollPublic(orgId, userId)
				}),
				apiKeysLayer,
			)
			assert.notStrictEqual(rolled.publicKey, first.publicIngestKey)

			// Same setup instance, so its memo still holds the old row: only the forced re-read sees the roll.
			const again = yield* setup.forOrg(orgId, userId)
			assert.strictEqual(again.publicIngestKey, rolled.publicKey)
		}).pipe(Effect.provide(setupLayer))
	})
})
