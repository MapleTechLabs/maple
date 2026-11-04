// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema, DateTime, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import {
	DashboardId,
	DashboardDocument,
	DashboardConcurrencyError,
	DashboardNotFoundError,
	DashboardPersistenceError,
	DashboardStoredConfigInvalidError,
	DashboardValidationError,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	UserId,
} from "@maple/domain/http"
import { Database, DatabaseError } from "@maple/backend/platform/DatabaseLive"
import { DashboardPersistenceService } from "./DashboardPersistenceService"
import { Env } from "@maple/backend/platform/Env"
import { CURRENT_DASHBOARD_SCHEMA_VERSION } from "@maple/widgets/dashboard"
import {
	cleanupTestDbs,
	createTestDb,
	executeSql,
	queryFirstRow,
	type TestDb,
} from "@maple/backend/platform/test-pglite"

const trackedDbs: TestDb[] = []

// A Database layer that builds successfully but fails every query, exercising
// the service's `mapError(toPersistenceError)` path. The unreachable-URL
// approach instead fails during migration in layer construction, surfacing a
// raw DatabaseError that never reaches the service's mapping.
const failingDatabaseLayer = Layer.succeed(
	Database,
	Database.of({
		execute: () =>
			Effect.fail(new DatabaseError({ message: "simulated query failure", cause: new Error("boom") })),
	}),
)

afterEach(() => cleanupTestDbs(trackedDbs))

const getError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined

	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure

	return Cause.squash(exit.cause)
}

const testConfig = () =>
	ConfigProvider.layer(
		ConfigProvider.fromUnknown({
			PORT: "3472",
			MCP_PORT: "3473",
			TINYBIRD_HOST: "https://api.tinybird.co",
			TINYBIRD_TOKEN: "test-token",
			MAPLE_AUTH_MODE: "self_hosted",
			MAPLE_ROOT_PASSWORD: "test-root-password",
			MAPLE_DEFAULT_ORG_ID: "default",
			MAPLE_INGEST_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
			MAPLE_INGEST_KEY_LOOKUP_HMAC_KEY: "maple-test-lookup-secret",
		}),
	)

const makeLayer = (testDb: TestDb) =>
	DashboardPersistenceService.layer.pipe(
		Layer.provide(testDb.layer),
		Layer.provide(Env.layer),
		Layer.provide(testConfig()),
	)

const asDashboardId = Schema.decodeUnknownSync(DashboardId)
const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)
const org = asOrgId("org_a")
const user = asUserId("user_a")

const makePortableDashboard = (
	overrides: Partial<PortableDashboardDocument> = {},
): PortableDashboardDocument =>
	new PortableDashboardDocument({
		name: "Portable Dashboard",
		timeRange: {
			type: "relative",
			value: "12h",
		},
		widgets: [],
		...overrides,
	})

describe("DashboardPersistenceService", () => {
	it.effect("lists dashboards only for the requested org", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: orgA } = yield* persistence.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({ name: "Org A" }),
			)
			yield* persistence.create(
				asOrgId("org_b"),
				asUserId("user_b"),
				makePortableDashboard({ name: "Org B" }),
			)
			const dashboards = yield* persistence.list(asOrgId("org_a"))

			assert.strictEqual(dashboards.dashboards.length, 1)
			assert.strictEqual(dashboards.dashboards[0]!.document.id, orgA.id)
			assert.strictEqual(dashboards.dashboards[0]!.document.name, "Org A")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("mutate replaces the stored document for the same org/id", () => {
		const testDb = createTestDb(trackedDbs)
		const later = asIsoDateTimeString(DateTime.formatIso(DateTime.makeUnsafe("2026-01-01T01:00:00.000Z")))

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				org,
				user,
				makePortableDashboard({ name: "First Name" }),
			)
			yield* persistence.mutate(org, user, created.id, (current) =>
				Effect.succeed(new DashboardDocument({ ...current, name: "Second Name", updatedAt: later })),
			)
			const dashboards = yield* persistence.list(org)

			assert.strictEqual(dashboards.dashboards.length, 1)
			assert.strictEqual(dashboards.dashboards[0]!.document.name, "Second Name")
			assert.strictEqual(dashboards.dashboards[0]!.document.updatedAt, later)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates dashboards from the portable import payload with fresh metadata", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({
					name: "Imported Dashboard",
					description: "Imported from JSON",
					tags: ["imported"],
				}),
			)

			const listed = yield* persistence.list(asOrgId("org_a"))

			assert.strictEqual(typeof created.id, "string")
			assert.strictEqual(created.name, "Imported Dashboard")
			assert.strictEqual(created.description, "Imported from JSON")
			assert.deepStrictEqual(created.tags, ["imported"])
			assert.deepStrictEqual(created.widgets, [])
			assert.strictEqual(typeof created.createdAt, "string")
			assert.strictEqual(typeof created.updatedAt, "string")
			assert.strictEqual(listed.dashboards.length, 1)
			assert.strictEqual(listed.dashboards[0]!.document.id, created.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("creates a dashboard from a portable payload with no tags or description", () => {
		const testDb = createTestDb(trackedDbs)

		// `tags`/`description` are `Schema.optionalKey`; `makePortableDashboard`
		// omits both here. The create path must not forward their `undefined` values
		// into `new DashboardDocument(...)`, which the Schema.Class constructor rejects.
		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({ name: "No Tags" }),
			)

			const listed = yield* persistence.list(asOrgId("org_a"))

			assert.strictEqual(created.name, "No Tags")
			assert.strictEqual(created.description, undefined)
			assert.strictEqual(created.tags, undefined)
			assert.strictEqual(listed.dashboards.length, 1)
			assert.strictEqual(listed.dashboards[0]!.document.id, created.id)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("returns DashboardNotFoundError when deleting a missing dashboard", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const exit = yield* Effect.exit(persistence.delete(asOrgId("org_a"), asDashboardId("missing")))
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, DashboardNotFoundError)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("maps database/driver errors to DashboardPersistenceError", () => {
		const failingLayer = DashboardPersistenceService.layer.pipe(Layer.provide(failingDatabaseLayer))

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const exit = yield* Effect.exit(persistence.list(asOrgId("org_a")))
			const failure = getError(exit)

			assert.isTrue(Exit.isFailure(exit))
			assert.instanceOf(failure, DashboardPersistenceError)
		}).pipe(Effect.provide(failingLayer))
	})

	// `validatePayload` is the single jsonb write choke point, so repairing the
	// section invariants there covers v2 PATCH, MCP, template
	// instantiate, Perses import and version restore at once.
	it.effect("repairs dangling section membership before persisting", () => {
		const testDb = createTestDb(trackedDbs)

		const widget = (id: string, membership: Record<string, string>) => ({
			id,
			visualization: "chart",
			dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
			display: {},
			layout: { x: 0, y: 0, w: 4, h: 4 },
			...membership,
		})

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			yield* persistence.create(
				org,
				user,
				makePortableDashboard({
					widgets: [
						widget("orphan", { sectionId: "deleted", tabId: "t1" }),
						widget("dangling-tab", { sectionId: "s1", tabId: "gone" }),
					],
					sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "Latency" }] }],
				}),
			)

			const listed = yield* persistence.list(asOrgId("org_a"))
			const stored = listed.dashboards[0]!.document
			const [orphan, dangling] = stored.widgets

			// A widget pointing at a section that is gone becomes ungrouped, and
			// the keys are absent rather than `undefined` — they are optionalKey.
			assert.isFalse("sectionId" in orphan!)
			assert.isFalse("tabId" in orphan!)
			// A dangling tab snaps to the section's first tab rather than vanishing.
			assert.strictEqual(dangling!.sectionId, "s1")
			assert.strictEqual(dangling!.tabId, "t1")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("leaves a dashboard without sections byte-identical", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			yield* persistence.create(org, user, makePortableDashboard({ name: "Flat" }))
			const listed = yield* persistence.list(asOrgId("org_a"))
			assert.isFalse("sections" in listed.dashboards[0]!.document)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	// Regression: `createDashboardDocument` enumerates portable fields explicitly,
	// so a newly-added one is silently dropped unless it is listed there. This
	// path backs v2 POST, JSON import and template instantiate alike — all three
	// lost their groups.
	it.effect("carries sections through the portable create path", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				asOrgId("org_a"),
				asUserId("user_a"),
				makePortableDashboard({
					name: "Grouped import",
					sections: [{ id: "s1", title: "Overview", tabs: [{ id: "t1", title: "Latency" }] }],
					widgets: [
						{
							id: "w1",
							visualization: "chart",
							dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
							display: {},
							layout: { x: 0, y: 0, w: 6, h: 4 },
							sectionId: "s1",
							tabId: "t1",
						},
					],
				}),
			)

			assert.strictEqual(created.sections?.length, 1)
			assert.strictEqual(created.sections?.[0]?.title, "Overview")
			assert.strictEqual(created.widgets[0]?.sectionId, "s1")

			// And it survives the round-trip through storage, not just the response.
			const listed = yield* persistence.list(asOrgId("org_a"))
			assert.strictEqual(listed.dashboards[0]?.document.sections?.length, 1)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	describe("schema versioning", () => {
		const readStoredPayload = (testDb: TestDb, id: string) =>
			Effect.promise(() =>
				queryFirstRow<{ payload_json: Record<string, unknown> }>(
					testDb,
					"SELECT payload_json FROM dashboards WHERE id = $1",
					[id],
				),
			)

		/** Inserts a row straight into storage, bypassing the write path's stamping. */
		const insertRawDashboard = (testDb: TestDb, id: string, payload: unknown) =>
			Effect.promise(() =>
				executeSql(
					testDb,
					`INSERT INTO dashboards (org_id, id, name, payload_json, created_at, updated_at, created_by, updated_by, version)
					 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
					[
						"org_a",
						id,
						"Legacy",
						JSON.stringify(payload),
						"2026-01-01T00:00:00.000Z",
						"2026-01-01T00:00:00.000Z",
						"user_a",
						"user_a",
						1,
					],
				),
			)

		const legacyPayload = (id: string) => ({
			// No `schemaVersion` key: exactly how every pre-versioning row is stored.
			id,
			name: "Legacy",
			timeRange: { type: "relative", value: "12h" },
			widgets: [
				{
					id: "w1",
					visualization: "chart",
					dataSource: {
						endpoint: "custom_query_builder_timeseries",
						params: {
							queries: [{ id: "a", name: "A", dataSource: "traces", aggregation: "count" }],
						},
					},
					display: {},
					layout: { x: 0, y: 0, w: 6, h: 4 },
				},
			],
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
		})

		it.effect("stamps the current schema version into the stored payload", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const { document: created } = yield* persistence.create(org, user, makePortableDashboard())

				const row = yield* readStoredPayload(testDb, created.id)
				assert.strictEqual(row?.payload_json.schemaVersion, CURRENT_DASHBOARD_SCHEMA_VERSION)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		// These two tests used to assert lazy upgrade: a legacy row read fine and was
		// rewritten at its next natural write. Schema v3 deliberately ends that. The
		// v2 -> v3 step is a one-shot backfill rather than a migration-chain entry, so
		// this build cannot read a row the backfill has not touched — and that gap IS
		// the migration window. The pair below pins both halves of it so the window is
		// a documented, tested property rather than a surprise in production.
		it.effect("refuses a legacy row the backfill has not converted yet", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				yield* insertRawDashboard(testDb, "dash-legacy", legacyPayload("dash-legacy"))

				const outcome = yield* Effect.exit(
					persistence.get(asOrgId("org_a"), asDashboardId("dash-legacy")),
				)

				// Loudly, not silently. A half-decoded document would be persisted by
				// the next read-modify-write and the original lost.
				assert.strictEqual(outcome._tag, "Failure")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("refuses a stored payload it cannot fully decode", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const corrupt = { ...legacyPayload("dash-corrupt"), widgets: [{ id: "no-layout" }] }
				yield* insertRawDashboard(testDb, "dash-corrupt", corrupt)

				const exit = yield* Effect.exit(
					persistence.get(asOrgId("org_a"), asDashboardId("dash-corrupt")),
				)

				assert.isTrue(Exit.isFailure(exit))
				const error = getError(exit)
				assert.instanceOf(error, DashboardStoredConfigInvalidError)
				assert.strictEqual(error.component, "document")
				assert.strictEqual(error.error.retryable, false)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("lists the readable dashboards when one stored payload does not decode", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				yield* insertRawDashboard(testDb, "dash-corrupt", {
					...legacyPayload("dash-corrupt"),
					widgets: [{}],
				})
				const { document: good } = yield* persistence.create(
					org,
					user,
					makePortableDashboard({ name: "Good" }),
				)

				const listed = yield* persistence.list(org)
				assert.deepStrictEqual(
					Arr.map(listed.dashboards, (d) => d.document.id),
					[good.id],
				)
				const page = yield* persistence.listPage(org, { limit: 10 })
				assert.deepStrictEqual(
					Arr.map(page.dashboards, (d) => d.document.id),
					[good.id],
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})

	describe("optimistic concurrency", () => {
		const rename = (name: string) => (current: DashboardDocument) =>
			Effect.succeed(new DashboardDocument({ ...current, name }))

		it.effect("rejects an edit based on a stale version with a 409 conflict", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const { document: created } = yield* persistence.create(
					org,
					user,
					makePortableDashboard({ name: "v1" }),
				)
				// Both editors loaded version 1; the first save wins.
				yield* persistence.mutate(org, user, created.id, rename("first"), { expectedVersion: 1 })
				const exit = yield* Effect.exit(
					persistence.mutate(org, user, created.id, rename("second"), { expectedVersion: 1 }),
				)

				const error = getError(exit)
				assert.instanceOf(error, DashboardConcurrencyError)
				assert.strictEqual(error.error.code, "dashboard_concurrent_update")
				const { document: stored } = yield* persistence.get(org, created.id)
				assert.strictEqual(stored.name, "first")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("keeps last-write-wins for a caller that sends no expected version", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const { document: created } = yield* persistence.create(
					org,
					user,
					makePortableDashboard({ name: "v1" }),
				)
				yield* persistence.mutate(org, user, created.id, rename("first"), { expectedVersion: 1 })
				yield* persistence.mutate(org, user, created.id, rename("second"))

				const { document: stored } = yield* persistence.get(org, created.id)
				assert.strictEqual(stored.name, "second")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("returns the committed version from every read and write", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const created = yield* persistence.create(org, user, makePortableDashboard({ name: "v1" }))
				assert.strictEqual(created.version, 1)
				const saved = yield* persistence.mutate(org, user, created.document.id, rename("first"), {
					expectedVersion: created.version,
				})
				assert.strictEqual(saved.version, 2)
				assert.strictEqual((yield* persistence.get(org, created.document.id)).version, 2)
				const page = yield* persistence.listPage(org, { limit: 10 })
				assert.deepStrictEqual(
					Arr.map(page.dashboards, (d) => d.version),
					[2],
				)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("rolls the dashboard write back when its history row cannot be written", () => {
			const testDb = createTestDb(trackedDbs)

			return Effect.gen(function* () {
				const persistence = yield* DashboardPersistenceService
				const { document: created } = yield* persistence.create(
					org,
					user,
					makePortableDashboard({ name: "v1" }),
				)
				// Every history write fails from here on, after the dashboard row was updated.
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`CREATE FUNCTION refuse_history() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'history unavailable'; END $$ LANGUAGE plpgsql`,
					),
				)
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						"CREATE TRIGGER refuse_history BEFORE INSERT OR UPDATE ON dashboard_versions FOR EACH ROW EXECUTE FUNCTION refuse_history()",
					),
				)

				const exit = yield* Effect.exit(persistence.mutate(org, user, created.id, rename("lost")))

				assert.instanceOf(getError(exit), DashboardPersistenceError)
				const stored = yield* persistence.get(org, created.id)
				assert.strictEqual(stored.document.name, "v1")
				assert.strictEqual(stored.version, 1)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})

	it.effect("rejects a document with duplicate widget ids", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const exit = yield* Effect.exit(
				persistence.create(
					org,
					user,
					makePortableDashboard({
						widgets: [
							{
								id: "same",
								visualization: "chart",
								dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
								display: {},
								layout: { x: 0, y: 0, w: 4, h: 4 },
							},
							{
								id: "same",
								visualization: "chart",
								dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
								display: {},
								layout: { x: 0, y: 0, w: 4, h: 4 },
							},
						],
					}),
				),
			)

			const error = getError(exit)
			assert.instanceOf(error, DashboardValidationError)
			assert.deepStrictEqual(error.details, ["Duplicate widget id: same"])
			assert.strictEqual((yield* persistence.list(org)).dashboards.length, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("keeps a board stored with duplicate widget ids editable", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				org,
				user,
				makePortableDashboard({
					widgets: [
						{
							id: "same",
							visualization: "chart",
							dataSource: { kind: "query", resultShape: "timeseries", queries: [] },
							display: {},
							layout: { x: 0, y: 0, w: 4, h: 4 },
						},
					],
				}),
			)
			// Stored before the rule existed: the widget appears twice.
			yield* Effect.promise(() =>
				executeSql(
					testDb,
					`UPDATE dashboards SET payload_json = jsonb_set(payload_json, '{widgets}', (payload_json->'widgets') || (payload_json->'widgets')) WHERE id = $1`,
					[created.id],
				),
			)

			yield* persistence.mutate(org, user, created.id, (current) =>
				Effect.succeed(new DashboardDocument({ ...current, name: "renamed" })),
			)

			const { document: stored } = yield* persistence.get(org, created.id)
			assert.strictEqual(stored.name, "renamed")
			assert.strictEqual(stored.widgets.length, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("deletes a dashboard together with its version history", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(org, user, makePortableDashboard())
			yield* persistence.delete(org, created.id)

			const remaining = yield* Effect.promise(() =>
				queryFirstRow<{ count: number }>(
					testDb,
					"SELECT count(*)::int AS count FROM dashboard_versions WHERE dashboard_id = $1",
					[created.id],
				),
			)
			assert.strictEqual(remaining?.count, 0)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("cuts a new history version every window under a steady stream of edits", () => {
		const testDb = createTestDb(trackedDbs)
		const rename = (name: string) => (current: DashboardDocument) =>
			Effect.succeed(new DashboardDocument({ ...current, name }))

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(
				org,
				user,
				makePortableDashboard({ name: "v0" }),
			)
			// Renames 3s apart: each is inside the window of the previous edit, but the
			// third is 6s after the version it would merge into.
			yield* TestClock.adjust("3 seconds")
			yield* persistence.mutate(org, user, created.id, rename("v1"))
			yield* TestClock.adjust("3 seconds")
			yield* persistence.mutate(org, user, created.id, rename("v2"))
			yield* TestClock.adjust("3 seconds")
			yield* persistence.mutate(org, user, created.id, rename("v3"))

			const history = yield* persistence.listVersions(org, created.id)
			assert.deepStrictEqual(
				Arr.map(history.versions, (version) => [version.versionNumber, version.changeKind]),
				[
					[3, "renamed"],
					[2, "renamed"],
					[1, "created"],
				],
			)
			const latest = yield* persistence.getVersion(org, created.id, history.versions[0]!.id)
			assert.strictEqual(latest.snapshot.name, "v3")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("pages the list in SQL newest first, ties broken by id", () => {
		const testDb = createTestDb(trackedDbs)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			// Two created in the same millisecond share updatedAt, so only the id orders them.
			const { document: a } = yield* persistence.create(org, user, makePortableDashboard({ name: "a" }))
			const { document: b } = yield* persistence.create(org, user, makePortableDashboard({ name: "b" }))
			yield* TestClock.adjust("1 second")
			const { document: newest } = yield* persistence.create(
				org,
				user,
				makePortableDashboard({ name: "c" }),
			)

			const first = yield* persistence.listPage(org, { limit: 2 })
			assert.isNotNull(first.next)
			const second = yield* persistence.listPage(org, { limit: 2, after: first.next! })
			assert.isNull(second.next)

			const tied = [a.id, b.id].sort().reverse()
			assert.deepStrictEqual(
				Arr.map([...first.dashboards, ...second.dashboards], (d) => d.document.id),
				[newest.id, ...tied],
			)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
