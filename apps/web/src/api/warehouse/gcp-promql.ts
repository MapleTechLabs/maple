import { Effect, Schema } from "effect"
import { GcpPromQlRangeRequest } from "@maple/domain/http"
import { promQlChartRows, promQlFailureNotice, promQlStepSeconds } from "@maple/query-engine"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

// Live Google Cloud Monitoring reads through the API's PromQL proxy (widget data source
// `gcp_promql`). Nothing comes from the warehouse; the API edge-caches each answer.

const PromQlChartInput = Schema.Struct({
	query: Schema.String,
	projects: Schema.optional(Schema.Array(Schema.String)),
	legend: Schema.optional(Schema.String),
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})

/** A PromQL range query as chart rows, plus a one-line notice when some projects could not be read. */
export const getGcpPromQlChart = Effect.fn("Integrations.getGcpPromQlChart")(function* ({
	data,
}: {
	data: (typeof PromQlChartInput)["Encoded"]
}) {
	const input = yield* decodeInput(PromQlChartInput, data, "getGcpPromQlChart")
	const payload = yield* decodeInput(
		GcpPromQlRangeRequest,
		{
			query: input.query.trim(),
			startTime: input.startTime,
			endTime: input.endTime,
			stepSeconds: promQlStepSeconds(input.startTime, input.endTime),
			...(input.projects === undefined ? undefined : { projects: input.projects }),
		},
		"getGcpPromQlChart",
	)
	const result = yield* runWarehouseQuery("gcpPromQlQueryRange", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.integrations.gcpPromQlQueryRange({ payload })
		}),
	)
	const notice = promQlFailureNotice(result.failures, true)
	return {
		data: promQlChartRows(result.series, result.projects.length, input.legend),
		...(notice === undefined ? undefined : { notice }),
	}
})

/** Metric names containing `search`, for the PromQL editor's metric picker. */
export const getGcpMetricSearch = Effect.fn("Integrations.getGcpMetricSearch")(function* ({
	data,
}: {
	data: { readonly search: string }
}) {
	return yield* runWarehouseQuery("gcpMetricSearch", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.integrations.gcpMetricSearch({ query: { search: data.search, limit: 50 } })
		}),
	)
})

/** What a starter query needs to know about a metric. */
export const getGcpMetricDescriptor = (type: string) =>
	runWarehouseQuery("gcpMetricDescribe", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.integrations.gcpMetricDescribe({ query: { type } })
		}),
	)
