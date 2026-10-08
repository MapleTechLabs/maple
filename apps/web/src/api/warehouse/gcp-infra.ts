import { Effect, Schema } from "effect"
import { GCP_INFRA_SERVICE_IDS } from "@maple/domain/gcp-infra"
import { GcpInfraMetricsRequest, GcpInfraPresenceRequest } from "@maple/domain/http"
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

/** The services with a metric in the window. */
export const getGcpInfraPresence = Effect.fn("QueryEngine.getGcpInfraPresence")(function* ({
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
export const getGcpInfraMetrics = Effect.fn("QueryEngine.getGcpInfraMetrics")(function* ({
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
