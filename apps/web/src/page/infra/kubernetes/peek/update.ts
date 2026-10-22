import { bucketSecondsForRange } from "../../../../components/infra/constants"
import { podKey } from "../../../../components/infra/pod-restarts"
import type { Result } from "effect"
import { Command, type Update } from "foldkit"
import * as Chart from "../../../../charts/chart"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import type { LoadFailure } from "../../../../data/load-failure"
import { requestKey } from "../../../../data/request-key"
import type { TimeWindow } from "../../../../data/time-range"
import type { Resources } from "../../../../platform/resources"
import * as Dialog from "../../../../ui/dialog"
import type { PageContext } from "../../../contract"
import { seriesSteps } from "../../kit/requests"
import type { SeriesData } from "../../kit/series"
import type { PodRow, PodSummary } from "../pod-data"
import { FetchPeekSeries, FetchPeekSummary, Message, OutMessage } from "./message"
import { type Model, PEEK_METRICS, seriesId } from "./model"

export type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage, Resources>

/** The peeked pod, where it sits in the list and the rows a step lands on. */
export type Peek = Readonly<{ pod: PodRow; index: number; count: number; neighbors: ReadonlyArray<PodRow> }>

export const init = (id: string): Model => ({
	dialog: Dialog.init(id, "sheet"),
	summaries: {},
	series: {},
	charts: {},
	chartRuntime: { _tag: "Loading" },
	themeColors: null,
})

/** The peek on the page on screen; a key no row matches means the sheet is closed. */
export const resolvePeek = (pods: ReadonlyArray<PodRow>, key: string | undefined): Peek | null => {
	const index = key === undefined ? -1 : pods.findIndex((pod) => podKey(pod) === key)
	const pod = index >= 0 ? pods[index] : undefined
	if (pod === undefined) return null
	const neighbors = [pods[index - 1], pods[index + 1]].filter((row): row is PodRow => row !== undefined)
	return { pod, index, count: pods.length, neighbors }
}

const summaryInputOf = (pod: PodRow, window: TimeWindow) => ({
	podName: pod.podName,
	namespace: pod.namespace || undefined,
	startTime: window.startTime,
	endTime: window.endTime,
})

/** The summary and (unless `summaryOnly`) every chart of the pods (`PeekPrefetch`). */
const request = (
	model: Model,
	context: PageContext,
	window: TimeWindow,
	pods: ReadonlyArray<PodRow>,
	mode: Keyed.RequestMode,
	summaryOnly = false,
) => {
	const summaries = seriesSteps<PodSummary, LoadFailure, Message>(
		model.summaries,
		pods.map((pod) => {
			const input = summaryInputOf(pod, window)
			const id = podKey(pod)
			return {
				id,
				key: requestKey(context.orgId, "podDetailSummary", { data: input }),
				fetch: (key: string) => FetchPeekSummary({ podKey: id, key, input }),
			}
		}),
		mode,
	)
	const series = seriesSteps<SeriesData, LoadFailure, Message>(
		model.series,
		(summaryOnly ? [] : pods).flatMap((pod) =>
			PEEK_METRICS.map((metric) => {
				const input = {
					...summaryInputOf(pod, window),
					metric,
					bucketSeconds: bucketSecondsForRange(window.startTime, window.endTime),
				}
				const id = seriesId(podKey(pod), metric)
				return {
					id,
					key: requestKey(context.orgId, "podInfraTimeseries", { data: input }),
					fetch: (key: string) => FetchPeekSeries({ id, key, input }),
				}
			}),
		),
		mode,
	)
	return {
		model: { ...model, summaries: summaries.slots, series: series.slots },
		commands: [...summaries.commands, ...series.commands],
	}
}

const loadRuntime = Command.mapMessage(LoadChartRuntime(), (message) =>
	message._tag === "CompletedLoadChartRuntime"
		? Message.CompletedLoadChartRuntime()
		: Message.FailedLoadChartRuntime({ reason: message.reason }),
)

const liftDialog = (model: Model, result: ReturnType<typeof Dialog.update>) => ({
	model: { ...model, dialog: result.model },
	commands: Command.mapMessages(result.commands ?? [], (message) => Message.GotDialogMessage({ message })),
})

/**
 * Follows the list: opens on a peeked row (warming it and its neighbours), closes when the key no
 * longer matches a row. The URL already says so, so the dialog's own Opened/Closed are dropped.
 */
export const sync = (model: Model, context: PageContext, window: TimeWindow | null, peek: Peek | null): Return => {
	if (peek === null) return liftDialog(model, Dialog.close(model.dialog))
	const opened = liftDialog(model, Dialog.open(model.dialog))
	const isOpening = !model.dialog.isOpen
	const runtime = isOpening && model.chartRuntime._tag !== "Ready" ? [loadRuntime] : []
	if (window === null) return { model: opened.model, commands: [...opened.commands, ...runtime] }
	const requested = request(opened.model, context, window, [peek.pod, ...peek.neighbors], "Load")
	return { model: requested.model, commands: [...opened.commands, ...runtime, ...requested.commands] }
}

const accepted = <A>(
	slots: Readonly<Record<string, Keyed.Keyed<A, LoadFailure>>>,
	id: string,
	key: string,
	result: Result.Result<A, LoadFailure>,
) => {
	const slot = slots[id]
	return slot === undefined ? slots : { ...slots, [id]: Keyed.accept(slot, key, result) }
}

export const update = (
	model: Model,
	message: Message,
	context: PageContext,
	window: TimeWindow | null,
	peek: Peek | null,
): Return =>
	Message.match<Return>(message, {
		CompletedFetchSummary: ({ podKey: id, key, result }) => ({
			model: { ...model, summaries: accepted(model.summaries, id, key, result) },
		}),
		CompletedFetchSeries: ({ id, key, result }) => ({
			model: { ...model, series: accepted(model.series, id, key, result) },
		}),
		ClickedStep: ({ step }) => ({ model, outMessage: OutMessage.RequestedStep({ step }) }),
		PressedStepKey: ({ step }) => ({ model, outMessage: OutMessage.RequestedStep({ step }) }),
		// `useAtomRefresh` on the summary atom alone: the charts are not re-read.
		ClickedRetrySummary: () =>
			peek === null || window === null ? { model } : request(model, context, window, [peek.pod], "Refresh", true),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({ model: { ...model, chartRuntime: { _tag: "Failed", reason } } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		GotChartMessage: ({ id, message: inner }) => {
			const chart = model.charts[id] ?? Chart.init()
			return { model: { ...model, charts: { ...model.charts, [id]: Chart.update(chart, inner).model } } }
		},
		GotDialogMessage: ({ message: inner }) => {
			const result = Dialog.update(model.dialog, inner)
			const lifted = liftDialog(model, result)
			return result.outMessage?._tag === "Closed" ? { ...lifted, outMessage: OutMessage.Closed() } : lifted
		},
	})
