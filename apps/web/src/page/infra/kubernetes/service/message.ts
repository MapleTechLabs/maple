import { ChartEnvMessages } from "@maple/views/charts/chart-env"
import { getServiceDetailOverview } from "@maple/web-data/warehouse/custom-charts"
import { workloadInfraTimeseries } from "@maple/web-data/warehouse/infra"
import { Effect, Schema, Array as Arr } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import * as Chart from "@maple/views/charts/chart"
import { LoadFailure, settleTo } from "@maple/views/data/load-failure"
import * as Frame from "../../kit/frame"
import { SeriesRow } from "../../../kit/series"
import * as Rail from "../lens/rail"
import { fetchPods, PodsInput, PodsPage } from "../pod-data"
import { ServicePoint } from "./model"

export const Message = defineMessageUnion({
	CompletedFetchLinked: { key: Schema.String, result: Schema.Result(Rail.ServiceWorkloads, LoadFailure) },
	CompletedFetchOverview: {
		key: Schema.String,
		result: Schema.Result(Schema.Array(ServicePoint), LoadFailure),
	},
	CompletedFetchCpu: { key: Schema.String, result: Schema.Result(Schema.Array(SeriesRow), LoadFailure) },
	CompletedFetchPods: { key: Schema.String, result: Schema.Result(PodsPage, LoadFailure) },
	ClickedRetryOverview: {},
	ClickedRetryPods: {},
	...ChartEnvMessages,
	CompletedMountLinkedCursor: {},
	GotChartMessage: { id: Schema.String, message: Chart.Message },
	GotRailMessage: { message: Rail.Message },
	GotFrameMessage: { message: Frame.Message },
})
export type Message = typeof Message.Type

export const FetchLinked = Command.define("FetchLensLinkedWorkload", {
	args: { key: Schema.String, input: Rail.WorkloadsInput },
	messages: [Message.CompletedFetchLinked],
	execute: ({ key, input }) =>
		Effect.map(Rail.fetchServiceWorkloads(input), (result) =>
			Message.CompletedFetchLinked({ key, result }),
		),
})

export const OverviewInput = Schema.Struct({
	serviceName: Schema.String,
	startTime: Schema.String,
	endTime: Schema.String,
})
export type OverviewInput = typeof OverviewInput.Type

export const FetchOverview = Command.define("FetchLensServiceOverview", {
	args: { key: Schema.String, input: OverviewInput },
	messages: [Message.CompletedFetchOverview],
	execute: ({ key, input }) =>
		getServiceDetailOverview({ data: input }).pipe(
			Effect.map((response) =>
				Arr.map(response.data, (point) => ({
					bucket: point.bucket,
					p99LatencyMs: point.p99LatencyMs,
					throughput: point.throughput,
					totalCount: point.totalCount,
				})),
			),
			settleTo((result) => Message.CompletedFetchOverview({ key, result })),
		),
})

export const CpuInput = Schema.Struct({
	kind: Schema.Literals(["deployment", "statefulset", "daemonset"]),
	workloadName: Schema.String,
	namespace: Schema.optional(Schema.String),
	metric: Schema.Literal("cpu_limit"),
	groupByPod: Schema.Boolean,
	startTime: Schema.String,
	endTime: Schema.String,
	bucketSeconds: Schema.Number,
})
export type CpuInput = typeof CpuInput.Type

export const FetchCpu = Command.define("FetchLensCpu", {
	args: { key: Schema.String, input: CpuInput },
	messages: [Message.CompletedFetchCpu],
	execute: ({ key, input }) =>
		workloadInfraTimeseries({ data: input }).pipe(
			Effect.map((response) => response.data),
			settleTo((result) => Message.CompletedFetchCpu({ key, result })),
		),
})

export const FetchPods = Command.define("FetchLensPods", {
	args: { key: Schema.String, input: PodsInput },
	messages: [Message.CompletedFetchPods],
	execute: ({ key, input }) =>
		Effect.map(fetchPods(input), (result) => Message.CompletedFetchPods({ key, result })),
})
