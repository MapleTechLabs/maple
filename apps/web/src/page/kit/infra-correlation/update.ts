import { getActiveInfraCorrelations, type InfraCorrelation } from "../../../components/infra/infra-correlations"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { seriesSteps } from "../../infra/kit/requests"
import { FetchCorrelationSeries, operationOf, type SeriesRequest } from "./command"
import { Message, type Model } from "./model"

export type Return = Readonly<{ model: Model; commands?: ReadonlyArray<Command.Command<Message, never, Resources>> }>

/** Charts bucket at a minute: host and kubelet metrics are sampled coarsely. */
export const BUCKET_SECONDS = 60

export const init = (id: string, orgId: string): Model => ({
	id,
	orgId,
	window: null,
	series: {},
	charts: {},
	chartRuntime: { _tag: "Loading" },
	themeColors: null,
})

/** A chart's slot and chart id, `<kind>-<metric>` (the linked-cursor id). */
export const chartIdOf = (correlation: InfraCorrelation, metric: string): string => `${correlation.kind}-${metric}`

/** Every chart's read, in render order (Container, Pod, Node, Host; each group's charts in order). */
export const requestsOf = (correlations: ReadonlyArray<InfraCorrelation>, window: TimeWindow) =>
	correlations.flatMap((correlation): ReadonlyArray<Readonly<{ chartId: string; request: SeriesRequest }>> => {
		const shared = { ...window, bucketSeconds: BUCKET_SECONDS }
		switch (correlation.kind) {
			case "container":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: { _tag: "container", containerName: correlation.identifier, hostName: correlation.hostName, metric, ...shared },
				}))
			case "pod":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: { _tag: "pod", podName: correlation.identifier, namespace: correlation.namespace, metric, ...shared },
				}))
			case "node":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: { _tag: "node", nodeName: correlation.identifier, metric, ...shared },
				}))
			case "host":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: { _tag: "host", hostName: correlation.identifier, metric, ...shared },
				}))
		}
	})

const loadRuntime = Command.mapMessage(LoadChartRuntime(), (message) =>
	message._tag === "CompletedLoadChartRuntime"
		? Message.CompletedLoadChartRuntime()
		: Message.FailedLoadChartRuntime({ reason: message.reason }),
)

/** The panel on screen: every chart reads its series, and the chart library loads once. */
const requested = (model: Model, window: TimeWindow, resourceAttributes: Readonly<Record<string, string>>): Return => {
	const correlations = getActiveInfraCorrelations({ ...resourceAttributes })
	const steps = seriesSteps(
		model.series,
		requestsOf(correlations, window).map(({ chartId, request }) => {
			const { operation, data } = operationOf(request)
			return {
				id: chartId,
				key: requestKey(model.orgId, operation, { data }),
				fetch: (key: string) => FetchCorrelationSeries({ key, chartId, request }),
			}
		}),
		"Load",
	)
	return {
		model: { ...model, window, series: steps.slots },
		commands: [...steps.commands, ...(model.chartRuntime._tag === "Loading" ? [loadRuntime] : [])],
	}
}

export const update = (model: Model, message: Message): Return =>
	Message.match<Return>(message, {
		ResolvedWindow: ({ window, resourceAttributes }) => requested(model, window, resourceAttributes),
		CompletedFetchSeries: ({ chartId, key, result }) => {
			const slot = model.series[chartId]
			return slot === undefined
				? { model }
				: { model: { ...model, series: { ...model.series, [chartId]: Keyed.accept(slot, key, result) } } }
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const chart = model.charts[chartId] ?? Chart.init()
			return { model: { ...model, charts: { ...model.charts, [chartId]: Chart.update(chart, inner).model } } }
		},
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedMountLinkedCursor: () => ({ model }),
	})
