import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import {
	CreateCustomIngestKeyRequest,
	CustomIngestKeyId,
	OrgId,
	UpdateCustomIngestKeyRequest,
	UserId,
} from "@maple/domain/http"
import { hashIngestKey } from "@maple/db"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/platform/test-pglite"
import { OrgCustomIngestKeysService } from "./OrgCustomIngestKeysService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const LOOKUP_HMAC_KEY = "maple-test-lookup-secret"

const config = ConfigProvider.layer(
	ConfigProvider.fromUnknown({
		PORT: "3472",
		MCP_PORT: "3473",
		TINYBIRD_HOST: "https://api.tinybird.co",
		TINYBIRD_TOKEN: "test-token",
		MAPLE_AUTH_MODE: "self_hosted",
		MAPLE_ROOT_PASSWORD: "test-root-password",
		MAPLE_DEFAULT_ORG_ID: "default",
		MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
		MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: LOOKUP_HMAC_KEY,
	}),
)

const makeLayer = (testDb: TestDb) =>
	OrgCustomIngestKeysService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(config),
	)

const orgA = Schema.decodeUnknownSync(OrgId)("org_a")
const orgB = Schema.decodeUnknownSync(OrgId)("org_b")
const user = Schema.decodeUnknownSync(UserId)("user_a")
const missingId = Schema.decodeUnknownSync(CustomIngestKeyId)("0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b")

describe("OrgCustomIngestKeysService", () => {
	it.effect("creates a key whose secret is stored only as its lookup hash", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateCustomIngestKeyRequest({
					name: "  Checkout staging  ",
					allowedSignals: ["traces", "logs", "traces"],
					rateLimitRps: 200,
					resourceAttributes: [{ key: " service.name ", value: "checkout", mode: "set" }],
				}),
			)

			assert.isTrue(created.secret.startsWith("maple_ik_"))
			assert.isTrue(created.secret.startsWith(created.key.keyPrefix))
			assert.strictEqual(created.key.name, "Checkout staging")
			assert.deepStrictEqual(created.key.allowedSignals, ["traces", "logs"])
			assert.deepStrictEqual(created.key.resourceAttributes, [
				{ key: "service.name", value: "checkout", mode: "set" },
			])

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ key_hash: string }>(
					testDb,
					"SELECT key_hash FROM org_ingest_custom_keys WHERE id = $1",
					[created.key.id],
				),
			)
			assert.strictEqual(row?.key_hash, hashIngestKey(created.secret, LOOKUP_HMAC_KEY))

			const listed = yield* keys.list(orgA)
			assert.deepStrictEqual(listed, [created.key])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects reserved, duplicate and out-of-range settings", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const attempt = (request: CreateCustomIngestKeyRequest) =>
				keys.create(orgA, user, request).pipe(
					Effect.flip,
					Effect.map((error) => error._tag),
				)

			const reserved = yield* attempt(
				new CreateCustomIngestKeyRequest({
					name: "a",
					resourceAttributes: [{ key: "maple_org_id", value: "other", mode: "set" }],
				}),
			)
			const duplicate = yield* attempt(
				new CreateCustomIngestKeyRequest({
					name: "a",
					resourceAttributes: [
						{ key: "env", value: "a", mode: "set" },
						{ key: "env", value: "b", mode: "default" },
					],
				}),
			)
			const rate = yield* attempt(new CreateCustomIngestKeyRequest({ name: "a", rateLimitRps: 0 }))
			const signals = yield* attempt(
				new CreateCustomIngestKeyRequest({ name: "a", allowedSignals: [] }),
			)
			const name = yield* attempt(new CreateCustomIngestKeyRequest({ name: "   " }))
			const expiry = yield* attempt(new CreateCustomIngestKeyRequest({ name: "a", expiresAtMs: 0 }))
			const reservedCase = yield* attempt(
				new CreateCustomIngestKeyRequest({
					name: "a",
					resourceAttributes: [{ key: "Maple_Org_Id", value: "other", mode: "set" }],
				}),
			)
			const emptyValue = yield* attempt(
				new CreateCustomIngestKeyRequest({
					name: "a",
					resourceAttributes: [{ key: "service.name", value: "", mode: "default" }],
				}),
			)
			const description = yield* attempt(
				new CreateCustomIngestKeyRequest({ name: "a", description: "x".repeat(501) }),
			)

			assert.deepStrictEqual(
				[reserved, duplicate, rate, signals, name, expiry, reservedCase, emptyValue, description],
				Array(9).fill("@maple/http/errors/CustomIngestKeyValidationError"),
			)
			assert.deepStrictEqual(yield* keys.list(orgA), [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("updates only the given fields and clears nullable ones with null", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateCustomIngestKeyRequest({ name: "k", rateLimitRps: 10, allowedSignals: ["logs"] }),
			)
			const updated = yield* keys.update(
				orgA,
				user,
				created.key.id,
				new UpdateCustomIngestKeyRequest({ name: "renamed", rateLimitRps: null }),
			)

			assert.strictEqual(updated.name, "renamed")
			assert.isNull(updated.rateLimitRps)
			assert.deepStrictEqual(updated.allowedSignals, ["logs"])
			assert.strictEqual(updated.keyPrefix, created.key.keyPrefix)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("roll replaces the secret but keeps the id and settings", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateCustomIngestKeyRequest({ name: "k", rateLimitRps: 5 }),
			)
			const rolled = yield* keys.roll(orgA, user, created.key.id)

			assert.notStrictEqual(rolled.secret, created.secret)
			assert.strictEqual(rolled.key.id, created.key.id)
			assert.strictEqual(rolled.key.rateLimitRps, 5)

			const oldHashRow = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(
					testDb,
					"SELECT id FROM org_ingest_custom_keys WHERE key_hash = $1",
					[hashIngestKey(created.secret, LOOKUP_HMAC_KEY)],
				),
			)
			assert.isUndefined(oldHashRow)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps keys isolated by org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(orgA, user, new CreateCustomIngestKeyRequest({ name: "k" }))

			const errors = yield* Effect.all([
				keys.get(orgB, created.key.id).pipe(Effect.flip),
				keys
					.update(orgB, user, created.key.id, new UpdateCustomIngestKeyRequest({ name: "x" }))
					.pipe(Effect.flip),
				keys.pause(orgB, user, created.key.id, null).pipe(Effect.flip),
				keys.resume(orgB, user, created.key.id).pipe(Effect.flip),
				keys.roll(orgB, user, created.key.id).pipe(Effect.flip),
				keys.delete(orgB, created.key.id).pipe(Effect.flip),
			])

			assert.deepStrictEqual(
				errors.map((error) => error._tag),
				Array(6).fill("@maple/http/errors/CustomIngestKeyNotFoundError"),
			)
			assert.deepStrictEqual(yield* keys.list(orgB), [])
			assert.strictEqual((yield* keys.get(orgA, created.key.id)).status, "active")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete removes the key", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(orgA, user, new CreateCustomIngestKeyRequest({ name: "k" }))
			yield* keys.delete(orgA, created.key.id)

			assert.deepStrictEqual(yield* keys.list(orgA), [])
			const missing = yield* keys.delete(orgA, missingId).pipe(Effect.flip)
			assert.strictEqual(missing._tag, "@maple/http/errors/CustomIngestKeyNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("caps an organization at 50 keys", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			yield* Effect.forEach(
				Array.from({ length: 50 }, (_, index) => index),
				(index) => keys.create(orgA, user, new CreateCustomIngestKeyRequest({ name: `k${index}` })),
			)
			const overCap = yield* keys
				.create(orgA, user, new CreateCustomIngestKeyRequest({ name: "k50" }))
				.pipe(Effect.flip)

			assert.strictEqual(overCap._tag, "@maple/http/errors/CustomIngestKeyValidationError")
			assert.strictEqual((yield* keys.list(orgA)).length, 50)
			assert.isTrue(
				(yield* keys.create(orgB, user, new CreateCustomIngestKeyRequest({ name: "b" }))).secret
					.length > 0,
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("accepts an unchanged past expiry on update", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateCustomIngestKeyRequest({ name: "k", expiresAtMs: 5_000 }),
			)
			yield* TestClock.adjust("10 seconds")
			const updated = yield* keys.update(
				orgA,
				user,
				created.key.id,
				new UpdateCustomIngestKeyRequest({ name: "renamed", expiresAtMs: 5_000 }),
			)
			const moved = yield* keys
				.update(orgA, user, created.key.id, new UpdateCustomIngestKeyRequest({ expiresAtMs: 6_000 }))
				.pipe(Effect.flip)

			assert.strictEqual(updated.name, "renamed")
			assert.strictEqual(moved._tag, "@maple/http/errors/CustomIngestKeyValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a timed pause ends on its own and resume clears an open-ended one", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			yield* TestClock.adjust("1 minute")
			const created = yield* keys.create(orgA, user, new CreateCustomIngestKeyRequest({ name: "k" }))

			const timed = yield* keys.pause(orgA, user, created.key.id, 60_000 + 3_600_000)
			assert.strictEqual(timed.status, "paused")
			assert.strictEqual(timed.pausedUntil, "1970-01-01T01:01:00.000Z")
			yield* TestClock.adjust("1 hour")
			const ended = yield* keys.get(orgA, created.key.id)
			assert.strictEqual(ended.status, "active")
			assert.isNull(ended.pausedAt)

			const open = yield* keys.pause(orgA, user, created.key.id, null)
			assert.strictEqual(open.status, "paused")
			assert.isNull(open.pausedUntil)
			yield* TestClock.adjust("30 days")
			assert.strictEqual((yield* keys.get(orgA, created.key.id)).status, "paused")
			assert.strictEqual((yield* keys.resume(orgA, user, created.key.id)).status, "active")

			const past = yield* keys.pause(orgA, user, created.key.id, 1_000).pipe(Effect.flip)
			assert.strictEqual(past._tag, "@maple/http/errors/CustomIngestKeyValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reports an expired key as expired even while paused", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* OrgCustomIngestKeysService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateCustomIngestKeyRequest({ name: "k", expiresAtMs: 5_000 }),
			)
			yield* keys.pause(orgA, user, created.key.id, null)
			yield* TestClock.adjust("10 seconds")
			assert.strictEqual((yield* keys.get(orgA, created.key.id)).status, "expired")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
