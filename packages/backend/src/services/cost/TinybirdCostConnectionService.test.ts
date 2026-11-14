import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId, UserId } from "@maple/domain/http"
import { Effect, Fiber, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { TinybirdCostConnectionService } from "./TinybirdCostConnectionService"
import { TINYBIRD_HOSTS } from "./providers/tinybird/tinybird-cost-api"
import {
	FAKE_HOST,
	FAKE_ORG,
	type FakeTinybird,
	fakeTinybirdDeps,
	makeFakeTinybird,
} from "./providers/tinybird/fake-tinybird"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const USER = Schema.decodeSync(UserId)("user_cost")
const TOKEN = "p.eyJ1IjogIjAxMjM0NTY3ODkiLCAiaWQiOiAiYWJjZGVmIn0.Sig_nature-0123456789"
const VALIDATION = "@maple/http/cost-connections/CostConnectionValidationError"
const PERSISTENCE = "@maple/http/cost-connections/CostConnectionPersistenceError"
const REJECTED = "Tinybird rejected this token."
const NO_SCOPE =
	"This token cannot read the organization's usage. Create one with the ORG_DATASOURCES:READ scope."

const run = <A, E>(
	testDb: TestDb,
	world: FakeTinybird,
	effect: Effect.Effect<A, E, TinybirdCostConnectionService>,
) =>
	effect.pipe(
		Effect.provide(
			Layer.effect(TinybirdCostConnectionService, TinybirdCostConnectionService.make).pipe(
				Layer.provide(fakeTinybirdDeps(testDb, world)),
			),
		),
	)

const set = (token: string) => TinybirdCostConnectionService.use((service) => service.set(ORG, USER, token))
const failureOf = (token: string) =>
	Effect.map(Effect.flip(set(token)), (error) => [error._tag, error.message])

const storedToken = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<{
			provider: string
			secret_ciphertext: string
			account_id: string
			account_label: string
		}>(
			testDb,
			"SELECT provider, secret_ciphertext, account_id, account_label FROM cost_connections WHERE org_id = 'org_cost'",
		),
	)

describe("TinybirdCostConnectionService", () => {
	it.effect("finds the token's host among the regions and saves the organization it reads", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saved = yield* set(`  ${TOKEN}\n`)
				assert.deepStrictEqual(saved, { accountId: FAKE_ORG.workspace_id, accountLabel: "Acme" })
				// Every allowlisted host was asked once, with the token as a bearer, and no other host.
				assert.deepStrictEqual(
					Arr.sort(
						Arr.map(world.calls, (call) => call.host),
						Str.Order,
					),
					Arr.sort(
						Arr.map(TINYBIRD_HOSTS, (entry) => entry.host),
						Str.Order,
					),
				)
				assert.isTrue(Arr.every(world.authorizations, (header) => header === `Bearer ${TOKEN}`))
				const stored = yield* storedToken(testDb)
				assert.isFalse(Str.includes(TOKEN)(stored?.secret_ciphertext ?? TOKEN))
				assert.deepStrictEqual(
					[stored?.provider, stored?.account_id, stored?.account_label],
					["tinybird", FAKE_ORG.workspace_id, "Acme"],
				)
			}),
		)
	})

	it.effect("finds a token of the original host the same way", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ tokenHost: "https://api.tinybird.co" })
		return run(
			testDb,
			world,
			Effect.map(set(TOKEN), (saved) => assert.strictEqual(saved.accountId, FAKE_ORG.workspace_id)),
		)
	})

	it.effect("refuses a token its own host knows but will not let read the organization", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ ownRefusal: { status: 403, error: "Not enough permissions" } })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* failureOf(TOKEN), [VALIDATION, NO_SCOPE])
				world.ownRefusal = {
					status: 400,
					error: "Resource 'organization.shared_infra_active_seconds' not found",
				}
				assert.deepStrictEqual(yield* failureOf(TOKEN), [VALIDATION, NO_SCOPE])
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("refuses a token no host knows, or whose signature fails", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ tokenHost: "https://api.example.com" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* failureOf(TOKEN), [VALIDATION, REJECTED])
				world.tokenHost = FAKE_HOST
				world.invalidToken = true
				assert.deepStrictEqual(yield* failureOf(TOKEN), [VALIDATION, REJECTED])
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("saves the token though another region never answers", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ hangingHost: "https://api.tinybird.co" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const saving = yield* Effect.forkChild(set(TOKEN))
				yield* TestClock.adjust("9 seconds")
				const saved = yield* Fiber.join(saving)
				assert.strictEqual(saved.accountId, FAKE_ORG.workspace_id)
			}),
		)
	})

	it.effect("reports a host that is down as a retryable failure, not as a bad token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ tokenHost: "https://api.example.com", downHost: FAKE_HOST })
		return run(
			testDb,
			world,
			Effect.map(failureOf(TOKEN), (failure) =>
				assert.deepStrictEqual(failure, [
					PERSISTENCE,
					"Could not check this token with Tinybird. Try again.",
				]),
			),
		)
	})

	it.effect("saves an organization with no shared-plan usage, named by its oldest workspace", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ identity: { ...FAKE_ORG, organization_name: "" } })
		return run(
			testDb,
			world,
			Effect.map(set(TOKEN), (saved) =>
				assert.deepStrictEqual(saved, {
					accountId: FAKE_ORG.workspace_id,
					accountLabel: "maple_prod",
				}),
			),
		)
	})

	it.effect("refuses an organization with no workspace, which has nothing to read", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird({ identity: null })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* failureOf(TOKEN), [
					VALIDATION,
					"This Tinybird organization has no workspace yet, so there is nothing to read.",
				])
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})

	it.effect("never sends text that is not a token, nor any token of an org outside the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const refusals = yield* Effect.forEach(
					["", "p.", "eyJhbGciOi", "p.two words", `p.${Str.repeat(600)("a")}`],
					failureOf,
				)
				assert.deepStrictEqual(
					refusals,
					Arr.replicate([VALIDATION, "That is not a Tinybird token. They start with p."], 5),
				)
				world.cloudCost = false
				const outside = yield* Effect.flip(set(TOKEN))
				assert.strictEqual(outside._tag, "@maple/http/errors/CloudCostDisabledError")
				assert.deepStrictEqual(world.calls, [])
			}),
		)
	})

	it.effect("removes the token and its source together", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeTinybird()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* set(TOKEN)
				yield* TinybirdCostConnectionService.use((service) => service.remove(ORG))
				assert.isUndefined(yield* storedToken(testDb))
			}),
		)
	})
})
