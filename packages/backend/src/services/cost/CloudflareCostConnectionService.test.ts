import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { CloudflareCostConnectionService } from "./CloudflareCostConnectionService"
import {
	FAKE_ACCOUNT,
	type FakeCloudflare,
	fakeCloudflareDeps,
	makeFakeCloudflare,
} from "./providers/cloudflare/fake-cloudflare"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const TOKEN = "cfut_0123456789abcdefghijABCDEFGHIJ0123456789"
const OTHER_TOKEN = "cfat_9876543210zyxwvutsrqZYXWVUTSRQ9876543210"
const ACCOUNT_PATH = `/client/v4/accounts/${FAKE_ACCOUNT.id}`
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-11T06:00:00Z"))
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"

const run = <A, E>(
	testDb: TestDb,
	world: FakeCloudflare,
	effect: Effect.Effect<A, E, CloudflareCostConnectionService>,
) =>
	Effect.andThen(TestClock.setTime(NOW), effect).pipe(
		Effect.provide(
			Layer.effect(CloudflareCostConnectionService, CloudflareCostConnectionService.make).pipe(
				Layer.provide(fakeCloudflareDeps(testDb, world)),
			),
		),
	)

const set = (token: string) => CloudflareCostConnectionService.use((service) => service.set(ORG, USER, token))
const remove = CloudflareCostConnectionService.use((service) => service.remove(ORG))

interface Stored {
	readonly id: string
	readonly provider: string
	readonly secret_ciphertext: string
	readonly account_id: string
	readonly account_label: string
}

const storedToken = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Stored>(
			testDb,
			"SELECT id, provider, secret_ciphertext, account_id, account_label FROM cost_connections WHERE org_id = 'org_cost'",
		),
	)

interface Source {
	readonly id: string
	readonly connection_ref: string
	readonly account_id: string
	readonly enabled: boolean
}

const source = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Source>(
			testDb,
			"SELECT id, connection_ref, account_id, enabled FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'cloudflare'",
		),
	)

describe("CloudflareCostConnectionService", () => {
	it.effect("checks a token with Cloudflare, seals it and makes the cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${TOKEN}  `)
				assert.deepStrictEqual(saved, { accountId: FAKE_ACCOUNT.id, accountLabel: "Example Account" })
				// Which account, then whether it has billing data, then proof the token reads it.
				assert.deepStrictEqual(world.urls, [
					"/client/v4/accounts?per_page=50",
					`${ACCOUNT_PATH}/billable-usage/info`,
					`${ACCOUNT_PATH}/billable-usage?from=2026-10-10&to=2026-11-11`,
				])
				assert.deepStrictEqual(world.authorizations, Arr.replicate(`Bearer ${TOKEN}`, 3))

				const stored = yield* storedToken(testDb)
				assert.isFalse(Str.includes(TOKEN)(stored?.secret_ciphertext ?? TOKEN))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["cloudflare", FAKE_ACCOUNT.id, "Example Account"],
				)
				const made = yield* source(testDb)
				// The source is named after the token's account, which a later token keeps.
				assert.deepStrictEqual(
					[made?.connection_ref, made?.account_id, made?.enabled],
					[stored?.id, FAKE_ACCOUNT.id, true],
				)
			}),
		)
	})

	it.effect("refuses a token that reads several accounts or none, before asking for billing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare({
			accounts: [FAKE_ACCOUNT, { id: "fedcba9876543210fedcba9876543210", name: "Second Account" }],
		})
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const several = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(several._tag, VALIDATION)
				assert.strictEqual(
					several.message,
					"This token can read 2 accounts. Create one limited to a single account.",
				)
				world.accounts = []
				assert.include((yield* Effect.flip(set(TOKEN))).message, "can read 0 accounts")
				assert.deepStrictEqual(world.urls, Arr.replicate("/client/v4/accounts?per_page=50", 2))
				assert.isUndefined(yield* storedToken(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses a token Cloudflare does not know, and one without billing access", () => {
		const testDb = createTestDb(trackedDbs)
		// Cloudflare answers 403 for an unknown token on the account listing.
		const world = makeFakeCloudflare({ accountsStatus: 403 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const unknown = yield* Effect.flip(set(TOKEN))
				assert.deepStrictEqual(
					[unknown._tag, unknown.message],
					[VALIDATION, "Cloudflare rejected this token."],
				)
				world.accountsStatus = 401
				assert.strictEqual(
					(yield* Effect.flip(set(TOKEN))).message,
					"Cloudflare rejected this token.",
				)

				world.accountsStatus = 200
				world.billingStatus = 403
				const noBilling = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(noBilling._tag, VALIDATION)
				assert.include(noBilling.message, "Billing: Read permission")
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("refuses an account Cloudflare has no usage-based billing data for", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare({ covered: false })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(error._tag, VALIDATION)
				assert.include(error.message, "no usage-based billing data")
				assert.isUndefined(yield* storedToken(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("reports a Cloudflare outage as a retryable failure, not as a bad token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare({ billingStatus: 503 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(error._tag, PERSISTENCE)
				world.billingStatus = 200
				world.usage = "<html>maintenance</html>"
				assert.strictEqual((yield* Effect.flip(set(TOKEN)))._tag, PERSISTENCE)
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("never sends text that cannot be a token, nor any token of an org outside the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const refusals = yield* Effect.forEach(
					["", "   ", "two words", `cfut_${Str.repeat(300)("a")}`, "line\nbreak"],
					(text) => Effect.map(Effect.flip(set(text)), (error) => error._tag),
				)
				assert.deepStrictEqual(refusals, Arr.replicate(VALIDATION, 5))

				world.cloudCost = false
				const outside = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
				assert.deepStrictEqual(world.urls, [])
			}),
		)
	})

	it.effect("keeps the connection and its source when the account's token is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(TOKEN)
				const first = yield* storedToken(testDb)
				const firstSource = yield* source(testDb)

				// The account was renamed since: the label follows, the id is what is compared.
				world.accounts = [{ id: FAKE_ACCOUNT.id, name: "Renamed Account" }]
				const replaced = yield* set(OTHER_TOKEN)
				assert.strictEqual(replaced.accountLabel, "Renamed Account")
				const second = yield* storedToken(testDb)
				assert.strictEqual(second?.id, first?.id)
				assert.strictEqual(second?.account_label, "Renamed Account")
				assert.notStrictEqual(second?.secret_ciphertext, first?.secret_ciphertext)
				assert.deepStrictEqual(yield* source(testDb), firstSource)
			}),
		)
	})

	it.effect(
		"refuses a token of another Cloudflare account while a source exists, and keeps the saved one",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeCloudflare()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* set(TOKEN)
					const first = yield* storedToken(testDb)

					// The other account's charges would overwrite the days the source already holds.
					world.accounts = [{ id: "fedcba9876543210fedcba9876543210", name: "Second Account" }]
					const refused = yield* Effect.flip(set(OTHER_TOKEN))
					assert.strictEqual(refused._tag, VALIDATION)
					assert.include(refused.message, "another Cloudflare account")
					assert.deepStrictEqual(yield* storedToken(testDb), first)
				}),
			)
		},
	)

	it.effect("makes a source held for its old token's failure due again once the token is replaced", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		const held = Effect.promise(() =>
			queryFirstRow<{
				error: string | null
				reason: string | null
				held: boolean
				failures: number
				leased: boolean
			}>(
				testDb,
				`SELECT last_error AS error, last_error_reason AS reason, next_attempt_at IS NOT NULL AS held,
				        consecutive_failures AS failures, lease_until IS NOT NULL AS leased
				   FROM cost_sources WHERE org_id = 'org_cost'`,
			),
		)
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(TOKEN)
				yield* Effect.promise(() =>
					testDb.pglite.query(
						// A pull on the old token is in flight: it holds the source's lease.
						`UPDATE cost_sources SET last_error = 'Cloudflare rejected the saved token.',
						        last_error_reason = 'auth', next_attempt_at = now() + interval '6 hours',
						        consecutive_failures = 3, lease_until = now() + interval '20 minutes'`,
					),
				)
				assert.strictEqual((yield* held)?.held, true)
				yield* set(OTHER_TOKEN)
				// The lease goes too: the old pull's failure, arriving later, finds the claim gone and writes nothing.
				assert.deepStrictEqual(yield* held, {
					error: null,
					reason: null,
					held: false,
					failures: 0,
					leased: false,
				})
			}),
		)
	})

	it.effect("removes the token and its source together, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeCloudflare()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(TOKEN)
				world.cloudCost = false
				yield* remove
				assert.isUndefined(yield* storedToken(testDb))
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})
})
