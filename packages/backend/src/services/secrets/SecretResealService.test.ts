import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, String as Str } from "effect"
import type { EncryptedValue } from "@maple/backend/platform/Crypto"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { openSecret, parseSecretKeyring, sealSecret } from "@maple/backend/platform/SecretBox"
import {
	clickHousePasswordSlot,
	oauthAccessTokenSlot,
	oauthRefreshTokenSlot,
	openRouterKeySlot,
} from "@maple/backend/platform/secret-slots"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { RESEAL_TARGETS } from "./reseal-targets"
import { SecretResealService } from "./SecretResealService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const keyOf = (byte: number) => Buffer.alloc(32, byte).toString("base64")
const fail = (message: string) => message

const keyring = (primary: number, decryptOnly: ReadonlyArray<number> = []) =>
	parseSecretKeyring(
		{
			primary: keyOf(primary),
			decryptOnly: Option.some(Arr.join(Arr.map(decryptOnly, keyOf), ",")),
		},
		fail,
	)

/** The service as a deployment whose primary key is `primary`, with `decryptOnly` kept for opening. */
const layer = (testDb: TestDb, primary: number, decryptOnly: ReadonlyArray<number> = []) =>
	SecretResealService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(
			Env.layer.pipe(
				Layer.provide(
					ConfigProvider.layer(
						ConfigProvider.fromUnknown({
							PORT: "3472",
							TINYBIRD_HOST: "https://api.tinybird.co",
							TINYBIRD_TOKEN: "test-token",
							MAPLE_AUTH_MODE: "self_hosted",
							MAPLE_ROOT_PASSWORD: "test-root-password",
							MAPLE_DEFAULT_ORG_ID: "default",
							MAPLE_INGEST_KEY_ENCRYPTION_KEY: keyOf(primary),
							MAPLE_INGEST_KEY_DECRYPTION_KEYS: Arr.join(Arr.map(decryptOnly, keyOf), ","),
							MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
						}),
					),
				),
			),
		),
	)

const sweep = (testDb: TestDb, primary: number, decryptOnly: ReadonlyArray<number> = []) =>
	SecretResealService.use((service) => service.resealDue).pipe(
		Effect.provide(layer(testDb, primary, decryptOnly)),
	)

const NOW = "2026-11-10T00:00:00.000Z"

const seedClickHouseSettings = (testDb: TestDb, orgId: string, password: EncryptedValue) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into org_clickhouse_settings
				(org_id, ch_url, ch_user, ch_password_ciphertext, ch_password_iv, ch_password_tag,
				 ch_database, sync_status, created_at, updated_at, created_by, updated_by)
			 values ($1, 'https://ch.example', 'maple', $2, $3, $4, 'maple', 'connected', $5, $5, 'u', 'u')`,
			[orgId, password.ciphertext, password.iv, password.tag, NOW],
		),
	)

const seedOpenRouterKey = (testDb: TestDb, orgId: string, key: EncryptedValue) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into org_openrouter_keys
				(org_id, key_ciphertext, key_iv, key_tag, key_hint, created_at, updated_at, updated_by)
			 values ($1, $2, $3, $4, 'cdef', $5, $5, 'user_1')`,
			[orgId, key.ciphertext, key.iv, key.tag, NOW],
		),
	)

const seedOAuthConnection = (
	testDb: TestDb,
	orgId: string,
	provider: string,
	access: EncryptedValue,
	refresh: EncryptedValue,
) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`insert into oauth_connections
				(id, org_id, provider, external_user_id, connected_by_user_id,
				 access_token_ciphertext, access_token_iv, access_token_tag,
				 refresh_token_ciphertext, refresh_token_iv, refresh_token_tag, created_at, updated_at)
			 values ($1, $2, $3, 'ext', 'user_1', $4, $5, $6, $7, $8, $9, $10, $10)`,
			[
				`${orgId}-${provider}`,
				orgId,
				provider,
				access.ciphertext,
				access.iv,
				access.tag,
				refresh.ciphertext,
				refresh.iv,
				refresh.tag,
				NOW,
			],
		),
	)

const readTriple = (testDb: TestDb, sql: string, params: ReadonlyArray<string>) =>
	Effect.promise(() => queryFirstRow<EncryptedValue>(testDb, sql, [...params])).pipe(
		Effect.flatMap((row) => Effect.fromNullishOr(row)),
		Effect.orDie,
	)

const clickHousePassword = (testDb: TestDb, orgId: string) =>
	readTriple(
		testDb,
		`select ch_password_ciphertext as ciphertext, ch_password_iv as iv, ch_password_tag as tag
		 from org_clickhouse_settings where org_id = $1`,
		[orgId],
	)

/** A ClickHouse password sealed for `orgId` by a deployment whose primary key was `key`. */
const sealedPassword = (key: number, orgId: string, password: string) =>
	Effect.flatMap(keyring(key), (ring) =>
		sealSecret(ring, clickHousePasswordSlot, { orgId }, password, fail),
	)

describe("SecretResealService", () => {
	it.effect("reads every sealed column without touching an empty database", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 0, failed: 0, remaining: 0 })
		})
	})

	it.effect(
		"after a rotation, moves values onto the new key, still bound to their rows, and then rests",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const oldRing = yield* keyring(1)
				const ref = { orgId: "org_a", provider: "linear" }
				yield* seedClickHouseSettings(testDb, "org_a", yield* sealedPassword(1, "org_a", "ch-pass"))
				yield* seedOpenRouterKey(
					testDb,
					"org_a",
					yield* sealSecret(oldRing, openRouterKeySlot, { orgId: "org_a" }, "sk-or-old", fail),
				)
				yield* seedOAuthConnection(
					testDb,
					"org_a",
					"linear",
					yield* sealSecret(oldRing, oauthAccessTokenSlot, ref, "access-1", fail),
					yield* sealSecret(oldRing, oauthRefreshTokenSlot, ref, "refresh-1", fail),
				)

				assert.deepStrictEqual(yield* sweep(testDb, 2, [1]), { resealed: 4, failed: 0, remaining: 0 })

				// The old key is gone from this keyring: everything must open with the new one alone.
				const ring = yield* keyring(2)
				const password = yield* clickHousePassword(testDb, "org_a")
				assert.isTrue(Str.startsWith(`v2.${ring.primary.id}.`)(password.ciphertext))
				assert.strictEqual(
					yield* openSecret(ring, clickHousePasswordSlot, { orgId: "org_a" }, password, fail),
					"ch-pass",
				)
				const moved = yield* openSecret(
					ring,
					clickHousePasswordSlot,
					{ orgId: "org_b" },
					password,
					fail,
				).pipe(Effect.option)
				assert.deepStrictEqual(moved, Option.none())

				const openRouterKey = yield* readTriple(
					testDb,
					`select key_ciphertext as ciphertext, key_iv as iv, key_tag as tag
				 from org_openrouter_keys where org_id = $1`,
					["org_a"],
				)
				assert.strictEqual(
					yield* openSecret(ring, openRouterKeySlot, { orgId: "org_a" }, openRouterKey, fail),
					"sk-or-old",
				)

				const access = yield* readTriple(
					testDb,
					`select access_token_ciphertext as ciphertext, access_token_iv as iv, access_token_tag as tag
				 from oauth_connections where org_id = $1`,
					["org_a"],
				)
				const refresh = yield* readTriple(
					testDb,
					`select refresh_token_ciphertext as ciphertext, refresh_token_iv as iv, refresh_token_tag as tag
				 from oauth_connections where org_id = $1`,
					["org_a"],
				)
				assert.strictEqual(
					yield* openSecret(ring, oauthAccessTokenSlot, ref, access, fail),
					"access-1",
				)
				assert.strictEqual(
					yield* openSecret(ring, oauthRefreshTokenSlot, ref, refresh, fail),
					"refresh-1",
				)

				assert.deepStrictEqual(yield* sweep(testDb, 2, [1]), { resealed: 0, failed: 0, remaining: 0 })
			})
		},
	)

	it.effect("leaves a value it cannot open untouched and still reseals the rest", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const lostKey = yield* sealedPassword(7, "org_a", "unreadable")
			const preV2 = {
				ciphertext: Buffer.from("old-ciphertext").toString("base64"),
				iv: Buffer.alloc(12, 1).toString("base64"),
				tag: Buffer.alloc(16, 1).toString("base64"),
			}
			yield* seedClickHouseSettings(testDb, "org_a", lostKey)
			yield* seedClickHouseSettings(testDb, "org_b", yield* sealedPassword(1, "org_b", "ch-pass"))
			yield* seedClickHouseSettings(testDb, "org_c", preV2)

			assert.deepStrictEqual(yield* sweep(testDb, 2, [1]), { resealed: 1, failed: 2, remaining: 2 })
			assert.deepStrictEqual(yield* clickHousePassword(testDb, "org_a"), lostKey)
			assert.deepStrictEqual(yield* clickHousePassword(testDb, "org_c"), preV2)
		})
	})

	it.effect("works through more rows than one page holds", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.forEach(Arr.range(1, 450), (n) => {
				const orgId = `org_${Str.padStart(4, "0")(String(n))}`
				return Effect.flatMap(sealedPassword(1, orgId, "ch-pass"), (password) =>
					seedClickHouseSettings(testDb, orgId, password),
				)
			})

			assert.deepStrictEqual(yield* sweep(testDb, 2, [1]), { resealed: 450, failed: 0, remaining: 0 })
		})
	})

	it.effect("does not overwrite a value that changed after it was read", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const ring = yield* keyring(2, [1])
			const target = RESEAL_TARGETS.clickHousePasswordSlot
			yield* seedClickHouseSettings(testDb, "org_a", yield* sealedPassword(1, "org_a", "old-pass"))
			const database = yield* Database
			const [row] = yield* database.execute((db) =>
				target.pending(db, `v2.${ring.primary.id}.`, null, 10),
			)
			assert.isDefined(row)

			const newer = yield* sealSecret(
				ring,
				clickHousePasswordSlot,
				{ orgId: "org_a" },
				"new-pass",
				fail,
			)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`update org_clickhouse_settings
					 set ch_password_ciphertext = $1, ch_password_iv = $2, ch_password_tag = $3`,
					[newer.ciphertext, newer.iv, newer.tag],
				),
			)

			const stale = yield* row.reseal(ring)
			assert.isFalse(yield* database.execute((db) => row.write(db, stale)))
			assert.deepStrictEqual(yield* clickHousePassword(testDb, "org_a"), newer)
		}).pipe(Effect.provide(testDb.layer))
	})
})
