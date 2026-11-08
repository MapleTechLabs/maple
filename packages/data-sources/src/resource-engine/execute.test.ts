import { describe, expect, it } from "@effect/vitest"
import { Array as Arr, Effect, Layer } from "effect"
import { HttpClient } from "effect/http"
import type { ExternalQuery } from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../limits"
import type { QueryRequest } from "../port"
import { catalogEntryOf, prepareResourceQuery } from "./index"
import type { PageRequest, ResourceDefinition, ResourceRow } from "./types"

const DAY_MS = 86_400_000
const END_MS = Date.UTC(2026, 10, 8)

/** `rows` rows, each `kind` "a", served in pages of 10 with no total endpoint. */
const resource = (rows: number) => {
	const pages: Array<PageRequest> = []
	const all: ReadonlyArray<ResourceRow> = Arr.makeBy(rows, (i) => ({
		id: `r${i}`,
		kind: "a",
		created_at: END_MS - DAY_MS + i,
	}))
	const def: ResourceDefinition = {
		name: "things",
		note: "Test rows.",
		noun: { one: "thing", many: "things" },
		timeField: "created_at",
		pageSize: 10,
		fields: [
			{
				name: "id",
				type: "string",
				capabilities: { filter: "client", sort: false, group: false, measure: true },
				serverOps: [],
			},
			{
				name: "kind",
				type: "string",
				capabilities: { filter: "client", sort: false, group: true, measure: false },
				serverOps: [],
			},
			{
				name: "created_at",
				type: "timestamp",
				capabilities: { filter: "client", sort: false, group: false, measure: false },
				serverOps: [],
			},
		],
		fetchPage: (request) =>
			Effect.sync(() => {
				pages.push(request)
				return Arr.take(Arr.drop(all, request.offset), request.limit)
			}),
	}
	return { def, pages }
}

const request = (granularitySeconds: number, days = 1): QueryRequest => ({
	window: { startMs: END_MS - days * DAY_MS, endMs: END_MS, granularitySeconds },
	limits: DEFAULT_LIMITS.interactive,
	workload: "interactive",
	redactPii: false,
})

const noNetwork = Layer.succeed(
	HttpClient.HttpClient,
	HttpClient.make(() => Effect.die("no network in engine tests")),
)

const run = (def: ResourceDefinition, query: ExternalQuery, req: QueryRequest) =>
	Effect.gen(function* () {
		const catalog = { entries: [catalogEntryOf(def)], examples: [], truncated: false }
		const prepared = yield* prepareResourceQuery([def], query, req, catalog)
		return yield* prepared.run({ spend: () => Effect.void })
	}).pipe(Effect.provide(noNetwork))

const BY_KIND = {
	_tag: "resource",
	resource: "things",
	measure: { fn: "count" },
	groupBy: { field: "kind" },
} as const

// A scan budget of two pages of 10.
const TWO_PAGES = { ...request(3600), limits: { ...DEFAULT_LIMITS.interactive, maxScanRows: 20 } }

describe("resource engine", () => {
	it.effect("refuses a time grid over the bucket limit before building it", () =>
		Effect.gen(function* () {
			const { def, pages } = resource(5)
			const query = {
				_tag: "resource",
				resource: "things",
				measure: { fn: "count" },
				groupBy: { time: "created_at" },
			} as const
			const error = yield* Effect.flip(run(def, query, request(1, 90)))
			expect(error._tag).toBe("@maple/data-sources/Limit")
			expect(error.message).toContain("7776000 time buckets")
			expect(pages).toHaveLength(0)
		}),
	)

	it.effect("reads one row past a full last page to prove the end when there is no total", () =>
		Effect.gen(function* () {
			const { def, pages } = resource(20)
			const table = yield* run(def, BY_KIND, TWO_PAGES)
			expect(table.rows).toEqual([{ kind: "a", count: 20 }])
			expect(Arr.map(pages, (p) => [p.offset, p.limit])).toEqual([
				[0, 10],
				[10, 10],
				[20, 1],
			])
		}),
	)

	it.effect("still refuses when the probe finds more rows than the scan budget read", () =>
		Effect.gen(function* () {
			const { def } = resource(21)
			const error = yield* Effect.flip(run(def, BY_KIND, TWO_PAGES))
			expect(error.message).toContain("without reaching the end")
		}),
	)
})
