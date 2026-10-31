import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import { OrgId, UserId } from "@maple/domain/http"
import { StatusPageComponentPublicId, type StatusPageConfig } from "@maple/domain/http/v2"
import { StatusPageComponentId, StatusPageId, UptimeMonitorId } from "@maple/domain/primitives"
import {
	DEFAULT_STATUS_PAGE_THEME,
	STATUS_PAGE_BREAK_GLASS_PREFIX,
	sha256Base64Url,
	type StatusPageTheme,
} from "@maple/domain/status-page"
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
				theme: { ...DEFAULT_STATUS_PAGE_THEME, accent: "#AABBCC" },
				createdBy: USER,
			})
			assert.strictEqual(page.name, "Acme")
			assert.strictEqual(page.theme.accent, "#aabbcc")
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
			const badColor = yield* Effect.flip(
				service.update(ORG, page.id, { theme: { ...DEFAULT_STATUS_PAGE_THEME, card: "red" } }),
			)
			assert.strictEqual(badColor._tag, "@maple/http/errors/StatusPageValidationError")

			assert.strictEqual(yield* service.remove(ORG, page.id), page.id)
			const gone = yield* Effect.flip(service.get(ORG, page.id))
			assert.strictEqual(gone._tag, "@maple/http/errors/StatusPageNotFoundError")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("stores https footer links, refuses other schemes and clears a link on null", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* service.create(ORG, {
				name: "Acme",
				slug: "links",
				privacyUrl: " https://acme.test/privacy ",
				createdBy: USER,
			})
			assert.strictEqual(page.privacyUrl, "https://acme.test/privacy")
			assert.isNull(page.termsUrl)

			const linked = yield* service.update(ORG, page.id, { termsUrl: "https://acme.test/terms" })
			assert.strictEqual(linked.termsUrl, "https://acme.test/terms")
			assert.strictEqual(linked.privacyUrl, "https://acme.test/privacy")

			const insecure = yield* Effect.flip(
				service.update(ORG, page.id, { privacyUrl: "http://acme.test/privacy" }),
			)
			assert.strictEqual(insecure._tag, "@maple/http/errors/StatusPageValidationError")
			assert.include(insecure.message, "Privacy policy URL")
			const script = yield* Effect.flip(
				service.create(ORG, {
					name: "Bad",
					slug: "bad-links",
					termsUrl: "javascript:alert(1)",
					createdBy: USER,
				}),
			)
			assert.strictEqual(script._tag, "@maple/http/errors/StatusPageValidationError")
			assert.include(script.message, "Terms of service URL")

			const cleared = yield* service.update(ORG, page.id, { privacyUrl: null })
			assert.isNull(cleared.privacyUrl)
			assert.strictEqual(cleared.termsUrl, "https://acme.test/terms")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("stores a forced theme with lower-cased colours and refuses unreadable text", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("themed")
			assert.deepStrictEqual(page.theme, DEFAULT_STATUS_PAGE_THEME)
			const dark: StatusPageTheme = {
				...DEFAULT_STATUS_PAGE_THEME,
				preset: "midnight",
				appearance: "dark",
				background: "#0F1115",
				text: " #F5F5F5 ",
				border: "",
			}
			const updated = yield* service.update(ORG, page.id, { theme: dark })
			assert.deepStrictEqual(updated.theme, {
				...dark,
				background: "#0f1115",
				text: "#f5f5f5",
				border: null,
			})

			const unreadable = yield* Effect.flip(
				service.update(ORG, page.id, {
					theme: { ...DEFAULT_STATUS_PAGE_THEME, appearance: "light", text: "#757575" },
				}),
			)
			assert.strictEqual(unreadable._tag, "@maple/http/errors/StatusPageValidationError")
			assert.include(unreadable.message, "4.49:1")
			assert.strictEqual((yield* service.get(ORG, page.id)).theme.background, "#0f1115")
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	it.effect("merges partial theme edits onto the stored theme, so two edits keep both fields", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const service = yield* StatusPagesService
			const page = yield* createPage("partial-theme")
			yield* Effect.all(
				[
					service.update(ORG, page.id, { theme: { preset: "mono" } }),
					service.update(ORG, page.id, { theme: { radius: "lg" } }),
				],
				{ concurrency: "unbounded" },
			)
			const { theme } = yield* service.get(ORG, page.id)
			assert.strictEqual(theme.preset, "mono")
			assert.strictEqual(theme.radius, "lg")
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
			assert.deepStrictEqual(yield* titles({ pageId: null, state: "all", limit: 10, offset: 0 }), [
				"C",
				"B",
				"A",
			])
			assert.deepStrictEqual(yield* titles({ pageId: null, state: "open", limit: 10, offset: 0 }), [
				"C",
				"B",
			])
			assert.deepStrictEqual(yield* titles({ pageId: null, state: "closed", limit: 10, offset: 0 }), [
				"A",
			])
			assert.deepStrictEqual(yield* titles({ pageId: null, state: "all", limit: 1, offset: 1 }), ["B"])
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
			yield* Effect.flip(
				service.update(ORG, page.id, { theme: { ...DEFAULT_STATUS_PAGE_THEME, accent: "nope" } }),
			)
			assert.strictEqual(yield* revision(testDb, page.id), before)
		}).pipe(Effect.provide(makeLayer(testDb)))
	})

	describe("config", () => {
		const NO_CHANGES = { fields: [], created: [], updated: [], deleted: [], reordered: false }
		const cleanupSlugs = (testDb: TestDb) =>
			Effect.promise(() =>
				testDb.pglite.query<{ slug: string }>(
					`SELECT slug FROM status_page_cleanups WHERE delete_snapshot = false`,
				),
			).pipe(Effect.map((result) => result.rows.map((row) => row.slug)))

		const seeded = (testDb: TestDb) =>
			Effect.gen(function* () {
				const service = yield* StatusPagesService
				yield* seedMonitor(testDb, ORG, MONITOR)
				yield* seedMonitor(testDb, OTHER_ORG, OTHER_MONITOR)
				const page = yield* createPage("config")
				const api = yield* service.createComponent(ORG, page.id, { name: "API", monitorId: MONITOR })
				const web = yield* service.createComponent(ORG, page.id, { name: "Web" })
				const docs = yield* service.createComponent(ORG, page.id, { name: "Docs" })
				return { service, page, api, web, docs, config: yield* service.getConfig(ORG, page.id) }
			})

		it.effect("reads the page and its components in order as one document", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { page, api, web, docs, config } = yield* seeded(testDb)
				assert.match(config.version ?? "", /^[0-9a-z]+$/u)
				assert.deepStrictEqual(config, {
					version: config.version,
					name: page.name,
					slug: "config",
					description: null,
					website_url: null,
					logo_url: null,
					privacy_url: null,
					terms_url: null,
					show_powered_by: true,
					auto_incidents: "off",
					theme: DEFAULT_STATUS_PAGE_THEME,
					components: [api, web, docs].map((component) => ({
						id: component.id,
						name: component.name,
						description: null,
						group: null,
						monitor_id: component.monitorId,
						manual_status: null,
						show_uptime: true,
					})),
				})
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("applies footer links, reads them back and clears them when omitted", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config } = yield* seeded(testDb)
				const linked = yield* service.applyConfig(
					ORG,
					page.id,
					{
						...config,
						privacy_url: "https://acme.test/privacy",
						terms_url: "https://acme.test/terms",
					},
					USER,
				)
				assert.deepStrictEqual(linked.changes.fields, ["privacy_url", "terms_url"])
				const read = yield* service.getConfig(ORG, page.id)
				assert.strictEqual(read.privacy_url, "https://acme.test/privacy")
				assert.strictEqual(read.terms_url, "https://acme.test/terms")
				assert.strictEqual((yield* service.get(ORG, page.id)).termsUrl, "https://acme.test/terms")

				const insecure = yield* Effect.flip(
					service.applyConfig(ORG, page.id, { ...read, terms_url: "http://acme.test/terms" }, USER),
				)
				assert.strictEqual(insecure._tag, "@maple/http/errors/StatusPageValidationError")

				const { privacy_url: _privacy, terms_url: _terms, ...withoutLinks } = read
				const cleared = yield* service.applyConfig(ORG, page.id, withoutLinks, USER)
				assert.deepStrictEqual(cleared.changes.fields, ["privacy_url", "terms_url"])
				assert.isNull(cleared.config.privacy_url)
				assert.isNull(cleared.config.terms_url)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect(
			"creates, updates, deletes and reorders components, with defaults for omitted fields",
			() => {
				const testDb = createTestDb(trackedDbs)
				return Effect.gen(function* () {
					const { service, page, api, web, docs } = yield* seeded(testDb)
					yield* service.update(ORG, page.id, { description: "Old", showPoweredBy: false })
					const before = yield* revision(testDb, page.id)
					const { config: applied, changes } = yield* service.applyConfig(
						ORG,
						page.id,
						{
							name: "Acme",
							slug: "config",
							theme: { preset: "paper" },
							components: [
								{ id: docs.id, name: "Docs site", group: "Web" },
								{ name: "Status API", monitor_id: MONITOR, show_uptime: false },
								{ id: api.id, name: "API", monitor_id: MONITOR },
							],
						},
						USER,
					)
					assert.strictEqual(yield* revision(testDb, page.id), before + 1)
					const pageNow = yield* service.get(ORG, page.id)
					assert.strictEqual(pageNow.name, "Acme")
					assert.isNull(pageNow.description)
					assert.isTrue(pageNow.showPoweredBy)
					assert.deepStrictEqual(pageNow.theme, { ...DEFAULT_STATUS_PAGE_THEME, preset: "paper" })

					const listed = yield* service.listComponents(ORG, page.id)
					assert.deepStrictEqual(
						listed.map((row) => [
							row.name,
							row.position,
							row.groupName,
							row.monitorId,
							row.showUptime,
						]),
						[
							["Docs site", 0, "Web", null, true],
							["Status API", 1, null, MONITOR, false],
							["API", 2, null, MONITOR, true],
						],
					)
					assert.strictEqual(listed[0]?.id, docs.id)
					assert.strictEqual(listed[2]?.id, api.id)
					assert.isFalse(listed.some((row) => row.id === web.id))
					assert.deepStrictEqual(
						applied.components.map((component) => component.id),
						listed.map((row) => row.id),
					)
					assert.deepStrictEqual(applied, yield* service.getConfig(ORG, page.id))
					assert.deepStrictEqual(changes, {
						fields: ["name", "description", "show_powered_by", "theme"],
						created: ["Status API"],
						updated: ["Docs site"],
						deleted: ["Web"],
						reordered: true,
					})
				}).pipe(Effect.provide(makeLayer(testDb)))
			},
		)

		it.effect("re-applying the current document changes nothing and leaves the revision alone", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config } = yield* seeded(testDb)
				const before = yield* revision(testDb, page.id)
				const applied = yield* service.applyConfig(ORG, page.id, config, USER)
				assert.deepStrictEqual(applied.config, config)
				assert.deepStrictEqual(applied.changes, NO_CHANGES)
				assert.strictEqual(yield* revision(testDb, page.id), before)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect(
			"refuses ids of another page, duplicates, foreign monitors and bad themes, changing nothing",
			() => {
				const testDb = createTestDb(trackedDbs)
				return Effect.gen(function* () {
					const { service, page, config } = yield* seeded(testDb)
					const other = yield* createPage("config-other")
					const elsewhere = yield* service.createComponent(ORG, other.id, { name: "Elsewhere" })
					const foreignOrgPage = yield* createPage("config-foreign", OTHER_ORG)
					const foreignOrg = yield* service.createComponent(OTHER_ORG, foreignOrgPage.id, {
						name: "X",
					})
					const before = yield* revision(testDb, page.id)
					const first = config.components[0]
					assert.isDefined(first)
					const withRenamedPage = { ...config, name: "Renamed" }
					const cases: ReadonlyArray<readonly [StatusPageConfig, string]> = [
						[
							{
								...withRenamedPage,
								components: [...config.components, { id: elsewhere.id, name: "E" }],
							},
							`Component ${Schema.encodeSync(StatusPageComponentPublicId)(elsewhere.id)} is not on this page`,
						],
						[
							{ ...withRenamedPage, components: [{ id: foreignOrg.id, name: "X" }] },
							`Component ${Schema.encodeSync(StatusPageComponentPublicId)(foreignOrg.id)} is not on this page`,
						],
						[
							{
								...withRenamedPage,
								components: [...config.components, { ...first, name: "Twice" }],
							},
							"is listed more than once",
						],
						[
							{
								...withRenamedPage,
								components: [{ name: "Foreign", monitor_id: OTHER_MONITOR }],
							},
							"Unknown uptime monitor upm_",
						],
						[{ ...withRenamedPage, theme: { appearance: "light", text: "#757575" } }, "4.49:1"],
						[
							{ ...withRenamedPage, components: [{ name: " " }] },
							"components[0].name is required",
						],
					]
					yield* Effect.forEach(cases, ([input, message]) =>
						Effect.flip(service.applyConfig(ORG, page.id, input, USER)).pipe(
							Effect.map((error) => {
								assert.strictEqual(error._tag, "@maple/http/errors/StatusPageValidationError")
								assert.include(error.message, message)
							}),
						),
					)
					assert.strictEqual(yield* revision(testDb, page.id), before)
					assert.deepStrictEqual(yield* service.getConfig(ORG, page.id), config)
					assert.strictEqual((yield* service.listComponents(ORG, other.id)).length, 1)
				}).pipe(Effect.provide(makeLayer(testDb)))
			},
		)

		it.effect("queues the old slug for cleanup on a rename and refuses a taken slug", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config } = yield* seeded(testDb)
				yield* createPage("taken-elsewhere", OTHER_ORG)
				const taken = yield* Effect.flip(
					service.applyConfig(ORG, page.id, { ...config, slug: "taken-elsewhere" }, USER),
				)
				assert.strictEqual(taken._tag, "@maple/http/errors/StatusPageSlugTakenError")
				assert.deepStrictEqual(yield* cleanupSlugs(testDb), [])

				const renamed = yield* service.applyConfig(
					ORG,
					page.id,
					{ ...config, slug: "config-new" },
					USER,
				)
				assert.strictEqual(renamed.config.slug, "config-new")
				assert.deepStrictEqual(yield* cleanupSlugs(testDb), ["config"])
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("reports no change for values that differ only until stored", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config } = yield* seeded(testDb)
				yield* service.update(ORG, page.id, {
					theme: { ...DEFAULT_STATUS_PAGE_THEME, appearance: "light", accent: "#1a2b3c" },
				})
				const current = yield* service.getConfig(ORG, page.id)
				const [first, ...rest] = current.components
				assert.isDefined(first)
				const padded: StatusPageConfig = {
					...current,
					name: ` ${current.name} `,
					description: "   ",
					theme: { ...current.theme, accent: "#1A2B3C" },
					components: [{ ...first, name: ` ${first.name} `, group: " " }, ...rest],
				}
				const applied = yield* service.applyConfig(ORG, page.id, padded, USER)
				assert.deepStrictEqual(applied.changes, NO_CHANGES)
				assert.deepStrictEqual(applied.config.components, config.components)
				assert.strictEqual(applied.config.theme?.accent, "#1a2b3c")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("with if_version, an edited config is a conflict and nothing is written", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config, web } = yield* seeded(testDb)
				yield* service.createComponent(ORG, page.id, { name: "Added meanwhile" })
				const moved = yield* service.getConfig(ORG, page.id)
				assert.notStrictEqual(moved.version, config.version)
				const conflict = yield* Effect.flip(
					service.applyConfig(ORG, page.id, config, USER, { ifVersion: config.version }),
				)
				assert.strictEqual(conflict._tag, "@maple/http/errors/StatusPageConflictError")
				assert.include(conflict.message, "changed since it was read")
				assert.deepStrictEqual(yield* service.getConfig(ORG, page.id), moved)

				const applied = yield* service.applyConfig(ORG, page.id, { ...moved, name: "Fresh" }, USER, {
					ifVersion: moved.version,
				})
				assert.strictEqual(applied.config.name, "Fresh")
				assert.notStrictEqual(applied.config.version, moved.version)
				assert.isTrue(applied.config.components.some((c) => c.id === web.id))
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("a status flip between read and apply is no conflict; a rename by someone else is", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config, web } = yield* seeded(testDb)
				const before = yield* revision(testDb, page.id)
				// What a monitor flip does to the page (`bumpPagesForMonitors`), and a reconcile's bump.
				yield* Effect.promise(() =>
					executeSql(
						testDb,
						`UPDATE status_pages SET revision = revision + 1 WHERE id IN (
							SELECT page_id FROM status_page_components WHERE monitor_id = $1)`,
						[MONITOR],
					),
				)
				yield* Effect.promise(() =>
					executeSql(testDb, `UPDATE status_pages SET revision = revision + 1 WHERE id = $1`, [
						page.id,
					]),
				)
				assert.strictEqual(yield* revision(testDb, page.id), before + 2)
				const applied = yield* service.applyConfig(
					ORG,
					page.id,
					{ ...config, description: "Edited during an outage." },
					USER,
					{ ifVersion: config.version },
				)
				assert.deepStrictEqual(applied.changes.fields, ["description"])

				const read = yield* service.getConfig(ORG, page.id)
				yield* service.updateComponent(ORG, web.id, { name: "Web app" })
				const conflict = yield* Effect.flip(
					service.applyConfig(ORG, page.id, { ...read, name: "Mine" }, USER, {
						ifVersion: read.version,
					}),
				)
				assert.strictEqual(conflict._tag, "@maple/http/errors/StatusPageConflictError")
				assert.strictEqual((yield* service.get(ORG, page.id)).name, read.name)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("caps a page at 200 components, for an apply and for a single create", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page } = yield* seeded(testDb)
				const document = (count: number): StatusPageConfig => ({
					name: "Big",
					slug: "config",
					components: Array.from({ length: count }, (_, index) => ({ name: `C${index}` })),
				})
				const tooMany = yield* Effect.flip(service.applyConfig(ORG, page.id, document(201), USER))
				assert.strictEqual(tooMany._tag, "@maple/http/errors/StatusPageValidationError")
				assert.include(tooMany.message, "at most 200 components")
				assert.lengthOf(yield* service.listComponents(ORG, page.id), 3)

				yield* service.applyConfig(ORG, page.id, document(200), USER)
				const extra = yield* Effect.flip(service.createComponent(ORG, page.id, { name: "201st" }))
				assert.strictEqual(extra._tag, "@maple/http/errors/StatusPageValidationError")
				assert.include(extra.message, "at most 200 components")
				assert.lengthOf(yield* service.listComponents(ORG, page.id), 200)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("a missing or cross-org page is not found", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const { service, page, config } = yield* seeded(testDb)
				const read = yield* Effect.flip(service.getConfig(OTHER_ORG, page.id))
				assert.strictEqual(read._tag, "@maple/http/errors/StatusPageNotFoundError")
				const write = yield* Effect.flip(service.applyConfig(OTHER_ORG, page.id, config, USER))
				assert.strictEqual(write._tag, "@maple/http/errors/StatusPageNotFoundError")
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})

	describe("create with components and drafts", () => {
		const pageCount = (testDb: TestDb) =>
			Effect.promise(() =>
				testDb.pglite.query<{ count: number }>(`SELECT count(*)::int AS count FROM status_pages`),
			).pipe(Effect.map((result) => result.rows[0]?.count))

		it.effect("writes the page and its components in list order, as a draft when asked", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedMonitor(testDb, ORG, MONITOR)
				const service = yield* StatusPagesService
				const page = yield* service.create(ORG, {
					name: "Acme",
					slug: "acme-draft",
					components: [
						{ name: " API ", monitor_id: MONITOR, group: "Core" },
						{ name: "Docs", show_uptime: false, manual_status: "degraded" },
					],
					draft: true,
					createdBy: USER,
				})
				assert.isTrue(page.draft)
				const components = yield* service.listComponents(ORG, page.id)
				assert.deepStrictEqual(
					components.map((c) => [c.name, c.position, c.monitorId, c.groupName, c.showUptime]),
					[
						["API", 0, MONITOR, "Core", true],
						["Docs", 1, null, null, false],
					],
				)
				const plain = yield* createPage("acme-public")
				assert.isFalse(plain.draft)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("creates nothing when a component is invalid or names another org's monitor", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				yield* seedMonitor(testDb, OTHER_ORG, OTHER_MONITOR)
				const service = yield* StatusPagesService
				const foreign = yield* Effect.flip(
					service.create(ORG, {
						name: "Acme",
						slug: "acme-foreign",
						components: [{ name: "API" }, { name: "Stolen", monitor_id: OTHER_MONITOR }],
						createdBy: USER,
					}),
				)
				assert.strictEqual(foreign._tag, "@maple/http/errors/StatusPageValidationError")
				assert.include(foreign.message, "upm_")
				const blank = yield* Effect.flip(
					service.create(ORG, {
						name: "Acme",
						slug: "acme-blank",
						components: [{ name: "API" }, { name: "   " }],
						createdBy: USER,
					}),
				)
				assert.include(blank.message, "components[1].name")
				assert.strictEqual(yield* pageCount(testDb), 0)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})

		it.effect("makePublic clears a draft once and bumps its revision only then", () => {
			const testDb = createTestDb(trackedDbs)
			return Effect.gen(function* () {
				const service = yield* StatusPagesService
				const page = yield* service.create(ORG, {
					name: "Acme",
					slug: "acme-public-later",
					draft: true,
					createdBy: USER,
				})
				const crossOrg = yield* Effect.flip(service.makePublic(OTHER_ORG, page.id))
				assert.strictEqual(crossOrg._tag, "@maple/http/errors/StatusPageNotFoundError")
				const published = yield* service.makePublic(ORG, page.id)
				assert.isFalse(published.draft)
				assert.strictEqual(published.revision, page.revision + 1)
				const again = yield* service.makePublic(ORG, page.id)
				assert.strictEqual(again.revision, published.revision)
			}).pipe(Effect.provide(makeLayer(testDb)))
		})
	})
})
