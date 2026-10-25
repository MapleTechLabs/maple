import { DashboardWidgetSchema } from "@maple/domain/http"
import type { V2DashboardTemplate } from "@maple/domain/http/v2"
import { resolveTimeRangeWindow } from "@maple/query-engine"
import { AsyncData } from "foldkit"
import { Option, Result, Schema } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import { LoadChartRuntime } from "../../../charts/chart-runtime"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import { AppRoute, hrefOf } from "../../../route"
import type { DashboardsTemplatesSearch } from "../../../route/search"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import * as Dialog from "../../../ui/dialog"
import { planWidget } from "../kit/widget-data"
import {
	AwaitCreated,
	CreateFromTemplate,
	FetchMetrics,
	FetchPreview,
	FetchTemplates,
	FetchWidget,
	ReadClock,
	WaitPreviewDelay,
	WaitSearchDebounce,
} from "./command"
import { previewVariableValues } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

export type Return = PageReturn<Model, Message>
type Search = typeof DashboardsTemplatesSearch.Type
type Route = Readonly<{ search: Search }>

/** Widgets past this many are not worth the warehouse round trip in a preview (`MAX_PREVIEW_WIDGETS`). */
export const MAX_PREVIEW_WIDGETS = 8

/** The v2 wire widget is the stored widget under another schema; decoding narrows its type. */
const decodeWidget = Schema.decodeUnknownOption(DashboardWidgetSchema)

const templatesKey = (context: PageContext) => requestKey(context.orgId, "dashboards.listTemplates", {})
const metricsKey = (context: PageContext) => requestKey(context.orgId, "listMetrics", { limit: 1000 })

const loadChartRuntime = Command.mapMessage(LoadChartRuntime(), (message) =>
	message._tag === "CompletedLoadChartRuntime"
		? Message.CompletedLoadChartRuntime()
		: Message.FailedLoadChartRuntime({ reason: message.reason }),
)

export const init = (route: Route, context: PageContext): Return => {
	const templates = templatesKey(context)
	const metrics = metricsKey(context)
	return {
		model: {
			search: route.search,
			nowMs: null,
			templates: { key: templates, data: AsyncData.Loading() },
			metrics: { key: metrics, data: AsyncData.Loading() },
			searchDraft: "",
			searchGeneration: 0,
			query: "",
			filter: "all",
			previewGeneration: 0,
			isPreviewArmed: false,
			preview: Keyed.idle(),
			previewWidgets: [],
			gates: {},
			requests: {},
			charts: {},
			tableSorts: {},
			previewWidth: 0,
			parameters: {},
			isCreating: false,
			themeColors: null,
			chartRuntime: { _tag: "Loading" },
			panelSheet: openPanelSheet(),
		},
		commands: [
			ReadClock(),
			FetchTemplates({ key: templates }),
			FetchMetrics({ key: metrics }),
			loadChartRuntime,
		],
	}
}

export const templatesOf = (model: Model): ReadonlyArray<V2DashboardTemplate> =>
	Option.getOrElse(AsyncData.getData(model.templates.data), () => [])

export const selectedOf = (model: Model): V2DashboardTemplate | null =>
	templatesOf(model).find((template) => template.id === model.search.template) ?? null

export const PANEL_SHEET_ID = "dashboard-template-panel"

/** `<Sheet open={selected !== null}>`: each selection opens it afresh. */
const openPanelSheet = () => Dialog.init(PANEL_SHEET_ID, "sheet", { isOpen: true })

/** A new selection drops the old preview and starts the 250 ms arming delay (the panel remounts). */
const reselect = (model: Model): Return => {
	const previewGeneration = model.previewGeneration + 1
	const next: Model = {
		...model,
		panelSheet: openPanelSheet(),
		previewGeneration,
		isPreviewArmed: false,
		preview: Keyed.idle(),
		previewWidgets: [],
		gates: {},
		parameters: {},
	}
	return selectedOf(next) === null
		? { model: next }
		: { model: next, commands: [WaitPreviewDelay({ generation: previewGeneration })] }
}

export const routeChanged = (model: Model, route: Route): Return =>
	route.search.template === model.search.template
		? { model: { ...model, search: route.search } }
		: reselect({ ...model, search: route.search })

/** The preview request for the selection and its current parameters (`useDeferredValue`). */
const requestPreview = (model: Model, context: PageContext): Return => {
	const selected = selectedOf(model)
	if (selected === null || !model.isPreviewArmed) return { model }
	const key = requestKey(context.orgId, "dashboards.previewTemplate", {
		templateId: selected.id,
		parameters: model.parameters,
	})
	return Option.match(Keyed.request(model.preview, key, "Load"), {
		onNone: () => ({ model }),
		onSome: (preview) => ({
			model: { ...model, preview },
			commands: [FetchPreview({ key, templateId: selected.id, parameters: model.parameters })],
		}),
	})
}

type PreviewPlan = Readonly<{
	gates: Model["gates"]
	requests: Model["requests"]
	commands: ReadonlyArray<ReturnType<typeof FetchWidget>>
	asked: ReadonlyArray<string>
}>

/** Plans the shown preview widgets over the preview's own range; tiles fetch at once. */
const planPreview = (model: Model, context: PageContext): Return => {
	const preview = Option.getOrUndefined(AsyncData.getData(model.preview.data))
	if (preview === undefined || model.nowMs === null) return { model }
	const window = resolveTimeRangeWindow(preview.timeRange, {
		timeZone: context.timeZone,
		nowMs: model.nowMs,
	})
	const shown = model.previewWidgets.slice(0, MAX_PREVIEW_WIDGETS)
	// `ResolvedDashboardVariablesProvider` declares no variables, so nothing waits on one.
	const variables = { names: [], values: previewVariableValues(preview.variables) }
	const initial: PreviewPlan = { gates: model.gates, requests: model.requests, commands: [], asked: [] }
	const planned = shown.reduce(
		(state, widget) => {
			const gate = planWidget({
				orgId: context.orgId,
				dataSource: widget.dataSource,
				window,
				...(widget.timeRange === undefined ? undefined : { widgetTimeRange: widget.timeRange }),
				variables,
			})
			const gates = { ...state.gates, [widget.id]: gate }
			if (gate._tag !== "Request" || state.asked.includes(gate.request.key)) return { ...state, gates }
			const { key, endpoint, params } = gate.request
			return Option.match(Keyed.request(state.requests[key] ?? Keyed.idle(), key, "Load"), {
				onNone: () => ({ ...state, gates }),
				onSome: (slot) => ({
					gates,
					requests: { ...state.requests, [key]: slot },
					commands: [...state.commands, FetchWidget({ key, endpoint, params })],
					asked: [...state.asked, key],
				}),
			})
		},
		initial,
	)
	return {
		model: {
			...model,
			gates: planned.gates,
			requests: planned.requests,
			charts: Object.fromEntries(
				shown.map((widget) => [widget.id, model.charts[widget.id] ?? Chart.init()]),
			),
		},
		commands: planned.commands,
	}
}

const navigate = (model: Model, url: string, isReplace: boolean): Return => ({
	model,
	outMessage: PageOutMessage.RequestedNavigation({ url, isReplace }),
})

const selectionHref = (templateId: string | undefined) =>
	hrefOf(AppRoute.DashboardsTemplates({ search: templateId === undefined ? {} : { template: templateId } }))

/** `createFromTemplate`: only filled parameters are sent. */
const create = (model: Model, templateId: string): Return => {
	if (model.isCreating) return { model }
	const parameters = Object.fromEntries(
		Object.entries(model.parameters)
			.map(([key, value]) => [key, value.trim()] as const)
			.filter(([, value]) => value.length > 0),
	)
	return {
		model: { ...model, isCreating: true },
		commands: [CreateFromTemplate({ templateId, parameters })],
	}
}

const sortStep = (model: Model, widgetId: string, field: string, isText: boolean): Return => {
	const current = model.tableSorts[widgetId] ?? { key: null, dir: "desc" as const }
	const next =
		current.key === field
			? current.dir === "asc"
				? { key: null, dir: current.dir }
				: { key: field, dir: "asc" as const }
			: { key: field, dir: isText ? ("asc" as const) : ("desc" as const) }
	return { model: { ...model, tableSorts: { ...model.tableSorts, [widgetId]: next } } }
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedReadClock: ({ nowMs }) => planPreview({ ...model, nowMs }, context),
		CompletedFetchTemplates: ({ key, result }) => {
			const next = { ...model, templates: Keyed.accept(model.templates, key, result) }
			// The panel mounts once the list resolves the selection; its arming delay starts then.
			return selectedOf(model) === null && selectedOf(next) !== null ? reselect(next) : { model: next }
		},
		CompletedFetchMetrics: ({ key, result }) => ({
			model: { ...model, metrics: Keyed.accept(model.metrics, key, result) },
		}),
		ElapsedPreviewDelay: ({ generation }) =>
			generation === model.previewGeneration
				? requestPreview({ ...model, isPreviewArmed: true }, context)
				: { model },
		CompletedFetchPreview: ({ key, result }) => {
			const preview = Keyed.accept(model.preview, key, result)
			const widgets = Option.match(AsyncData.getData(preview.data), {
				onNone: () => model.previewWidgets,
				onSome: (data) => data.widgets.flatMap((widget) => Option.toArray(decodeWidget(widget))),
			})
			return planPreview({ ...model, preview, previewWidgets: widgets }, context)
		},
		CompletedFetchWidget: ({ key, result }) => {
			const slot = model.requests[key]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							requests: { ...model.requests, [key]: Keyed.accept(slot, key, result) },
						},
					}
		},
		MeasuredPreview: ({ width }) => ({ model: { ...model, previewWidth: width } }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ widgetId, message: inner }) => {
			const next = Chart.update(model.charts[widgetId] ?? Chart.init(), inner)
			return {
				model: { ...model, charts: { ...model.charts, [widgetId]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (chart) =>
					Message.GotChartMessage({ widgetId, message: chart }),
				),
			}
		},
		ClickedSortColumn: ({ widgetId, field, isText }) => sortStep(model, widgetId, field, isText),
		ChangedSearchDraft: ({ value }) => {
			const searchGeneration = model.searchGeneration + 1
			return {
				model: { ...model, searchDraft: value, searchGeneration },
				commands: [WaitSearchDebounce({ generation: searchGeneration })],
			}
		},
		ElapsedSearchDebounce: ({ generation }) =>
			generation === model.searchGeneration
				? { model: { ...model, query: model.searchDraft.trim() } }
				: { model },
		ChangedFilter: ({ filter }) => ({ model: { ...model, filter } }),
		ClickedTemplate: ({ templateId }) => navigate(model, selectionHref(templateId), true),
		ClickedBack: () => navigate(model, hrefOf(AppRoute.Dashboards({ search: {} })), false),
		// `onOpenChange(false)`: dismissing the sheet clears the selection.
		GotPanelSheetMessage: ({ message: inner }) => {
			const next = Dialog.update(model.panelSheet, inner)
			const stepped = {
				model: { ...model, panelSheet: next.model },
				commands: Command.mapMessages(next.commands ?? [], (dialog) => Message.GotPanelSheetMessage({ message: dialog })),
			}
			return next.outMessage?._tag === "Closed"
				? { ...stepped, outMessage: PageOutMessage.RequestedNavigation({ url: selectionHref(undefined), isReplace: true }) }
				: stepped
		},
		ClickedRetry: () =>
			Option.match(Keyed.request(model.templates, templatesKey(context), "Refresh"), {
				onNone: () => ({ model }),
				onSome: (templates) => ({
					model: { ...model, templates },
					commands: [FetchTemplates({ key: templatesKey(context) })],
				}),
			}),
		ChangedParameter: ({ key, value }) =>
			requestPreview({ ...model, parameters: { ...model.parameters, [key]: value } }, context),
		ClickedCreate: ({ templateId }) => create(model, templateId),
		CompletedCreate: ({ result }) =>
			Result.match(result, {
				onFailure: (failure) => ({
					model: { ...model, isCreating: false },
					outMessage: PageOutMessage.RequestedToast({
						type: "error",
						title: failure.title,
						description: failure.message,
						timeoutMs: null,
						action: null,
					}),
				}),
				onSuccess: (created) => ({
					model: { ...model, isCreating: false },
					outMessage: PageOutMessage.RequestedNavigation({
						url: hrefOf(
							AppRoute.Dashboard({
								dashboardId: AppRoute.Dashboard.fields.dashboardId.make(created.id),
								search: {},
							}),
						),
						isReplace: false,
						toast: {
							type: "success",
							title: `Dashboard "${created.name}" created`,
							description: "",
						},
					}),
					commands: [AwaitCreated({ orgId: context.orgId, id: created.id, txid: created.txid })],
				}),
			}),
		CompletedAwaitCreated: () => ({ model }),
	})
