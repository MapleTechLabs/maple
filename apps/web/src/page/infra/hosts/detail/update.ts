import { bucketSecondsForRange } from "../../../../components/infra/constants"
import { Option } from "effect"
import { Command, Update } from "foldkit"
import { makeInitIfMissingStep } from "foldkit/bindingInit"
import { LoadChartRuntime } from "../../../../charts/chart-runtime"
import * as Keyed from "../../../../data/keyed"
import { requestKey } from "../../../../data/request-key"
import { AppRoute, hrefOf } from "../../../../route"
import type { PageContext, PageOutMessage } from "../../../contract"
import * as Frame from "../../kit/frame"
import { WIDEN_TIME_PRESET } from "../../kit/frame"
import { routeFrame } from "../../kit/frame-step"
import type { SeriesSlots } from "../../kit/series"
import { FetchSeries, FetchSummary, type SeriesInput, type SummaryInput } from "./command"
import { ChartsBinding, FrameBinding, HostDetailComposition } from "./composition"
import { makeNoopStep, makeStep } from "./definition"
import { type HostMetric, Message } from "./message"
import type { Model } from "./model"
import { navigate, type Search } from "./navigate"

type HostCommand = ReturnType<typeof FetchSummary> | ReturnType<typeof FetchSeries>
type UpdateReturn = Readonly<{
	model: Model
	commands?: ReadonlyArray<HostCommand>
	outMessage?: PageOutMessage
}>
/** A data request: no OutMessage, so it composes with the frame's Steps. */
type RequestReturn = Readonly<{ model: Model; commands?: ReadonlyArray<HostCommand> }>
type Route = Readonly<{ hostName: string; search: Search }>

export const DEFAULT_PRESET = "1h"
export const HOST_METRICS: ReadonlyArray<HostMetric> = ["cpu", "memory", "filesystem", "network", "load15"]

const scopeOf = (model: Pick<Model, "search">, context: PageContext): Frame.Scope => ({
	search: model.search,
	defaultPreset: DEFAULT_PRESET,
	timeZone: context.timeZone,
})

/** The summary slot's request for `input`: the next slot and its fetch, or nothing for an unmoved key. */
const summaryStep = (
	model: Model,
	context: PageContext,
	input: SummaryInput,
	mode: Keyed.RequestMode,
): RequestReturn => {
	const key = requestKey(context.orgId, "hostDetailSummary", { data: input })
	return Option.match(Keyed.request(model.summary, key, mode), {
		onNone: () => ({ model }),
		onSome: (summary) => ({ model: { ...model, summary }, commands: [FetchSummary({ key, input })] }),
	})
}

const requestAll = (model: Model, context: PageContext, mode: Frame.RequestMode): RequestReturn => {
	const window = model.frame.window
	if (window === null) return { model }
	const summaryInput = { hostName: model.hostName, startTime: window.startTime, endTime: window.endTime }
	const bucketSeconds = bucketSecondsForRange(window.startTime, window.endTime)
	const series = HOST_METRICS.reduce<
		Readonly<{ slots: SeriesSlots; commands: ReadonlyArray<HostCommand> }>
	>(
		(acc, metric) => {
			const input: SeriesInput = { hostName: model.hostName, metric, ...window, bucketSeconds }
			const key = requestKey(context.orgId, "hostInfraTimeseries", { data: input })
			return Option.match(Keyed.request(acc.slots[metric] ?? Keyed.idle(), key, mode), {
				onNone: () => acc,
				onSome: (next) => ({
					slots: { ...acc.slots, [metric]: next },
					commands: [...acc.commands, FetchSeries({ key, input })],
				}),
			})
		},
		{ slots: model.series, commands: [] },
	)
	const summary = summaryStep({ ...model, series: series.slots }, context, summaryInput, mode)
	return { model: summary.model, commands: [...series.commands, ...(summary.commands ?? [])] }
}

/** Entry: the frame starts on the page scope and resolves snapped; each strip's chart starts at rest. */
export const init = HostDetailComposition.makeInit((route: Route, context: PageContext) => {
	const scope = scopeOf(route, context)
	return {
		model: {
			hostName: route.hostName,
			search: route.search,
			frame: Frame.init("infra-host-time-range", scope),
			summary: Keyed.idle(),
			series: {},
			charts: {},
			chartRuntime: { _tag: "Loading" },
			themeColors: null,
		},
		commands: [
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
		steps: [
			...HOST_METRICS.map((metric) => makeInitIfMissingStep(ChartsBinding, { key: metric, args: [] })),
			FrameBinding.requestResolve({ scope, mode: "Load" }),
		],
	}
})

export const update = HostDetailComposition.makeUpdate.withContext((context: PageContext) => ({
	CompletedFetchSummary: (model, { key, result }): UpdateReturn => ({
		model: { ...model, summary: Keyed.accept(model.summary, key, result) },
	}),
	CompletedFetchSeries: (model, { metric, key, result }): UpdateReturn => {
		const slot = model.series[metric]
		return slot === undefined
			? { model }
			: { model: { ...model, series: { ...model.series, [metric]: Keyed.accept(slot, key, result) } } }
	},
	ClickedRetrySummary: (model): UpdateReturn => {
		const window = model.frame.window
		if (window === null) return { model }
		const input = { hostName: model.hostName, startTime: window.startTime, endTime: window.endTime }
		return summaryStep(model, context, input, "Refresh")
	},
	ClickedWidenRange: (model): UpdateReturn =>
		navigate(model, {
			...model.search,
			startTime: undefined,
			endTime: undefined,
			timePreset: WIDEN_TIME_PRESET,
		}),
	CompletedLoadChartRuntime: (model): UpdateReturn => ({
		model: { ...model, chartRuntime: { _tag: "Ready" } },
	}),
	FailedLoadChartRuntime: (model, { reason }): UpdateReturn => ({
		model: { ...model, chartRuntime: { _tag: "Failed", reason } },
	}),
	ResolvedThemeColors: (model, { colors }): UpdateReturn => ({ model: { ...model, themeColors: colors } }),
	CompletedMountLinkedCursor: (model): UpdateReturn => ({ model }),
	ResolvedFrameWindow: (model, { mode }) => requestAll(model, context, mode),
	InformedOfRouteChange: (model, { search }) => {
		const href = (next: Search) => hrefOf(AppRoute.InfraHost({ hostName: model.hostName, search: next }))
		if (href(model.search) === href(search)) return makeNoopStep()(model)
		const next = { ...model, search }
		const frameStep = routeFrame(model.search, next, search, {
			resolve: () => FrameBinding.requestResolve({ scope: scopeOf(next, context) }),
			requestAll: (mode) => makeStep((moved: Model) => requestAll(moved, context, mode)),
		})
		return Update.combineSteps(model, [makeStep(() => ({ model: next })), frameStep])
	},
	/** A new time zone reaches the frame too, so a later Reload resolves in it. */
	InformedOfContextChange: (model) =>
		Update.combineSteps(model, [
			FrameBinding.informOfScope({ scope: scopeOf(model, context) }),
			makeStep((next: Model) => requestAll(next, context, "Load")),
		]),
}))
