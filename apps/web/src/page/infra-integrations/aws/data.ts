import { AWS_INFRA_KIND_IDS } from "@maple/domain/aws-infra"
import { V2AwsIntegration } from "@maple/domain/http/v2"
import {
	getAwsInfraFleet,
	getAwsInfraSparklines,
	getAwsInfraTimeseries,
} from "@maple/web-data/warehouse/aws-infra"
import { getServiceOverview } from "@maple/web-data/warehouse/services"
import { Effect, Schema } from "effect"
import { toLoadFailure } from "../../../data/load-failure"
import type { TimeWindow } from "../../../data/time-range"
import { MapleApiV2Client } from "../../../platform/api-clients"

// The AWS reads, as Effects the pages wrap in their own Commands.

export const AwsStatus = V2AwsIntegration
export type AwsStatus = V2AwsIntegration

export const KindId = Schema.Literals(AWS_INFRA_KIND_IDS)

/** One kind's metric rows, or that its read failed. */
export const FleetRead = Schema.Struct({
	kind: KindId,
	points: Schema.Array(
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			metric: Schema.String,
			total: Schema.Number,
			samples: Schema.Number,
			peak: Schema.Number,
			lastSeen: Schema.String,
		}),
	),
	failed: Schema.Boolean,
})
export type FleetRead = typeof FleetRead.Type

export const SparkRead = Schema.Struct({
	kind: KindId,
	points: Schema.Array(
		Schema.Struct({
			keys: Schema.Array(Schema.String),
			bucket: Schema.String,
			metric: Schema.String,
			total: Schema.Number,
			samples: Schema.Number,
		}),
	),
})
export type SparkRead = typeof SparkRead.Type

export const BucketPoint = Schema.Struct({
	bucket: Schema.String,
	metric: Schema.String,
	total: Schema.Number,
	samples: Schema.Number,
})
export type BucketPoint = typeof BucketPoint.Type

/** The connections: which accounts and regions the page covers. */
export const loadStatus = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* client.awsIntegration.status()
}).pipe(Effect.mapError(toLoadFailure), Effect.result)

export const loadFleet = (window: TimeWindow) =>
	getAwsInfraFleet({ data: window }).pipe(
		Effect.map((response): ReadonlyArray<FleetRead> => response.kinds),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const SparksInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	kinds: Schema.Array(KindId),
})
export type SparksInput = typeof SparksInput.Type

export const loadSparks = (input: SparksInput) =>
	getAwsInfraSparklines({ data: { ...input, kinds: [...input.kinds] } }).pipe(
		Effect.map((response): ReadonlyArray<SparkRead> => response.kinds),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

export const TimeseriesInput = Schema.Struct({
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
	kind: KindId,
	keys: Schema.Array(Schema.String),
})
export type TimeseriesInput = typeof TimeseriesInput.Type

export const loadTimeseries = (input: TimeseriesInput) =>
	getAwsInfraTimeseries({ data: { ...input, keys: [...input.keys] } }).pipe(
		Effect.map((response): ReadonlyArray<BucketPoint> => response.points),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)

/** A traced service's entry spans: what "Traced as" matches a resource's name against. */
export const TracedService = Schema.Struct({
	serviceName: Schema.String,
	errorRate: Schema.Number,
	throughput: Schema.Number,
	p95LatencyMs: Schema.Number,
})
export type TracedService = typeof TracedService.Type

export const loadTraced = (window: TimeWindow) =>
	getServiceOverview({ data: { startTime: window.startTime, endTime: window.endTime } }).pipe(
		Effect.map((response): ReadonlyArray<TracedService> =>
			response.data.map((row) => ({
				serviceName: row.serviceName,
				errorRate: row.errorRate,
				throughput: row.throughput,
				p95LatencyMs: row.p95LatencyMs,
			})),
		),
		Effect.mapError(toLoadFailure),
		Effect.result,
	)
