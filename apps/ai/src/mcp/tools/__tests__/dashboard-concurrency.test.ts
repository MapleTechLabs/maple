// BOUNDARY: Test doubles preserve opaque values so the consuming boundary can be exercised.
// Concurrency regression tests for the shared dashboard mutation pipeline used
// by the MCP tools (add_dashboard_widget, remove_dashboard_widget,
// reorder_dashboard_widgets, update_dashboard_widget, update_dashboard).
//
// These tests exercise `DashboardPersistenceService.mutate`, which the MCP
// tools delegate to via `withDashboardMutation`. The previous
// implementation was a read-modify-write with no compare-and-swap, so two
// concurrent calls could silently lose one update. The new implementation
// uses a `(id, version)` CAS with bounded retry; these tests guard against
// regressions of that property.

import { afterEach, assert, describe, it } from "@effect/vitest"
import { Cause, ConfigProvider, Effect, Exit, Layer, Option, Schema, Array as Arr } from "effect"
import {
	DashboardConcurrencyError,
	DashboardDocument,
	IsoDateTimeString,
	OrgId,
	PortableDashboardDocument,
	UserId,
} from "@maple/domain/http"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { Env } from "@maple/backend/platform/Env"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"

const trackedDbs: TestDb[] = []

afterEach(() => cleanupTestDbs(trackedDbs))

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

const asIsoDateTimeString = Schema.decodeUnknownSync(IsoDateTimeString)
const asOrgId = Schema.decodeUnknownSync(OrgId)
const asUserId = Schema.decodeUnknownSync(UserId)

const ORG = asOrgId("org_a")
const USER = asUserId("user_a")

type Widget = DashboardDocument["widgets"][number]

const widget = (id: string): Widget => ({
	id,
	visualization: "stat",
	dataSource: { kind: "route", endpoint: "test" },
	display: {},
	layout: { x: 0, y: 0, w: 3, h: 4 },
})

const seed = (name = "Dashboard") =>
	new PortableDashboardDocument({ name, timeRange: { type: "relative", value: "12h" }, widgets: [] })

const rename = (name: string) => (existing: DashboardDocument) =>
	Effect.succeed(new DashboardDocument({ ...existing, name }))

const findError = <A, E>(exit: Exit.Exit<A, E>): unknown => {
	if (!Exit.isFailure(exit)) return undefined
	const failure = Option.getOrUndefined(Exit.findErrorOption(exit))
	if (failure !== undefined) return failure
	return Cause.squash(exit.cause)
}

describe("dashboard concurrency", () => {
	it.effect("two concurrent `mutate` calls both land via retry — no lost update", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(ORG, USER, seed())

			const addWidget = (widgetId: string) =>
				persistence.mutate(ORG, USER, created.id, (existing) =>
					Effect.succeed(
						new DashboardDocument({
							...existing,
							widgets: [...existing.widgets, widget(widgetId)],
							updatedAt: asIsoDateTimeString(new Date().toISOString()),
						}),
					),
				)

			yield* Effect.all([addWidget("w-a"), addWidget("w-b")], { concurrency: 2 })

			const listed = yield* persistence.list(ORG)

			assert.strictEqual(listed.dashboards.length, 1)
			const widgets = Arr.map(listed.dashboards[0].document.widgets, (w) => w.id).sort()
			assert.deepStrictEqual(widgets, ["w-a", "w-b"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("two writers based on the same version: one lands, the other is a typed conflict", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(ORG, USER, seed("Initial"))

			// Both loaded version 1. Whichever commits second must not clobber the first.
			const exits = yield* Effect.all(
				Arr.map(["From writer A", "From writer B"], (name) =>
					Effect.exit(
						persistence.mutate(ORG, USER, created.id, rename(name), { expectedVersion: 1 }),
					),
				),
				{ concurrency: 2 },
			)

			const successes = Arr.filter(exits, Exit.isSuccess)
			const failures = Arr.filter(exits, Exit.isFailure)
			assert.strictEqual(successes.length, 1)
			assert.strictEqual(failures.length, 1)
			assert.instanceOf(findError(failures[0]), DashboardConcurrencyError)
			const { document: stored } = yield* persistence.get(ORG, created.id)
			assert.strictEqual(stored.name, successes[0].value.document.name)
		}).pipe(Effect.provide(layer))
	})

	it.effect("after a conflict, a retry based on the fresh version resolves", () => {
		const testDb = createTestDb(trackedDbs)
		const layer = makeLayer(testDb)

		return Effect.gen(function* () {
			const persistence = yield* DashboardPersistenceService
			const { document: created } = yield* persistence.create(ORG, USER, seed("Initial"))
			yield* persistence.mutate(ORG, USER, created.id, rename("Writer A"), { expectedVersion: 1 })
			const stale = yield* Effect.exit(
				persistence.mutate(ORG, USER, created.id, rename("Writer B"), { expectedVersion: 1 }),
			)
			assert.instanceOf(findError(stale), DashboardConcurrencyError)

			// What the web store does on a 409: re-read, re-apply on top, send the new version.
			yield* persistence.mutate(ORG, USER, created.id, rename("Recovered"), { expectedVersion: 2 })

			assert.strictEqual((yield* persistence.get(ORG, created.id)).document.name, "Recovered")
		}).pipe(Effect.provide(layer))
	})
})
