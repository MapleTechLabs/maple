// A fake Anthropic Admin API for tests: the organization and cost report calls answered from a
// mutable world, with every call recorded. The cost report pages its buckets by `limit`.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { addDays } from "../../sync-plan"
import { fakeCostEnvConfig } from "../fake-cost-env"
import type { CostBucket, CostResult } from "./anthropic-cost-api"

export type FakeCostResult = typeof CostResult.Encoded
export type FakeCostBucket = typeof CostBucket.Encoded

export interface FakeAnthropic {
	/** Status of `GET /v1/organizations/me`. */
	meStatus: number
	organization: { readonly id: string; readonly name: string }
	/** Status of the cost report. */
	costStatus: number
	/** Every daily bucket the organization has, oldest first, or raw text for a malformed answer. */
	buckets: ReadonlyArray<FakeCostBucket> | string
	/** A report that always says there is another page. */
	endless: boolean
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	readonly urls: Array<string>
	/** The `x-api-key` and `anthropic-version` of each call. */
	readonly headers: Array<readonly [string | null, string | null]>
}

export const FAKE_ORGANIZATION = { id: "4f2b1c9e-0a7d-4c3b-9e5f-1a2b3c4d5e6f", name: "Acme" }

export const makeFakeAnthropic = (overrides: Partial<FakeAnthropic> = {}): FakeAnthropic => ({
	meStatus: 200,
	organization: FAKE_ORGANIZATION,
	costStatus: 200,
	buckets: [],
	endless: false,
	cloudCost: true,
	urls: [],
	headers: [],
	...overrides,
})

/** One cost line as the API answers it: a model's input tokens unless `over` says otherwise. */
export const costResult = (amount: string, over: Partial<FakeCostResult> = {}): FakeCostResult => ({
	amount,
	currency: "USD",
	cost_type: "tokens",
	description: "Claude Opus 5.5 Usage - Input Tokens",
	model: "claude-opus-5-5",
	token_type: "uncached_input_tokens",
	service_tier: "standard",
	context_window: "0-200k",
	speed: null,
	inference_geo: null,
	workspace_id: "wrkspc_01",
	...over,
})

/** The bucket of `day`. */
export const costBucket = (day: string, results: ReadonlyArray<FakeCostResult>): FakeCostBucket => ({
	starting_at: `${day}T00:00:00Z`,
	ending_at: `${addDays(day, 1)}T00:00:00Z`,
	results,
})

const refused = (status: number) =>
	Response.json(
		{ type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } },
		{ status },
	)

const costAnswer = (world: FakeAnthropic, params: URLSearchParams): Response => {
	if (typeof world.buckets === "string") return new Response(world.buckets, { status: 200 })
	const from = params.get("starting_at") ?? ""
	const to = params.get("ending_at") ?? ""
	const limit = Number(params.get("limit") ?? "7")
	// The cursor is opaque to callers; here it is the index of the page's first bucket.
	const offset = Number(Str.slice(5)(params.get("page") ?? "page_0"))
	const held = Arr.filter(world.buckets, (bucket) => bucket.starting_at >= from && bucket.ending_at <= to)
	const data = Arr.take(Arr.drop(held, offset), limit)
	const hasMore = world.endless || offset + limit < held.length
	return Response.json({
		data,
		has_more: hasMore,
		next_page: hasMore ? `page_${offset + limit}` : null,
	})
}

const fetchStub =
	(world: FakeAnthropic): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		const headers = new Headers(init?.headers)
		world.urls.push(`${url.pathname}${url.search}`)
		world.headers.push([headers.get("x-api-key"), headers.get("anthropic-version")])
		if (url.pathname === "/v1/organizations/me") {
			return world.meStatus === 200
				? Response.json({ ...world.organization, type: "organization" })
				: refused(world.meStatus)
		}
		if (world.costStatus !== 200) return refused(world.costStatus)
		return costAnswer(world, url.searchParams)
	}

/** Everything the Anthropic cost services need, over the fake and a test database. */
export const fakeAnthropicDeps = (testDb: TestDb, world: FakeAnthropic) =>
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
		Layer.provide(fakeCostEnvConfig()),
	)
