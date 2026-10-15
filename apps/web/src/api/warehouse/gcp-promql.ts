import { Effect, Schema } from "effect"
import { GcpPromQlRangeRequest } from "@maple/domain/http"
import { promQlRangeInput, promQlWidgetData } from "@maple/query-engine"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import {
	WarehouseDateTimeString,
	decodeInput,
	invalidWarehouseInput,
	runWarehouseQuery,
} from "@/api/warehouse/effect-utils"

// Live Google Cloud Monitoring reads through the API's PromQL proxy (widget data source
// `gcp_promql`). Nothing comes from the warehouse; the API edge-caches each answer.

const PromQlChartInput = Schema.Struct({
	promql: Schema.String,
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
	// A bad project id or an over-long query is the author's to fix, not a support case.
	const payload = yield* Schema.decodeUnknownEffect(GcpPromQlRangeRequest)(
		promQlRangeInput(input, input),
	).pipe(Effect.catch((error) => invalidWarehouseInput("gcpPromQlRangeRequest", error.message)))
	const result = yield* runWarehouseQuery("gcpPromQlQueryRange", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.integrations.gcpPromQlQueryRange({ payload })
		}),
	)
	return promQlWidgetData(result, input.legend, true)
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
export const getGcpMetricDescriptor = Effect.fn("Integrations.getGcpMetricDescriptor")(function* (
	type: string,
) {
	return yield* runWarehouseQuery("gcpMetricDescribe", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.integrations.gcpMetricDescribe({ query: { type } })
		}),
	)
})
