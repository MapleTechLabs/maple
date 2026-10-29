import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Layer } from "effect"
import { OrgId, StatusPageComponentId, StatusPageIncidentId, UptimeMonitorId } from "@maple/domain/primitives"
import { DEFAULT_STATUS_PAGE_THEME, utcDay } from "@maple/domain/status-page"
import { cleanupTestDbs, createTestDb, type TestDb } from "@maple/backend/platform/test-pglite"
import { StatusPageSnapshotBuilder, toSnapshot, type SnapshotInput } from "./StatusPageSnapshotBuilder"
import {
	DAY_MS,
	newPageId,
	NOW,
	ORG,
	seedComponent,
	seedDaily,
	seedIncident,
	seedMonitor,
	seedPage,
} from "./status-page-test-support"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const COMPONENT = StatusPageComponentId.make("22222222-2222-4222-8222-222222222222")
const MONITOR = UptimeMonitorId.make("33333333-3333-4333-8333-333333333333")
const INCIDENT = StatusPageIncidentId.make("44444444-4444-4444-8444-444444444444")

const API_COMPONENT: SnapshotInput["components"][number] = {
	id: COMPONENT,
	name: "API",
	description: null,
	groupName: null,
	monitorId: MONITOR,
	manualStatus: null,
	showUptime: true,
	monitorStatus: "up",
}

const baseInput = (overrides: Partial<SnapshotInput> = {}): SnapshotInput => ({
	page: {
		id: newPageId(),
		name: "Acme",
		slug: "acme",
		description: null,
		websiteUrl: null,
		logoUrl: null,
		privacyUrl: null,
		termsUrl: "https://acme.example/terms",
		theme: DEFAULT_STATUS_PAGE_THEME,
		showPoweredBy: true,
		breakGlassTokenSha256: null,
		revision: 3,
	},
	components: [API_COMPONENT],
	daily: [],
	incidents: [],
	updates: [],
	incidentComponents: [],
	nowMs: NOW,
	...overrides,
})

const incident = (overrides: Partial<SnapshotInput["incidents"][number]> = {}) => ({
	id: INCIDENT,
	kind: "incident" as const,
	title: "API errors",
	impact: "minor" as const,
	status: "investigating" as const,
	published: true,
	startedAt: NOW - 60_000,
	resolvedAt: null,
	scheduledStart: null,
	scheduledEnd: null,
	...overrides,
})

const componentWith = (overrides: Partial<SnapshotInput["components"][number]>) => [
	{ ...API_COMPONENT, ...overrides },
]

describe("toSnapshot", () => {
	it("maps a down monitor to a major outage", () => {
		const snapshot = toSnapshot(baseInput({ components: componentWith({ monitorStatus: "down" }) }))
		assert.strictEqual(snapshot.components[0]?.status, "major_outage")
	})

	it("applies a manual override when it is worse than the monitor", () => {
		const snapshot = toSnapshot(baseInput({ components: componentWith({ manualStatus: "degraded" }) }))
		assert.strictEqual(snapshot.components[0]?.status, "degraded")
	})

	it("applies an active incident's impact to the components it names", () => {
		const snapshot = toSnapshot(
			baseInput({
				incidents: [incident({ impact: "major" })],
				incidentComponents: [{ incidentId: INCIDENT, componentId: COMPONENT }],
			}),
		)
		assert.strictEqual(snapshot.components[0]?.status, "partial_outage")
		// The base leaves incidents out, so the edge can drop the impact when one resolves there.
		assert.strictEqual(snapshot.components[0]?.baseStatus, "operational")
		assert.deepStrictEqual(snapshot.incidents[0]?.componentIds, [COMPONENT])
	})

	it("leaves drafts and old resolved incidents off the page", () => {
		const snapshot = toSnapshot(
			baseInput({
				incidents: [
					incident({ published: false, impact: "critical" }),
					incident({
						id: StatusPageIncidentId.make("55555555-5555-4555-8555-555555555555"),
						status: "resolved",
						resolvedAt: NOW - 20 * DAY_MS,
					}),
				],
				incidentComponents: [{ incidentId: INCIDENT, componentId: COMPONENT }],
			}),
		)
		assert.deepStrictEqual(snapshot.incidents, [])
		assert.strictEqual(snapshot.components[0]?.status, "operational")
		// Past the listing window, the resolved one still marks its day in the calendar index.
		assert.deepStrictEqual(
			snapshot.incidentHistory.map((entry) => entry.resolvedAt),
			[NOW - 20 * DAY_MS],
		)
	})

	it("indexes a year of published incidents and started maintenance, newest first, without updates", () => {
		const id = (n: number) => StatusPageIncidentId.make(`55555555-5555-4555-8555-55555555555${n}`)
		const snapshot = toSnapshot(
			baseInput({
				incidents: [
					incident({ id: id(0), title: "Open now", startedAt: NOW - 3_600_000 }),
					incident({
						id: id(1),
						title: "Spring outage",
						impact: "critical",
						status: "resolved",
						startedAt: NOW - 200 * DAY_MS,
						resolvedAt: NOW - 199 * DAY_MS,
					}),
					incident({
						id: id(2),
						title: "Too old",
						status: "resolved",
						startedAt: NOW - 400 * DAY_MS,
						resolvedAt: NOW - 366 * DAY_MS,
					}),
					incident({
						id: id(3),
						kind: "maintenance",
						title: "Not started",
						status: "scheduled",
						startedAt: NOW + DAY_MS,
						scheduledEnd: NOW + 2 * DAY_MS,
					}),
					incident({ id: id(4), title: "Draft", published: false }),
				],
				updates: [
					{
						id: "u-old",
						incidentId: id(1),
						status: "resolved",
						body: "Fixed",
						source: "dashboard",
						overlayEntryId: null,
						createdAt: NOW - 199 * DAY_MS,
					},
				],
			}),
		)
		assert.deepStrictEqual(snapshot.incidentHistory, [
			{
				id: id(0),
				title: "Open now",
				kind: "incident",
				impact: "minor",
				startedAt: NOW - 3_600_000,
				resolvedAt: null,
			},
			{
				id: id(1),
				title: "Spring outage",
				kind: "incident",
				impact: "critical",
				startedAt: NOW - 200 * DAY_MS,
				resolvedAt: NOW - 199 * DAY_MS,
			},
		])
		assert.deepStrictEqual(
			snapshot.incidents.map((listed) => listed.title),
			["Not started", "Open now"],
		)
	})

	it("lists upcoming maintenance without affecting status", () => {
		const snapshot = toSnapshot(
			baseInput({
				incidents: [
					incident({ kind: "maintenance", status: "scheduled", scheduledEnd: NOW + DAY_MS }),
				],
				incidentComponents: [{ incidentId: INCIDENT, componentId: COMPONENT }],
			}),
		)
		assert.strictEqual(snapshot.incidents.length, 1)
		assert.strictEqual(snapshot.components[0]?.status, "operational")
	})

	it("marks the components of in-progress maintenance as under maintenance", () => {
		const snapshot = toSnapshot(
			baseInput({
				incidents: [
					incident({ kind: "maintenance", status: "in_progress", scheduledEnd: NOW + DAY_MS }),
				],
				incidentComponents: [{ incidentId: INCIDENT, componentId: COMPONENT }],
			}),
		)
		assert.strictEqual(snapshot.incidents.length, 1)
		assert.strictEqual(snapshot.components[0]?.status, "maintenance")
		assert.strictEqual(snapshot.components[0]?.baseStatus, "operational")
	})

	it("fills 365 days of bars", () => {
		const today = utcDay(NOW)
		const snapshot = toSnapshot(
			baseInput({
				daily: [
					{
						monitorId: MONITOR,
						day: today,
						checks: 10,
						failures: 1,
						downChecks: 0,
					},
					{
						monitorId: MONITOR,
						day: utcDay(NOW - DAY_MS),
						checks: 20,
						failures: 0,
						downChecks: 0,
					},
				],
			}),
		)
		const days = snapshot.components[0]?.days ?? []
		assert.strictEqual(days.length, 365)
		assert.deepStrictEqual(days.at(-1), { day: today, checks: 10, failures: 1, downChecks: 0 })
		assert.deepStrictEqual(days[0], {
			day: utcDay(NOW - 364 * DAY_MS),
			checks: 0,
			failures: 0,
			downChecks: 0,
		})
	})

	it("gives components without a monitor or with hidden uptime no bars, but still marks monitored ones", () => {
		const hidden = toSnapshot(baseInput({ components: componentWith({ showUptime: false }) }))
		const unmonitored = toSnapshot(baseInput({ components: componentWith({ monitorId: null }) }))
		assert.deepStrictEqual(hidden.components[0]?.days, [])
		assert.deepStrictEqual(unmonitored.components[0]?.days, [])
		assert.isTrue(hidden.components[0]?.monitored)
		assert.isFalse(unmonitored.components[0]?.monitored)
	})

	it("links break-glass updates to their entries and names the entry that opened an incident", () => {
		const update = (
			id: string,
			at: number,
			source: "break_glass" | "dashboard",
			entry: string | null,
		) => ({
			id,
			incidentId: INCIDENT,
			status: "investigating" as const,
			body: id,
			source,
			overlayEntryId: entry,
			createdAt: at,
		})
		const opened = toSnapshot(
			baseInput({
				incidents: [incident()],
				updates: [
					update("later", NOW - 1_000, "dashboard", null),
					update("first", NOW - 60_000, "break_glass", "entry-1"),
				],
			}),
		)
		assert.strictEqual(opened.incidents[0]?.openedByOverlayEntryId, "entry-1")
		// An imported entry keeps its overlay id, so the feed does not show it twice after import.
		assert.deepStrictEqual(
			opened.incidents[0]?.updates.map((u) => [u.id, u.overlayEntryId]),
			[
				["later", null],
				["entry-1", "entry-1"],
			],
		)
		const followedUp = toSnapshot(
			baseInput({
				incidents: [incident()],
				updates: [
					update("first", NOW - 60_000, "dashboard", null),
					update("later", NOW - 1_000, "break_glass", "entry-2"),
				],
			}),
		)
		assert.isNull(followedUp.incidents[0]?.openedByOverlayEntryId)
	})
})

describe("StatusPageSnapshotBuilder.build", () => {
	it.effect("reads a page from Postgres into its snapshot", () => {
		const testDb = createTestDb(trackedDbs)
		const pageId = newPageId()
		const monitorId = crypto.randomUUID()
		const downComponent = crypto.randomUUID()
		const manualComponent = crypto.randomUUID()
		return Effect.gen(function* () {
			yield* seedPage(testDb, { id: pageId, slug: "acme-build", revision: 4 })
			yield* seedMonitor(testDb, { id: monitorId, status: "down" })
			yield* seedDaily(testDb, {
				monitorId,
				day: utcDay(NOW),
				checks: 5,
				failures: 2,
				downChecks: 1,
				lastCheckAt: NOW - 30_000,
			})
			yield* seedDaily(testDb, {
				monitorId,
				day: utcDay(NOW - 300 * DAY_MS),
				checks: 7,
				failures: 0,
				downChecks: 0,
				lastCheckAt: NOW - 300 * DAY_MS,
			})
			yield* seedComponent(testDb, {
				id: manualComponent,
				pageId,
				name: "Docs",
				position: 1,
				manualStatus: "degraded",
			})
			yield* seedComponent(testDb, { id: downComponent, pageId, name: "API", position: 0, monitorId })
			yield* seedIncident(testDb, {
				id: crypto.randomUUID(),
				pageId,
				title: "Draft",
				status: "investigating",
				published: false,
				startedAt: NOW - 1000,
				componentIds: [manualComponent],
			})
			yield* seedIncident(testDb, {
				id: crypto.randomUUID(),
				pageId,
				title: "Docs slow",
				impact: "critical",
				status: "identified",
				startedAt: NOW - 2000,
				componentIds: [manualComponent],
			})
			yield* seedIncident(testDb, {
				id: crypto.randomUUID(),
				pageId,
				title: "Old outage",
				impact: "major",
				status: "resolved",
				startedAt: NOW - 120 * DAY_MS,
				resolvedAt: NOW - 120 * DAY_MS + 3_600_000,
				componentIds: [downComponent],
			})
			const otherPage = newPageId()
			yield* seedPage(testDb, { id: otherPage, slug: "other-build" })
			yield* seedIncident(testDb, {
				id: crypto.randomUUID(),
				pageId: otherPage,
				title: "Other page",
				status: "resolved",
				startedAt: NOW - 10 * DAY_MS,
				resolvedAt: NOW - 10 * DAY_MS,
			})

			const builder = yield* StatusPageSnapshotBuilder
			const snapshot = yield* builder.build(pageId, NOW)
			assert.strictEqual(snapshot.revision, 4)
			assert.deepStrictEqual(snapshot.page.theme, DEFAULT_STATUS_PAGE_THEME)
			assert.deepStrictEqual(
				snapshot.components.map((c) => [c.name, c.status, c.days.length]),
				[
					["API", "major_outage", 365],
					["Docs", "major_outage", 0],
				],
			)
			assert.deepStrictEqual(
				snapshot.incidents.map((i) => [i.title, i.updates.length]),
				[["Docs slow", 1]],
			)
			assert.deepStrictEqual(
				snapshot.incidentHistory.map((entry) => [entry.title, entry.impact]),
				[
					["Docs slow", "critical"],
					["Old outage", "major"],
				],
			)
			assert.strictEqual(snapshot.components[0]?.days[64]?.checks, 7)
			assert.deepStrictEqual(
				snapshot.components.map((c) => c.monitored),
				[true, false],
			)

			const missing = yield* Effect.exit(builder.build(newPageId(), NOW))
			assert.isTrue(Exit.isFailure(missing))
		}).pipe(Effect.provide(StatusPageSnapshotBuilder.layer.pipe(Layer.provide(testDb.layer))))
	})

	it.effect("reads the probe pulse across orgs, or for one org only when asked", () => {
		const testDb = createTestDb(trackedDbs)
		return Effect.gen(function* () {
			const builder = yield* StatusPageSnapshotBuilder
			const ours = crypto.randomUUID()
			const theirs = crypto.randomUUID()
			yield* seedMonitor(testDb, { id: ours, status: "up" })
			yield* seedMonitor(testDb, { id: theirs, status: "up", orgId: "org_other" })
			const daily = (monitorId: string, lastCheckAt: number, orgId: string = ORG) =>
				seedDaily(testDb, {
					monitorId,
					day: utcDay(NOW),
					checks: 1,
					failures: 0,
					downChecks: 0,
					lastCheckAt,
					orgId,
				})
			yield* daily(ours, NOW - 600_000)
			yield* daily(theirs, NOW - 1_000, "org_other")

			assert.strictEqual(yield* builder.probesSeenAt(NOW), NOW - 1_000)
			assert.strictEqual(yield* builder.probesSeenAt(NOW, ORG), NOW - 600_000)
			// Another org's fresh probe never vouches for a silent org.
			assert.strictEqual(yield* builder.probesSeenAt(NOW, OrgId.make("org_silent")), null)
		}).pipe(Effect.provide(StatusPageSnapshotBuilder.layer.pipe(Layer.provide(testDb.layer))))
	})
})
