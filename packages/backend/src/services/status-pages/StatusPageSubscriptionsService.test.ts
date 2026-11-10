import { afterEach, assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import * as SecureRandom from "effect/crypto/SecureRandom"
import { TestClock } from "effect/testing"
import { UserId } from "@maple/domain/http"
import { ENABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { StatusPageComponentId, StatusPageSubscriberId, type StatusPageId } from "@maple/primitives"
import { EmailService } from "@maple/backend/platform/EmailService"
import { cleanupTestDbs, createTestDb, queryFirstRow, type TestDb } from "@maple/backend/testing/test-pglite"
import { testEnv } from "@maple/backend/services/integrations/vcs/__tests__/harness"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { ORG, NOW, seedCustomDomain } from "./status-page-test-support"
import { StatusPagesService } from "./StatusPagesService"
import {
	STATUS_PAGE_CONFIRMATIONS_PER_HOUR,
	StatusPageSubscriptionsService,
} from "./StatusPageSubscriptionsService"
import { mintUnsubscribeToken } from "./subscription-tokens"

const trackedDbs: TestDb[] = []
afterEach(() => cleanupTestDbs(trackedDbs))

const USER = UserId.make("user_subscriptions")
const BASE_URL = "https://status.maple.test"
const HMAC_KEY = "maple-test-lookup-secret"

interface SentEmail {
	readonly to: string
	readonly subject: string
	readonly html: string
}

const makeHarness = (options: { readonly rollout?: boolean; readonly baseUrl?: string | null } = {}) => {
	const testDb = createTestDb(trackedDbs)
	const sent: SentEmail[] = []
	const emailStub = Layer.succeed(EmailService, {
		isConfigured: true,
		send: (to, subject, html) => Effect.sync(() => void sent.push({ to, subject, html })),
	})
	const flagsStub = Layer.succeed(OrganizationFeatureFlagsService, {
		flags: () =>
			Effect.succeed({ ...ENABLED_ORGANIZATION_FEATURE_FLAGS, statusPages: options.rollout ?? true }),
	})
	const baseUrl = options.baseUrl === undefined ? BASE_URL : options.baseUrl
	const base = Layer.mergeAll(
		testDb.layer,
		testEnv(baseUrl === null ? {} : { MAPLE_STATUS_PAGE_BASE_URL: baseUrl }),
	)
	const layer = Layer.mergeAll(
		Layer.effect(StatusPageSubscriptionsService, StatusPageSubscriptionsService.make).pipe(
			Layer.provide(Layer.mergeAll(emailStub, flagsStub)),
		),
		Layer.effect(StatusPagesService, StatusPagesService.make),
	).pipe(Layer.provideMerge(base))
	return { testDb, sent, layer }
}

/** A public page with two components, as its owners would create it. */
const createPage = (slug: string, options: { readonly draft?: boolean } = {}) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		const pages = yield* StatusPagesService
		const page = yield* pages.create(ORG, {
			name: "Acme",
			slug,
			createdBy: USER,
			draft: options.draft ?? false,
			components: [{ name: "API" }, { name: "Dashboard" }],
		})
		const components = yield* pages.listComponents(ORG, page.id)
		return { pageId: page.id, componentIds: Arr.map(components, (component) => component.id) }
	})

/** The token in an email's confirmation link. */
const confirmToken = (email: SentEmail | undefined): string => {
	const match = /subscribe\/confirm\?token=([^"&]+)/u.exec(email?.html ?? "")
	return decodeURIComponent(match?.[1] ?? "")
}

const subscriberRow = (testDb: TestDb, pageId: StatusPageId, email: string) =>
	Effect.promise(() =>
		queryFirstRow<{
			id: string
			confirmed_at: string | null
			component_ids: ReadonlyArray<string> | null
		}>(
			testDb,
			`SELECT id, confirmed_at, component_ids FROM status_page_subscribers WHERE page_id = $1 AND email = $2`,
			[pageId, email],
		),
	)

describe("StatusPageSubscriptionsService", () => {
	it.effect("emails a confirmation link, and the link confirms the address once", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId, componentIds } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			const firstComponent = componentIds.slice(0, 1)
			yield* subscriptions.subscribe(pageId, {
				email: " Ana@Example.COM ",
				componentIds: firstComponent,
			})

			assert.deepStrictEqual(
				Arr.map(sent, (email) => [email.to, email.subject]),
				[["ana@example.com", "Confirm your subscription to Acme status updates"]],
			)
			assert.include(sent[0]?.html ?? "", `${BASE_URL}/s/acme/subscribe/confirm?token=`)
			assert.include(sent[0]?.html ?? "", "API")
			const pending = yield* subscriberRow(testDb, pageId, "ana@example.com")
			assert.isNull(pending?.confirmed_at ?? null)
			assert.deepStrictEqual(pending?.component_ids, firstComponent)

			const token = confirmToken(sent[0])
			yield* subscriptions.confirm(pageId, token)
			const confirmed = yield* subscriberRow(testDb, pageId, "ana@example.com")
			assert.isNotNull(confirmed?.confirmed_at ?? null)

			const reused = yield* Effect.flip(subscriptions.confirm(pageId, token))
			assert.strictEqual(reused._tag, "@maple/http/errors/StatusPageSubscriptionTokenInvalidError")
		}).pipe(Effect.provide(layer))
	})

	it.effect("answers a confirmed address like any other and sends it nothing", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			yield* subscriptions.confirm(pageId, confirmToken(sent[0]))
			yield* TestClock.adjust("2 hours")

			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			assert.strictEqual(sent.length, 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("resends to a pending address only after a wait, and the new link replaces the old", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			assert.strictEqual(sent.length, 1)

			yield* TestClock.adjust("61 minutes")
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			assert.strictEqual(sent.length, 2)

			const stale = yield* Effect.flip(subscriptions.confirm(pageId, confirmToken(sent[0])))
			assert.strictEqual(stale._tag, "@maple/http/errors/StatusPageSubscriptionTokenInvalidError")
			yield* subscriptions.confirm(pageId, confirmToken(sent[1]))
		}).pipe(Effect.provide(layer))
	})

	it.effect("refuses a confirmation link after 48 hours", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			yield* TestClock.adjust("49 hours")

			const expired = yield* Effect.flip(subscriptions.confirm(pageId, confirmToken(sent[0])))
			assert.strictEqual(expired._tag, "@maple/http/errors/StatusPageSubscriptionTokenInvalidError")
		}).pipe(Effect.provide(layer))
	})

	it.effect("stops sending confirmations once a page reaches its hourly cap", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* Effect.forEach(
				Arr.range(1, STATUS_PAGE_CONFIRMATIONS_PER_HOUR + 1),
				(n) => subscriptions.subscribe(pageId, { email: `visitor${n}@example.com` }),
				{ discard: true },
			)
			assert.strictEqual(sent.length, STATUS_PAGE_CONFIRMATIONS_PER_HOUR)

			yield* TestClock.adjust("61 minutes")
			yield* subscriptions.subscribe(pageId, { email: "later@example.com" })
			assert.strictEqual(sent.length, STATUS_PAGE_CONFIRMATIONS_PER_HOUR + 1)
		}).pipe(Effect.provide(layer))
	})

	it.effect("counts resends to pending addresses against the hourly cap", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* Effect.forEach(
				Arr.range(1, STATUS_PAGE_CONFIRMATIONS_PER_HOUR),
				(n) => subscriptions.subscribe(pageId, { email: `visitor${n}@example.com` }),
				{ discard: true },
			)
			yield* TestClock.adjust("21 minutes")
			yield* subscriptions.subscribe(pageId, { email: "visitor1@example.com" })
			assert.strictEqual(sent.length, STATUS_PAGE_CONFIRMATIONS_PER_HOUR)
		}).pipe(Effect.provide(layer))
	})

	it.effect("never sends more than the hourly cap, whatever mix of new addresses and resends", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			const half = Math.floor(STATUS_PAGE_CONFIRMATIONS_PER_HOUR / 2)
			const subscribeAll = (from: number, to: number) =>
				Effect.forEach(
					Arr.range(from, to),
					(n) => subscriptions.subscribe(pageId, { email: `visitor${n}@example.com` }),
					{ discard: true, concurrency: 10 },
				)
			yield* subscribeAll(1, half)
			// Resends of the first half, plus new addresses, inside one hour.
			for (const minutes of ["21 minutes", "21 minutes"]) {
				yield* TestClock.adjust(minutes)
				yield* subscribeAll(1, STATUS_PAGE_CONFIRMATIONS_PER_HOUR * 2)
			}
			assert.strictEqual(sent.length, STATUS_PAGE_CONFIRMATIONS_PER_HOUR)
		}).pipe(Effect.provide(layer))
	})

	it.effect("rejects a bad address, an empty pick and a component from another page", () => {
		const { sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const other = yield* createPage("other")
			const subscriptions = yield* StatusPageSubscriptionsService
			const failures = yield* Effect.forEach(
				[
					{ email: "not-an-address" },
					{ email: "ana@example.com", componentIds: [] },
					{ email: "ana@example.com", componentIds: other.componentIds },
					{
						email: "ana@example.com",
						componentIds: [StatusPageComponentId.make(SecureRandom.uuidV4Unsafe())],
					},
				],
				(input) => Effect.flip(subscriptions.subscribe(pageId, input)),
			)
			assert.deepStrictEqual(
				Arr.map(failures, (failure) => failure._tag),
				Arr.makeBy(4, () => "@maple/http/errors/StatusPageSubscriptionInvalidError"),
			)
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect("treats a draft page, and a page whose org left the rollout, as not found", () => {
		const draft = makeHarness()
		const outOfRollout = makeHarness({ rollout: false })
		const attempt = (slug: string, options: { readonly draft?: boolean } = {}) =>
			Effect.gen(function* () {
				const { pageId } = yield* createPage(slug, options)
				const subscriptions = yield* StatusPageSubscriptionsService
				return yield* Effect.flip(subscriptions.subscribe(pageId, { email: "ana@example.com" }))
			})
		return Effect.gen(function* () {
			const fromDraft = yield* attempt("draft", { draft: true }).pipe(Effect.provide(draft.layer))
			const fromRollout = yield* attempt("acme").pipe(Effect.provide(outOfRollout.layer))
			assert.strictEqual(fromDraft._tag, "@maple/http/errors/StatusPageSubscriptionPageNotFoundError")
			assert.strictEqual(fromRollout._tag, "@maple/http/errors/StatusPageSubscriptionPageNotFoundError")
			assert.strictEqual(draft.sent.length + outOfRollout.sent.length, 0)
		})
	})

	it.effect("refuses subscriptions where no status page origin is configured", () => {
		const { sent, layer } = makeHarness({ baseUrl: null })
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			const failure = yield* Effect.flip(subscriptions.subscribe(pageId, { email: "ana@example.com" }))
			assert.strictEqual(failure._tag, "@maple/http/errors/StatusPageSubscriptionUnavailableError")
			assert.strictEqual(sent.length, 0)
		}).pipe(Effect.provide(layer))
	})

	it.effect(
		"links the confirmation to the page's active custom domain, with or without a status origin",
		() => {
			const withOrigin = makeHarness()
			const withoutOrigin = makeHarness({ baseUrl: null })
			const subscribeOn = (testDb: TestDb, status: "active" | "pending_dns") =>
				Effect.gen(function* () {
					const { pageId } = yield* createPage("acme")
					yield* seedCustomDomain(testDb, { pageId, hostname: "status.acme.com", status })
					const subscriptions = yield* StatusPageSubscriptionsService
					yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
				})
			return Effect.gen(function* () {
				yield* subscribeOn(withOrigin.testDb, "active").pipe(Effect.provide(withOrigin.layer))
				yield* subscribeOn(withoutOrigin.testDb, "active").pipe(Effect.provide(withoutOrigin.layer))
				assert.include(
					withOrigin.sent[0]?.html ?? "",
					"https://status.acme.com/subscribe/confirm?token=",
				)
				assert.include(
					withoutOrigin.sent[0]?.html ?? "",
					"https://status.acme.com/subscribe/confirm?token=",
				)

				// A domain not live yet is no address: the shared origin it is.
				const pending = makeHarness()
				yield* subscribeOn(pending.testDb, "pending_dns").pipe(Effect.provide(pending.layer))
				assert.include(pending.sent[0]?.html ?? "", `${BASE_URL}/s/acme/subscribe/confirm?token=`)
			})
		},
	)

	it.effect("unsubscribes by signed link, idempotently, and refuses a forged one", () => {
		const { testDb, sent, layer } = makeHarness()
		return Effect.gen(function* () {
			const { pageId } = yield* createPage("acme")
			const subscriptions = yield* StatusPageSubscriptionsService
			yield* subscriptions.subscribe(pageId, { email: "ana@example.com" })
			yield* subscriptions.confirm(pageId, confirmToken(sent[0]))
			const row = yield* subscriberRow(testDb, pageId, "ana@example.com")
			const token = mintUnsubscribeToken(HMAC_KEY, StatusPageSubscriberId.make(row?.id ?? ""))

			const forged = yield* Effect.flip(
				subscriptions.unsubscribe(pageId, `${Str.slice(0, -2)(token)}xx`),
			)
			assert.strictEqual(forged._tag, "@maple/http/errors/StatusPageSubscriptionTokenInvalidError")
			assert.isDefined(yield* subscriberRow(testDb, pageId, "ana@example.com"))

			yield* subscriptions.unsubscribe(pageId, token)
			assert.isUndefined(yield* subscriberRow(testDb, pageId, "ana@example.com"))
			yield* subscriptions.unsubscribe(pageId, token)
		}).pipe(Effect.provide(layer))
	})
})
