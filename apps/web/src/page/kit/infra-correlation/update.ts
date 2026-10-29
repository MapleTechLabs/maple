import {
	getActiveInfraCorrelations,
	type InfraCorrelation,
} from "../../../components/infra/infra-correlations"
import { Option } from "effect"
import { Command, Update } from "foldkit"
import { makeInitIfMissingStep } from "foldkit/bindingInit"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { SeriesSlots } from "../../infra/kit/series"
import { FetchCorrelationSeries, operationOf, type SeriesRequest } from "./command"
import { ChartsBinding, InfraCorrelationComposition } from "./composition"
import { makeStep } from "./definition"
import { Message, type Model } from "./model"

type ModelOnly = Readonly<{ model: Model }>
type ChartRequest = Readonly<{ chartId: string; request: SeriesRequest }>

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
export const chartIdOf = (correlation: InfraCorrelation, metric: string): string =>
	`${correlation.kind}-${metric}`

/** Every chart's read, in render order (Container, Pod, Node, Host; each group's charts in order). */
export const requestsOf = (
	correlations: ReadonlyArray<InfraCorrelation>,
	window: TimeWindow,
): ReadonlyArray<ChartRequest> =>
	correlations.flatMap((correlation): ReadonlyArray<ChartRequest> => {
		const shared = { ...window, bucketSeconds: BUCKET_SECONDS }
		switch (correlation.kind) {
			case "container":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: {
						_tag: "container",
						containerName: correlation.identifier,
						hostName: correlation.hostName,
						metric,
						...shared,
					},
				}))
			case "pod":
				return correlation.charts.map(({ metric }) => ({
					chartId: chartIdOf(correlation, metric),
					request: {
						_tag: "pod",
						podName: correlation.identifier,
						namespace: correlation.namespace,
						metric,
						...shared,
					},
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
const requested = (model: Model, window: TimeWindow, requests: ReadonlyArray<ChartRequest>) => {
	const series = requests.reduce<
		Readonly<{ slots: SeriesSlots; commands: ReadonlyArray<ReturnType<typeof FetchCorrelationSeries>> }>
	>(
		(acc, { chartId, request }) => {
			const { operation, data } = operationOf(request)
			const key = requestKey(model.orgId, operation, { data })
			return Option.match(Keyed.request(acc.slots[chartId] ?? Keyed.idle(), key, "Load"), {
				onNone: () => acc,
				onSome: (next) => ({
					slots: { ...acc.slots, [chartId]: next },
					commands: [...acc.commands, FetchCorrelationSeries({ key, chartId, request })],
				}),
			})
		},
		{ slots: model.series, commands: [] },
	)
	return {
		model: { ...model, window, series: series.slots },
		commands: [...series.commands, ...(model.chartRuntime._tag === "Loading" ? [loadRuntime] : [])],
	}
}

/** The panel at rest, before it mounts and resolves its window. */
export const initPanel = InfraCorrelationComposition.makeInit((id: string, orgId: string) => ({
	model: init(id, orgId),
}))

export const update = InfraCorrelationComposition.makeUpdate({
	/** Each requested chart gets its chart Model first, so its pointer Messages have a home. */
	ResolvedWindow: (model, { window, resourceAttributes }) => {
		const requests = requestsOf(getActiveInfraCorrelations({ ...resourceAttributes }), window)
		return Update.combineSteps(model, [
			...requests.map(({ chartId }) =>
				makeInitIfMissingStep(ChartsBinding, { key: chartId, args: [] }),
			),
			makeStep((next: Model) => requested(next, window, requests)),
		])
	},
	CompletedFetchSeries: (model, { chartId, key, result }) => {
		const slot = model.series[chartId]
		return slot === undefined
			? { model }
			: { model: { ...model, series: { ...model.series, [chartId]: Keyed.accept(slot, key, result) } } }
	},
	CompletedLoadChartRuntime: (model): ModelOnly => ({
		model: { ...model, chartRuntime: { _tag: "Ready" } },
	}),
	FailedLoadChartRuntime: (model, { reason }): ModelOnly => ({
		model: { ...model, chartRuntime: { _tag: "Failed", reason } },
	}),
	ResolvedThemeColors: (model, { colors }) => ({ model: { ...model, themeColors: colors } }),
	CompletedMountLinkedCursor: (model) => ({ model }),
})
