// A fake PlanetScale for tests: the OAuth token endpoint, and the invoice API answered in pages
// from a mutable world, with every call recorded.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { type OrgId, UserId } from "@maple/domain/http"
import { Effect, Layer, Schema, Array as Arr, Option, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { EnvTestLive } from "@maple/backend/testing/env-test-support"
import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { executeSql, insertTestSource, type TestDb } from "@maple/backend/testing/test-pglite"
import { fakeCostEnvConfig } from "../fake-cost-env"

export interface FakeInvoice {
	readonly id: string
	readonly billing_period_start: string
	readonly billing_period_end: string
	readonly paid: boolean
}

/** The scopes PlanetScale reports for a grant made with the invoice scope, and for one made before it. */
export const FAKE_SCOPES_WITH_INVOICES = "read_organizations read_organization read_invoices read_databases"
export const FAKE_SCOPES_WITHOUT_INVOICES = "read_organizations read_organization read_databases"

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
	/** The organization the grant can see. Any other answers 404. */
	organization: string
	/** The `Authorization` header of the live access token. Any other answers 401. */
	authorization: string
	/** The access token the token endpoint issues, at the exchange and at every refresh. */
	issuedAccessToken: string
	/** The scopes the token endpoint reports for the grant; null when it reports none. */
	grantedScope: string | null
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
	/** Runs before an invoice request is answered: what another writer does while a read is in flight. */
	beforeAnswer: (() => Promise<void>) | null
	/** The invoice API's calls: the connect flow's own reads are left out. */
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
	/** How each request said to treat a redirect. */
	readonly redirects: Array<string | undefined>
	/** The `grant_type` of each call to the token endpoint. */
	readonly tokenRequests: Array<string>
}

export const FAKE_PLANETSCALE_ORGANIZATION = "acme"
export const FAKE_PLANETSCALE_ACCESS_TOKEN = "ps-access-token"
export const FAKE_PLANETSCALE_API_URL = "https://api.planetscale.com"

export const makeFakePlanetScale = (overrides: Partial<FakePlanetScale> = {}): FakePlanetScale => ({
	organization: FAKE_PLANETSCALE_ORGANIZATION,
	authorization: `Bearer ${FAKE_PLANETSCALE_ACCESS_TOKEN}`,
	issuedAccessToken: FAKE_PLANETSCALE_ACCESS_TOKEN,
	grantedScope: FAKE_SCOPES_WITH_INVOICES,
	invoicesStatus: 200,
	lineItemsStatus: 200,
	invoices: [],
	lineItems: {},
	maxPerPage: 100,
	cloudCost: true,
	networkError: null,
	beforeAnswer: null,
	urls: [],
	authorizations: [],
	redirects: [],
	tokenRequests: [],
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
		if (Str.endsWith("/oauth/token")(url.pathname)) {
			const body = init?.body
			// The form arrives as text or as its bytes.
			const form = new URLSearchParams(
				typeof body === "string"
					? body
					: body instanceof Uint8Array
						? new TextDecoder().decode(body)
						: "",
			)
			world.tokenRequests.push(form.get("grant_type") ?? "")
			return Response.json({
				access_token: world.issuedAccessToken,
				refresh_token: "ps-refresh-token",
				token_type: "Bearer",
				expires_in: 3600,
				...(world.grantedScope === null ? undefined : { scope: world.grantedScope }),
			})
		}
		// What the connect flow reads to name the grant: not part of a cost read.
		if (url.pathname === "/v1/user") return Response.json({ id: "psuser_1", email: "dev@acme.test" })
		if (url.pathname === "/v1/organizations") {
			return Response.json({ data: [{ id: "psorg_1", name: world.organization }] })
		}
		world.urls.push(`${url.pathname}${url.search}`)
		world.authorizations.push(authorization)
		world.redirects.push(init?.redirect)
		if (world.networkError !== null) return Promise.reject(new TypeError(world.networkError))
		await world.beforeAnswer?.()
		if (authorization !== world.authorization) return refused(401)
		const base = `/v1/organizations/${world.organization}/invoices`
		if (!Str.startsWith(base)(url.pathname)) return refused(404)
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
export const fakePlanetScaleDeps = (testDb: TestDb, world: FakePlanetScale) =>
	Layer.effect(PlanetScaleOAuthService, PlanetScaleOAuthService.make).pipe(
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
				EnvTestLive,
			),
		),
		Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fakePlanetScaleFetch(world))),
		Layer.provide(
			fakeCostEnvConfig(undefined, {
				PLANETSCALE_OAUTH_CLIENT_ID: "ps-client-id",
				PLANETSCALE_OAUTH_CLIENT_SECRET: "ps-client-secret",
			}),
		),
	)

const FAKE_USER = Schema.decodeSync(UserId)("user_cost")

/** Runs the real OAuth start and callback exchange against the fake, so a grant is stored for the org. */
export const authorizePlanetScale = (orgId: OrgId) =>
	Effect.gen(function* () {
		const oauth = yield* PlanetScaleOAuthService
		const { state } = yield* oauth.startConnect(orgId, FAKE_USER, {
			callbackUrl: "https://api.example.com/api/integrations/planetscale/callback",
		})
		yield* oauth.completeConnect("auth-code", state, { orgId, userId: FAKE_USER })
	})

/** The org's connection, bound to `organization`, as the integration stores it. Answers its id. */
export const bindPlanetScale = (testDb: TestDb, orgId: OrgId, organization: string, id = "psconn_a") =>
	Effect.promise(async () => {
		const sourceId = await insertTestSource(testDb, {
			orgId,
			platform: "planetscale",
			name: organization,
		})
		await executeSql(
			testDb,
			`INSERT INTO planetscale_connections
			   (id, org_id, source_id, ps_organization, connected_by_user_id, created_at, updated_at)
			 VALUES ($1, $2, $3, $4, 'user_cost', now(), now())`,
			[id, orgId, sourceId, organization],
		)
		return id
	})

/** A stored grant and a bound connection: an org that has connected PlanetScale. Answers the connection's id. */
export const connectPlanetScale = (testDb: TestDb, world: FakePlanetScale, orgId: OrgId) =>
	Effect.andThen(authorizePlanetScale(orgId), bindPlanetScale(testDb, orgId, world.organization))
