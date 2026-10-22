import { Clock, Effect, Schema } from "effect"
import {
	SupabaseInfraProjectTimeseriesRequest,
	SupabaseLogIssuesRequest,
	SupabaseProjectWindowRequest,
} from "@maple/domain/http"
import { SupabaseProjectRef } from "@maple/domain/primitives"
import { MapleInternalHttp } from "./warehouse-services"
import { InfraWindowInput, decodeInput, resolveInfraWindow, runWarehouseQuery } from "./effect-utils"

/**
 * /infra/supabase insights: edge API traffic and recurring log issues (from the polled Supabase
 * logs), the org's services calling a project (from traces), and the polled advisors and top
 * queries. Responses are the domain classes as the API sends them. Windows default to 6 hours.
 */

const ProjectInput = Schema.Struct({ ...InfraWindowInput.fields, projectRef: SupabaseProjectRef })
const BucketedProjectInput = Schema.Struct({ ...ProjectInput.fields, bucketSeconds: Schema.Finite })
const LogIssuesInput = Schema.Struct({
	...InfraWindowInput.fields,
	projectRef: Schema.optional(SupabaseProjectRef),
})
const InsightsInput = Schema.Struct({ projectRef: SupabaseProjectRef })

export type SupabaseProjectInput = (typeof ProjectInput)["Encoded"]
export type SupabaseBucketedProjectInput = (typeof BucketedProjectInput)["Encoded"]
export type SupabaseLogIssuesInput = (typeof LogIssuesInput)["Encoded"]
export type SupabaseInsightsInput = (typeof InsightsInput)["Encoded"]

/** Edge requests by status class per bucket, plus requests, 5xx rate and p95 upstream ms. */
export const getSupabaseApiTraffic = Effect.fn("QueryEngine.getSupabaseApiTraffic")(function* ({
	data,
}: {
	data: SupabaseBucketedProjectInput
}) {
	const input = yield* decodeInput(BucketedProjectInput, data, "getSupabaseApiTraffic")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("supabaseApiTraffic", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseApiTraffic({
				payload: new SupabaseInfraProjectTimeseriesRequest({
					...range,
					bucketSeconds: input.bucketSeconds,
					projectRef: input.projectRef,
				}),
			})
		}),
	)
})

/** The ten busiest (method, path) pairs. */
export const getSupabaseApiTopPaths = Effect.fn("QueryEngine.getSupabaseApiTopPaths")(function* ({
	data,
}: {
	data: SupabaseProjectInput
}) {
	const input = yield* decodeInput(ProjectInput, data, "getSupabaseApiTopPaths")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("supabaseApiTopPaths", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseApiTopPaths({
				payload: new SupabaseProjectWindowRequest({ ...range, projectRef: input.projectRef }),
			})
		}),
	)
})

/** The org's services calling the project, each with its product mix and a call sparkline. */
export const getSupabaseProjectCallers = Effect.fn("QueryEngine.getSupabaseProjectCallers")(function* ({
	data,
}: {
	data: SupabaseBucketedProjectInput
}) {
	const input = yield* decodeInput(BucketedProjectInput, data, "getSupabaseProjectCallers")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("supabaseProjectCallers", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseProjectCallers({
				payload: new SupabaseInfraProjectTimeseriesRequest({
					...range,
					bucketSeconds: input.bucketSeconds,
					projectRef: input.projectRef,
				}),
			})
		}),
	)
})

/** Recurring WARN+ log messages of one project, or of every project when `projectRef` is omitted. */
export const getSupabaseLogIssues = Effect.fn("QueryEngine.getSupabaseLogIssues")(function* ({
	data,
}: {
	data: SupabaseLogIssuesInput
}) {
	const input = yield* decodeInput(LogIssuesInput, data, "getSupabaseLogIssues")
	const range = resolveInfraWindow(input, yield* Clock.currentTimeMillis)
	return yield* runWarehouseQuery("supabaseLogIssues", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.supabaseLogIssues({
				payload: new SupabaseLogIssuesRequest(
					input.projectRef === undefined ? range : { ...range, projectRef: input.projectRef },
				),
			})
		}),
	)
})

/** The project's polled advisors (grouped by level) and top statements. */
export const getSupabaseProjectInsights = Effect.fn("Integrations.getSupabaseProjectInsights")(function* ({
	data,
}: {
	data: SupabaseInsightsInput
}) {
	const input = yield* decodeInput(InsightsInput, data, "getSupabaseProjectInsights")
	return yield* runWarehouseQuery("supabaseProjectInsights", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.integrations.supabaseProjectInsights({ params: { ref: input.projectRef } })
		}),
	)
})
