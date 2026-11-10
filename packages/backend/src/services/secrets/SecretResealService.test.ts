import { afterEach, assert, describe, it } from "@effect/vitest"
import { Array as Arr, ConfigProvider, Effect, Layer, Option, Schema, String as Str } from "effect"
import { encryptAes256Gcm, type EncryptedValue } from "@maple/backend/platform/Crypto"
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
import * as slots from "@maple/backend/platform/secret-slots"
import { UptimeHeadersJson } from "@maple/backend/services/uptime/uptime-headers"
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

const legacy = (plaintext: string, key: number, aad?: string) =>
	encryptAes256Gcm(
		plaintext,
		Buffer.alloc(32, key),
		fail,
		aad === undefined ? undefined : Buffer.from(aad, "utf8"),
	)

describe("SecretResealService", () => {
	it.effect("reads every sealed column without touching an empty database", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 0, failed: 0, remaining: 0 })
		})
	})

	it.effect("moves pre-v2 values onto the current key, bound to their rows, and then rests", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const ring = yield* keyring(1)
			yield* seedClickHouseSettings(testDb, "org_a", yield* legacy("ch-pass", 1))
			yield* seedOpenRouterKey(
				testDb,
				"org_a",
				yield* legacy("sk-or-old", 1, "org_openrouter_keys:v1:org_a"),
			)
			yield* seedOAuthConnection(
				testDb,
				"org_a",
				"linear",
				yield* legacy("access-1", 1),
				yield* legacy("refresh-1", 1),
			)

			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 4, failed: 0, remaining: 0 })

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

			const ref = { orgId: "org_a", provider: "linear" }
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
			assert.strictEqual(yield* openSecret(ring, oauthAccessTokenSlot, ref, access, fail), "access-1")
			assert.strictEqual(
				yield* openSecret(ring, oauthRefreshTokenSlot, ref, refresh, fail),
				"refresh-1",
			)

			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 0, failed: 0, remaining: 0 })
		})
	})

	it.effect("after a rotation, reseals values held under the old key and the old key can go", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const oldRing = yield* keyring(1)
			yield* seedClickHouseSettings(
				testDb,
				"org_a",
				yield* sealSecret(oldRing, clickHousePasswordSlot, { orgId: "org_a" }, "ch-pass", fail),
			)

			assert.deepStrictEqual(yield* sweep(testDb, 2, [1]), { resealed: 1, failed: 0, remaining: 0 })

			const newRingAlone = yield* keyring(2)
			assert.strictEqual(
				yield* openSecret(
					newRingAlone,
					clickHousePasswordSlot,
					{ orgId: "org_a" },
					yield* clickHousePassword(testDb, "org_a"),
					fail,
				),
				"ch-pass",
			)
		})
	})

	it.effect("leaves a value it cannot open untouched and still reseals the rest", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const lost = yield* legacy("unreadable", 7)
			yield* seedClickHouseSettings(testDb, "org_a", lost)
			yield* seedClickHouseSettings(testDb, "org_b", yield* legacy("ch-pass", 1))

			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 1, failed: 1, remaining: 1 })
			assert.deepStrictEqual(yield* clickHousePassword(testDb, "org_a"), lost)
		})
	})

	it.effect("works through more rows than one page holds", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const password = yield* legacy("ch-pass", 1)
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`insert into org_clickhouse_settings
						(org_id, ch_url, ch_user, ch_password_ciphertext, ch_password_iv, ch_password_tag,
						 ch_database, sync_status, created_at, updated_at, created_by, updated_by)
					 select 'org_' || lpad(n::text, 4, '0'), 'https://ch.example', 'maple', $1, $2, $3,
						'maple', 'connected', $4, $4, 'u', 'u'
					 from generate_series(1, 450) as n`,
					[password.ciphertext, password.iv, password.tag, NOW],
				),
			)

			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 450, failed: 0, remaining: 0 })
		})
	})

	it.effect("does not overwrite a value that changed after it was read", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const ring = yield* keyring(1)
			const target = RESEAL_TARGETS.clickHousePasswordSlot
			yield* seedClickHouseSettings(testDb, "org_a", yield* legacy("old-pass", 1))
			const database = yield* Database
			const [row] = yield* database.execute((db) => target.pending(db, "v2.none.", null, 10))
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

	it.effect("seals uptime check headers that are still in the config, and only those", () => {
		const testDb = createTestDb(trackedDbs)
		const seedMonitor = (id: string, headers: Record<string, string>) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					`insert into uptime_monitors
						(id, org_id, name, kind, config_json, created_by, created_at, updated_at)
					 values ($1, 'org_a', $1, 'http', $2::jsonb, 'user_1', $3, $3)`,
					[
						id,
						JSON.stringify({
							_tag: "http",
							url: "https://status.example.com/health",
							method: "GET",
							headers,
							assertions: [],
							timeoutMs: 5000,
						}),
						NOW,
					],
				),
			)
		const stored = (id: string) =>
			Effect.promise(() =>
				queryFirstRow<EncryptedValue & { readonly headers: string }>(
					testDb,
					`select (config_json -> 'headers')::text as headers, headers_ciphertext as ciphertext,
						headers_iv as iv, headers_tag as tag
					 from uptime_monitors where id = $1`,
					[id],
				),
			).pipe(
				Effect.flatMap((row) => Effect.fromNullishOr(row)),
				Effect.orDie,
			)
		return Effect.gen(function* () {
			const ring = yield* keyring(1)
			yield* seedMonitor("mon_with", { Authorization: "Bearer s3cr3t" })
			yield* seedMonitor("mon_without", {})

			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 1, failed: 0, remaining: 0 })

			const sealed = yield* stored("mon_with")
			assert.strictEqual(sealed.headers, "{}")
			const opened = yield* openSecret(
				ring,
				slots.uptimeMonitorHeadersSlot,
				{ orgId: "org_a", id: "mon_with" },
				sealed,
				fail,
			)
			assert.deepStrictEqual(yield* Schema.decodeEffect(UptimeHeadersJson)(opened), {
				Authorization: "Bearer s3cr3t",
			})
			assert.isNull((yield* stored("mon_without")).ciphertext)
			assert.deepStrictEqual(yield* sweep(testDb, 1), { resealed: 0, failed: 0, remaining: 0 })
		})
	})
})
