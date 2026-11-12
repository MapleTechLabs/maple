// A fake PlanetScale invoice API for tests: invoices and their line items answered in pages from a
// mutable world, with every call recorded.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Effect, Layer, Array as Arr, Option, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"

export interface FakeInvoice {
	readonly id: string
	readonly billing_period_start: string
	readonly billing_period_end: string
	readonly paid: boolean
}

export interface FakeLineItem {
	readonly id: string
	readonly description: string | null
	readonly metric_name: string | null
	readonly subtotal: string
	readonly database_name: string | null
	readonly resource: {
		readonly type: string
		readonly name: string
		readonly created_at: string
		readonly deleted_at: string | null
	} | null
}

export interface FakePlanetScale {
	/** The organization the token can see. Any other answers 404. */
	organization: string
	/** The `Authorization` header of the live token. Any other answers 404, as PlanetScale does. */
	authorization: string
	/** Status of the invoice list. */
	invoicesStatus: number
	/** Status of every line-item read. */
	lineItemsStatus: number
	/** Newest first, as PlanetScale lists them; or raw text for a malformed answer. */
	invoices: ReadonlyArray<FakeInvoice> | string
	/** By invoice id; or raw text for a malformed answer. */
	lineItems: Readonly<Record<string, ReadonlyArray<FakeLineItem>>> | string
	/** The most items a page holds, whatever `per_page` asks for. */
	maxPerPage: number
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	/** The fetch itself fails with this, as when the network does. */
	networkError: string | null
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
	/** How each request said to treat a redirect. */
	readonly redirects: Array<string | undefined>
}

export const FAKE_PLANETSCALE_ORGANIZATION = "acme"
export const FAKE_PLANETSCALE_TOKEN_ID = "tokenid0123"
export const FAKE_PLANETSCALE_TOKEN = "pscale_tkn_example"

export const makeFakePlanetScale = (overrides: Partial<FakePlanetScale> = {}): FakePlanetScale => ({
	organization: FAKE_PLANETSCALE_ORGANIZATION,
	authorization: `${FAKE_PLANETSCALE_TOKEN_ID}:${FAKE_PLANETSCALE_TOKEN}`,
	invoicesStatus: 200,
	lineItemsStatus: 200,
	invoices: [],
	lineItems: {},
	maxPerPage: 100,
	cloudCost: true,
	networkError: null,
	urls: [],
	authorizations: [],
	redirects: [],
	...overrides,
})

/** The invoice of the calendar month `month` (`YYYY-MM`), which ends where `nextMonth` starts. */
export const fakeInvoice = (month: string, nextMonth: string, paid = true): FakeInvoice => ({
	id: `inv_${month}`,
	billing_period_start: `${month}-01T00:00:00.000Z`,
	billing_period_end: `${nextMonth}-01T00:00:00.000Z`,
	paid,
})

export const fakeLineItem = (overrides: Partial<FakeLineItem> = {}): FakeLineItem => ({
	id: "line_1",
	description: "PS-10-AWS-ARM for branch 'main'",
	metric_name: "PS_10_AWS_ARM",
	subtotal: "31.00",
	database_name: "orders",
	resource: { type: "Branch", name: "main", created_at: "2025-03-04T10:00:00.000Z", deleted_at: null },
	...overrides,
})

const refused = (status: number) =>
	status >= 300 && status < 400
		? new Response(null, { status, headers: { location: "https://elsewhere.test/invoices" } })
		: Response.json({ code: status === 404 ? "not_found" : `status_${status}` }, { status })

const page = (items: ReadonlyArray<unknown>, url: URL, maxPerPage: number) => {
	const perPage = Math.min(Number(url.searchParams.get("per_page") ?? "25"), maxPerPage)
	const current = Number(url.searchParams.get("page") ?? "1")
	const more = current * perPage < items.length
	return Response.json({
		type: "list",
		current_page: current,
		per_page: perPage,
		next_page: more ? current + 1 : null,
		next_page_url: more ? `${url.origin}${url.pathname}?page=${current + 1}` : null,
		prev_page: current > 1 ? current - 1 : null,
		prev_page_url: null,
		data: Arr.take(Arr.drop(items, (current - 1) * perPage), perPage),
	})
}

/** `fetch`, answered by the world. */
export const fakePlanetScaleFetch =
	(world: FakePlanetScale): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		const authorization = new Headers(init?.headers).get("authorization")
		world.urls.push(`${url.pathname}${url.search}`)
		world.authorizations.push(authorization)
		world.redirects.push(init?.redirect)
		if (world.networkError !== null) return Promise.reject(new TypeError(world.networkError))
		const base = `/v1/organizations/${world.organization}/invoices`
		if (authorization !== world.authorization || !Str.startsWith(base)(url.pathname)) return refused(404)
		if (url.pathname === base) {
			if (world.invoicesStatus !== 200) return refused(world.invoicesStatus)
			return typeof world.invoices === "string"
				? new Response(world.invoices, { status: 200 })
				: page(world.invoices, url, world.maxPerPage)
		}
		if (world.lineItemsStatus !== 200) return refused(world.lineItemsStatus)
		if (typeof world.lineItems === "string") return new Response(world.lineItems, { status: 200 })
		const invoiceId = Str.replace("/line-items", "")(Str.slice(base.length + 1)(url.pathname))
		return Option.match(Option.fromNullishOr(world.lineItems[invoiceId]), {
			onNone: () => refused(404),
			onSome: (items) => page(items, url, world.maxPerPage),
		})
	}

/** Everything the PlanetScale cost services need, over the fake and a test database. */
export const fakePlanetScaleDeps = (
	testDb: TestDb,
	world: FakePlanetScale,
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
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakePlanetScaleFetch(world))),
		Layer.provide(fakeCostEnvConfig(encryptionKey)),
	)
