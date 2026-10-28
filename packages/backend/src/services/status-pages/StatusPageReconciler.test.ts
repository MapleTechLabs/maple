import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { overlayIncidentId, StatusPageKeys, type StatusPageOverlayEntry } from "@maple/domain/status-page"
import type { StatusPageId } from "@maple/domain/primitives"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { Database } from "@maple/backend/platform/DatabaseLive"
import { importEntry, StatusPageReconciler } from "./StatusPageReconciler"
import { type InMemoryStatusPageStore, StatusPageStore } from "./StatusPageStore"
import {
	DAY_MS,
	NOW,
	newPageId,
	ORG,
	readPage,
	seedAlertIncident,
	seedComponent,
	seedMonitor,
	seedIncident,
	seedPage,
} from "./status-page-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const entry = (
	overrides: Partial<StatusPageOverlayEntry> & Pick<StatusPageOverlayEntry, "id" | "at">,
): StatusPageOverlayEntry => ({
	incidentId: null,
	title: null,
	status: "investigating",
	impact: "major",
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
			impact: string
			resolved: boolean
			components: number
		}>(
			`SELECT i.id, i.title, i.status, i.impact, i.resolved_at IS NOT NULL AS resolved,
				(SELECT count(*)::int FROM status_page_incident_components c WHERE c.incident_id = i.id) AS components
			 FROM status_page_incidents i WHERE i.page_id = $1 ORDER BY i.started_at`,
			[pageId],
		),
	).pipe(Effect.map((result) => result.rows))

const updatesOf = (testDb: TestDb, incidentId: string) =>
	Effect.promise(() =>
		testDb.pglite.query<{ overlay_entry_id: string | null; source: string; status: string }>(
			`SELECT overlay_entry_id, source, status FROM status_page_incident_updates WHERE incident_id = $1 ORDER BY created_at`,
			[incidentId],
		),
	).pipe(Effect.map((result) => result.rows))

const putEntry = (store: InMemoryStatusPageStore, pageId: StatusPageId, value: StatusPageOverlayEntry) =>
	store.putKv(StatusPageKeys.overlayEntry(pageId, value.id), JSON.stringify(value))

/** Marks the page published at `at`, as the publisher would after a sweep. */
const markPublished = (testDb: TestDb, pageId: string, at: number) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`UPDATE status_pages SET published_revision = revision, published_at = $2 WHERE id = $1`,
			[pageId, new Date(at).toISOString()],
		),
	)

/** Runs `body` with a reconciler over a fresh database and an in-memory store. */
const withReconciler = <A, E>(
	body: (ctx: {
		readonly testDb: TestDb
		readonly store: InMemoryStatusPageStore
		readonly reconciler: StatusPageReconciler["Service"]
	}) => Effect.Effect<A, E>,
	options: { readonly listPageSize?: number } = {},
) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const testDb = createTestDb(trackedDbs)
		const store = yield* StatusPageStore.makeInMemoryWith(options)
		const layer = StatusPageReconciler.layer.pipe(
			Layer.provide(Layer.succeed(StatusPageStore, store.api)),
			Layer.provide(testDb.layer),
		)
		return yield* StatusPageReconciler.use((reconciler) => body({ testDb, store, reconciler })).pipe(
			Effect.provide(layer),
		)
	})

describe("StatusPageReconciler", () => {
	it.effect("imports a new incident and its `bg-` follow-up once, keeping keys until published", () =>
		withReconciler(({ testDb, store, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const componentId = crypto.randomUUID()
				// No token: entries posted before a revoke still import.
				yield* seedPage(testDb, { id: pageId, slug: "acme-bg" })
				yield* seedComponent(testDb, { id: componentId, pageId, name: "API", position: 0 })

				const opening = entry({
					id: crypto.randomUUID(),
					at: NOW,
					title: "Login broken",
					componentIds: [componentId, "not-a-component"],
				})
				const followUp = entry({
					id: crypto.randomUUID(),
					at: NOW + 60_000,
					incidentId: overlayIncidentId(opening.id),
					status: "resolved",
					impact: null,
					body: "Fixed",
				})
				yield* putEntry(store, pageId, opening)
				yield* putEntry(store, pageId, followUp)

				const first = yield* reconciler.reconcile(pageId)
				assert.deepStrictEqual(first, { imported: 2, cleared: 0 })
				const incidents = yield* incidentsOf(testDb, pageId)
				assert.deepStrictEqual(
					incidents.map(({ title, status, impact, resolved, components }) => ({
						title,
						status,
						impact,
						resolved,
						components,
					})),
					[
						{
							title: "Login broken",
							status: "resolved",
							impact: "major",
							resolved: true,
							components: 1,
						},
					],
				)
				const incidentId = incidents[0]?.id ?? ""
				assert.deepStrictEqual(
					(yield* updatesOf(testDb, incidentId)).map((u) => [u.overlay_entry_id, u.source]),
					[
						[opening.id, "break_glass"],
						[followUp.id, "break_glass"],
					],
				)
				assert.strictEqual((yield* readPage(testDb, pageId))?.revision, "3")

				// Not yet in a published snapshot: the edge must keep overlaying them.
				const unpublished = yield* reconciler.reconcileAll()
				assert.deepStrictEqual(unpublished, { pages: 1, imported: 0, cleared: 0, failed: 0 })
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.overlayEntry(pageId, opening.id)))

				yield* markPublished(testDb, pageId, NOW + 5 * 60_000)
				const published = yield* reconciler.reconcileAll()
				assert.deepStrictEqual(published, { pages: 1, imported: 0, cleared: 2, failed: 0 })
				const { kv } = yield* store.contents
				assert.isFalse(kv.has(StatusPageKeys.overlayEntry(pageId, opening.id)))
				assert.isFalse(kv.has(StatusPageKeys.overlayEntry(pageId, followUp.id)))
				assert.strictEqual((yield* incidentsOf(testDb, pageId)).length, 1)
				assert.strictEqual((yield* updatesOf(testDb, incidentId)).length, 2)
			}),
		),
	)

	it.effect("keeps a key whose page published before the import's revision", () =>
		withReconciler(({ testDb, store, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-lag" })
				const only = entry({ id: crypto.randomUUID(), at: NOW })
				yield* putEntry(store, pageId, only)
				yield* reconciler.reconcileAll()
				// Published, but a later bump (revision past published_revision) is still pending.
				yield* markPublished(testDb, pageId, NOW + 60_000)
				yield* Effect.promise(() =>
					executeSql(testDb, `UPDATE status_pages SET revision = revision + 1 WHERE id = $1`, [
						pageId,
					]),
				)
				assert.strictEqual((yield* reconciler.reconcileAll()).cleared, 0)
				assert.isTrue((yield* store.contents).kv.has(StatusPageKeys.overlayEntry(pageId, only.id)))
			}),
		),
	)

	it.effect("reconciles every page across KV list pages", () =>
		withReconciler(
			({ testDb, store, reconciler }) =>
				Effect.gen(function* () {
					const pageIds = Array.from({ length: 4 }, () => newPageId())
					yield* Effect.forEach(
						pageIds,
						(pageId, index) =>
							seedPage(testDb, { id: pageId, slug: `many-${index}` }).pipe(
								Effect.andThen(
									putEntry(store, pageId, entry({ id: crypto.randomUUID(), at: NOW })),
								),
								Effect.andThen(
									putEntry(store, pageId, entry({ id: crypto.randomUUID(), at: NOW + 1 })),
								),
							),
						{ discard: true },
					)
					// Eight keys, three per list call.
					const result = yield* reconciler.reconcileAll()
					assert.deepStrictEqual(result, { pages: 4, imported: 8, cleared: 0, failed: 0 })
					const counts = yield* Effect.forEach(pageIds, (pageId) =>
						incidentsOf(testDb, pageId).pipe(Effect.map((rows) => rows.length)),
					)
					assert.deepStrictEqual(counts, [2, 2, 2, 2])
				}),
			{ listPageSize: 3 },
		),
	)

	it.effect("imports an entry once when two reconciles race", () =>
		withReconciler(({ testDb, store, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-race" })
				const only = entry({ id: crypto.randomUUID(), at: NOW, title: "Outage" })
				yield* putEntry(store, pageId, only)
				const results = yield* Effect.all(
					[reconciler.reconcile(pageId), reconciler.reconcile(pageId)],
					{
						concurrency: 2,
					},
				)
				assert.strictEqual(
					results.reduce((sum, r) => sum + r.imported, 0),
					1,
				)
				const incidents = yield* incidentsOf(testDb, pageId)
				assert.strictEqual(incidents.length, 1)
				assert.strictEqual((yield* updatesOf(testDb, incidents[0]?.id ?? "")).length, 1)
			}),
		),
	)

	it.effect("rolls back a losing import, leaving no orphan incident", () =>
		withReconciler(({ testDb }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-lost" })
				const only = entry({ id: crypto.randomUUID(), at: NOW, title: "Outage" })
				const scope = { orgId: ORG, pageId, componentIds: [] }
				const database = yield* Database
				// The second import read no update row, as a concurrent run would have.
				const won = yield* database.execute((db) => importEntry(db, scope, only))
				const lost = yield* database.execute((db) => importEntry(db, scope, only))
				assert.deepStrictEqual([won, lost], [true, false])
				assert.strictEqual((yield* incidentsOf(testDb, pageId)).length, 1)
				assert.strictEqual((yield* readPage(testDb, pageId))?.revision, "2")
			}).pipe(Effect.provide(testDb.layer)),
		),
	)

	it.effect(
		"keeps impact and status on a no-change entry, and ignores a status of the other lifecycle",
		() =>
			withReconciler(({ testDb, store, reconciler }) =>
				Effect.gen(function* () {
					const pageId = newPageId()
					const incidentId = crypto.randomUUID()
					yield* seedPage(testDb, { id: pageId, slug: "acme-keep" })
					yield* seedIncident(testDb, {
						id: incidentId,
						pageId,
						title: "Slow API",
						impact: "critical",
						status: "identified",
						startedAt: NOW - 60_000,
					})
					yield* putEntry(
						store,
						pageId,
						entry({
							id: crypto.randomUUID(),
							at: NOW,
							incidentId,
							status: null,
							impact: null,
							body: "Still on it",
						}),
					)
					yield* putEntry(
						store,
						pageId,
						entry({
							id: crypto.randomUUID(),
							at: NOW + 1,
							incidentId,
							status: "completed",
							impact: null,
						}),
					)
					assert.strictEqual((yield* reconciler.reconcile(pageId)).imported, 2)
					const [incident] = yield* incidentsOf(testDb, pageId)
					assert.deepStrictEqual(
						[incident?.status, incident?.impact, incident?.resolved],
						["identified", "critical", false],
					)
					assert.deepStrictEqual(
						(yield* updatesOf(testDb, incidentId)).map((u) => u.status),
						["identified", "identified", "identified"],
					)
				}),
			),
	)

	it.effect("opens a new incident as investigating and major when the entry leaves them null", () =>
		withReconciler(({ testDb, store, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-defaults" })
				yield* putEntry(
					store,
					pageId,
					entry({ id: crypto.randomUUID(), at: NOW, status: null, impact: null }),
				)
				yield* reconciler.reconcile(pageId)
				const [incident] = yield* incidentsOf(testDb, pageId)
				assert.deepStrictEqual([incident?.status, incident?.impact], ["investigating", "major"])
			}),
		),
	)
})

describe("StatusPageReconciler.repairAutoIncidents", () => {
	it.effect("opens the page incident a recent alert missed, once, and leaves older alerts alone", () =>
		withReconciler(({ testDb, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				const ruleId = crypto.randomUUID()
				const monitorId = crypto.randomUUID()
				yield* seedPage(testDb, { id: pageId, slug: "acme-missed", autoIncidents: "publish" })
				yield* seedMonitor(testDb, { id: monitorId, status: "down", alertRuleId: ruleId })
				yield* seedComponent(testDb, {
					id: crypto.randomUUID(),
					pageId,
					name: "Checkout",
					position: 0,
					monitorId,
				})
				const missed = crypto.randomUUID()
				yield* seedAlertIncident(testDb, {
					id: missed,
					status: "open",
					ruleId,
					firstTriggeredAt: NOW - 60_000,
				})
				// Opened long ago: its page incident may have been deleted on purpose.
				yield* seedAlertIncident(testDb, {
					id: crypto.randomUUID(),
					status: "open",
					ruleId,
					firstTriggeredAt: NOW - DAY_MS,
				})

				assert.strictEqual(yield* reconciler.repairAutoIncidents(), 1)
				const incidents = yield* incidentsOf(testDb, pageId)
				assert.deepStrictEqual(
					incidents.map((i) => [i.title, i.status]),
					[["Checkout is down", "investigating"]],
				)
				assert.strictEqual(yield* reconciler.repairAutoIncidents(), 0)
			}),
		),
	)

	it.effect("resolves auto incidents whose alert incident is resolved or gone, and only those", () =>
		withReconciler(({ testDb, reconciler }) =>
			Effect.gen(function* () {
				const pageId = newPageId()
				yield* seedPage(testDb, { id: pageId, slug: "acme-auto" })
				const resolvedAlert = crypto.randomUUID()
				const openAlert = crypto.randomUUID()
				yield* seedAlertIncident(testDb, { id: resolvedAlert, status: "resolved" })
				yield* seedAlertIncident(testDb, { id: openAlert, status: "open" })
				const orphanOfResolved = crypto.randomUUID()
				const orphanOfMissing = crypto.randomUUID()
				const stillOpen = crypto.randomUUID()
				const seed = (id: string, alertIncidentId: string, startedAt: number) =>
					seedIncident(testDb, {
						id,
						pageId,
						title: id,
						status: "investigating",
						startedAt,
						alertIncidentId,
					})
				yield* seed(orphanOfResolved, resolvedAlert, NOW - 3_000)
				yield* seed(orphanOfMissing, crypto.randomUUID(), NOW - 2_000)
				yield* seed(stillOpen, openAlert, NOW - 1_000)
				const before = Number((yield* readPage(testDb, pageId))?.revision)

				assert.strictEqual(yield* reconciler.repairAutoIncidents(), 2)
				const incidents = yield* incidentsOf(testDb, pageId)
				assert.deepStrictEqual(
					incidents.map((i) => [i.id, i.status]),
					[
						[orphanOfResolved, "resolved"],
						[orphanOfMissing, "resolved"],
						[stillOpen, "investigating"],
					],
				)
				assert.deepStrictEqual(
					(yield* updatesOf(testDb, orphanOfMissing)).map((u) => [u.source, u.status]),
					[
						["dashboard", "investigating"],
						["auto", "resolved"],
					],
				)
				assert.strictEqual(Number((yield* readPage(testDb, pageId))?.revision), before + 2)
				assert.strictEqual(yield* reconciler.repairAutoIncidents(), 0)
			}),
		),
	)
})
