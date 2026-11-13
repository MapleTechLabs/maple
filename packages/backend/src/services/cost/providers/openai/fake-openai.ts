// A fake OpenAI for tests: the organization costs endpoint answered from a mutable world, with every
// call recorded. Like the real API it answers a bucket for every day of the range, empty or not,
// sums costs by the `group_by` fields, and pages buckets with an opaque cursor.
import { DISABLED_ORGANIZATION_FEATURE_FLAGS } from "@maple/domain/organization-feature-flags"
import { DateTime, Effect, Layer, Array as Arr, Record as Rec, String as Str } from "effect"
import { FetchHttpClient } from "effect/http"
import { Env } from "@maple/backend/platform/Env"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { TestDb } from "@maple/backend/testing/test-pglite"
import { CostConnectionStore } from "../../CostConnectionStore"
import { fakeCostEnvConfig } from "../fake-cost-env"

export const FAKE_OPENAI_ORG = "org-GLHrIv00VVN9dEQC2b4wsBkf"

/** One charge on one UTC day. */
export interface FakeCost {
	readonly day: string
	readonly value: number
	readonly lineItem?: string | null
	readonly projectId?: string | null
	readonly quantity?: number | null
	readonly unit?: string | null
	/** The organization the charge is reported under; the world's own when left out. */
	readonly organizationId?: string
}

export interface FakeOpenAi {
	/** Status of the costs call. */
	status: number
	/** Every charge the organization has, or raw text for a malformed answer. */
	costs: ReadonlyArray<FakeCost> | string
	organizationId: string
	/** Buckets one page holds at most, below what the request's `limit` asks for. */
	pageSize: number
	/** Answers `has_more` with no `next_page`. */
	dropCursor: boolean
	/** Answers `has_more` with the cursor it was asked with, so reading on repeats the page. */
	repeatCursor: boolean
	/** The `openai-organization` header every answer carries; none when undefined. */
	organizationHeader: string | undefined
	/** Whether the org is in the `cloudCost` rollout. */
	cloudCost: boolean
	readonly urls: Array<string>
	readonly authorizations: Array<string | null>
}

export const makeFakeOpenAi = (overrides: Partial<FakeOpenAi> = {}): FakeOpenAi => ({
	status: 200,
	costs: [],
	organizationId: FAKE_OPENAI_ORG,
	pageSize: 180,
	dropCursor: false,
	repeatCursor: false,
	organizationHeader: undefined,
	cloudCost: true,
	urls: [],
	authorizations: [],
	...overrides,
})

const DAY_SECONDS = 86_400
const dayOf = (seconds: number) => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(seconds * 1000))

const keyOf = (cost: FakeCost, world: FakeOpenAi, groupBy: ReadonlyArray<string>) =>
	Arr.join(
		[
			cost.organizationId ?? world.organizationId,
			Arr.contains(groupBy, "project_id") ? (cost.projectId ?? "") : "",
			Arr.contains(groupBy, "line_item") ? (cost.lineItem ?? "") : "",
		],
		"\u0000",
	)

/** One bucket's results: costs summed per group, the fields not grouped by left null. */
const resultsOf = (world: FakeOpenAi, costs: ReadonlyArray<FakeCost>, groupBy: ReadonlyArray<string>) =>
	Arr.map(Rec.values(Arr.groupBy(costs, (cost) => keyOf(cost, world, groupBy))), (group) => {
		const first = Arr.headNonEmpty(group)
		const grouped = (field: string, value: string | null | undefined) =>
			Arr.contains(groupBy, field) ? (value ?? null) : null
		return {
			object: "organization.costs.result",
			amount: { value: Arr.reduce(group, 0, (total, cost) => total + cost.value), currency: "usd" },
			line_item: grouped("line_item", first.lineItem),
			project_id: grouped("project_id", first.projectId),
			organization_id: first.organizationId ?? world.organizationId,
			quantity: first.quantity ?? null,
			quantity_unit: first.unit ?? null,
		}
	})

const costsAnswer = (world: FakeOpenAi, costs: ReadonlyArray<FakeCost>, params: URLSearchParams) => {
	const start = Number(params.get("start_time") ?? "0")
	const end = Number(params.get("end_time") ?? `${start + DAY_SECONDS}`)
	// Only the bracketed name groups, so a request that sends another gets ungrouped results.
	const groupBy = params.getAll("group_by[]")
	const size = Math.min(world.pageSize, Number(params.get("limit") ?? "7"))
	const offset = Number(Str.replace("page_", "")(params.get("page") ?? "page_0"))
	const days = Math.max(0, Math.ceil((end - start) / DAY_SECONDS))
	const buckets = Arr.map(Arr.take(Arr.drop(Arr.range(0, days - 1), offset), size), (index) => {
		const startTime = start + index * DAY_SECONDS
		return {
			object: "bucket",
			start_time: startTime,
			end_time: startTime + DAY_SECONDS,
			results: resultsOf(
				world,
				Arr.filter(costs, (cost) => cost.day === dayOf(startTime)),
				groupBy,
			),
		}
	})
	const next = offset + size
	const hasMore = days > 0 && next < days
	return Response.json({
		object: "page",
		data: days === 0 ? [] : buckets,
		has_more: hasMore,
		next_page:
			hasMore && !world.dropCursor
				? world.repeatCursor
					? (params.get("page") ?? "page_0")
					: `page_${next}`
				: null,
	})
}

const fetchStub =
	(world: FakeOpenAi): typeof fetch =>
	async (input: string | URL | Request, init?: RequestInit) => {
		const href = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
		const url = new URL(href)
		world.urls.push(`${url.pathname}${url.search}`)
		world.authorizations.push(new Headers(init?.headers).get("authorization"))
		if (world.status !== 200) {
			return Response.json(
				{ error: { message: "Request refused", type: "invalid_request_error" } },
				{ status: world.status },
			)
		}
		if (typeof world.costs === "string") return new Response(world.costs, { status: 200 })
		const answer = costsAnswer(world, world.costs, url.searchParams)
		if (world.organizationHeader !== undefined) {
			answer.headers.set("openai-organization", world.organizationHeader)
		}
		return answer
	}

/** Everything the OpenAI cost services need, over the fake and a test database. */
export const fakeOpenAiDeps = (testDb: TestDb, world: FakeOpenAi) =>
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
