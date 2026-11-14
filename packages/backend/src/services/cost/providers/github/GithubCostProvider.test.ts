import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema, Array as Arr, String as Str } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import type { CostProviderError } from "../../CostProvider"
import { monthsOfWindow } from "./billing-usage"
import { type FakeGithub, fakeGithubDeps, insertInstallation, makeFakeGithub } from "./fake-github"
import { GithubCostProvider } from "./GithubCostProvider"
import * as VendorFake from "@maple/backend/testing/vendor-fake"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const INSTALLATION = "0190f2b3-0000-4000-8000-0000000000e1"
const WINDOW = { startDay: "2026-11-01", endDay: "2026-11-03" }
/** The pull runs on the window's last day. */
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-03T06:00:00Z"))
const USAGE_PATH = "/organizations/example-org/settings/billing/usage"

const run = <A, E>(testDb: TestDb, world: FakeGithub, effect: Effect.Effect<A, E, GithubCostProvider>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* insertInstallation(testDb, {
			id: INSTALLATION,
			orgId: "org_cost",
			login: "example-org",
			externalId: "4242",
		})
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(GithubCostProvider, GithubCostProvider.make).pipe(
				Layer.provide(fakeGithubDeps(testDb, world)),
			),
		),
	)

const pull = (orgId: OrgId, connectionRef: string, window = WINDOW) =>
	GithubCostProvider.use((provider) => provider.pull({ orgId, connectionRef }, window))

const reasonOf = (error: CostProviderError) => [error.reason, error.requests, error.provider]

const line = (date: string, netAmount: number) => ({
	date,
	product: "actions",
	sku: "Actions Linux",
	quantity: 10,
	unitType: "Minutes",
	pricePerUnit: 0.008,
	grossAmount: netAmount,
	discountAmount: 0,
	netAmount,
	organizationName: "example-org",
	repositoryName: "example-org/api",
})

describe("GithubCostProvider", () => {
	it.effect(
		"reads the organization's usage with the installation's token and returns the window's days",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeGithub({
				usage: [
					line("2026-11-01T00:00:00Z", 1),
					line("2026-11-03T11:12:05Z", 2),
					line("2026-11-07T00:00:00Z", 9),
				],
			})
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const pulled = yield* pull(ORG, INSTALLATION)
					assert.deepStrictEqual(world.paths, [
						"/app/installations/4242/access_tokens",
						`${USAGE_PATH}?year=2026&month=11`,
					])
					assert.deepStrictEqual(world.authorizations, ["token token-1"])
					// GitHub bills no requests, rows carry the organization, and yesterday on can still change.
					assert.strictEqual(pulled.requests, 0)
					assert.deepStrictEqual(
						Arr.map(pulled.rows, (row) => [
							row.day,
							row.billedCost,
							row.accountId,
							row.estimated,
						]),
						[
							["2026-11-01", 1, "example-org", false],
							["2026-11-03", 2, "example-org", true],
						],
					)
				}),
			)
		},
	)

	it.effect("asks for each month a window touches, once", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* pull(ORG, INSTALLATION, { startDay: "2025-12-15", endDay: "2026-02-02" })
				assert.deepStrictEqual(world.paths.slice(1), [
					`${USAGE_PATH}?year=2025&month=12`,
					`${USAGE_PATH}?year=2026&month=1`,
					`${USAGE_PATH}?year=2026&month=2`,
				])
				assert.deepStrictEqual(monthsOfWindow({ startDay: "2026-11-30", endDay: "2026-11-30" }), [
					{ year: 2026, month: 11 },
				])
			}),
		)
	})

	it.effect("says what the sync should do about each way GitHub refuses", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const reasons = yield* Effect.forEach([401, 403, 404, 429, 502, 422], (status) =>
					Effect.gen(function* () {
						world.usageStatus = status
						// A long rate limit is not waited out: the sync comes back to it.
						world.retryAfter = status === 429 ? 600 : null
						// A 502 is retried with a back-off before it is surfaced.
						return (yield* Effect.flip(VendorFake.elapsing(pull(ORG, INSTALLATION)))).reason
					}),
				)
				assert.deepStrictEqual(reasons, [
					"auth",
					"not_ready",
					"not_ready",
					"rate_limited",
					"upstream",
					"upstream",
				])

				// A secondary rate limit is a 403 with `retry-after`, not a missing permission.
				world.usageStatus = 403
				world.retryAfter = 600
				assert.strictEqual((yield* Effect.flip(pull(ORG, INSTALLATION))).reason, "rate_limited")

				// An organization on the older billing is told so, whatever status GitHub refuses it with.
				world.retryAfter = null
				world.refusal = "This endpoint requires the enhanced billing platform."
				const older = yield* Effect.forEach([400, 403, 404], (status) =>
					Effect.gen(function* () {
						world.usageStatus = status
						const error = yield* Effect.flip(pull(ORG, INSTALLATION))
						return [error.reason, Str.includes("enhanced billing platform")(error.message)]
					}),
				)
				assert.deepStrictEqual(older, Arr.replicate(["not_ready", true], 3))
			}),
		)
	})

	it.effect("asks nothing of an installation that has not accepted the billing permission", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ permissions: { actions: "read", metadata: "read" } })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const error = yield* Effect.flip(pull(ORG, INSTALLATION))
				assert.deepStrictEqual(reasonOf(error), ["not_ready", 0, "github"])
				assert.include(error.message, "has not granted Maple access to billing")
				// A second read right after mints no second token: the first shows what is accepted now.
				yield* Effect.flip(pull(ORG, INSTALLATION))
				assert.deepStrictEqual(world.paths, ["/app/installations/4242/access_tokens"])

				// The organization accepts it: the old token never gains it, so a new one is minted.
				world.permissions = { actions: "read", organization_administration: "read" }
				yield* TestClock.adjust("1 minute")
				const pulled = yield* pull(ORG, INSTALLATION)
				assert.deepStrictEqual(pulled.rows, [])
				assert.deepStrictEqual(world.authorizations, ["token token-2"])
			}),
		)
	})

	it.effect("mints a new token and asks once more when GitHub rejects the cached one", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ rejected: ["token token-1"] })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const pulled = yield* pull(ORG, INSTALLATION)
				assert.deepStrictEqual(pulled.rows, [])
				assert.deepStrictEqual(world.authorizations, ["token token-1", "token token-2"])

				// A token GitHub keeps rejecting is asked with twice, then the pull fails as auth.
				world.rejected = ["token token-2", "token token-3"]
				assert.strictEqual((yield* Effect.flip(pull(ORG, INSTALLATION))).reason, "auth")
				assert.lengthOf(world.authorizations, 4)
			}),
		)
	})

	it.effect("asks anyway when the token does not list what the installation accepted", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ permissions: null })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* pull(ORG, INSTALLATION)
				assert.deepStrictEqual(world.authorizations, ["token token-1"])
			}),
		)
	})

	it.effect("fails an answer it cannot read as invalid, with nothing to store", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ usage: "<html>maintenance</html>" })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(reasonOf(yield* Effect.flip(pull(ORG, INSTALLATION))), [
					"invalid_response",
					0,
					"github",
				])
				world.usage = [{ ...line("soon", 1) }]
				assert.strictEqual((yield* Effect.flip(pull(ORG, INSTALLATION))).reason, "invalid_response")
				// A day followed by anything but a UTC time, a day that does not exist, a time that does not.
				const refused = yield* Effect.forEach(
					[
						"2026-11-02invalid",
						"2026-11-02Tgarbage",
						"2026-11-31",
						"2026-11-31T00:00:00Z",
						"2026-02-30",
						"2026-11-02T24:00:00Z",
						"2026-11-02T11:12:05+01:00",
					],
					(date) =>
						Effect.gen(function* () {
							world.usage = [{ ...line(date, 1) }]
							return (yield* Effect.flip(pull(ORG, INSTALLATION))).reason
						}),
				)
				assert.deepStrictEqual(refused, Arr.replicate("invalid_response", 7))
				// A day alone and a UTC timestamp with a fraction are both read.
				world.usage = [line("2026-11-02", 1), line("2026-11-03T11:12:05.250Z", 2)]
				assert.deepStrictEqual(
					Arr.map((yield* pull(ORG, INSTALLATION)).rows, (row) => row.day),
					["2026-11-02", "2026-11-03"],
				)
				// A 2xx without the list is not an empty month: storing it would empty the window's days.
				world.usage = "{}"
				assert.strictEqual((yield* Effect.flip(pull(ORG, INSTALLATION))).reason, "invalid_response")
			}),
		)
	})

	it.effect("fails as auth when GitHub no longer mints a token for the installation", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ mintStatus: 404 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.strictEqual((yield* Effect.flip(pull(ORG, INSTALLATION))).reason, "auth")
				assert.deepStrictEqual(world.authorizations, [])
			}),
		)
	})

	it.effect("never reads through another org's installation, a user's, or one that is not active", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		const USER_INSTALL = "0190f2b3-0000-4000-8000-0000000000e2"
		const SUSPENDED = "0190f2b3-0000-4000-8000-0000000000e3"
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* insertInstallation(testDb, {
					id: USER_INSTALL,
					orgId: "org_cost",
					login: "example-user",
					externalId: "4243",
					accountType: "user",
				})
				yield* insertInstallation(testDb, {
					id: SUSPENDED,
					orgId: "org_cost",
					login: "example-paused",
					externalId: "4244",
					status: "suspended",
				})
				const reasons = yield* Effect.forEach(
					[
						pull(OTHER_ORG, INSTALLATION),
						pull(ORG, USER_INSTALL),
						pull(ORG, SUSPENDED),
						pull(ORG, "no-such-installation"),
					],
					(attempt) => Effect.map(Effect.flip(attempt), (error) => error.reason),
				)
				assert.deepStrictEqual(reasons, ["auth", "auth", "auth", "auth"])
				assert.deepStrictEqual(world.paths, [])
			}),
		)
	})
})
