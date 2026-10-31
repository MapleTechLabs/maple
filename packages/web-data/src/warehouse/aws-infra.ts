import { Effect, Schema } from "effect"
import { AWS_INFRA_KIND_IDS } from "@maple/domain/aws-infra"
import {
	AwsInfraMetricsRequest,
	AwsInfraPresenceRequest,
	AwsInfraSparklinesRequest,
	AwsInfraTimeseriesRequest,
} from "@maple/domain/http"
import { MapleInternalHttp } from "./warehouse-services"
import { WarehouseDateTimeString, decodeInput, runWarehouseQuery } from "./effect-utils"

/** /infra/aws data access over the `aws.*` metrics the CloudWatch metric stream sends. */

const WindowInputSchema = Schema.Struct({
	startTime: WarehouseDateTimeString,
	endTime: WarehouseDateTimeString,
})

const Kind = Schema.Literals(AWS_INFRA_KIND_IDS)

const SparklinesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	bucketSeconds: Schema.Number,
	kinds: Schema.Array(Kind),
})

const TimeseriesInputSchema = Schema.Struct({
	...WindowInputSchema.fields,
	bucketSeconds: Schema.Number,
	kind: Kind,
	keys: Schema.Array(Schema.String),
})

const getAwsInfraPresence = Effect.fn("QueryEngine.getAwsInfraPresence")(function* (
	input: (typeof WindowInputSchema)["Type"],
) {
	const result = yield* runWarehouseQuery("awsInfraPresence", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.awsInfraPresence({ payload: new AwsInfraPresenceRequest(input) })
		}),
	)
	return result.kinds
})

/**
 * Every reporting kind's metrics at once: one presence probe, then one query per reporting kind.
 * A kind whose query fails is returned empty and `failed`, so the others still show.
 */
export const getAwsInfraFleet = Effect.fn("QueryEngine.getAwsInfraFleet")(function* ({
	data,
}: {
	data: (typeof WindowInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(WindowInputSchema, data, "getAwsInfraFleet")
	const kinds = yield* getAwsInfraPresence(input)
	return {
		kinds: yield* Effect.forEach(
			kinds,
			(kind) =>
				runWarehouseQuery("awsInfraMetrics", () =>
					Effect.gen(function* () {
						const client = yield* MapleInternalHttp
						return yield* client.queryEngine.awsInfraMetrics({
							payload: new AwsInfraMetricsRequest({ ...input, kind }),
						})
					}),
				).pipe(
					Effect.map((result) => ({ kind, points: result.data, failed: false })),
					Effect.orElseSucceed(() => ({ kind, points: [], failed: true })),
				),
			{ concurrency: "unbounded" },
		),
	}
})

/** The row sparklines of the listed kinds; a kind whose query fails draws none. */
export const getAwsInfraSparklines = Effect.fn("QueryEngine.getAwsInfraSparklines")(function* ({
	data,
}: {
	data: (typeof SparklinesInputSchema)["Encoded"]
}) {
	const { kinds, ...input } = yield* decodeInput(SparklinesInputSchema, data, "getAwsInfraSparklines")
	return {
		kinds: yield* Effect.forEach(
			kinds,
			(kind) =>
				runWarehouseQuery("awsInfraSparklines", () =>
					Effect.gen(function* () {
						const client = yield* MapleInternalHttp
						return yield* client.queryEngine.awsInfraSparklines({
							payload: new AwsInfraSparklinesRequest({ ...input, kind }),
						})
					}),
				).pipe(
					Effect.map((result) => ({ kind, points: result.data })),
					Effect.orElseSucceed(() => ({ kind, points: [] })),
				),
			{ concurrency: "unbounded" },
		),
	}
})

/** One resource's metrics over time: a point per bucket and metric. */
export const getAwsInfraTimeseries = Effect.fn("QueryEngine.getAwsInfraTimeseries")(function* ({
	data,
}: {
	data: (typeof TimeseriesInputSchema)["Encoded"]
}) {
	const input = yield* decodeInput(TimeseriesInputSchema, data, "getAwsInfraTimeseries")
	const result = yield* runWarehouseQuery("awsInfraTimeseries", () =>
		Effect.gen(function* () {
			const client = yield* MapleInternalHttp
			return yield* client.queryEngine.awsInfraTimeseries({
				payload: new AwsInfraTimeseriesRequest({ ...input, keys: [...input.keys] }),
			})
		}),
	)
	return { points: result.data }
})
