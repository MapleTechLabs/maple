import { afterEach, assert, describe, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { CreateSourceRequest, OrgId, UpdateSourceRequest, UserId } from "@maple/domain/http"
import { SourceId } from "@maple/domain/primitives"
import { hashIngestKey } from "@maple/db"
import { Env } from "@maple/backend/platform/Env"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"
import { SourcesService } from "./SourcesService"

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
	SourcesService.layer.pipe(Layer.provide(testDb.layer), Layer.provide(Env.layer), Layer.provide(config))

const orgA = Schema.decodeUnknownSync(OrgId)("org_a")
const orgB = Schema.decodeUnknownSync(OrgId)("org_b")
const user = Schema.decodeUnknownSync(UserId)("user_a")
const missingId = Schema.decodeUnknownSync(SourceId)("0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a5b")

/**
 * An integration source as its service creates it, with what its poller last reported. Fixture
 * rows reuse their own id as their source's.
 */
const insertSource = (
	testDb: TestDb,
	id: string,
	platform: string,
	name: string,
	poll: { readonly okAt?: number; readonly error?: string; readonly disconnected?: boolean } = {},
) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO sources (id, org_id, name, platform, kind, last_poll_ok_at, last_poll_error,
				disconnected_at, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'integration', $5, $6, $7, now(), now())`,
			[
				id,
				orgA,
				name,
				platform,
				poll.okAt === undefined ? null : new Date(poll.okAt).toISOString(),
				poll.error ?? null,
				poll.disconnected === true ? new Date().toISOString() : null,
			],
		),
	)

const ownSources = (keys: SourcesService["Service"], orgId: OrgId) =>
	keys.list(orgId).pipe(Effect.map((sources) => sources.filter((source) => source.kind !== "default")))

describe("SourcesService", () => {
	it.effect("creates a source whose token is stored only as its lookup hash", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({
					platform: "nodejs",
					name: "  Checkout staging  ",
					allowedSignals: ["traces", "logs", "traces"],
					rateLimitRps: 200,
					resourceAttributes: [{ key: " service.name ", value: "checkout", mode: "set" }],
				}),
			)

			assert.isTrue(created.secret.startsWith("maple_src_"))
			assert.isTrue(created.secret.startsWith(created.source.keyPrefix ?? "-"))
			assert.strictEqual(created.source.name, "Checkout staging")
			assert.deepStrictEqual(created.source.allowedSignals, ["traces", "logs"])
			assert.deepStrictEqual(created.source.resourceAttributes, [
				{ key: "service.name", value: "checkout", mode: "set" },
			])

			const row = yield* Effect.promise(() =>
				queryFirstRow<{ key_hash: string }>(testDb, "SELECT key_hash FROM sources WHERE id = $1", [
					created.source.id,
				]),
			)
			assert.strictEqual(row?.key_hash, hashIngestKey(created.secret, LOOKUP_HMAC_KEY))

			const listed = yield* keys.list(orgA)
			assert.deepStrictEqual(
				listed.map((source) => source.kind),
				["default", "token"],
			)
			assert.deepStrictEqual(listed[1], created.source)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rejects reserved, duplicate and out-of-range settings", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const attempt = (request: CreateSourceRequest) =>
				keys.create(orgA, user, request).pipe(
					Effect.flip,
					Effect.map((error) => error._tag),
				)

			const reserved = yield* attempt(
				new CreateSourceRequest({
					platform: "nodejs",
					name: "a",
					resourceAttributes: [{ key: "maple_org_id", value: "other", mode: "set" }],
				}),
			)
			const duplicate = yield* attempt(
				new CreateSourceRequest({
					platform: "nodejs",
					name: "a",
					resourceAttributes: [
						{ key: "env", value: "a", mode: "set" },
						{ key: "env", value: "b", mode: "default" },
					],
				}),
			)
			const rate = yield* attempt(
				new CreateSourceRequest({ platform: "nodejs", name: "a", rateLimitRps: 0 }),
			)
			const signals = yield* attempt(
				new CreateSourceRequest({ platform: "nodejs", name: "a", allowedSignals: [] }),
			)
			const name = yield* attempt(new CreateSourceRequest({ platform: "nodejs", name: "   " }))
			const expiry = yield* attempt(
				new CreateSourceRequest({ platform: "nodejs", name: "a", expiresAtMs: 0 }),
			)
			const reservedCase = yield* attempt(
				new CreateSourceRequest({
					platform: "nodejs",
					name: "a",
					resourceAttributes: [{ key: "Maple_Org_Id", value: "other", mode: "set" }],
				}),
			)
			const emptyValue = yield* attempt(
				new CreateSourceRequest({
					platform: "nodejs",
					name: "a",
					resourceAttributes: [{ key: "service.name", value: "", mode: "default" }],
				}),
			)
			const description = yield* attempt(
				new CreateSourceRequest({ platform: "nodejs", name: "a", description: "x".repeat(501) }),
			)

			assert.deepStrictEqual(
				[reserved, duplicate, rate, signals, name, expiry, reservedCase, emptyValue, description],
				Array(9).fill("@maple/http/errors/SourceValidationError"),
			)
			assert.deepStrictEqual(yield* ownSources(keys, orgA), [])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("updates only the given fields and clears nullable ones with null", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({
					platform: "nodejs",
					name: "k",
					rateLimitRps: 10,
					allowedSignals: ["logs"],
				}),
			)
			const updated = yield* keys.update(
				orgA,
				user,
				created.source.id,
				new UpdateSourceRequest({ name: "renamed", rateLimitRps: null }),
			)

			assert.strictEqual(updated.name, "renamed")
			assert.isNull(updated.rateLimitRps)
			assert.deepStrictEqual(updated.allowedSignals, ["logs"])
			assert.strictEqual(updated.keyPrefix, created.source.keyPrefix)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("roll replaces the secret but keeps the id and settings", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k", rateLimitRps: 5 }),
			)
			const rolled = yield* keys.roll(orgA, user, created.source.id)

			assert.notStrictEqual(rolled.secret, created.secret)
			assert.strictEqual(rolled.source.id, created.source.id)
			assert.strictEqual(rolled.source.rateLimitRps, 5)

			const oldHashRow = yield* Effect.promise(() =>
				queryFirstRow<{ id: string }>(testDb, "SELECT id FROM sources WHERE key_hash = $1", [
					hashIngestKey(created.secret, LOOKUP_HMAC_KEY),
				]),
			)
			assert.isUndefined(oldHashRow)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps sources isolated by org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k" }),
			)

			const errors = yield* Effect.all([
				keys.get(orgB, created.source.id).pipe(Effect.flip),
				keys
					.update(orgB, user, created.source.id, new UpdateSourceRequest({ name: "x" }))
					.pipe(Effect.flip),
				keys.pause(orgB, user, created.source.id, null).pipe(Effect.flip),
				keys.resume(orgB, user, created.source.id).pipe(Effect.flip),
				keys.roll(orgB, user, created.source.id).pipe(Effect.flip),
				keys.delete(orgB, created.source.id).pipe(Effect.flip),
			])

			assert.deepStrictEqual(
				errors.map((error) => error._tag),
				Array(6).fill("@maple/http/errors/SourceNotFoundError"),
			)
			assert.deepStrictEqual(yield* ownSources(keys, orgB), [])
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).status, "active")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("delete removes the source", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k" }),
			)
			yield* keys.delete(orgA, created.source.id)

			assert.deepStrictEqual(yield* ownSources(keys, orgA), [])
			const missing = yield* keys.delete(orgA, missingId).pipe(Effect.flip)
			assert.strictEqual(missing._tag, "@maple/http/errors/SourceNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("caps an organization at 100 sources", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* Effect.forEach(
				Array.from({ length: 100 }, (_, index) => index),
				(index) =>
					keys.create(
						orgA,
						user,
						new CreateSourceRequest({ platform: "nodejs", name: `k${index}` }),
					),
			)
			const overCap = yield* keys
				.create(orgA, user, new CreateSourceRequest({ platform: "nodejs", name: "k100" }))
				.pipe(Effect.flip)

			assert.strictEqual(overCap._tag, "@maple/http/errors/SourceValidationError")
			assert.strictEqual((yield* ownSources(keys, orgA)).length, 100)
			assert.isTrue(
				(yield* keys.create(orgB, user, new CreateSourceRequest({ platform: "nodejs", name: "b" })))
					.secret.length > 0,
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("accepts an unchanged past expiry on update", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k", expiresAtMs: 5_000 }),
			)
			yield* TestClock.adjust("10 seconds")
			const updated = yield* keys.update(
				orgA,
				user,
				created.source.id,
				new UpdateSourceRequest({ name: "renamed", expiresAtMs: 5_000 }),
			)
			const moved = yield* keys
				.update(orgA, user, created.source.id, new UpdateSourceRequest({ expiresAtMs: 6_000 }))
				.pipe(Effect.flip)

			assert.strictEqual(updated.name, "renamed")
			assert.strictEqual(moved._tag, "@maple/http/errors/SourceValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a timed pause ends on its own and resume clears an open-ended one", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* TestClock.adjust("1 minute")
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k" }),
			)

			const timed = yield* keys.pause(orgA, user, created.source.id, 60_000 + 3_600_000)
			assert.strictEqual(timed.status, "paused")
			assert.strictEqual(timed.pausedUntil, "1970-01-01T01:01:00.000Z")
			yield* TestClock.adjust("1 hour")
			const ended = yield* keys.get(orgA, created.source.id)
			assert.strictEqual(ended.status, "active")
			assert.isNull(ended.pausedAt)

			const open = yield* keys.pause(orgA, user, created.source.id, null)
			assert.strictEqual(open.status, "paused")
			assert.isNull(open.pausedUntil)
			yield* TestClock.adjust("30 days")
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).status, "paused")
			assert.strictEqual((yield* keys.resume(orgA, user, created.source.id)).status, "active")

			const past = yield* keys.pause(orgA, user, created.source.id, 1_000).pipe(Effect.flip)
			assert.strictEqual(past._tag, "@maple/http/errors/SourceValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reports an expired source as expired even while paused", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k", expiresAtMs: 5_000 }),
			)
			yield* keys.pause(orgA, user, created.source.id, null)
			yield* TestClock.adjust("10 seconds")
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).status, "expired")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a refusal in the last 15 minutes makes the source failing", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const created = yield* keys.create(
				orgA,
				user,
				new CreateSourceRequest({ platform: "nodejs", name: "k" }),
			)
			yield* TestClock.adjust("1 hour")
			const stamp = (column: string, ms: number) =>
				Effect.promise(() =>
					executeSql(
						testDb,
						`UPDATE sources SET ${column} = to_timestamp($1::bigint / 1000.0) WHERE id = $2`,
						[ms, created.source.id],
					),
				)
			// The test clock is at one hour.
			yield* stamp("last_used_at", 1_800_000)
			yield* stamp("last_rejected_at", 3_300_000)
			yield* Effect.promise(() =>
				executeSql(testDb, "UPDATE sources SET last_rejection = $1 WHERE id = $2", [
					"Rate limited at 200 requests per second",
					created.source.id,
				]),
			)
			const failing = (yield* keys.get(orgA, created.source.id)).health
			assert.strictEqual(failing.status, "failing")
			assert.strictEqual(failing.problem, "Rate limited at 200 requests per second")

			// Fifteen minutes without a refusal: it clears on its own.
			yield* stamp("last_rejected_at", 2_000_000)
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).health.status, "healthy")

			// A new token or new rules: the old refusal no longer applies.
			yield* stamp("last_rejected_at", 3_400_000)
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).health.status, "failing")
			yield* keys.roll(orgA, user, created.source.id)
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).health.status, "healthy")
			yield* stamp("last_rejected_at", 3_500_000)
			// Saving the same rules lifts nothing; a new rate limit does.
			yield* keys.update(orgA, user, created.source.id, new UpdateSourceRequest({ rateLimitRps: null }))
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).health.status, "failing")
			yield* keys.update(orgA, user, created.source.id, new UpdateSourceRequest({ rateLimitRps: 500 }))
			assert.strictEqual((yield* keys.get(orgA, created.source.id)).health.status, "healthy")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lists one default source per org that only takes a name and description", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			const [first] = yield* keys.list(orgA)
			const [again] = yield* keys.list(orgA)
			assert.strictEqual(first?.id, again?.id)
			assert.strictEqual(first?.kind, "default")
			assert.isNull(first?.keyPrefix)
			if (first === undefined) return

			const renamed = yield* keys.update(
				orgA,
				user,
				first.id,
				new UpdateSourceRequest({ name: "Prod" }),
			)
			assert.strictEqual(renamed.name, "Prod")

			const refused = yield* Effect.all([
				keys
					.update(orgA, user, first.id, new UpdateSourceRequest({ rateLimitRps: 5 }))
					.pipe(Effect.flip),
				keys.pause(orgA, user, first.id, null).pipe(Effect.flip),
				keys.roll(orgA, user, first.id).pipe(Effect.flip),
				keys.delete(orgA, first.id).pipe(Effect.flip),
			])
			assert.deepStrictEqual(
				refused.map((error) => error._tag),
				Array(4).fill("@maple/http/errors/SourceValidationError"),
			)
			assert.strictEqual((yield* keys.list(orgA)).length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps a scrape target that PlanetScale adopted while listing sources", () => {
		const testDb = createTestDb(trackedDbs)
		const target = "9d1e2f3a-0000-4000-8000-000000000003"
		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* Effect.promise(async () => {
				await executeSql(
					testDb,
					`INSERT INTO sources (id, org_id, name, platform, kind, created_at, updated_at)
					 VALUES ('0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a50', $1, 'branches', 'prometheus', 'integration', now(), now())`,
					[orgA],
				)
				// Adopted by a PlanetScale connection: managed, still pointing at its Prometheus source.
				await executeSql(
					testDb,
					`INSERT INTO scrape_targets (id, org_id, name, url, managed_by, source_id, created_at, updated_at)
					 VALUES ($1, $2, 'branches', 'http://ps/metrics', 'planetscale:conn_1', '0f8e6c1a-2b3d-4e5f-8a9b-0c1d2e3f4a50', now(), now())`,
					[target, orgA],
				)
			})
			yield* keys.list(orgA)
			const rows = yield* Effect.promise(() =>
				testDb.pglite.query<{ id: string }>("SELECT id FROM scrape_targets"),
			)
			assert.deepStrictEqual(
				rows.rows.map((row) => row.id),
				[target],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reads an integration source's health from what its poller reported, and pauses it", () => {
		const testDb = createTestDb(trackedDbs)
		const insertTarget = (id: string, name: string, lastScrapeAt: number | null, error: string | null) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO scrape_targets (id, org_id, source_id, name, url, scrape_interval_seconds, last_scrape_at, last_scrape_error, created_at, updated_at)
					 VALUES ($1, $2, $1, $3, 'http://node:9100/metrics', 15, $4, $5, now(), now())`,
					[
						id,
						orgA,
						name,
						lastScrapeAt === null ? null : new Date(lastScrapeAt).toISOString(),
						error,
					],
				),
			)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* TestClock.adjust("1 hour")
			yield* insertSource(testDb, "9d1e2f3a-0000-4000-8000-000000000001", "prometheus", "node", {
				okAt: 3_600_000 - 30_000,
			})
			yield* insertSource(testDb, "9d1e2f3a-0000-4000-8000-000000000002", "prometheus", "broken", {
				error: "connection refused",
			})
			yield* insertTarget("9d1e2f3a-0000-4000-8000-000000000001", "node", 3_600_000 - 30_000, null)
			yield* insertTarget("9d1e2f3a-0000-4000-8000-000000000002", "broken", null, "connection refused")

			const first = yield* ownSources(keys, orgA)
			assert.deepStrictEqual(
				first
					.map((source) => [source.name, source.platform, source.health.status, source.keyPrefix])
					.sort(),
				[
					["broken", "prometheus", "failing", null],
					["node", "prometheus", "healthy", null],
				],
			)
			assert.strictEqual(
				first.find((source) => source.name === "broken")?.health.problem,
				"connection refused",
			)

			const broken = first.find((source) => source.name === "broken")
			if (broken === undefined) return
			// A rename answers with the integration's health, not push health.
			const renamed = yield* keys.update(
				orgA,
				user,
				broken.id,
				new UpdateSourceRequest({ name: "scraper" }),
			)
			assert.deepStrictEqual([renamed.name, renamed.health.status], ["scraper", "failing"])
			// Integration sources pause like token sources; the pause wins over the integration's health.
			const paused = yield* keys.pause(orgA, user, broken.id, null)
			assert.deepStrictEqual([paused.status, paused.health.status], ["paused", "paused"])
			assert.strictEqual(
				(yield* ownSources(keys, orgA)).find((source) => source.id === broken.id)?.health.status,
				"paused",
			)
			const resumed = yield* keys.resume(orgA, user, broken.id)
			assert.deepStrictEqual([resumed.status, resumed.health.status], ["active", "failing"])
			const refused = yield* keys.delete(orgA, broken.id).pipe(Effect.flip)
			assert.strictEqual(refused._tag, "@maple/http/errors/SourceValidationError")

			// Deleting the source deletes the target that sends as it.
			yield* Effect.promise(() => executeSql(testDb, "DELETE FROM sources WHERE id = $1", [broken.id]))
			const targets = yield* Effect.promise(() =>
				testDb.pglite.query<{ id: string }>("SELECT id FROM scrape_targets"),
			)
			assert.deepStrictEqual(
				targets.rows.map((row) => row.id),
				["9d1e2f3a-0000-4000-8000-000000000001"],
			)
			assert.deepStrictEqual(
				(yield* ownSources(keys, orgA)).map((source) => source.name),
				["node"],
			)
			const fetched = yield* keys.get(
				orgA,
				first.find((source) => source.name === "node")?.id ?? broken.id,
			)
			assert.strictEqual(fetched.health.status, "healthy")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reads a scrape target that is switched off as paused", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* insertSource(testDb, "9d1e2f3a-0000-4000-8000-000000000009", "prometheus", "off")
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO scrape_targets (id, org_id, source_id, name, url, enabled, created_at, updated_at)
					 VALUES ($2, $1, $2, 'off', 'http://off/metrics', false, now(), now())`,
					[orgA, "9d1e2f3a-0000-4000-8000-000000000009"],
				),
			)
			const [off] = yield* ownSources(keys, orgA)
			assert.deepStrictEqual(
				[off?.health.status, off?.health.problem],
				["paused", "Scraping is turned off"],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("reads a revoked GitHub installation as disconnected", () => {
		const testDb = createTestDb(trackedDbs)
		const insertInstallation = (id: string, login: string, status: string) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO vcs_installations (id, org_id, source_id, provider, external_installation_id, account_login, account_type, external_account_id, status, installed_by_user_id, created_at, updated_at)
					 VALUES ($1, $2, $1, 'github', $3, $4, 'Organization', $3, $5, 'user_a', now(), now())`,
					[id, orgA, `ext-${login}`, login, status],
				),
			)

		return Effect.gen(function* () {
			const keys = yield* SourcesService
			yield* insertSource(testDb, "7a1e2f3a-0000-4000-8000-000000000001", "github", "GitHub acme")
			yield* insertSource(testDb, "7a1e2f3a-0000-4000-8000-000000000002", "github", "GitHub globex", {
				error: "The GitHub installation is suspended",
				disconnected: true,
			})
			yield* insertInstallation("7a1e2f3a-0000-4000-8000-000000000001", "acme", "active")
			yield* insertInstallation("7a1e2f3a-0000-4000-8000-000000000002", "globex", "suspended")

			const sources = yield* ownSources(keys, orgA)
			assert.deepStrictEqual(
				sources.map((source) => [source.name, source.platform, source.health.status]).sort(),
				[
					["GitHub acme", "github", "pending"],
					["GitHub globex", "github", "disconnected"],
				],
			)
			assert.strictEqual(
				sources.find((source) => source.name === "GitHub globex")?.health.problem,
				"The GitHub installation is suspended",
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
