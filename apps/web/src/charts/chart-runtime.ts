import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { defineTaggedUnion } from "foldkit/schema"

/**
 * The lazily loaded chart library (`./chart-host` and `@tanstack/charts`). A page loads it once and
 * renders its charts when it is `Ready`, so each chart Mount finds the module cached and draws
 * before the first paint that shows the card. Without it the
 * cards paint empty and the canvases arrive frames later.
 */
export const ChartRuntime = defineTaggedUnion({
	Loading: {},
	Ready: {},
	Failed: { reason: Schema.String },
})
export type ChartRuntime = typeof ChartRuntime.Type

export const ChartRuntimeMessage = defineMessageUnion({
	CompletedLoadChartRuntime: {},
	FailedLoadChartRuntime: { reason: Schema.String },
})
export type ChartRuntimeMessage = typeof ChartRuntimeMessage.Type

export const LoadChartRuntime = Command.define("LoadChartRuntime", {
	messages: [ChartRuntimeMessage.CompletedLoadChartRuntime, ChartRuntimeMessage.FailedLoadChartRuntime],
	execute: Effect.tryPromise(() => import("./chart-host")).pipe(
		Effect.as(ChartRuntimeMessage.CompletedLoadChartRuntime()),
		Effect.catch((error) =>
			Effect.succeed(ChartRuntimeMessage.FailedLoadChartRuntime({ reason: String(error) })),
		),
	),
})

export const isChartRuntimeReady = (runtime: ChartRuntime): boolean => runtime._tag === "Ready"
