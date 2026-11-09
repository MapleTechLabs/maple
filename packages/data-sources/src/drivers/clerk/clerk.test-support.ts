import { Array as Arr, Effect, Redacted, Schema } from "effect"
import {
	DataSourceRateLimitedError,
	ExternalDataSourceId,
	type ExternalQuery,
	type SourceCatalog,
} from "@maple/domain/data-sources"
import { DEFAULT_LIMITS } from "../../limits"
import type { DriverConnection, QueryContext, QueryRequest } from "../../port"
import { CLERK_EXAMPLES, clerkDriver, clerkResources } from "./index"
import { catalogEntryOf } from "../../resource-engine"
import { type FakeClerk, fakeClerkHttpClient } from "./testing"

export const SECRET = "sk_test_FakeSecretKey0123456789"
export const DAY_MS = 86_400_000
export const END_MS = Date.UTC(2026, 10, 8)
export const START_MS = END_MS - 30 * DAY_MS

export const connectionFor = (instance: "production" | "development"): DriverConnection => ({
	sourceId: Schema.decodeSync(ExternalDataSourceId)("00000000-0000-4000-8000-000000000001"),
	config: { _tag: "clerk", instance },
	secret: Redacted.make(SECRET),
})
export const connection = connectionFor("production")
export const devConnection = connectionFor("development")

export const CATALOG: SourceCatalog = {
	entries: Arr.map(clerkResources(Redacted.make("")), catalogEntryOf),
	examples: CLERK_EXAMPLES,
	truncated: false,
}

export const request = (overrides: Partial<QueryRequest> = {}): QueryRequest => ({
	window: { startMs: START_MS, endMs: END_MS, granularitySeconds: 86_400 },
	limits: DEFAULT_LIMITS.interactive,
	workload: "interactive",
	redactPii: false,
	...overrides,
})

export const unlimited: QueryContext = { spend: () => Effect.void }

/** A budget of `units` calls; `spent` records every grant. */
export const budget = (units: number) => {
	const state = { left: units, spent: 0 }
	const context: QueryContext = {
		spend: (calls) =>
			calls > state.left
				? Effect.fail(
						new DataSourceRateLimitedError({
							message: "Maple's share is used up",
							retryAfterSeconds: 10,
						}),
					)
				: Effect.sync(() => {
						state.left -= calls
						state.spent += calls
					}),
	}
	return { state, context }
}

export const prepare = (query: ExternalQuery, req: QueryRequest = request(), conn = connection) =>
	clerkDriver.prepare(conn, query, req, CATALOG)

export const run = (
	fake: FakeClerk,
	query: ExternalQuery,
	req: QueryRequest = request(),
	context = unlimited,
	conn = connection,
) =>
	Effect.gen(function* () {
		const prepared = yield* prepare(query, req, conn)
		const table = yield* prepared.run(context)
		return { summary: prepared.summary, table }
	}).pipe(
		// oxlint-disable-next-line effecttsgo/strict-effect-provide -- each test run is an entry point
		Effect.provide(fakeClerkHttpClient(fake)),
	)
