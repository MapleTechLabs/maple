import { Result } from "effect"
import { Command } from "foldkit"
import * as Chart from "../../../charts/chart"
import * as Keyed from "../../../data/keyed"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import * as Tooltip from "../../../ui/tooltip"
import { type PageContext, PageOutMessage } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import type { WhereFieldMessage } from "../../kit/where-field"
import { updateWhereFields } from "../../kit/where-field-update"
import { toPanelType } from "../kit/chart-registry"
import { SaveTimeRange, SaveWidget } from "./command"
import {
	addFormula,
	addQuery,
	cloneQuery,
	removeFormula,
	setPanelType,
} from "./edits"
import type { EditorState } from "./editor-state"
import { validationErrorOf } from "./lowering"
import { ProductEdit } from "./product-edit"
import { applyEdit, stepComboStep } from "./product-step"
import { whereFieldsInputsOf, whereFieldsOf } from "./where-fields"
import { rawSqlErrorOf, reseedForType } from "./raw-sql"
import { withDefaultMetric } from "./metric-options"
import { runSqlPreview, sqlStep } from "./sql-step"
import { Message } from "./message"
import type { Model } from "./model"
import {
	acceptFetch,
	chartStep,
	generate,
	isConfigurablePanel,
	leaveDialogStep,
	queryPanelStep,
	selectStep,
	timeRangeModeStep,
} from "./step"
import {
	backHref,
	editedWidget,
	isSqlSource,
	editState,
	leave,
	navigate,
	planPreview,
	receiveDocument,
	requestAutocomplete,
	type Return,
	runPreview,
	widgetOf,
} from "./update"

/** `emitAttribute`: only a non-empty key becomes a breakdown. */
const breakdownValueOf = (key: string): string | null => (key.trim() === "" ? null : `attribute:${key.trim()}`)

/** The SQL draft taken as the opened one, so a discarded or saved draft no longer reads as dirty. */
const savedSql = (model: Model): Model["rawSql"] =>
	model.rawSql === null ? null : { ...model.rawSql, initial: model.rawSql.draft }

/** A failed write's message, kept until dismissed. */
const errorToast = (title: string) =>
	PageOutMessage.RequestedToast({ type: "error", title, description: "", timeoutMs: null, action: null })

const timePickerStep = (model: Model, context: PageContext, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotTimePickerMessage({ message: inner }),
	)
	const updated = { ...model, timePicker: next.model }
	const timeRange = TimeRangePicker.dashboardTimeRangeOf(next.outMessage)
	if (timeRange === undefined) return { model: updated, commands }
	if (model.timeRange?.type === "relative" && timeRange.type === "relative" && model.timeRange.value === timeRange.value)
		return { model: updated, commands }
	const previewed = planPreview({ ...updated, timeRange }, context)
	const looked = requestAutocomplete(previewed.model, context)
	const planned = {
		model: looked.model,
		commands: [...(previewed.commands ?? []), ...(looked.commands ?? [])],
	}
	const save = SaveTimeRange({ orgId: context.orgId, dashboardId: model.dashboardId, timeRange })
	return { ...planned, commands: [...commands, ...(planned.commands ?? []), save] }
}

/** The Custom picker: a picked preset or range is the widget's own window. */
const rangePickerStep = (model: Model, context: PageContext, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.rangePicker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) => Message.GotRangePickerMessage({ message: inner }))
	const updated = { ...model, rangePicker: next.model }
	const timeRange = TimeRangePicker.dashboardTimeRangeOf(next.outMessage)
	if (timeRange === undefined) return { model: updated, commands }
	const edited = editState(updated, context, (state) => ({ ...state, timeRange }))
	return { ...edited, commands: [...commands, ...(edited.commands ?? [])] }
}

/** The Source tabs: the preview switches to what the picked source runs. */
const tabsStep = (model: Model, context: PageContext, message: Tabs.Message): Return => {
	const next = Tabs.update(model.sourceTabs, message)
	const planned = planPreview(
		{ ...model, sourceTabs: next.model, sourceMode: next.model.selected === "rawSql" ? "rawSql" : "builder" },
		context,
	)
	return {
		...planned,
		commands: [
			...Command.mapMessages(next.commands ?? [], (inner) => Message.GotSourceTabsMessage({ message: inner })),
			...(planned.commands ?? []),
		],
	}
}

/** `useSortState` with `resettable`: desc, then asc, then unsorted; text columns start ascending. */
const sortStep = (model: Model, field: string, isText: boolean): Return => {
	const current = model.tableSort
	const tableSort =
		current.key === field
			? current.dir === "asc"
				? { key: null, dir: current.dir }
				: { key: field, dir: "asc" as const }
			: { key: field, dir: isText ? ("asc" as const) : ("desc" as const) }
	return { model: { ...model, tableSort } }
}

/** A list read through the query engine lowers a fresh `createQueryDraft(0)` on each Apply. */
const isEngineList = (model: Model, state: EditorState): boolean =>
	!isSqlSource(model) &&
	toPanelType(state.visualization, state.chartId) === "list" &&
	state.listDataSource !== "logs"

/** The list's lowered query under `id`; the preview keeps the draft's own. */
const withListQueryId = (state: EditorState, id: string | null): EditorState =>
	id === null ? state : { ...state, queries: state.queries.map((query, index) => (index === 0 ? { ...query, id } : query)) }

/**
 * `applyChanges`: an invalid query set, or a save in flight, leaves Apply a no-op. An engine list
 * first asks for its query's fresh id (`listQueryId`).
 */
const apply = (model: Model, context: PageContext, listQueryId: string | null): Return => {
	const widget = widgetOf(model)
	if (model.isSaving || widget === null || model.state === null) return { model }
	const rawSql = isSqlSource(model) ? (model.rawSql?.draft ?? null) : null
	if (rawSql === null ? validationErrorOf(model.state) !== null : rawSqlErrorOf(rawSql) !== null) return { model }
	if (listQueryId === null && isEngineList(model, model.state)) return { model, commands: generate("applyList", "") }
	return {
		model: { ...model, isSaving: true },
		commands: [
			SaveWidget({
				orgId: context.orgId,
				dashboardId: model.dashboardId,
				widget: editedWidget(widget, withListQueryId(model.state, listQueryId), rawSql),
			}),
		],
	}
}

const edit = (model: Model, context: PageContext, change: (state: EditorState) => EditorState): Return =>
	editState(model, context, change)

const productEdit = (model: Model, context: PageContext, change: ProductEdit): Return =>
	planPreview(applyEdit(model, change), context)

/** A where field's step; an applied suggestion edits its text like typing. */
const whereFieldStep = (model: Model, context: PageContext, message: WhereFieldMessage): Return => {
	const next = updateWhereFields(model.whereFields, message, whereFieldsInputsOf(model, context))
	const commands = Command.mapMessages(next.commands ?? [], (inner) => Message.GotWhereFieldMessage({ message: inner }))
	const updated = { ...model, whereFields: next.fields }
	const field = next.change === undefined ? undefined : whereFieldsOf(model, null).get(next.change.fieldId)
	if (next.change === undefined || field === undefined) return { model: updated, commands }
	const edited = productEdit(updated, context, field.edit(next.change.expression))
	return { ...edited, commands: [...commands, ...(edited.commands ?? [])] }
}

const acceptSuggestions = (model: Model, message: Message & { _tag: "CompletedFetchSuggestions" }): Return => {
	const slot = model.suggestions[message.lookup]
	return slot === undefined
		? { model }
		: {
				model: {
					...model,
					suggestions: { ...model.suggestions, [message.lookup]: Keyed.accept(slot, message.key, message.result) },
				},
			}
}

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		UpdatedDashboard: (updated) => receiveDocument(model, context, updated),
		CompletedReadClock: ({ nowMs }) => planPreview({ ...model, nowMs }, context),
		MeasuredPreview: ({ widthPx }) =>
			widthPx === model.previewWidth
				? { model }
				: planPreview({ ...model, previewWidth: widthPx }, context),
		// A stat that just got its value asks for its sparkline series next.
		CompletedFetchWidget: (fetched) => planPreview(acceptFetch(model, fetched.key, fetched), context),
		// The options settle the variables, which may unblock a preview waiting on them.
		CompletedFetchVariableOptions: ({ name, key, result }) => {
			const slot = model.variableOptions[name]
			return slot === undefined
				? { model }
				: planPreview({ ...model, variableOptions: { ...model.variableOptions, [name]: Keyed.accept(slot, key, result) } }, context)
		},
		GotSparklineChartMessage: ({ message: inner }) => {
			const next = Chart.update(model.sparklineChart, inner)
			return {
				model: { ...model, sparklineChart: next.model },
				commands: Command.mapMessages(next.commands ?? [], (message) => Message.GotSparklineChartMessage({ message })),
			}
		},
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ message: inner }) => chartStep(model, inner),
		ClickedSortColumn: ({ field, isText }) => sortStep(model, field, isText),
		GotTimePickerMessage: ({ message: inner }) => timePickerStep(model, context, inner),
		GotRangePickerMessage: ({ message: inner }) => rangePickerStep(model, context, inner),
		// The editor has no persistence banner, so the failure toasts.
		CompletedSaveTimeRange: ({ error }) => (error === null ? { model } : { model, outMessage: errorToast(error) }),
		GotSourceTabsMessage: ({ message: inner }) => tabsStep(model, context, inner),
		GotSelectMessage: ({ id, message: inner }) => selectStep(model, context, id, inner),
		GotQueryPanelMessage: ({ message: inner }) => queryPanelStep(model, context, inner),
		ClickedAddQuery: () => ({ model, commands: generate("addQuery", "") }),
		ClickedAddFormula: () => ({ model, commands: generate("addFormula", "") }),
		GeneratedId: ({ purpose, source, id }) =>
			purpose === "applyList"
				? apply(model, context, id)
				: edit(model, context, (state) =>
						purpose === "addQuery"
							? addQuery(state, id)
							: purpose === "cloneQuery"
								? cloneQuery(state, source, id)
								: addFormula(state, id),
					),
		ToggledFormulaVisible: ({ formulaId }) =>
			edit(model, context, (state) => ({
				...state,
				formulas: state.formulas.map((formula) =>
					formula.id === formulaId ? { ...formula, hidden: !formula.hidden } : formula,
				),
			})),
		ChangedFormulaText: ({ formulaId, field, value }) =>
			edit(model, context, (state) => ({
				...state,
				formulas: state.formulas.map((formula) =>
					formula.id === formulaId ? { ...formula, [field]: value } : formula,
				),
			})),
		ClickedRemoveFormula: ({ formulaId }) =>
			edit(model, context, (state) => removeFormula(state, formulaId)),
		ClickedRunPreview: () => (isSqlSource(model) ? runSqlPreview(model, context) : runPreview(model, context)),
		ChangedSql: (m) => sqlStep(model, m),
		ChangedSqlBucket: (m) => sqlStep(model, m),
		ClickedSqlToken: (m) => sqlStep(model, m),
		CompletedInsertSqlToken: (m) => sqlStep(model, m),
		CompletedFocusSql: (m) => sqlStep(model, m),
		ToggledSqlCollapsed: (m) => sqlStep(model, m),
		GotSqlChipTooltipMessage: ({ message: inner }) => {
			const next = Tooltip.update(model.sqlChipTooltip, inner)
			return {
				model: { ...model, sqlChipTooltip: next.model },
				commands: Command.mapMessages(next.commands ?? [], (tip) => Message.GotSqlChipTooltipMessage({ message: tip })),
			}
		},
		ChangedTitle: ({ value }) => edit(model, context, (state) => ({ ...state, title: value })),
		ChangedMarkdown: ({ value }) =>
			edit(model, context, (state) => ({ ...state, markdownContent: value })),
		ChangedDescription: ({ value }) =>
			edit(model, context, (state) => ({ ...state, description: value })),
		ChangedTimeRangeMode: ({ mode }) => timeRangeModeStep(model, context, mode),
		ClickedPanelType: ({ panel }) =>
			isConfigurablePanel(panel)
				? edit(
						model.state === null || model.rawSql === null
							? model
							: { ...model, rawSql: reseedForType(model.rawSql, model.state, setPanelType(model.state, panel)) },
						context,
						(state) => setPanelType(state, panel),
					)
				: { model },
		ChangedStacked: ({ isStacked }) =>
			edit(model, context, (state) => ({ ...state, stacked: isStacked })),
		ChangedCurve: ({ curveType }) => edit(model, context, (state) => ({ ...state, curveType })),
		ChangedPoints: ({ pointsMode }) => edit(model, context, (state) => ({ ...state, pointsMode })),
		ChangedLegend: ({ legendPosition }) =>
			edit(model, context, (state) => ({ ...state, legendPosition })),
		// Stats live inside the legend: enabling them with the legend hidden turns it on.
		ToggledSeriesStats: () =>
			edit(model, context, (state) =>
				!state.seriesStatsEnabled && state.legendPosition === "hidden"
					? { ...state, seriesStatsEnabled: true, legendPosition: "bottom" }
					: { ...state, seriesStatsEnabled: !state.seriesStatsEnabled },
			),
		ClickedAddThreshold: () =>
			edit(model, context, (state) => ({
				...state,
				thresholds: [...state.thresholds, { value: 0, color: "#ef4444" }],
			})),
		ChangedThresholdValue: ({ index, value }) =>
			edit(model, context, (state) => ({
				...state,
				thresholds: state.thresholds.map((threshold, i) =>
					i === index
						? { ...threshold, value: Number.isFinite(Number(value)) ? Number(value) : 0 }
						: threshold,
				),
			})),
		ChangedThresholdColor: ({ index, color }) =>
			edit(model, context, (state) => ({
				...state,
				thresholds: state.thresholds.map((threshold, i) =>
					i === index ? { ...threshold, color } : threshold,
				),
			})),
		ClickedRemoveThreshold: ({ index }) =>
			edit(model, context, (state) => ({
				...state,
				thresholds: state.thresholds.filter((_, i) => i !== index),
			})),
		ChangedUnit: ({ unit }) => edit(model, context, (state) => ({ ...state, unit })),
		ToggledSparkline: () =>
			edit(model, context, (state) => ({ ...state, sparklineEnabled: !state.sparklineEnabled })),
		ChangedGaugeBound: ({ bound, value }) =>
			edit(model, context, (state) => (bound === "min" ? { ...state, gaugeMin: value } : { ...state, gaugeMax: value })),
		ChangedTableLimit: ({ value }) => edit(model, context, (state) => ({ ...state, tableLimit: value })),
		ChangedHeatmapScaleType: ({ scaleType }) =>
			edit(model, context, (state) => ({ ...state, heatmapScaleType: scaleType })),
		ToggledPercentChange: () =>
			edit(model, context, (state) => ({
				...state,
				includePercentChange: !state.includePercentChange,
			})),
		ClickedApply: () => apply(model, context, null),
		// What was saved is no longer an unsaved change, so the way back is not held.
		CompletedSave: ({ error }) =>
			error === null
				? navigate(
						{ ...model, isSaving: false, initial: model.state, initialSourceMode: model.sourceMode, rawSql: savedSql(model) },
						backHref(model),
					)
				: {
						model: { ...model, isSaving: false },
						outMessage: errorToast(error),
					},
		ClickedCancel: () => leave(model, backHref(model)),
		GotLeaveDialogMessage: ({ message: inner }) => leaveDialogStep(model, inner),
		ClickedDiscard: () => {
			const closed = Dialog.close(model.leaveDialog)
			return {
				...navigate(
					{ ...model, leaveDialog: closed.model, initial: model.state, sourceMode: model.initialSourceMode, rawSql: savedSql(model) },
					model.pendingLeaveUrl ?? backHref(model),
				),
				commands: Command.mapMessages(closed.commands ?? [], (inner) =>
					Message.GotLeaveDialogMessage({ message: inner }),
				),
			}
		},
		ChangedProduct: ({ edit: change }) => productEdit(model, context, change),
		GotStepComboMessage: ({ id, message: inner }) => stepComboStep(model, context, id, inner, productEdit),
		FocusedListField: ({ index }) => ({ model: { ...model, listFieldFocus: index } }),
		BlurredListField: () => ({ model: { ...model, listFieldFocus: null } }),
		GotWhereFieldMessage: ({ message: inner }) => whereFieldStep(model, context, inner),
		ToggledProductPanel: () => ({ model: { ...model, isProductPanelCollapsed: !model.isProductPanelCollapsed } }),
		ChangedBreakdownAttribute: ({ value }) =>
			productEdit(
				{ ...model, breakdownAttribute: { isActive: true, key: value } },
				context,
				ProductEdit.SetBreakdown({ value: breakdownValueOf(value) }),
			),
		CompletedFetchSuggestions: (fetched) => acceptSuggestions(model, fetched),
		FocusedQueryEditor: () =>
			model.isAutocompleteActive
				? { model }
				: requestAutocomplete({ ...model, isAutocompleteActive: true }, context),
		// A failed read is forgotten, so the next edit asks again instead of leaving the picker empty.
		CompletedFetchMetricKeys: ({ metric, result }) =>
			Result.isSuccess(result)
				? { model: { ...model, metricKeys: { ...model.metricKeys, [metric]: result.success } } }
				: { model: { ...model, metricKeysRequested: model.metricKeysRequested.filter((key) => key !== metric) } },
		CompletedFetchMetricOptions: ({ search, result }) => {
			if (search !== model.metricSearch) return { model }
			if (!Result.isSuccess(result)) return { model: { ...model, metricRequested: null } }
			const listed = { ...model, metricOptions: { search, ...result.success } }
			// A metrics query without a metric yet takes the first one listed.
			return listed.state !== null && listed.state.queries.some((query) => query.dataSource === "metrics" && query.metricName === "")
				? edit(listed, context, (state) => withDefaultMetric(state, result.success.options))
				: { model: listed }
		},
		CompletedFetchAutocomplete: ({ key, lookup, result }) => {
			const slot = model.autocomplete[lookup]
			return slot === undefined
				? { model }
				: {
						model: {
							...model,
							autocomplete: {
								...model.autocomplete,
								[lookup]: Keyed.accept(slot, key, result),
							},
						},
					}
		},
	})
