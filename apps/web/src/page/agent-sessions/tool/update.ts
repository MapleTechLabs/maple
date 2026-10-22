import { errorTrendBucket } from "../../../lib/agent-sessions/tool-error-display"
import { toEpochMs } from "@maple/ui/lib/time-format"
import { Option, Record } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import type { TimeWindow } from "../../../data/time-range"
import type { Resources } from "../../../platform/resources"
import { AppRoute, hrefOf } from "../../../route"
import type { AgentSessionToolSearch } from "../../../route/search"
import * as Select from "../../../ui/select"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { chartBucketSeconds, DEFAULT_TOOL_PRESET, toolSelection } from "../tools-kit/model"
import type { Selection } from "../tools-kit/reads"
import { nextSort } from "../tools-kit/table"
import { ALL, facetValue, initFacetSelect } from "../tools-kit/toolbar"
import {
	CompleteReloadSpin,
	FetchErrors,
	FetchFacets,
	FetchSeries,
	FetchSessions,
	FetchTotals,
	ResolveWindow,
} from "./command"
import { type FacetKey, Message, type RequestMode } from "./message"
import type { Model } from "./model"
import * as ErrorModal from "./error-modal-model"
import * as ErrorModalUpdate from "./error-modal-update"

type Return = PageReturn<Model, Message>
type Commands = ReadonlyArray<Command.Command<Message, never, Resources>>
export type Search = typeof AgentSessionToolSearch.Type

const keyed = <A, E>(
	slot: Keyed.Keyed<A, E>,
	key: string,
	mode: Keyed.RequestMode,
	fetch: (key: string) => Command.Command<Message, never, Resources>,
): readonly [Keyed.Keyed<A, E>, Commands] =>
	Option.match(Keyed.request(slot, key, mode), {
		onNone: () => [slot, []] as const,
		onSome: (next) => [next, [fetch(key)]] as const,
	})

/** The tool is pinned from the route: a `?tool=` carried in cannot disagree with the page. */
export const selectionOf = (model: Model, window: TimeWindow): Selection => ({
	...toolSelection(model.search, window),
	tool: model.toolName,
	search: undefined,
})

export const rangeOf = (window: TimeWindow) => ({
	startMs: toEpochMs(window.startTime),
	endMs: toEpochMs(window.endTime),
})

const requestAll = (model: Model, context: PageContext, mode: RequestMode): Return => {
	const { window } = model
	if (window === null) return { model }
	const org = context.orgId
	const selection = selectionOf(model, window)
	const range = rangeOf(window)
	const bucketSeconds = chartBucketSeconds(range.startMs, range.endMs)
	const errorBucket = errorTrendBucket(range.startMs, range.endMs).seconds
	const sessionsInput = {
		startTime: window.startTime,
		endTime: window.endTime,
		tool: model.toolName,
		service: selection.service,
		env: selection.env,
		model: selection.model,
	}
	const [series, seriesCommands] = keyed(
		model.series,
		requestKey(org, "getAiToolSeries", { data: { ...selection, bucketSeconds, split: "none" } }),
		mode,
		(key) => FetchSeries({ key, selection, bucketSeconds }),
	)
	const [totals, totalsCommands] = keyed(
		model.totals,
		requestKey(org, "getAiToolTotals", { data: { ...selection, periods: ["current"] } }),
		mode,
		(key) => FetchTotals({ key, selection }),
	)
	const [errors, errorsCommands] = keyed(
		model.errors,
		requestKey(org, "getAiToolErrors", { data: { ...selection, bucketSeconds: errorBucket } }),
		mode,
		(key) => FetchErrors({ key, selection, tool: model.toolName, bucketSeconds: errorBucket }),
	)
	const [sessions, sessionsCommands] = keyed(
		model.sessions,
		requestKey(org, "listAiSessions", { data: sessionsInput }),
		mode,
		(key) => FetchSessions({ key, input: sessionsInput }),
	)
	const [facets, facetCommands] = keyed(
		model.facets,
		requestKey(org, "getAiSessionsFacets", { data: window }),
		"Load",
		(key) => FetchFacets({ key, window }),
	)
	return {
		model: { ...model, series, totals, errors, sessions, facets },
		commands: [
			...seriesCommands,
			...totalsCommands,
			...errorsCommands,
			...sessionsCommands,
			...facetCommands,
		],
	}
}

const resolveCommand = (search: Search, context: PageContext, mode: RequestMode) =>
	ResolveWindow({
		mode,
		startTime: search.startTime,
		endTime: search.endTime,
		preset: search.timePreset ?? DEFAULT_TOOL_PRESET,
		timeZone: context.timeZone,
	})

const hrefFor = (toolName: string, search: Search) => hrefOf(AppRoute.AgentSessionTool({ toolName, search }))

const navigate = (model: Model, search: Search): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({
		url: hrefFor(model.toolName, search),
		isReplace: false,
	}),
})

export const init = (
	route: { readonly toolName: string; readonly search: Search },
	context: PageContext,
): Return => {
	const { search } = route
	const model: Model = {
		toolName: route.toolName,
		search,
		window: null,
		nowMs: 0,
		series: Keyed.idle(),
		totals: Keyed.idle(),
		errors: Keyed.idle(),
		sessions: Keyed.idle(),
		facets: Keyed.idle(),
		serviceSelect: initFacetSelect("agent-tool-service", search.service),
		modelSelect: initFacetSelect("agent-tool-model", search.model),
		envSelect: initFacetSelect("agent-tool-env", search.env),
		timePicker: TimeRangePicker.init("agent-tool-time-range"),
		errorsSort: { key: "calls", dir: "desc" },
		isErrorsExpanded: false,
		charts: {},
		themeColors: null,
		chartRuntime: { _tag: "Loading" },
		refreshVersion: 0,
		isReloading: false,
		errorModal: ErrorModal.init(),
	}
	return {
		model,
		commands: [
			resolveCommand(search, context, "Load"),
			Command.mapMessage(LoadChartRuntime(), (message) =>
				message._tag === "CompletedLoadChartRuntime"
					? Message.CompletedLoadChartRuntime()
					: Message.FailedLoadChartRuntime({ reason: message.reason }),
			),
		],
	}
}

export const routeChanged = (
	model: Model,
	route: { readonly toolName: string; readonly search: Search },
	context: PageContext,
): Return => {
	if (hrefFor(model.toolName, model.search) === hrefFor(route.toolName, route.search)) return { model }
	const next: Model = {
		...model,
		search: route.search,
		serviceSelect: { ...model.serviceSelect, value: route.search.service ?? ALL },
		modelSelect: { ...model.modelSelect, value: route.search.model ?? ALL },
		envSelect: { ...model.envSelect, value: route.search.env ?? ALL },
	}
	// `useEffectiveTimeRange` re-resolves only on a time change; every other change reads its new keys.
	return isSameTime(model.search, route.search)
		? followModal(context)(requestAll(next, context, "Load"))
		: { model: next, commands: [resolveCommand(route.search, context, model.refreshVersion === 0 ? "Load" : "Refresh")] }
}

const isSameTime = (a: Search, b: Search): boolean =>
	a.startTime === b.startTime && a.endTime === b.endTime && a.timePreset === b.timePreset

export const contextChanged = (model: Model, context: PageContext): Return => ({
	model,
	commands: [resolveCommand(model.search, context, model.refreshVersion === 0 ? "Load" : "Refresh")],
})

const facetSelectStep = (model: Model, facet: FacetKey, message: Select.Message): Return => {
	const slot = facet === "service" ? "serviceSelect" : facet === "model" ? "modelSelect" : "envSelect"
	const next = Select.update(model[slot], message)
	const updated: Model = { ...model, [slot]: next.model }
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotFacetSelectMessage({ facet, message: inner }),
	)
	return next.outMessage === undefined
		? { model: updated, commands }
		: { ...navigate(updated, { ...model.search, [facet]: facetValue(next.outMessage.value) }), commands }
}

/** The groups of the Errors read in its own order: what the modal opens on and steps through. */
const errorFingerprints = (model: Model): ReadonlyArray<string> =>
	Option.match(AsyncData.getData(model.errors.data), {
		onNone: () => [],
		onSome: (errors) => errors.data.map((row) => row.fingerprint),
	})

const modalContextOf = (
	model: Model,
	context: PageContext,
	detailMode: Keyed.RequestMode = "Load",
): ErrorModalUpdate.ModalContext => ({
	orgId: context.orgId,
	detailMode,
	selection: model.window === null ? null : selectionOf(model, model.window),
	error: model.search.error,
	session: model.search.session,
	variant: model.search.variant,
	fingerprints: errorFingerprints(model),
})

/** The modal's step lifted: its search asks are set at once (nothing re-opens it meanwhile), then pushed. */
const liftModal = (model: Model, step: ErrorModalUpdate.Return): Return => {
	const lifted: Model = { ...model, errorModal: step.model }
	const commands = Command.mapMessages(step.commands ?? [], (message) => Message.GotErrorModalMessage({ message }))
	if (step.outMessage === undefined) return { model: lifted, commands }
	const { error, session, variant } = step.outMessage
	const search = { ...model.search, error, session, variant }
	return { ...navigate({ ...lifted, search }, search), commands }
}

/** After every step: the modal follows the URL and the Errors read. */
const followModal =
	(context: PageContext, detailMode: Keyed.RequestMode = "Load") =>
	(result: Return): Return => {
		const followed = liftModal(
			result.model,
			ErrorModalUpdate.follow(result.model.errorModal, modalContextOf(result.model, context, detailMode)),
		)
		return {
			...result,
			model: followed.model,
			commands: [...(result.commands ?? []), ...(followed.commands ?? [])],
			outMessage: result.outMessage ?? followed.outMessage,
		}
	}

// Reload re-reads the open group's facts too (`useRefreshableAtomValue`), even under the same key.
const detailModeOf = (message: Message): Keyed.RequestMode =>
	message._tag === "CompletedResolveWindow" ? message.mode : "Load"

export const update = (model: Model, message: Message, context: PageContext): Return =>
	followModal(context, detailModeOf(message))(step(model, message, context))

const step = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		GotErrorModalMessage: ({ message: inner }) =>
			liftModal(model, ErrorModalUpdate.update(model.errorModal, inner, modalContextOf(model, context))),
		CompletedResolveWindow: ({ window, nowMs, mode }) =>
			requestAll({ ...model, window, nowMs }, context, mode),
		CompletedFetchSeries: ({ key, result }) => ({
			model: { ...model, series: Keyed.accept(model.series, key, result) },
		}),
		CompletedFetchTotals: ({ key, result }) => ({
			model: { ...model, totals: Keyed.accept(model.totals, key, result) },
		}),
		CompletedFetchErrors: ({ key, result }) => ({
			model: { ...model, errors: Keyed.accept(model.errors, key, result) },
		}),
		CompletedFetchSessions: ({ key, result }) => ({
			model: { ...model, sessions: Keyed.accept(model.sessions, key, result) },
		}),
		CompletedFetchFacets: ({ key, result }) => ({
			model: { ...model, facets: Keyed.accept(model.facets, key, result) },
		}),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		ClickedReload: () => {
			const reloaded = { ...model, refreshVersion: model.refreshVersion + 1, isReloading: true }
			return {
				model: reloaded,
				commands: [
					resolveCommand(model.search, context, "Refresh"),
					CompleteReloadSpin({ version: reloaded.refreshVersion }),
				],
			}
		},
		CompletedReloadSpin: ({ version }) =>
			version === model.refreshVersion ? { model: { ...model, isReloading: false } } : { model },
		ClickedResetTimeRange: () =>
			navigate(model, {
				...model.search,
				startTime: undefined,
				endTime: undefined,
				timePreset: DEFAULT_TOOL_PRESET,
			}),
		ToggledFailingOnly: () =>
			navigate(model, { ...model.search, failing: model.search.failing === true ? undefined : true }),
		RemovedModelChip: () => navigate(model, { ...model.search, model: undefined }),
		// Opening another group drops the session and variant the last one was narrowed to.
		ClickedErrorRow: ({ fingerprint }) =>
			navigate(model, { ...model.search, error: fingerprint, session: undefined, variant: undefined }),
		ClickedErrorsSort: ({ key }) => ({
			model: { ...model, errorsSort: nextSort(model.errorsSort, key, []) },
		}),
		ToggledErrorsExpanded: () => ({ model: { ...model, isErrorsExpanded: !model.isErrorsExpanded } }),
		GotFacetSelectMessage: ({ facet, message: inner }) => facetSelectStep(model, facet, inner),
		GotTimePickerMessage: ({ message: inner }) => {
			const next = TimeRangePicker.update(model.timePicker, inner)
			const lifted: Return = {
				model: { ...model, timePicker: next.model },
				commands: Command.mapMessages(next.commands ?? [], (picker) =>
					Message.GotTimePickerMessage({ message: picker }),
				),
			}
			return next.outMessage === undefined || next.outMessage._tag === "RejectedRange"
				? lifted
				: {
						...lifted,
						outMessage: PageOutMessage.RequestedNavigation({
							url: hrefFor(model.toolName, {
								...model.search,
								...TimeRangePicker.searchPatchOf(next.outMessage),
							}),
							isReplace: false,
						}),
					}
		},
		GotChartMessage: ({ chartId, message: inner }) => {
			const current = Option.getOrElse(Record.get(model.charts, chartId), () => Chart.init())
			const next = Chart.update(current, inner)
			return {
				model: { ...model, charts: { ...model.charts, [chartId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ chartId, message: chart }),
				),
			}
		},
	})
