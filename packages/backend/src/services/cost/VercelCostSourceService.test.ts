import { afterEach, assert, describe, it } from "@effect/vitest"
import { OrgId } from "@maple/domain/http"
import { DateTime, Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import type { Database } from "@maple/backend/platform/DatabaseLive"
import type { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import {
	connectFakeVercel,
	type FakeVercel,
	fakeVercelDeps,
	makeFakeVercel,
} from "./providers/vercel/fake-vercel"
import { VercelCostProvider } from "./providers/vercel/VercelCostProvider"
import { VercelCostSourceService } from "./VercelCostSourceService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T09:00:00Z"))
/** The check read: yesterday alone. */
const CHECK_URL =
	"https://api.vercel.com/v1/billing/charges?teamId=team_1&from=2026-11-11T00%3A00%3A00Z&to=2026-11-12T00%3A00%3A00Z"

const run = <A, E>(
	testDb: TestDb,
	world: FakeVercel,
	effect: Effect.Effect<A, E, VercelCostSourceService | Database | Env>,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(VercelCostSourceService, VercelCostSourceService.make).pipe(
				Layer.provide(Layer.effect(VercelCostProvider, VercelCostProvider.make)),
				Layer.provideMerge(fakeVercelDeps(testDb, world)),
			),
		),
	)

const status = VercelCostSourceService.use((service) => service.status(ORG))
const add = VercelCostSourceService.use((service) => service.add(ORG))
const remove = VercelCostSourceService.use((service) => service.remove(ORG))

interface Source {
	readonly connection_ref: string
	readonly account_id: string
	readonly enabled: boolean
	readonly sources: number
}

/** The org's Vercel source, with how many it has. */
const source = (testDb: TestDb) =>
	Effect.promise(() =>
		queryFirstRow<Source>(
			testDb,
			`SELECT connection_ref, account_id, enabled, (count(*) OVER ())::int AS sources
			   FROM cost_sources WHERE org_id = 'org_cost' AND provider = 'vercel'`,
		),
	)

const sql = (testDb: TestDb, statement: string) => Effect.promise(() => testDb.pglite.query(statement))

describe("VercelCostSourceService", () => {
	it.effect("says whether the org has a Vercel team, and whether it is a cost source", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				assert.deepStrictEqual(yield* status, { team: null, authFailed: false, added: false })
				yield* connectFakeVercel({ orgId: ORG, teamName: "Acme Inc", teamSlug: "acme" })
				const team = { name: "Acme Inc", slug: "acme" }
				assert.deepStrictEqual(yield* status, { team, authFailed: false, added: false })
				yield* add
				assert.deepStrictEqual(yield* status, { team, authFailed: false, added: true })
				// A team the org only connected reads no billing: status alone asks Vercel nothing.
				assert.lengthOf(world.urls, 1)
				yield* sql(testDb, "UPDATE vercel_connections SET auth_failed_at = now()")
				assert.deepStrictEqual(yield* status, { team, authFailed: true, added: true })
			}),
		)
	})

	it.effect("adds the connected team once Vercel let its token read yesterday's charges", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG, token: "vc_token_abc" })
				const added = yield* add
				assert.deepStrictEqual(added, { team: { name: "Acme", slug: "acme" } })
				assert.deepStrictEqual(world.urls, [CHECK_URL])
				assert.deepStrictEqual(world.authorizations, ["Bearer vc_token_abc"])
				// The source points at the connection and is named after the team's slug.
				assert.deepStrictEqual(yield* source(testDb), {
					connection_ref: connectionRef,
					account_id: "acme",
					enabled: true,
					sources: 1,
				})
			}),
		)
	})

	it.effect("adding a team that is a source already changes nothing and asks Vercel nothing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				yield* add
				const first = yield* source(testDb)
				// Vercel would refuse now, but the source exists: there is nothing to check.
				world.chargesStatus = 403
				assert.deepStrictEqual(yield* add, { team: { name: "Acme", slug: "acme" } })
				assert.lengthOf(world.urls, 1)
				assert.deepStrictEqual(yield* source(testDb), first)
			}),
		)
	})

	it.effect("refuses, with the reason, a token Vercel does not let read the team's billing", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				const refusals = yield* Effect.forEach([403, 401, 404], (status) =>
					Effect.gen(function* () {
						world.chargesStatus = status
						const error = yield* Effect.flip(add)
						return [error._tag, error.message]
					}),
				)
				assert.deepStrictEqual(refusals, [
					[
						"@maple/http/errors/IntegrationsValidationError",
						"This Vercel token's role cannot read the team's billing. Use a token from an Owner, Member, Developer or Billing role.",
					],
					[
						"@maple/http/errors/IntegrationsValidationError",
						"Vercel rejected the saved token. Connect Vercel again with a new token.",
					],
					[
						"@maple/http/errors/IntegrationsValidationError",
						"Vercel has no billing data for this team, or the team is gone.",
					],
				])
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("refuses a team whose token the integration found rejected, without asking Vercel", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG, authFailedAt: NOW - 60_000 })
				const error = yield* Effect.flip(add)
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsValidationError")
				assert.include(error.message, "Connect Vercel again")
				assert.deepStrictEqual(world.urls, [])
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("reports a Vercel outage or an unreadable answer as retryable, not as a bad token", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				const tags = yield* Effect.forEach([500, 429], (status) =>
					Effect.gen(function* () {
						world.chargesStatus = status
						return (yield* Effect.flip(add))._tag
					}),
				)
				world.chargesStatus = 200
				world.charges = "<html>maintenance</html>"
				const unreadable = yield* Effect.flip(add)
				assert.deepStrictEqual(
					[...tags, unreadable._tag],
					[
						"@maple/http/errors/IntegrationsUpstreamError",
						"@maple/http/errors/IntegrationsUpstreamError",
						"@maple/http/errors/IntegrationsUpstreamError",
					],
				)
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect(
		"refuses an org with no Vercel connection, and one outside the rollout, before any read",
		() => {
			const testDb = createTestDb(trackedDbs)
			const world = makeFakeVercel()
			return run(
				testDb,
				world,
				Effect.gen(function* () {
					const notConnected = yield* Effect.flip(add)
					assert.strictEqual(notConnected._tag, "@maple/http/errors/IntegrationsNotConnectedError")

					yield* connectFakeVercel({ orgId: ORG })
					world.cloudCost = false
					assert.strictEqual(
						(yield* Effect.flip(add))._tag,
						"@maple/http/errors/CloudCostDisabledError",
					)
					assert.strictEqual(
						(yield* Effect.flip(status))._tag,
						"@maple/http/errors/CloudCostDisabledError",
					)
					assert.deepStrictEqual(world.urls, [])
					assert.isUndefined(yield* source(testDb))
				}),
			)
		},
	)

	it.effect("makes no source for a connection that moved to another team during the check", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				// The check read the old team: its answer says nothing about the new one.
				world.onRequest = () =>
					testDb.pglite
						.query("UPDATE vercel_connections SET team_id = 'team_2', team_slug = 'beta'")
						.then(() => undefined)
				const moved = yield* Effect.flip(add)
				assert.strictEqual(moved._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
				assert.isUndefined(yield* source(testDb))

				// Disconnected during the check: the same answer.
				world.onRequest = () =>
					testDb.pglite.query("DELETE FROM vercel_connections").then(() => undefined)
				const gone = yield* Effect.flip(add)
				assert.strictEqual(gone._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
				assert.isUndefined(yield* source(testDb))
			}),
		)
	})

	it.effect("removes the source and leaves the connection, without needing the rollout", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				yield* add
				world.cloudCost = false
				assert.deepStrictEqual(yield* remove, { removed: true })
				assert.isUndefined(yield* source(testDb))
				// Nothing left to remove: said, not failed.
				assert.deepStrictEqual(yield* remove, { removed: false })
				const connection = yield* Effect.promise(() =>
					queryFirstRow<{ team_slug: string }>(testDb, "SELECT team_slug FROM vercel_connections"),
				)
				assert.strictEqual(connection?.team_slug, "acme")
			}),
		)
	})
})
