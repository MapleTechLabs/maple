import { randomUUID } from "node:crypto"
import { afterEach, assert, describe, it } from "@effect/vitest"
import { vi } from "vitest"
import {
	ConfigProvider,
	Effect,
	Exit,
	Fiber,
	Layer,
	Option,
	Schema,
	Array as Arr,
	Record as Rec,
} from "effect"
import { TestClock } from "effect/testing"
import { FetchHttpClient } from "effect/http"
import * as PG from "@maple-dev/effect-orm/postgres"
import { ErrorIssueVerifications, OrgErasures } from "@maple/db/tables"
import {
	EnterpriseSsoUnavailableError,
	IntegrationsPersistenceError,
	OrganizationForbiddenError,
	OrganizationPersistenceError,
	OrganizationProviderError,
	OrgId,
	RoleName,
} from "@maple/domain/http"
import { ErrorIssueId, ErrorIssuePullRequestId, ErrorIssueVerificationId } from "@maple/primitives"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { countOrgRows, ORG_A, ORG_B, seedOrgRow } from "@maple/backend/testing/test-two-orgs"
import {
	fakeOffboardingProviders,
	OFFBOARDED_PROVIDERS,
	type FakeOffboardingOptions,
	type OffboardedProvider,
} from "@maple/backend/testing/offboarding-providers"
import { IntegrationOffboardingService } from "@maple/backend/services/integrations/IntegrationOffboardingService"
import { EnterpriseSsoService, type EnterpriseSsoServiceApi } from "./enterprise-sso/EnterpriseSsoService"
import { OrganizationDeletionService } from "./OrganizationDeletionService"
import { OrganizationRegionService } from "./OrganizationRegionService"
import { ORG_DELETE_REGISTRY } from "./OrganizationService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

type RemoveSso = EnterpriseSsoServiceApi["removeForDeletedOrganization"]

/** The real offboarding steps over integration services that reach no vendor. */
const offboardingOver = (options: FakeOffboardingOptions) =>
	Layer.effect(IntegrationOffboardingService, IntegrationOffboardingService.make).pipe(
		Layer.provide(fakeOffboardingProviders(options)),
	)

const nothingConnected = offboardingOver({ teardown: () => Effect.void })

// The region service is irrelevant to delete; `servesAll` spares it the edge cache.
const makeLayer = (
	testDb: TestDb,
	removeSso: RemoveSso = () => Effect.void,
	offboarding: Layer.Layer<IntegrationOffboardingService> = nothingConnected,
) =>
	Layer.effect(OrganizationDeletionService, OrganizationDeletionService.make).pipe(
		Layer.provide(
			Layer.mergeAll(
				OrganizationRegionService.servesAll,
				Layer.mock(EnterpriseSsoService)({ removeForDeletedOrganization: removeSso }),
				offboarding,
				FetchHttpClient.layer,
			),
		),
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(
			ConfigProvider.layer(
				ConfigProvider.fromUnknown({
					PORT: "3474",
					MCP_PORT: "3475",
					TINYBIRD_HOST: "https://api.tinybird.co",
					TINYBIRD_TOKEN: "test-token",
					// Self-hosted: no Clerk, so delete touches nothing but Postgres.
					MAPLE_AUTH_MODE: "self_hosted",
					MAPLE_ROOT_PASSWORD: "test-root-password",
					MAPLE_DEFAULT_ORG_ID: "default",
					MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
					MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
				}),
			),
		),
	)

const role = Schema.decodeUnknownSync(RoleName)

/** Every purged table with the column that ties its rows to an org. */
const purgedTables = [
	...Arr.map(ORG_DELETE_REGISTRY.orgScoped, (table) => ({ name: table.ddl.table.name, column: "org_id" })),
	...Arr.map(ORG_DELETE_REGISTRY.approvedOrgScoped, (table) => ({
		name: table.ddl.table.name,
		column: "approved_org_id",
	})),
]

/** One row per purged table for each org; returns per-table counts for both. */
const seedBothOrgs = (testDb: TestDb) =>
	Effect.forEach(
		purgedTables,
		(table) =>
			Effect.all([
				seedOrgRow(testDb, table.name, table.column, ORG_A),
				seedOrgRow(testDb, table.name, table.column, ORG_B),
			]),
		{ discard: true },
	)

const countsFor = (testDb: TestDb, orgId: OrgId) =>
	Effect.forEach(purgedTables, (table) =>
		countOrgRows(testDb, table.name, table.column, orgId).pipe(
			Effect.map((count) => [table.name, count] as const),
		),
	).pipe(Effect.map((entries) => Rec.fromEntries(entries)))

const everyTableAt = (count: number) => Rec.fromEntries(Arr.map(purgedTables, (table) => [table.name, count]))

describe("OrganizationDeletionService.delete", () => {
	it.effect("purges every registered table for the deleted org and leaves the other org intact", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			// An empty registry would make every assertion below vacuous.
			assert.isAbove(purgedTables.length, 0)
			yield* seedBothOrgs(testDb)
			// The seed must actually land in every table, or "B is intact" proves nothing.
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(1))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))

			const organizations = yield* OrganizationDeletionService
			yield* organizations.delete(ORG_A, [role("org:admin")])

			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a non-admin and deletes nothing", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService

			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:member")]))

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationForbiddenError)
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(1))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses to delete an org other orgs are billed through", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					"INSERT INTO org_billing_links (org_id, billing_org_id, linked_by, created_at) VALUES ($1, $2, 'user_a', now())",
					[ORG_B, ORG_A],
				),
			)
			const organizations = yield* OrganizationDeletionService

			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:admin")]))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationForbiddenError)

			// The member itself can still go, and takes its link with it.
			yield* organizations.delete(ORG_B, [role("org:admin")])
			assert.strictEqual(yield* countOrgRows(testDb, "org_billing_links", "billing_org_id", ORG_A), 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("removes the org's single sign-on before its rows, and keeps the rows when that fails", () => {
		const testDb = createTestDb(trackedDbs)
		const clerk = { down: true }
		// What the SSO removal still finds of the org's connection row when it runs.
		const rowsSeen: Array<number> = []
		const removeSso: RemoveSso = (orgId) =>
			countOrgRows(testDb, "org_sso_connections", "org_id", orgId).pipe(
				Effect.orDie,
				Effect.flatMap((count) => {
					rowsSeen.push(count)
					return clerk.down
						? Effect.fail(new EnterpriseSsoUnavailableError({ message: "Clerk is down" }))
						: Effect.void
				}),
			)
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService

			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:admin")]))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationProviderError)
			// Only the billing link is gone: delete drops it under its lock before anything else.
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), {
				...everyTableAt(1),
				org_billing_links: 0,
			})

			// The retry finds the connection row it needs, and then the purge runs.
			clerk.down = false
			yield* organizations.delete(ORG_A, [role("org:admin")])
			assert.deepStrictEqual(rowsSeen, [1, 1])
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb, removeSso)))
	})

	it.effect("ends the org's grant at every vendor while its rows still exist, then purges them", () => {
		const testDb = createTestDb(trackedDbs)
		// What each vendor teardown still finds of the org's stored grants when it runs.
		const grantsSeen: Array<readonly [OffboardedProvider, number]> = []
		const offboarding = offboardingOver({
			teardown: (provider, orgId) =>
				countOrgRows(testDb, "oauth_connections", "org_id", orgId).pipe(
					Effect.orDie,
					Effect.map((count) => void grantsSeen.push([provider, count])),
				),
		})
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService
			yield* organizations.delete(ORG_A, [role("org:admin")])

			assert.sameDeepMembers(
				grantsSeen,
				Arr.map(OFFBOARDED_PROVIDERS, (provider) => [provider, 1] as const),
			)
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb, undefined, offboarding)))
	})

	it.effect("still deletes the org when one vendor fails and another never answers", () => {
		const testDb = createTestDb(trackedDbs)
		const started: Array<OffboardedProvider> = []
		const offboarding = offboardingOver({
			// Chat's own teardown completes, with one workspace's revoke refused by its platform.
			refusedBy: ["chat"],
			teardown: (provider) =>
				Effect.andThen(
					Effect.sync(() => void started.push(provider)),
					provider === "linear"
						? Effect.fail(new IntegrationsPersistenceError({ message: "Linear is down" }))
						: provider === "supabase"
							? Effect.never
							: Effect.void,
				),
		})
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService
			const pending = yield* Effect.forkChild(organizations.delete(ORG_A, [role("org:admin")]))
			// The stalled vendor is waited on for a bounded time; the deletion then goes on.
			yield* Effect.promise(() => vi.waitFor(() => assert.include(started, "supabase")))
			yield* TestClock.adjust("1 minute")
			const deleted = yield* Fiber.join(pending)

			assert.isTrue(deleted.deleted)
			// The caller is told which vendors may still hold access.
			assert.sameMembers(deleted.incompleteTeardowns ?? [], ["linear", "supabase", "chat"])
			assert.sameMembers(started, [...OFFBOARDED_PROVIDERS])
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb, undefined, offboarding)))
	})

	it.effect("names no vendor when every teardown ended", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService
			const deleted = yield* organizations.delete(ORG_A, [role("org:admin")])
			assert.isUndefined(deleted.incompleteTeardowns)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("a deletion retried after a failed purge finishes the job", () => {
		const testDb = createTestDb(trackedDbs)
		const teardowns = { count: 0 }
		const offboarding = offboardingOver({
			teardown: (provider) =>
				provider === "linear" ? Effect.sync(() => void (teardowns.count += 1)) : Effect.void,
		})
		// The table the purge reaches last: renamed away, its delete fails after every other ran.
		const last = Arr.lastNonEmpty(ORG_DELETE_REGISTRY.approvedOrgScoped).ddl.table.name
		const rename = (from: string, to: string) =>
			Effect.promise(() => executeSql(testDb, `alter table "${from}" rename to "${to}"`))
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService
			yield* rename(last, `${last}_away`)
			const exit = yield* Effect.exit(organizations.delete(ORG_A, [role("org:admin")]))
			assert.instanceOf(Option.getOrUndefined(Exit.findErrorOption(exit)), OrganizationPersistenceError)

			yield* rename(`${last}_away`, last)
			const deleted = yield* organizations.delete(ORG_A, [role("org:admin")])

			assert.isTrue(deleted.deleted)
			// The teardown ran again on the retry and found nothing it could not handle.
			assert.strictEqual(teardowns.count, 2)
			assert.isUndefined(deleted.incompleteTeardowns)
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_A), everyTableAt(0))
			assert.deepStrictEqual(yield* countsFor(testDb, ORG_B), everyTableAt(1))
		}).pipe(Effect.provide(makeLayer(testDb, undefined, offboarding)))
	})

	it.effect("leaves the org's integrations connected when the deletion is refused or stops early", () => {
		const testDb = createTestDb(trackedDbs)
		const tornDown: Array<OffboardedProvider> = []
		const offboarding = offboardingOver({
			teardown: (provider) => Effect.sync(() => void tornDown.push(provider)),
		})
		const ssoDown: RemoveSso = () =>
			Effect.fail(new EnterpriseSsoUnavailableError({ message: "Clerk is down" }))
		return Effect.gen(function* () {
			yield* seedBothOrgs(testDb)
			const organizations = yield* OrganizationDeletionService
			yield* Effect.exit(organizations.delete(ORG_A, [role("org:member")]))
			yield* Effect.exit(organizations.delete(ORG_A, [role("org:admin")]))
			assert.deepStrictEqual(tornDown, [])
		}).pipe(Effect.provide(makeLayer(testDb, ssoDown, offboarding)))
	})

	it.effect(
		"queues the org's conversations and replays for erasure, then purges the rows naming them",
		() => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedOrgRow(testDb, "investigations", "org_id", ORG_A)
				yield* seedOrgRow(testDb, "investigations", "org_id", ORG_B)
				const organizations = yield* OrganizationDeletionService
				yield* organizations.delete(ORG_A, [role("org:admin")])

				const database = yield* Database
				const queued = yield* database.execute((db) =>
					db.run(
						PG.from(OrgErasures)
							.select("orgId", "kind")
							.orderBy(($) => [[$.kind, "asc"]]),
					),
				)
				assert.isTrue(Arr.every(queued, (row) => row.orgId === ORG_A))
				assert.deepStrictEqual(Arr.dedupe(Arr.map(queued, (row) => row.kind)), [
					"chat_session",
					"replay_blobs",
					"warehouse",
				])
				assert.strictEqual(yield* countOrgRows(testDb, "investigations", "org_id", ORG_A), 0)
				assert.strictEqual(yield* countOrgRows(testDb, "investigations", "org_id", ORG_B), 1)
			}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
		},
	)

	it.effect("leaves the verification tick nothing due for the deleted org", () => {
		const testDb = createTestDb(trackedDbs)
		const NOW_MS = Date.UTC(2026, 6, 6, 9, 0, 0)
		const waiting = (orgId: OrgId) => ({
			id: ErrorIssueVerificationId.make(randomUUID()),
			orgId,
			issueId: ErrorIssueId.make(randomUUID()),
			pullRequestId: ErrorIssuePullRequestId.make(randomUUID()),
			mergedAt: NOW_MS - 7_200_000,
			verifyAfter: NOW_MS - 3_600_000,
			createdAt: NOW_MS - 7_200_000,
			updatedAt: NOW_MS - 7_200_000,
		})
		return Effect.gen(function* () {
			const database = yield* Database
			yield* database.execute((db) =>
				db.run(PG.insertInto(ErrorIssueVerifications).values([waiting(ORG_A), waiting(ORG_B)])),
			)
			const organizations = yield* OrganizationDeletionService
			yield* organizations.delete(ORG_A, [role("org:admin")])

			// What the tick selects: every org's waiting rows whose window has closed.
			const due = yield* database.execute((db) =>
				db.run(
					PG.from(ErrorIssueVerifications)
						.select("orgId")
						.where(($) => [$.status.eq("waiting"), $.verifyAfter.lte(NOW_MS)]),
				),
			)
			assert.deepStrictEqual(
				Arr.map(due, (row) => row.orgId),
				[ORG_B],
			)
		}).pipe(Effect.provide(Layer.merge(makeLayer(testDb), testDb.layer)))
	})
})
