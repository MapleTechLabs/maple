import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Option, Schema } from "effect"
import { ApiKeyNotFoundError, OrgId, UserId } from "@maple/domain/http"
import { DatabaseLibsqlLive } from "../lib/DatabaseLibsqlLive"
import { Env } from "../lib/Env"
import { ApiKeysService } from "./ApiKeysService"
import { cleanupTempDirs, createTempDbUrl as makeTempDb } from "../lib/test-sqlite"

const createdTempDirs: string[] = []

afterEach(() => {
	cleanupTempDirs(createdTempDirs)
})

const createTempDbUrl = () => makeTempDb("maple-api-keys-", createdTempDirs)

const makeConfig = (url: string) =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_DB_URL: url,
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (url: string) =>
	ApiKeysService.layer.pipe(
		Layer.provide(DatabaseLibsqlLive),
		Layer.provide(Env.layer),
		Layer.provide(makeConfig(url)),
	)

const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

describe("ApiKeysService.roll", () => {
	it.effect("revokes the old key and issues a new active key inheriting name/kind", () => {
		const { url } = createTempDbUrl()

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_a")

			const created = yield* svc.create(orgId, asUserId("user_a"), {
				name: "CI/CD Pipeline",
				description: "deploys",
				kind: "mcp",
			})

			const rolled = yield* svc.roll(orgId, asUserId("user_b"), created.id, {
				createdByEmail: "roller@example.com",
			})

			// New, distinct key that inherits identity but gets a fresh secret/prefix.
			assert.notStrictEqual(rolled.id, created.id)
			assert.strictEqual(rolled.name, created.name)
			assert.strictEqual(rolled.kind, "mcp")
			assert.notStrictEqual(rolled.keyPrefix, created.keyPrefix)
			assert.notStrictEqual(rolled.secret, created.secret)
			assert.strictEqual(rolled.revoked, false)
			assert.strictEqual(rolled.lastUsedAt, null)
			assert.strictEqual(rolled.expiresAt, null)

			const { keys } = yield* svc.list(orgId)
			const oldRow = keys.find((k) => k.id === created.id)
			const newRow = keys.find((k) => k.id === rolled.id)

			assert.isDefined(oldRow)
			assert.strictEqual(oldRow?.revoked, true)
			assert.isNumber(oldRow?.revokedAt)
			assert.isDefined(newRow)
			assert.strictEqual(newRow?.revoked, false)

			// The new secret authenticates; the old one no longer does.
			const resolvedNew = yield* svc.resolveByKey(rolled.secret)
			const resolvedOld = yield* svc.resolveByKey(created.secret)
			assert.isTrue(Option.isSome(resolvedNew))
			if (Option.isSome(resolvedNew)) {
				assert.strictEqual(resolvedNew.value.keyId, rolled.id)
			}
			assert.deepStrictEqual(resolvedOld, Option.none())
		}).pipe(Effect.provide(makeLayer(url)))
	})

	it.effect("fails to roll an already-revoked key", () => {
		const { url } = createTempDbUrl()

		return Effect.gen(function* () {
			const svc = yield* ApiKeysService
			const orgId = asOrgId("org_a")

			const created = yield* svc.create(orgId, asUserId("user_a"), { name: "temp" })
			yield* svc.revoke(orgId, created.id)

			const exit = yield* Effect.exit(svc.roll(orgId, asUserId("user_a"), created.id, {}))

			assert.isTrue(Exit.isFailure(exit))
			const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
			assert.instanceOf(failure, ApiKeyNotFoundError)
		}).pipe(Effect.provide(makeLayer(url)))
	})
})
