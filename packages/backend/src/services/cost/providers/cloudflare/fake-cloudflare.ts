// A fake Cloudflare for tests: the accounts, billable usage and subscription calls answered from
// a mutable world, with every call recorded. Usage is served the way the real API was seen to:
// a billing period's days before `to`, and only when the period starts inside `[from, to)`.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { DateTime, Effect, Layer, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"
import type { Subscription, UsageRow } from "./cloudflare-billing-api"

export type FakeUsageRow = typeof UsageRow.Encoded
export type FakeSubscription = typeof Subscription.Encoded

export interface FakeCloudflare {
	/** Status of `GET /accounts`. */
	accountsStatus: number
	/** The accounts the token can see. */
	accounts: ReadonlyArray<{ readonly id: string; readonly name: string }>
	/** Status of the billable usage calls, `info` included. */
	billingStatus: number
	/** Whether the account has usage-based billing data. */
	covered: boolean
	/** Every usage row the account has, or raw text for a malformed answer. */
	usage: ReadonlyArray<FakeUsageRow> | string
	/** The day of the month a billing period starts on. */
	anchorDay: number
	/** The oldest day served: a year back on the real API. Older days of a range are left out, not refused. */
	oldestDay: string
	subscriptions: ReadonlyArray<FakeSubscription>
	/** Subscriptions one page holds, to make a listing span pages. */
	subscriptionsPageSize: number
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const FAKE_ACCOUNT = { id: "0123456789abcdef0123456789abcdef", name: "Example Account" }

export const makeFakeCloudflare = (overrides: Partial<FakeCloudflare> = {}): FakeCloudflare => ({
	accountsStatus: 200,
	accounts: [FAKE_ACCOUNT],
	billingStatus: 200,
	covered: true,
	usage: [],
	anchorDay: 1,
	oldestDay: "2000-01-01",
	subscriptions: [],
	subscriptionsPageSize: 50,
	cloudCost: true,
	urls: [],
	authorizations: [],
	...overrides,
})

/** One usage row of `day`, with the fields a real row carries that Maple reads. */
export const usageRow = (
	day: string,
	family: string,
	metric: string,
	cost: number,
	over: Partial<FakeUsageRow> = {},
): FakeUsageRow => ({
	ServiceName: metric,
	ServiceFamilyName: family,
	ChargePeriodStart: `${day}T00:00:00Z`,
	BillingCurrency: "USD",
	BilledCost: cost,
	EffectiveCost: cost,
	ListCost: cost,
	ConsumedQuantity: 1,
	ConsumedUnit: "",
	...over,
})

const DAY_MS = 86_400_000
const dayMs = (day: string) => DateTime.toEpochMillis(DateTime.makeUnsafe(`${day}T00:00:00Z`))

/** The day the billing period of `day` started: the newest anchor day at or before it. */
const periodStart = (day: string, anchorDay: number): string => {
	const anchor = Str.padStart(2, "0")(`${anchorDay}`)
	const sameMonth = `${Str.slice(0, 8)(day)}${anchor}`
	if (sameMonth <= day) return sameMonth
	const previous = DateTime.formatIsoDateUtc(
		DateTime.subtract(DateTime.makeUnsafe(`${Str.slice(0, 8)(day)}01T00:00:00Z`), { months: 1 }),
	)
	return `${Str.slice(0, 8)(previous)}${anchor}`
}

const envelope = (result: unknown, info: Record<string, unknown> = {}) =>
	Response.json({ success: true, errors: [], messages: [], result, result_info: info })

const refused = (status: number) =>
	Response.json(
		{ success: false, errors: [{ code: 10000, message: "Authentication error" }], result: null },
		{ status },
	)

const usageAnswer = (world: FakeCloudflare, params: URLSearchParams): Response => {
	const from = params.get("from") ?? ""
	const to = params.get("to") ?? ""
	// The real API refuses an empty range and one over 90 days.
	const days = (dayMs(to) - dayMs(from)) / DAY_MS
	if (!(days >= 1 && days <= 90)) return refused(400)
	if (typeof world.usage === "string") return new Response(world.usage, { status: 200 })
	return envelope(
		Arr.filter(world.usage, (row) => {
			const day = Str.slice(0, 10)(row.ChargePeriodStart)
			const start = periodStart(day, world.anchorDay)
			return start >= from && start < to && day < to && day >= world.oldestDay
		}),
	)
}

const subscriptionsAnswer = (world: FakeCloudflare, params: URLSearchParams): Response => {
	const page = Number(params.get("page") ?? "1")
	const size = world.subscriptionsPageSize
	return envelope(Arr.take(Arr.drop(world.subscriptions, (page - 1) * size), size), {
		page,
		total_pages: Math.max(1, Math.ceil(world.subscriptions.length / size)),
		total_count: world.subscriptions.length,
	})
}

const fetchStub =
	(world: FakeCloudflare): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		world.urls.push(`${url.pathname}${url.search}`)
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		if (Str.endsWith("/accounts")(url.pathname)) {
			return world.accountsStatus === 200
				? envelope(world.accounts, { total_count: world.accounts.length, total_pages: 1 })
				: refused(world.accountsStatus)
		}
		if (world.billingStatus !== 200) return refused(world.billingStatus)
		if (Str.endsWith("/billable-usage/info")(url.pathname)) {
			return envelope({ covered: world.covered, subscriptions: [] })
		}
		if (Str.endsWith("/billable-usage")(url.pathname)) return usageAnswer(world, url.searchParams)
		return subscriptionsAnswer(world, url.searchParams)
	}

/** Everything the Cloudflare cost services need, over the fake and a test database. */
export const fakeCloudflareDeps = (
	testDb: TestDb,
	world: FakeCloudflare,
	/** `MAPLE_INGEST_KEY_ENCRYPTION_KEY`, for a deployment whose secret key is unusable. */
	encryptionKey?: string,
) =>
	Layer.effect(CostConnectionStore, CostConnectionStore.make).pipe(
		Layer.provideMerge(
			Layer.mergeAll(
				FetchHttpClient.layer,
				Layer.succeed(OrganizationFeatureFlagsService, {
					flags: () =>
						Effect.sync(() => ({
							...DISABLED_ORGANIZATION_FEATURE_FLAGS,
							cloudCost: world.cloudCost,
						})),
				}),
				testDb.layer,
				Env.layer,
			),
		),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetchStub(world))),
		Layer.provide(fakeCostEnvConfig(encryptionKey)),
	)
