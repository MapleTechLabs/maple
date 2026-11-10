import { afterEach, assert, describe, it } from "@effect/vitest"
import { Clock, Effect, Layer, Array as Arr } from "effect"
import { TestClock } from "effect/testing"
import { UserId } from "@maple/domain/http"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import type { StatusPageComponentId, StatusPageId } from "@maple/primitives"
import { EmailDeliveryError, EmailService } from "@maple/backend/platform/EmailService"
import { cleanupTestDbs, createTestDb, executeSql, type TestDb } from "@maple/backend/testing/test-pglite"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { NOW, ORG, seedCustomDomain } from "./status-page-test-support"
import { STATUS_PAGE_NOTIFY_LOOKBACK_MS, StatusPageNotifier } from "./StatusPageNotifier"
import { StatusPagesService } from "./StatusPagesService"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const USER = UserId.make("user_notifier")
const BASE_URL = "https://status.maple.test"

interface SentEmail {
	readonly to: string
	readonly subject: string
	readonly html: string
	readonly headers: Readonly<Record<string, string>>
}

const makeHarness = (options: { readonly rollout?: boolean } = {}) => {
	const testDb = createTestDb(trackedDbs)
	const sent: SentEmail[] = []
	const email = { down: false }
	const emailStub = Layer.succeed(EmailService, {
		isConfigured: true,
		send: (to, subject, html, sendOptions) =>
			email.down
				? Effect.fail(new EmailDeliveryError({ message: "provider unavailable" }))
				: Effect.sync(
						() => void sent.push({ to, subject, html, headers: sendOptions?.headers ?? {} }),
					),
	})
	const flagsStub = Layer.succeed(OrganizationFeatureFlagsService, {
		flags: () =>
			Effect.succeed({ ...ENABLED_ORGANIZATION_FEATURE_FLAGS, statusPages: options.rollout ?? true }),
	})
	const layer = Layer.mergeAll(
		Layer.effect(StatusPageNotifier, StatusPageNotifier.make).pipe(
			Layer.provide(Layer.mergeAll(emailStub, flagsStub)),
		),
		Layer.effect(StatusPagesService, StatusPagesService.make),
	).pipe(
		Layer.provideMerge(Layer.mergeAll(testDb.layer, testEnv({ MAPLE_STATUS_PAGE_BASE_URL: BASE_URL }))),
	)
	return { testDb, sent, email, layer }
}

const createPage = Effect.gen(function* () {
	yield* TestClock.setTime(NOW)
	const pages = yield* StatusPagesService
	const page = yield* pages.create(ORG, {
		name: "Acme",
		slug: "acme",
		createdBy: USER,
		components: [{ name: "API" }, { name: "Dashboard" }],
	})
	const [api, dashboard] = Arr.map(yield* pages.listComponents(ORG, page.id), (component) => component.id)
	if (api === undefined || dashboard === undefined) return yield* Effect.die("components missing")
	return { pageId: page.id, api, dashboard }
})

/** A subscriber row as a confirmed (or pending) visitor leaves it; `componentIds` null is all. */
const seedSubscriber = (
	testDb: TestDb,
	pageId: StatusPageId,
	email: string,
	options: {
		readonly componentIds?: ReadonlyArray<StatusPageComponentId> | null
		readonly confirmedAt?: number | null
	} = {},
) =>
	Effect.promise(() => {
		const confirmedAt = options.confirmedAt === undefined ? NOW - 60_000 : options.confirmedAt
		return executeSql(
			testDb,
			`INSERT INTO status_page_subscribers (id, org_id, page_id, email, component_ids, confirmed_at, created_at, updated_at)
			 VALUES (gen_random_uuid()::text, $1, $2, $3, $4::jsonb, $5, $6, $6)`,
			[
				ORG,
				pageId,
				email,
				options.componentIds === undefined || options.componentIds === null
					? null
					: JSON.stringify(options.componentIds),
				confirmedAt === null ? null : new Date(confirmedAt).toISOString(),
				new Date(NOW - 120_000).toISOString(),
			],
		)
	})

const sweepNow = Effect.gen(function* () {
	const notifier = yield* StatusPageNotifier
	return yield* notifier.sweep(yield* Clock.currentTimeMillis)
})

const recipients = (sent: ReadonlyArray<SentEmail>) =>
	Arr.sort(
		Arr.map(sent, (email) => email.to),
		(a, b) => (a < b ? -1 : a > b ? 1 : 0),
	)

describe("StatusPageNotifier", () => {
	it.effect("links the page and unsubscribe at its active custom domain", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId, api } = yield* createPage
			yield* seedCustomDomain(testDb, { pageId, hostname: "status.acme.com", status: "active" })
			yield* seedSubscriber(testDb, pageId, "all@example.com")
			const pages = yield* StatusPagesService
			const incident = yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "API errors",
				impact: "major",
				status: "investigating",
				body: "Looking into it.",
				componentIds: [api],
				source: "dashboard",
			})

			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.include(sent[0]?.html ?? "", `https://status.acme.com#incident-${incident.id}`)
			assert.match(
				sent[0]?.headers["List-Unsubscribe"] ?? "",
				/^<https:\/\/status\.acme\.com\/unsubscribe\?token=[^>]+>$/u,
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("emails each update once, to confirmed subscribers whose components it touches", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId, api, dashboard } = yield* createPage
			yield* seedSubscriber(testDb, pageId, "all@example.com")
			yield* seedSubscriber(testDb, pageId, "api@example.com", { componentIds: [api] })
			yield* seedSubscriber(testDb, pageId, "dashboard@example.com", { componentIds: [dashboard] })
			yield* seedSubscriber(testDb, pageId, "pending@example.com", { confirmedAt: null })
			const pages = yield* StatusPagesService
			const incident = yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "API errors",
				impact: "major",
				status: "investigating",
				body: "We are looking into it.\n\nMore soon.",
				componentIds: [api],
				source: "dashboard",
			})

			yield* TestClock.adjust("1 minute")
			const first = yield* sweepNow
			assert.deepStrictEqual(recipients(sent), ["all@example.com", "api@example.com"])
			assert.deepStrictEqual(
				{ queued: first.queued, sent: first.sent, completed: first.completed },
				{ queued: 1, sent: 2, completed: 1 },
			)
			const email = sent[0]
			assert.strictEqual(email?.subject, "[Investigating] API errors")
			assert.include(email?.html ?? "", "More soon.")
			assert.include(email?.html ?? "", `${BASE_URL}/s/acme#incident-${incident.id}`)
			const unsubscribe = email?.headers["List-Unsubscribe"] ?? ""
			assert.match(unsubscribe, /^<https:\/\/status\.maple\.test\/s\/acme\/unsubscribe\?token=[^>]+>$/u)
			assert.strictEqual(email?.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click")

			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.strictEqual(sent.length, 2)

			yield* pages.postUpdate(ORG, incident.id, {
				status: "resolved",
				body: "Fixed.",
				source: "dashboard",
			})
			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.deepStrictEqual(
				Arr.map(sent.slice(2), (resolved) => resolved.subject),
				["[Resolved] API errors", "[Resolved] API errors"],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("sends maintenance and component-less incidents to every subscriber", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId, dashboard } = yield* createPage
			yield* seedSubscriber(testDb, pageId, "dashboard@example.com", { componentIds: [dashboard] })
			const pages = yield* StatusPagesService
			yield* pages.createIncident(ORG, pageId, {
				kind: "maintenance",
				title: "Database upgrade",
				impact: "none",
				status: "scheduled",
				body: "Planned.",
				componentIds: [],
				scheduledStart: NOW + 86_400_000,
				scheduledEnd: NOW + 90_000_000,
				source: "dashboard",
			})
			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.deepStrictEqual(
				Arr.map(sent, (email) => [email.to, email.subject]),
				[["dashboard@example.com", "[Maintenance: Scheduled] Database upgrade"]],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect("holds a draft incident until it is published, then sends only its newest update", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId, api } = yield* createPage
			yield* seedSubscriber(testDb, pageId, "all@example.com")
			const pages = yield* StatusPagesService
			const draft = yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "Probe failing",
				impact: "major",
				status: "investigating",
				body: "Auto-opened.",
				componentIds: [api],
				published: false,
				source: "dashboard",
			})
			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.strictEqual(sent.length, 0)

			yield* pages.postUpdate(ORG, draft.id, {
				status: "identified",
				body: "Cause found.",
				source: "dashboard",
				publish: true,
			})
			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			assert.deepStrictEqual(
				Arr.map(sent, (email) => email.subject),
				["[Identified] Probe failing"],
			)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"skips updates posted before the subscriber confirmed, and ones older than the lookback",
		() => {
			const { testDb, sent, layer } = makeHarness()
			return Effect.gen(function* () {
				const { pageId } = yield* createPage
				const pages = yield* StatusPagesService
				yield* pages.createIncident(ORG, pageId, {
					kind: "incident",
					title: "Earlier",
					impact: "minor",
					status: "investigating",
					body: "Before anyone subscribed.",
					componentIds: [],
					source: "dashboard",
				})
				yield* seedSubscriber(testDb, pageId, "late@example.com", { confirmedAt: NOW + 30_000 })
				yield* TestClock.adjust("1 minute")
				yield* sweepNow
				assert.strictEqual(sent.length, 0)

				yield* TestClock.setTime(NOW + STATUS_PAGE_NOTIFY_LOOKBACK_MS + 60_000)
				yield* seedSubscriber(testDb, pageId, "early@example.com", { confirmedAt: NOW - 3_600_000 })
				yield* sweepNow
				assert.strictEqual(sent.length, 0)
			}).pipe(Effect.provide(layer))
		},
	)

	it.effect("works through a long list over several sweeps, each address once", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage
			yield* Effect.forEach(
				Arr.range(1, 70),
				(n) => seedSubscriber(testDb, pageId, `visitor${n}@example.com`),
				{ discard: true },
			)
			const pages = yield* StatusPagesService
			yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "Outage",
				impact: "critical",
				status: "investigating",
				body: "Down.",
				componentIds: [],
				source: "dashboard",
			})
			yield* TestClock.adjust("1 minute")
			const first = yield* sweepNow
			yield* TestClock.adjust("1 minute")
			const second = yield* sweepNow
			yield* TestClock.adjust("1 minute")
			yield* sweepNow

			assert.isBelow(first.sent, 70)
			assert.strictEqual(first.sent + second.sent, 70)
			assert.strictEqual(new Set(Arr.map(sent, (email) => email.to)).size, 70)
			assert.strictEqual(sent.length, 70)
		}).pipe(Effect.provide(layer))
	})

	it.effect("retries a batch after an email outage, sending each address once", () => {
		const { testDb, sent, email, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage
			yield* seedSubscriber(testDb, pageId, "ana@example.com")
			yield* seedSubscriber(testDb, pageId, "bo@example.com")
			const pages = yield* StatusPagesService
			yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "Outage",
				impact: "critical",
				status: "investigating",
				body: "Down.",
				componentIds: [],
				source: "dashboard",
			})
			email.down = true
			yield* TestClock.adjust("1 minute")
			const failed = yield* sweepNow
			email.down = false
			yield* TestClock.adjust("1 minute")
			yield* sweepNow
			yield* TestClock.adjust("1 minute")
			yield* sweepNow

			assert.strictEqual(failed.failed, 2)
			assert.deepStrictEqual(recipients(sent), ["ana@example.com", "bo@example.com"])
		}).pipe(Effect.provide(layer))
	})

	it.effect("holds updates for an org out of the rollout, and drops them once they are old", () => {
		const { testDb, sent, layer } = makeHarness({ rollout: false })
		return Effect.gen(function* () {
			const { pageId } = yield* createPage
			yield* seedSubscriber(testDb, pageId, "all@example.com")
			const pages = yield* StatusPagesService
			yield* pages.createIncident(ORG, pageId, {
				kind: "incident",
				title: "Outage",
				impact: "critical",
				status: "investigating",
				body: "Down.",
				componentIds: [],
				source: "dashboard",
			})
			yield* TestClock.adjust("1 minute")
			const held = yield* sweepNow
			assert.deepStrictEqual(
				{ queued: held.queued, completed: held.completed },
				{ queued: 1, completed: 0 },
			)

			yield* TestClock.adjust(STATUS_PAGE_NOTIFY_LOOKBACK_MS + 60_000)
			const dropped = yield* sweepNow
			assert.strictEqual(dropped.completed, 1)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(layer))
	})
})
