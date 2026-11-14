import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { VcsInstallationId } from "@maple/domain/vcs"
import { DateTime, Effect, Layer, Schema, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/testing/test-pglite"
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { GithubCostSourceService } from "./GithubCostSourceService"
import {
	type FakeGithub,
	fakeGithubDeps,
	insertInstallation,
	makeFakeGithub,
} from "./providers/github/fake-github"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const OTHER_ORG = Schema.decodeSync(OrgId)("org_other")
const decodeId = Schema.decodeSync(VcsInstallationId)
const ORGANIZATION = decodeId("0190f2b3-0000-4000-8000-0000000000e1")
const USER_ACCOUNT = decodeId("0190f2b3-0000-4000-8000-0000000000e2")
const SUSPENDED = decodeId("0190f2b3-0000-4000-8000-0000000000e3")
const UNKNOWN = decodeId("0190f2b3-0000-4000-8000-0000000000ff")
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T09:00:00Z"))

const run = <A, E>(testDb: TestDb, world: FakeGithub, effect: Effect.Effect<A, E, GithubCostSourceService>) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		yield* insertInstallation(testDb, {
			id: ORGANIZATION,
			orgId: "org_cost",
			login: "example-org",
			externalId: "4242",
		})
		yield* insertInstallation(testDb, {
			id: USER_ACCOUNT,
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
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(GithubCostSourceService, GithubCostSourceService.make).pipe(
				Layer.provide(fakeGithubDeps(testDb, world)),
			),
		),
	)

const list = (orgId = ORG) => GithubCostSourceService.use((service) => service.list(orgId))
const add = (installationId: VcsInstallationId, orgId = ORG) =>
	GithubCostSourceService.use((service) => service.add(orgId, installationId))
const remove = (installationId: VcsInstallationId, orgId = ORG) =>
	GithubCostSourceService.use((service) => service.remove(orgId, installationId))

interface Source {
	readonly org_id: string
	readonly connection_ref: string
	readonly account_id: string
	readonly enabled: boolean
}

const sources = (testDb: TestDb) =>
	Effect.promise(() =>
		testDb.pglite.query<Source>(
			"SELECT org_id, connection_ref, account_id, enabled FROM cost_sources WHERE provider = 'github' ORDER BY connection_ref",
		),
	).pipe(Effect.map((result) => result.rows))

describe("GithubCostSourceService", () => {
	it.effect(
		"lists the org's installations with what each can be, and where its permissions are accepted",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeGithub()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const listed = yield* list()
					assert.deepStrictEqual(
						Arr.map(listed, (entry) => [entry.accountLogin, entry.state, entry.settingsUrl]),
						[
							[
								"example-org",
								"available",
								"https://github.com/organizations/example-org/settings/installations/4242",
							],
							[
								"example-paused",
								"inactive",
								"https://github.com/organizations/example-paused/settings/installations/4244",
							],
							[
								"example-user",
								"user_account",
								"https://github.com/settings/installations/4243",
							],
						],
					)
					// Listing asks GitHub nothing, and another org sees none of them.
					assert.deepStrictEqual(world.paths, [])
					assert.deepStrictEqual(yield* list(OTHER_ORG), [])
				}),
			)
		},
	)

	it.effect("reads the current month once, then makes the source named after the organization", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* add(ORGANIZATION), {
					accountLogin: "example-org",
					created: true,
				})
				assert.deepStrictEqual(world.paths, [
					"/app/installations/4242/access_tokens",
					"/organizations/example-org/settings/billing/usage?year=2026&month=11",
				])
				assert.deepStrictEqual(yield* sources(testDb), [
					{
						org_id: "org_cost",
						connection_ref: ORGANIZATION,
						account_id: "example-org",
						enabled: true,
					},
				])
				assert.deepStrictEqual(
					Arr.map(yield* list(), (entry) => entry.state),
					["added", "inactive", "user_account"],
				)

				// Adding it again keeps the one source, and says nothing was made.
				assert.strictEqual((yield* add(ORGANIZATION)).created, false)
				// Adding one that exists answers the same while GitHub is down.
				world.usageStatus = 503
				assert.strictEqual((yield* add(ORGANIZATION)).created, false)
				world.usageStatus = 200
				assert.lengthOf(yield* sources(testDb), 1)
			}),
		)
	})

	it.effect("refuses an organization that has not let Maple read billing, and stores nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ permissions: { actions: "read" } })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const missing = yield* Effect.flip(add(ORGANIZATION))
				assert.strictEqual(missing._tag, "@maple/http/github-cost/GithubCostPermissionMissingError")
				assert.strictEqual(
					missing.message,
					"GitHub has not granted Maple access to billing yet. Accept the new permission in the organization's GitHub App settings.",
				)

				// The token lists the permission, and GitHub still refuses the report.
				world.permissions = { organization_administration: "read" }
				world.usageStatus = 404
				yield* TestClock.adjust("1 minute")
				const refused = yield* Effect.flip(add(ORGANIZATION))
				assert.strictEqual(refused._tag, "@maple/http/github-cost/GithubCostPermissionMissingError")
				assert.include(refused.message, "found no billing report for this organization")

				// An organization on the older billing is not one its GitHub App settings can fix.
				world.usageStatus = 403
				world.refusal = "This endpoint requires the enhanced billing platform."
				const older = yield* Effect.flip(add(ORGANIZATION))
				assert.strictEqual(older._tag, "@maple/http/github-cost/GithubCostNotReadyError")
				assert.deepStrictEqual(yield* sources(testDb), [])
			}),
		)
	})

	it.effect("refuses a user account and an installation that is not active, without asking GitHub", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const user = yield* Effect.flip(add(USER_ACCOUNT))
				assert.strictEqual(user._tag, "@maple/http/github-cost/GithubCostNotReadyError")
				assert.include(user.message, "Only organization accounts have a billing report")
				const paused = yield* Effect.flip(add(SUSPENDED))
				assert.strictEqual(paused._tag, "@maple/http/github-cost/GithubCostNotReadyError")
				assert.include(paused.message, "suspended or was removed")
				assert.deepStrictEqual([world.paths, yield* sources(testDb)], [[], []])
			}),
		)
	})

	it.effect("does not find an installation of another org, or one that does not exist", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const foreign = yield* Effect.flip(add(ORGANIZATION, OTHER_ORG))
				assert.strictEqual(
					foreign._tag,
					"@maple/http/github-cost/GithubCostInstallationNotFoundError",
				)
				const unknown = yield* Effect.flip(add(UNKNOWN))
				assert.strictEqual(
					unknown._tag,
					"@maple/http/github-cost/GithubCostInstallationNotFoundError",
				)
				assert.deepStrictEqual([world.paths, yield* sources(testDb)], [[], []])
			}),
		)
	})

	it.effect(
		"reports a GitHub outage, a rate limit and an unreadable answer as retryable, not as a refusal",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeGithub({ usageStatus: 503 })
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					// A 503 is retried with a back-off before it is surfaced.
					const outage = yield* Effect.flip(VendorFake.elapsing(add(ORGANIZATION)))
					assert.strictEqual(outage._tag, "@maple/http/github-cost/GithubCostUnavailableError")

					world.usageStatus = 429
					world.retryAfter = 600
					const limited = yield* Effect.flip(add(ORGANIZATION))
					assert.strictEqual(limited._tag, "@maple/http/github-cost/GithubCostUnavailableError")

					world.usageStatus = 200
					world.retryAfter = null
					world.usage = "<html>maintenance</html>"
					const unreadable = yield* Effect.flip(add(ORGANIZATION))
					assert.strictEqual(unreadable._tag, "@maple/http/github-cost/GithubCostUnavailableError")
					assert.deepStrictEqual(yield* sources(testDb), [])
				}),
			)
		},
	)

	it.effect("asks GitHub nothing for an org outside the rollout, neither to list nor to add", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeGithub({ cloudCost: false })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.strictEqual(
					(yield* Effect.flip(list()))._tag,
					"@maple/http/errors/CloudCostDisabledError",
				)
				assert.strictEqual(
					(yield* Effect.flip(add(ORGANIZATION)))._tag,
					"@maple/http/errors/CloudCostDisabledError",
				)
				assert.deepStrictEqual([world.paths, yield* sources(testDb)], [[], []])
			}),
		)
	})

	it.effect(
		"removes only the org's own source, without needing the rollout, and says whether one was there",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeGithub()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					yield* add(ORGANIZATION)
					world.cloudCost = false
					// Another org naming this installation removes nothing.
					assert.deepStrictEqual(yield* remove(ORGANIZATION, OTHER_ORG), { accountLogin: null })
					assert.lengthOf(yield* sources(testDb), 1)
					assert.deepStrictEqual(yield* remove(ORGANIZATION), { accountLogin: "example-org" })
					assert.deepStrictEqual(yield* sources(testDb), [])
					assert.deepStrictEqual(yield* remove(ORGANIZATION), { accountLogin: null })
				}),
			)
		},
	)
})
