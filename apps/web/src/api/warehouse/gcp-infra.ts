import { Effect, Schema } from "effect"
import { GCP_INFRA_SERVICE_IDS, GCP_INFRA_SOURCE_IDS } from "@maple/domain/gcp-infra"
import {
	GcpInfraMetricsRequest,
	GcpInfraPresenceRequest,
	GcpInfraTimeseriesRequest,
} from "@maple/domain/http"
import { MapleInternalAtomClient } from "@/lib/services/common/internal-atom-client"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "@/api/warehouse/effect-utils"

/** /infra/gcp data access over the `gcp.*` metrics the Google Cloud poller stores. */

const WindowInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})

const MetricsInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	service: Schema.Literals(GCP_INFRA_SERVICE_IDS),
})

const TimeseriesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	bucketSeconds: Schema.Number,
	source: Schema.Literals(GCP_INFRA_SOURCE_IDS),
	keys: Schema.Array(Schema.String),
})

/** The services with a metric in the window. */
const getGcpInfraPresence = Effect.fn("QueryEngine.getGcpInfraPresence")(function* ({
	data,
}: {
	data: (typeof WindowInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(WindowInputSchema, data, "getGcpInfraPresence")
	const result = yield* runWarehouseQuery("gcpInfraPresence", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.gcpInfraPresence({
				payload: new GcpInfraPresenceRequest(input),
			})
		}),
	)
	return { services: result.services }
})

/** One service's metrics: a point per workload, metric and label value. */
const getGcpInfraMetrics = Effect.fn("QueryEngine.getGcpInfraMetrics")(function* ({
	data,
}: {
	data: (typeof MetricsInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(MetricsInputSchema, data, "getGcpInfraMetrics")
	const result = yield* runWarehouseQuery("gcpInfraMetrics", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.gcpInfraMetrics({
				payload: new GcpInfraMetricsRequest(input),
			})
		}),
	)
	return { points: result.data }
})

/**
 * Every reporting service's metrics at once: what the summary band, the tabs and the
 * Infrastructure overview read. One presence probe, then one query per reporting service; a
 * service whose query fails is returned empty and `failed`, so the others still show.
 */
export const getGcpInfraFleet = Effect.fn("QueryEngine.getGcpInfraFleet")(function* ({
	data,
}: {
	data: (typeof WindowInputSchema)["Encoded"]
}) {
	const { services } = yield* getGcpInfraPresence({ data })
	return {
		services: yield* Effect.forEach(
			services,
			(service) =>
				getGcpInfraMetrics({ data: { ...data, service } }).pipe(
					Effect.map(({ points }) => ({ service, points, failed: false })),
					Effect.orElseSucceed(() => ({ service, points: [], failed: true })),
				),
			{ concurrency: "unbounded" },
		),
	}
})

/** One workload's metrics over time: a point per bucket, metric and label value. */
export const getGcpInfraTimeseries = Effect.fn("QueryEngine.getGcpInfraTimeseries")(function* ({
	data,
}: {
	data: (typeof TimeseriesInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getGcpInfraTimeseries")
	const result = yield* runWarehouseQuery("gcpInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalAtomClient
			return yield* client.queryEngine.gcpInfraTimeseries({
				payload: new GcpInfraTimeseriesRequest(input),
			})
		}),
	)
	return { points: result.data }
})
