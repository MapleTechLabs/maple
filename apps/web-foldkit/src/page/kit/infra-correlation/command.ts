import {
	containerInfraTimeseries,
	hostInfraTimeseries,
	nodeInfraTimeseries,
	podInfraTimeseries,
} from "@maple/web-data/warehouse/infra"
import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { SeriesData } from "../../infra/kit/series"
import { Message } from "./model"

// The four `*InfraTimeseries` reads the panel's charts make, through the read cache under the
// atom key (`requestKey(org, "<function>", { data })`), so a reopened panel reuses them.

const Window = { startTime: Schema.String, endTime: Schema.String, bucketSeconds: Schema.Number }

export const SeriesRequest = Schema.Union([
	Schema.TaggedStruct("container", {
		containerName: Schema.String,
		hostName: Schema.optional(Schema.String),
		metric: Schema.Literals(["cpu", "memory_percent", "memory_bytes", "network", "disk_io", "uptime"]),
		...Window,
	}),
	Schema.TaggedStruct("pod", {
		podName: Schema.String,
		namespace: Schema.optional(Schema.String),
		metric: Schema.Literals(["cpu_usage", "cpu_limit", "cpu_request", "memory_limit", "memory_request"]),
		...Window,
	}),
	Schema.TaggedStruct("node", {
		nodeName: Schema.String,
		metric: Schema.Literals(["cpu_usage", "cpu_utilization", "memory_usage", "memory_utilization", "uptime"]),
		...Window,
	}),
	Schema.TaggedStruct("host", {
		hostName: Schema.String,
		metric: Schema.Literals(["cpu", "memory", "filesystem", "network", "load15"]),
		...Window,
	}),
])
export type SeriesRequest = typeof SeriesRequest.Type

const toSeries = (response: { readonly data: SeriesData["rows"]; readonly unit: string }): SeriesData => ({
	rows: response.data,
	unit: response.unit,
})

/** Each chart's own read, in its field order. */
const load = (request: SeriesRequest) => {
	switch (request._tag) {
		case "container": {
			const { containerName, hostName, metric, startTime, endTime, bucketSeconds } = request
			const data = { containerName, hostName, metric, startTime, endTime, bucketSeconds }
			return { operation: "containerInfraTimeseries", data, read: Effect.map(containerInfraTimeseries({ data }), toSeries) }
		}
		case "pod": {
			const { podName, namespace, metric, startTime, endTime, bucketSeconds } = request
			const data = { podName, namespace, metric, startTime, endTime, bucketSeconds }
			return { operation: "podInfraTimeseries", data, read: Effect.map(podInfraTimeseries({ data }), toSeries) }
		}
		case "node": {
			const { nodeName, metric, startTime, endTime, bucketSeconds } = request
			const data = { nodeName, metric, startTime, endTime, bucketSeconds }
			return { operation: "nodeInfraTimeseries", data, read: Effect.map(nodeInfraTimeseries({ data }), toSeries) }
		}
		case "host": {
			const { hostName, metric, startTime, endTime, bucketSeconds } = request
			const data = { hostName, metric, startTime, endTime, bucketSeconds }
			return { operation: "hostInfraTimeseries", data, read: Effect.map(hostInfraTimeseries({ data }), toSeries) }
		}
	}
}

/** The request key of one chart's read. */
export const operationOf = (request: SeriesRequest): Readonly<{ operation: string; data: unknown }> => {
	const { operation, data } = load(request)
	return { operation, data }
}

export const FetchCorrelationSeries = Command.define("FetchInfraCorrelationSeries", {
	args: { key: Schema.String, chartId: Schema.String, request: SeriesRequest },
	messages: [Message.CompletedFetchSeries],
	execute: ({ key, chartId, request }) =>
		readThrough({ key, idleTtlMs: IdleTtl.infraTimeseries, schema: SeriesData }, load(request).read).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSeries({ chartId, key, result })),
		),
})
