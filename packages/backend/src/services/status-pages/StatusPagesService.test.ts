import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { StatusPageComponentId, StatusPageId, UptimeMonitorId } from "@maple/domain/primitives"
import { STATUS_PAGE_BREAK_GLASS_PREFIX, sha256Base64Url } from "@maple/domain/status-page"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/platform/test-pglite"
import { StatusPagesService, type CreateStatusPageIncidentInput } from "./StatusPagesService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const ORG = Schema.decodeUnknownSync(OrgId)("org_status")
const OTHER_ORG = Schema.decodeUnknownSync(OrgId)("org_status_other")
const USER = Schema.decodeUnknownSync(UserId)("user_status")
const MONITOR = UptimeMonitorId.make("33333333-3333-4333-8333-333333333333")
const OTHER_MONITOR = UptimeMonitorId.make("44444444-4444-4444-8444-444444444444")
const DAY = 86_400_000

const makeLayer = (testDb: TestDb) =>
	Layer.effect(StatusPagesService, StatusPagesService.make).pipe(Layer.provide(testDb.layer))

const seedMonitor = (testDb: TestDb, orgId: OrgId, id: UptimeMonitorId) =>
	Effect.promise(() =>
		executeSql(
			testDb,
			`INSERT INTO uptime_monitors (id, org_id, name, kind, config_json, created_by, created_at, updated_at)
			 VALUES ($1, $2, 'API', 'heartbeat', '{"type":"heartbeat","graceSeconds":60}', $3, now(), now())`,
			[id, orgId, USER],
		),
	)

const pageRow = (testDb: TestDb, pageId: StatusPageId) =>
	Effect.promise(() =>
		testDb.pglite.query<{ revision: string; break_glass_token_sha256: string | null }>(
			`SELECT revision::text, break_glass_token_sha256 FROM status_pages WHERE id = $1`,
			[pageId],
		),
	).pipe(Effect.map((result) => result.rows[0]))

const revision = (testDb: TestDb, pageId: StatusPageId) =>
	pageRow(testDb, pageId).pipe(Effect.map((row) => Number(row?.revision)))

const createPage = (slug: string, orgId: OrgId = ORG) =>
	Effect.gen(function* () {
		const service = yield* StatusPagesService
		return yield* service.create(orgId, { name: `Page ${slug}`, slug, createdBy: USER })
	})

describe("StatusPagesService", () => {
	it.effect("creates, lists, updates and deletes a page, scoped to its org", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* service.create(ORG, {
				name: " Acme ",
				slug: "acme",
				websiteUrl: "https://acme.test",
				brandColor: "#AABBCC",
				createdBy: USER,
			})
			assert.strictEqual(page.name, "Acme")
			assert.strictEqual(page.brandColor, "#aabbcc")
			assert.strictEqual(page.revision, 1)
			assert.strictEqual(page.publishedRevision, 0)
			yield* createPage("elsewhere", OTHER_ORG)

			const listed = yield* service.list(ORG)
			assert.deepStrictEqual(
				listed.map((row) => row.slug),
				["acme"],
			)
			const crossOrg = yield* Effect.flip(service.get(OTHER_ORG, page.id))
			assert.strictEqual(crossOrg._tag, "@maple/http/errors/StatusPageNotFoundError")

			const updated = yield* service.update(ORG, page.id, { name: "Acme Inc", description: "  " })
			assert.strictEqual(updated.name, "Acme Inc")
			assert.isNull(updated.description)
			assert.strictEqual(updated.revision, 2)

			const badUrl = yield* Effect.flip(
				service.update(ORG, page.id, { logoUrl: "http://acme.test/logo.png" }),
			)
			assert.strictEqual(badUrl._tag, "@maple/http/errors/StatusPageValidationError")
			const badColor = yield* Effect.flip(service.update(ORG, page.id, { brandColor: "red" }))
			assert.strictEqual(badColor._tag, "@maple/http/errors/StatusPageValidationError")

			assert.strictEqual(yield* service.remove(ORG, page.id), page.id)
			const gone = yield* Effect.flip(service.get(ORG, page.id))
			assert.strictEqual(gone._tag, "@maple/http/errors/StatusPageNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("refuses a slug another org already uses, on create and on rename", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			yield* createPage("taken", OTHER_ORG)
			const onCreate = yield* Effect.flip(createPage("taken"))
			assert.strictEqual(onCreate._tag, "@maple/http/errors/StatusPageSlugTakenError")
			const mine = yield* createPage("mine")
			const onRename = yield* Effect.flip(service.update(ORG, mine.id, { slug: "taken" }))
			assert.strictEqual(onRename._tag, "@maple/http/errors/StatusPageSlugTakenError")
			// Keeping your own slug is not a conflict.
			const same = yield* service.update(ORG, mine.id, { slug: "mine" })
			assert.strictEqual(same.slug, "mine")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("queues edge cleanup for a renamed slug and a deleted page", () => {
		const testDb = createTestDb(trackedDbs)
		const cleanups = Effect.promise(() =>
			testDb.pglite.query<{ page_id: string; slug: string; delete_snapshot: boolean }>(
				`SELECT page_id, slug, delete_snapshot FROM status_page_cleanups ORDER BY created_at, delete_snapshot`,
			),
		).pipe(Effect.map((result) => result.rows))
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("before")
			yield* service.update(ORG, page.id, { slug: "before" })
			assert.deepStrictEqual(yield* cleanups, [])

			yield* service.update(ORG, page.id, { slug: "after" })
			assert.deepStrictEqual(yield* cleanups, [
				{ page_id: page.id, slug: "before", delete_snapshot: false },
			])

			yield* service.remove(ORG, page.id)
			assert.deepStrictEqual(yield* cleanups, [
				{ page_id: page.id, slug: "before", delete_snapshot: false },
				{ page_id: page.id, slug: "after", delete_snapshot: true },
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("links components only to monitors of the same org and reorders them", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			yield* seedMonitor(testDb, ORG, MONITOR)
			yield* seedMonitor(testDb, OTHER_ORG, OTHER_MONITOR)
			const page = yield* createPage("acme")

			const foreign = yield* Effect.flip(
				service.createComponent(ORG, page.id, { name: "API", monitorId: OTHER_MONITOR }),
			)
			assert.strictEqual(foreign._tag, "@maple/http/errors/StatusPageValidationError")

			const api = yield* service.createComponent(ORG, page.id, { name: "API", monitorId: MONITOR })
			const web = yield* service.createComponent(ORG, page.id, { name: "Web" })
			assert.deepStrictEqual([api.position, web.position], [0, 1])

			const reordered = yield* service.reorderComponents(ORG, page.id, [web.id, api.id])
			assert.deepStrictEqual(
				reordered.map((row) => [row.name, row.position]),
				[
					["Web", 0],
					["API", 1],
				],
			)
			const partial = yield* Effect.flip(service.reorderComponents(ORG, page.id, [web.id]))
			assert.strictEqual(partial._tag, "@maple/http/errors/StatusPageValidationError")

			// After a delete leaves a gap, a new component still lands last, not on top of one.
			yield* service.removeComponent(ORG, web.id)
			const docs = yield* service.createComponent(ORG, page.id, { name: "Docs" })
			assert.deepStrictEqual(
				(yield* service.listComponents(ORG, page.id)).map((row) => [row.name, row.position]),
				[
					["API", 1],
					["Docs", 2],
				],
			)
			assert.strictEqual(docs.position, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("publishes a draft in the same write as its update, or not at all", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("drafts")
			const draft = yield* service.createIncident(ORG, page.id, {
				kind: "incident",
				title: "Elevated errors",
				impact: "major",
				status: "investigating",
				body: "Looking into it",
				componentIds: [],
				published: false,
				source: "mcp",
				createdBy: USER,
			})
			assert.isFalse(draft.published)

			// A rejected update (maintenance status on an incident) leaves the draft and its updates as they were.
			yield* Effect.flip(
				service.postUpdate(ORG, draft.id, {
					status: "in_progress",
					body: "x",
					source: "mcp",
					publish: true,
				}),
			)
			const unchanged = yield* service.getIncident(ORG, draft.id)
			assert.isFalse(unchanged.published)
			assert.lengthOf(unchanged.updates, 1)

			yield* TestClock.adjust("1 minute")
			const published = yield* service.postUpdate(ORG, draft.id, {
				status: "identified",
				body: "Rolling back",
				source: "mcp",
				publish: true,
			})
			assert.isTrue(published.published)
			assert.lengthOf(published.updates, 2)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("opens an incident with its first update and resolves it", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("acme")
			const other = yield* createPage("other")
			const api = yield* service.createComponent(ORG, page.id, { name: "API" })
			const foreignComponent = yield* service.createComponent(ORG, other.id, { name: "Elsewhere" })
			const before = yield* revision(testDb, page.id)

			const wrongPage = yield* Effect.flip(
				service.createIncident(ORG, page.id, {
					kind: "incident",
					title: "Errors",
					impact: "major",
					status: "investigating",
					body: "Looking",
					componentIds: [foreignComponent.id],
					source: "dashboard",
				}),
			)
			assert.strictEqual(wrongPage._tag, "@maple/http/errors/StatusPageValidationError")

			const incident = yield* service.createIncident(ORG, page.id, {
				kind: "incident",
				title: "Elevated errors",
				impact: "major",
				status: "investigating",
				body: "We are looking into it",
				componentIds: [api.id],
				source: "dashboard",
				createdBy: USER,
			})
			assert.deepStrictEqual(incident.componentIds, [api.id])
			assert.deepStrictEqual(
				incident.updates.map((update) => [update.status, update.body]),
				[["investigating", "We are looking into it"]],
			)
			assert.isNull(incident.resolvedAt)
			assert.strictEqual(yield* revision(testDb, page.id), before + 1)

			yield* TestClock.adjust("1 minute")
			const resolved = yield* service.postUpdate(ORG, incident.id, {
				status: "resolved",
				body: "Fixed",
				source: "dashboard",
			})
			assert.strictEqual(resolved.status, "resolved")
			assert.isNotNull(resolved.resolvedAt)
			assert.deepStrictEqual(
				resolved.updates.map((update) => update.status),
				["resolved", "investigating"],
			)
			assert.strictEqual(yield* revision(testDb, page.id), before + 2)
			// Resolved incidents leave the default list.
			assert.lengthOf(yield* service.listIncidents(ORG, page.id), 0)
			assert.lengthOf(yield* service.listIncidents(ORG, page.id, { includeResolved: true }), 1)

			const reopened = yield* service.postUpdate(ORG, incident.id, {
				status: "monitoring",
				body: "Watching again",
				source: "api",
			})
			assert.isNull(reopened.resolvedAt)

			const maintenanceStatus = yield* Effect.flip(
				service.postUpdate(ORG, incident.id, { status: "completed", body: "x", source: "api" }),
			)
			assert.strictEqual(maintenanceStatus._tag, "@maple/http/errors/StatusPageValidationError")
			const crossOrg = yield* Effect.flip(service.getIncident(OTHER_ORG, incident.id))
			assert.strictEqual(crossOrg._tag, "@maple/http/errors/StatusPageIncidentNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("lists an org's incidents across pages, filtered by state and paged newest first", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const first = yield* createPage("first")
			const second = yield* createPage("second")
			const other = yield* createPage("other-org", OrgId.make("org_status_other"))
			const open = (pageId: StatusPageId, title: string, orgId: OrgId = ORG) =>
				TestClock.adjust("1 minute").pipe(
					Effect.andThen(
						service.createIncident(orgId, pageId, {
							kind: "incident",
							title,
							impact: "minor",
							status: "investigating",
							body: title,
							componentIds: [],
							source: "api",
							createdBy: USER,
						}),
					),
				)
			const a = yield* open(first.id, "A")
			yield* open(second.id, "B")
			yield* open(first.id, "C")
			yield* open(other.id, "Elsewhere", OrgId.make("org_status_other"))
			yield* service.postUpdate(ORG, a.id, { status: "resolved", body: "Fixed", source: "api" })

			const titles = (options: Parameters<typeof service.listOrgIncidents>[1]) =>
				service.listOrgIncidents(ORG, options).pipe(Effect.map((list) => list.map((i) => i.title)))
			assert.deepStrictEqual(yield* titles({ state: "all", limit: 10, offset: 0 }), ["C", "B", "A"])
			assert.deepStrictEqual(yield* titles({ state: "open", limit: 10, offset: 0 }), ["C", "B"])
			assert.deepStrictEqual(yield* titles({ state: "closed", limit: 10, offset: 0 }), ["A"])
			assert.deepStrictEqual(yield* titles({ state: "all", limit: 1, offset: 1 }), ["B"])
			assert.deepStrictEqual(yield* titles({ pageId: first.id, state: "all", limit: 10, offset: 0 }), [
				"C",
				"A",
			])
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("requires a valid window and maintenance statuses for maintenance", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("acme")
			const start = Date.UTC(2026, 10, 1, 2)
			const base: CreateStatusPageIncidentInput = {
				kind: "maintenance",
				title: "Database upgrade",
				impact: "minor",
				status: "scheduled",
				body: "Planned",
				componentIds: [],
				source: "dashboard",
			}
			const cases: ReadonlyArray<Partial<CreateStatusPageIncidentInput>> = [
				{ scheduledStart: start, scheduledEnd: null },
				{ scheduledStart: start, scheduledEnd: start },
				{ status: "investigating", scheduledStart: start, scheduledEnd: start + DAY },
			]
			yield* Effect.forEach(cases, (input) =>
				Effect.flip(service.createIncident(ORG, page.id, { ...base, ...input })).pipe(
					Effect.map((error) =>
						assert.strictEqual(error._tag, "@maple/http/errors/StatusPageValidationError"),
					),
				),
			)
			const ok = yield* service.createIncident(ORG, page.id, {
				...base,
				status: "scheduled",
				scheduledStart: start,
				scheduledEnd: start + DAY,
			})
			assert.strictEqual(ok.startedAt, start)
			const shrunk = yield* Effect.flip(service.updateIncident(ORG, ok.id, { scheduledEnd: start - 1 }))
			assert.strictEqual(shrunk._tag, "@maple/http/errors/StatusPageValidationError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("rotates a break-glass token, storing only its hash and suffix", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("acme")
			const token = yield* service.rotateBreakGlassToken(ORG, page.id)
			assert.isTrue(token.startsWith(STATUS_PAGE_BREAK_GLASS_PREFIX))
			const row = yield* pageRow(testDb, page.id)
			assert.strictEqual(
				row?.break_glass_token_sha256,
				yield* Effect.promise(() => sha256Base64Url(token)),
			)
			// The raw token appears in no column of the page.
			const dump = yield* Effect.promise(() =>
				testDb.pglite.query<{ dump: string }>(
					`SELECT row_to_json(p)::text AS dump FROM status_pages p`,
				),
			)
			assert.isFalse(dump.rows.some((entry) => entry.dump.includes(token)))
			const record = yield* service.get(ORG, page.id)
			assert.strictEqual(record.breakGlassTokenSuffix, token.slice(-6))

			yield* service.revokeBreakGlassToken(ORG, page.id)
			assert.isNull((yield* pageRow(testDb, page.id))?.break_glass_token_sha256)
			assert.isNull((yield* service.get(ORG, page.id)).breakGlassTokenSuffix)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("bumps the page revision on every visible mutation", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("acme")
			const first = yield* service.createComponent(ORG, page.id, { name: "First" })
			const incident = yield* service.createIncident(ORG, page.id, {
				kind: "incident",
				title: "Outage",
				impact: "critical",
				status: "investigating",
				body: "Down",
				componentIds: [first.id],
				source: "dashboard",
			})
			const extra = StatusPageComponentId.make("55555555-5555-4555-8555-555555555555")
			const mutations: ReadonlyArray<readonly [string, Effect.Effect<unknown, unknown>]> = [
				["update", service.update(ORG, page.id, { showPoweredBy: false })],
				["rotateBreakGlassToken", service.rotateBreakGlassToken(ORG, page.id)],
				["revokeBreakGlassToken", service.revokeBreakGlassToken(ORG, page.id)],
				["createComponent", service.createComponent(ORG, page.id, { name: "Second" })],
				["updateComponent", service.updateComponent(ORG, first.id, { manualStatus: "degraded" })],
				[
					"reorderComponents",
					service
						.listComponents(ORG, page.id)
						.pipe(
							Effect.flatMap((rows) =>
								service.reorderComponents(ORG, page.id, rows.map((row) => row.id).reverse()),
							),
						),
				],
				[
					"createIncident",
					service.createIncident(ORG, page.id, {
						kind: "incident",
						title: "More",
						impact: "minor",
						status: "identified",
						body: "b",
						componentIds: [],
						source: "api",
					}),
				],
				[
					"postUpdate",
					service.postUpdate(ORG, incident.id, {
						status: "identified",
						body: "Found it",
						source: "api",
					}),
				],
				["updateIncident", service.updateIncident(ORG, incident.id, { title: "Outage in us-east" })],
				["removeIncident", service.removeIncident(ORG, incident.id)],
				["removeComponent", service.removeComponent(ORG, first.id)],
			]
			yield* Effect.forEach(mutations, ([name, mutation]) =>
				Effect.gen(function* () {
					const before = yield* revision(testDb, page.id)
					yield* mutation
					assert.strictEqual(yield* revision(testDb, page.id), before + 1, name)
				}),
			)
			// A failed mutation rolls back its bump with the write.
			const before = yield* revision(testDb, page.id)
			yield* Effect.flip(service.updateComponent(ORG, extra, { name: "Nope" }))
			yield* Effect.flip(service.update(ORG, page.id, { brandColor: "nope" }))
			assert.strictEqual(yield* revision(testDb, page.id), before)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})
})
