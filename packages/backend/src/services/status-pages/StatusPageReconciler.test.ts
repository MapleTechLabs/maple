import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { overlayIncidentId, StatusPageKeys, type StatusPageOverlayEntry } from "@maple/domain/status-page"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { StatusPageReconciler } from "./StatusPageReconciler"
import { StatusPageStore } from "./StatusPageStore"
import { newPageId, NOW, readPage, seedComponent, seedPage } from "./status-page-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const entry = (overrides: Partial<StatusPageOverlayEntry> & Pick<StatusPageOverlayEntry, "id" | "at">) => ({
	incidentId: null,
	title: null,
	status: "investigating" as const,
	impact: "major" as const,
	body: "Update",
	componentIds: [],
	...overrides,
})

const incidentsOf = (testDb: TestDb, pageId: string) =>
	Effect.promise(() =>
		testDb.pglite.query<{
			id: string
			title: string
			status: string
			resolved: boolean
			components: number
		}>(
			`SELECT i.id, i.title, i.status, i.resolved_at IS NOT NULL AS resolved,
				(SELECT count(*)::int FROM status_page_incident_components c WHERE c.incident_id = i.id) AS components
			 FROM status_page_incidents i WHERE i.page_id = $1`,
			[pageId],
		),
	).pipe(Effect.map((result) => result.rows))

const updatesOf = (testDb: TestDb, incidentId: string) =>
	Effect.promise(() =>
		testDb.pglite.query<{ overlay_entry_id: string; source: string }>(
			`SELECT overlay_entry_id, source FROM status_page_incident_updates WHERE incident_id = $1 ORDER BY created_at`,
			[incidentId],
		),
	).pipe(Effect.map((result) => result.rows))

describe("StatusPageReconciler", () => {
	it.effect("imports a new incident and its follow-up once, then clears only those entries", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const store = yield* StatusPageStore.makeInMemory
			const pageId = newPageId()
			const componentId = crypto.randomUUID()
			yield* seedPage(testDb, { id: pageId, slug: "acme-bg", breakGlass: true })
			yield* seedComponent(testDb, { id: componentId, pageId, name: "API", position: 0 })

			const opening = crypto.randomUUID()
			const followUp = crypto.randomUUID()
			const entries = [
				// Out of order on purpose: import goes by `at`.
				entry({
					id: followUp,
					at: NOW + 60_000,
					incidentId: overlayIncidentId(opening),
					status: "resolved",
					body: "Fixed",
				}),
				entry({
					id: opening,
					at: NOW,
					title: "Login broken",
					componentIds: [componentId, "not-a-component"],
				}),
			]
			yield* store.putKv(StatusPageKeys.overlay(pageId), JSON.stringify({ entries }))

			const layer = StatusPageReconciler.layer.pipe(
				Layer.provide(Layer.succeed(StatusPageStore, store.api)),
				Layer.provide(testDb.layer),
			)
			const reconciler = yield* StatusPageReconciler.pipe(Effect.provide(layer))

			const first = yield* reconciler.reconcile(pageId)
			assert.strictEqual(first.imported, 2)
			const incidents = yield* incidentsOf(testDb, pageId)
			assert.deepStrictEqual(
				incidents.map(({ title, status, resolved, components }) => ({
					title,
					status,
					resolved,
					components,
				})),
				[{ title: "Login broken", status: "resolved", resolved: true, components: 1 }],
			)
			const incidentId = incidents[0]?.id ?? ""
			assert.deepStrictEqual(yield* updatesOf(testDb, incidentId), [
				{ overlay_entry_id: opening, source: "break_glass" },
				{ overlay_entry_id: followUp, source: "break_glass" },
			])
			assert.isFalse((yield* store.contents).kv.has(StatusPageKeys.overlay(pageId)))
			assert.strictEqual((yield* readPage(testDb, pageId))?.revision, "3")

			// The edge re-posts the same entries plus a new one (a re-import must not duplicate).
			const later = crypto.randomUUID()
			yield* store.putKv(
				StatusPageKeys.overlay(pageId),
				JSON.stringify({
					entries: [
						...entries,
						entry({
							id: later,
							at: NOW + 120_000,
							incidentId,
							status: "monitoring",
							body: "Watching",
						}),
					],
				}),
			)
			const second = yield* reconciler.reconcileAll()
			assert.deepStrictEqual(second, { pages: 1, imported: 3, failed: 0 })
			assert.strictEqual((yield* incidentsOf(testDb, pageId)).length, 1)
			assert.strictEqual((yield* updatesOf(testDb, incidentId)).length, 3)
			assert.strictEqual((yield* incidentsOf(testDb, pageId))[0]?.status, "monitoring")
		}),
	)

	it.effect("leaves the overlay when clearing it fails, and a rerun does not import twice", () =>
		Effect.gen(function* () {
			const testDb = createTestDb(trackedDbs)
			const store = yield* StatusPageStore.makeInMemory
			const pageId = newPageId()
			yield* seedPage(testDb, { id: pageId, slug: "acme-keep", breakGlass: true })
			const only = entry({ id: crypto.randomUUID(), at: NOW, title: "Outage" })
			yield* store.putKv(StatusPageKeys.overlay(pageId), JSON.stringify({ entries: [only] }))
			yield* store.setFailing((key) => key === StatusPageKeys.overlay(pageId))

			const layer = StatusPageReconciler.layer.pipe(
				Layer.provide(Layer.succeed(StatusPageStore, store.api)),
				Layer.provide(testDb.layer),
			)
			const reconciler = yield* StatusPageReconciler.pipe(Effect.provide(layer))
			const failed = yield* Effect.exit(reconciler.reconcile(pageId))
			assert.isTrue(Exit.isFailure(failed))
			assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.overlay(pageId)))

			yield* store.setFailing(false)
			assert.strictEqual((yield* reconciler.reconcile(pageId)).imported, 1)
			assert.strictEqual((yield* incidentsOf(testDb, pageId)).length, 1)
			assert.isFalse((yield* store.contents).kv.has(StatusPageKeys.overlay(pageId)))
		}),
	)
})

describe("StatusPageStore.removeOverlayEntries", () => {
	it.effect("removes only the given entries", () =>
		Effect.gen(function* () {
			const store = yield* StatusPageStore.makeInMemory
			const pageId = newPageId()
			const a = entry({ id: "a", at: NOW })
			const b = entry({ id: "b", at: NOW + 1 })
			yield* store.putKv(StatusPageKeys.overlay(pageId), JSON.stringify({ entries: [a, b] }))
			yield* store.api.removeOverlayEntries(pageId, ["a"])
			assert.deepStrictEqual(
				(yield* store.api.readOverlay(pageId)).entries.map((e) => e.id),
				["b"],
			)
		}),
	)
})
