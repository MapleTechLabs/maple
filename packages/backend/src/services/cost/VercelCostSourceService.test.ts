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
import * as VendorFake from "@maple/backend/testing/vendor-fake"
import { VercelCostProvider } from "./providers/vercel/VercelCostProvider"
import { VercelCostSourceService } from "./VercelCostSourceService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeSync(OrgId)("org_cost")
const NOW = DateTime.toEpochMillis(DateTime.makeUnsafe("2026-11-12T09:00:00Z"))
/** The check read: yesterday and today, as a head pull ends. */
const CHECK_URL =
	"https://api.vercel.com/v1/billing/charges?teamId=team_1&from=2026-11-11T00%3A00%3A00Z&to=2026-11-13T00%3A00%3A00Z"

const run = <A, E>(
	testDb: TestDb,
	world: FakeVercel,
	effect: Effect.Effect<A, E, VercelCostSourceService | Database | Env>,
	encryptionKey?: string,
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* effect
	}).pipe(
		Effect.provide(
			Layer.effect(VercelCostSourceService, VercelCostSourceService.make).pipe(
				Layer.provide(Layer.effect(VercelCostProvider, VercelCostProvider.make)),
				Layer.provideMerge(fakeVercelDeps(testDb, world, encryptionKey)),
			),
		),
	)

const status = VercelCostSourceService.use((service) => service.status(ORG))
/** Adds the team the Cost page was shown, `team_1` unless said otherwise. */
const addTeam = (teamId: string) => VercelCostSourceService.use((service) => service.add(ORG, teamId))
const add = addTeam("team_1")
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
				const team = { id: "team_1", name: "Acme Inc", slug: "acme" }
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

	it.effect("adds the connected team once Vercel let its token read the newest charges", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				const connectionRef = yield* connectFakeVercel({ orgId: ORG, token: "vc_token_abc" })
				const added = yield* add
				assert.deepStrictEqual(added, {
					team: { id: "team_1", name: "Acme", slug: "acme" },
					created: true,
				})
				assert.deepStrictEqual(world.urls, [CHECK_URL])
				assert.deepStrictEqual(world.authorizations, ["Bearer vc_token_abc"])
				// The source points at the connection.
				assert.deepStrictEqual(yield* source(testDb), {
					connection_ref: connectionRef,
					// The team's id: its slug can be renamed, and rows already stored keep their account.
					account_id: "team_1",
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
				assert.deepStrictEqual(yield* add, {
					team: { id: "team_1", name: "Acme", slug: "acme" },
					created: false,
				})
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
						"This Vercel token's role cannot read the team's billing. Use a token from an Owner, Member, Developer, Security, Billing or Enterprise Viewer role.",
					],
					[
						"@maple/http/errors/IntegrationsValidationError",
						"Vercel rejected the saved token. Replace the token of the Vercel connection.",
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
				assert.include(error.message, "Replace the token")
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
						// A 5xx is retried; the clock moves the back-off along.
						return (yield* Effect.flip(VendorFake.elapsing(add)))._tag
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

	it.effect("does not blame the token when Maple cannot open it", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return Effect.gen(function* () {
			// Sealed with the usable key, read on a deployment that has lost it.
			yield* run(testDb, world, connectFakeVercel({ orgId: ORG }))
			const error = yield* Effect.flip(run(testDb, world, add, "not-a-32-byte-key"))
			assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsUpstreamError")
			assert.deepStrictEqual(world.urls, [])
			assert.isUndefined(yield* source(testDb))
		})
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

				// A new token saved for the same team during the check: it was not the one that read.
				yield* sql(testDb, "UPDATE vercel_connections SET team_id = 'team_1', team_slug = 'acme'")
				world.onRequest = () =>
					testDb.pglite
						.query("UPDATE vercel_connections SET token_ciphertext = token_ciphertext || 'x'")
						.then(() => undefined)
				const replaced = yield* Effect.flip(add)
				assert.strictEqual(replaced._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
				assert.isUndefined(yield* source(testDb))

				// Disconnected during the check: the same answer.
				world.onRequest = () =>
					testDb.pglite.query("DELETE FROM vercel_connections").then(() => undefined)
				const gone = yield* Effect.flip(add)
				assert.strictEqual(gone._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
				assert.isUndefined(yield* source(testDb))
				assert.lengthOf(world.urls, 3)
			}),
		)
	})

	it.effect("refuses to add another team than the one the Cost page showed, before any read", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel()
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				// Shown team_1 in the dialog; the org's connection was moved to team_2 since.
				yield* connectFakeVercel({ orgId: ORG, teamId: "team_2", teamSlug: "beta", teamName: "Beta" })
				const error = yield* Effect.flip(addTeam("team_1"))
				assert.strictEqual(error._tag, "@maple/http/errors/IntegrationsConnectionChangedError")
				assert.include(error.message, "another team (beta)")
				assert.deepStrictEqual(world.urls, [])
				assert.isUndefined(yield* source(testDb))
				// Naming the team that is connected adds it.
				assert.strictEqual((yield* addTeam("team_2")).created, true)
				assert.strictEqual((yield* source(testDb))?.account_id, "team_2")
			}),
		)
	})

	it.effect("shows what Vercel said about a request it calls invalid, which no retry fixes", () => {
		const testDb = createTestDb(trackedDbs)
		const world = makeFakeVercel({ chargesStatus: 400 })
		return run(
			testDb,
			world,
			Effect.gen(function* () {
				yield* connectFakeVercel({ orgId: ORG })
				const error = yield* Effect.flip(add)
				// A public error: the dialog shows this text, not a fixed sentence.
				assert.deepStrictEqual(
					[error._tag, error.message],
					[
						"@maple/http/errors/IntegrationsValidationError",
						"Vercel refused the billing request as invalid: status 400",
					],
				)
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
