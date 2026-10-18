import type { TimeRange } from "@maple/domain/http"
import { Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import * as Dialog from "../../../ui/dialog"
import * as Tabs from "../../../ui/tabs"
import { type PageContext, PageOutMessage } from "../../contract"
import * as TimeRangePicker from "../../kit/time-range-picker"
import { SaveTimeRange, SaveWidget } from "./command"
import {
	addFormula,
	addQuery,
	cloneQuery,
	removeFormula,
	setPanelType,
} from "./edits"
import type { EditorState } from "./editor-state"
import { isNote, isTimeseriesPanel, validationErrorOf } from "./lowering"
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

const timePickerStep = (model: Model, context: PageContext, message: TimeRangePicker.Message): Return => {
	const next = TimeRangePicker.update(model.timePicker, message)
	const commands = Command.mapMessages(next.commands ?? [], (inner) =>
		Message.GotTimePickerMessage({ message: inner }),
	)
	const updated = { ...model, timePicker: next.model }
	if (next.outMessage === undefined) return { model: updated, commands }
	const timeRange: TimeRange = { type: "relative", value: next.outMessage.presetValue }
	if (model.timeRange?.type === "relative" && model.timeRange.value === timeRange.value)
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

const tabsStep = (model: Model, message: Tabs.Message): Return => {
	const next = Tabs.update(model.sourceTabs, message)
	return {
		model: {
			...model,
			sourceTabs: next.model,
			sourceMode: next.model.selected === "rawSql" ? "rawSql" : "builder",
		},
		commands: Command.mapMessages(next.commands ?? [], (inner) =>
			Message.GotSourceTabsMessage({ message: inner }),
		),
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

/** `applyChanges`: an invalid query set, or a save in flight, leaves Apply a no-op. */
const apply = (model: Model, context: PageContext): Return => {
	const widget = widgetOf(model)
	if (model.isSaving || widget === null || model.state === null) return { model }
	if (validationErrorOf(model.state) !== null) return { model }
	// TODO(widget-editor): the panel types this editor cannot configure yet keep Apply a no-op.
	if (!isNote(model.state) && !isTimeseriesPanel(model.state)) return { model }
	return {
		model: { ...model, isSaving: true },
		commands: [
			SaveWidget({
				orgId: context.orgId,
				dashboardId: model.dashboardId,
				widget: editedWidget(widget, model.state),
			}),
		],
	}
}

const edit = (model: Model, context: PageContext, change: (state: EditorState) => EditorState): Return =>
	editState(model, context, change)

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		UpdatedDashboard: (updated) => receiveDocument(model, context, updated),
		CompletedReadClock: ({ nowMs }) => planPreview({ ...model, nowMs }, context),
		MeasuredPreview: ({ widthPx }) =>
			widthPx === model.previewWidth
				? { model }
				: planPreview({ ...model, previewWidth: widthPx }, context),
		CompletedFetchWidget: (fetched) => ({ model: acceptFetch(model, fetched.key, fetched) }),
		ResolvedThemeColors: ({ colors }) => ({ model: { ...model, themeColors: colors } }),
		CompletedLoadChartRuntime: () => ({ model: { ...model, chartRuntime: { _tag: "Ready" } } }),
		FailedLoadChartRuntime: ({ reason }) => ({
			model: { ...model, chartRuntime: { _tag: "Failed", reason } },
		}),
		GotChartMessage: ({ message: inner }) => chartStep(model, inner),
		ClickedSortColumn: ({ field, isText }) => sortStep(model, field, isText),
		GotTimePickerMessage: ({ message: inner }) => timePickerStep(model, context, inner),
		CompletedSaveTimeRange: () => ({ model }),
		GotSourceTabsMessage: ({ message: inner }) => tabsStep(model, inner),
		GotSelectMessage: ({ id, message: inner }) => selectStep(model, context, id, inner),
		GotQueryPanelMessage: ({ message: inner }) => queryPanelStep(model, context, inner),
		ClickedAddQuery: () => ({ model, commands: generate("addQuery", "") }),
		ClickedAddFormula: () => ({ model, commands: generate("addFormula", "") }),
		GeneratedId: ({ purpose, source, id }) =>
			edit(model, context, (state) =>
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
		ClickedRunPreview: () => runPreview(model, context),
		ChangedTitle: ({ value }) => edit(model, context, (state) => ({ ...state, title: value })),
		ChangedMarkdown: ({ value }) =>
			edit(model, context, (state) => ({ ...state, markdownContent: value })),
		ChangedDescription: ({ value }) =>
			edit(model, context, (state) => ({ ...state, description: value })),
		ChangedTimeRangeMode: ({ mode }) => timeRangeModeStep(model, context, mode),
		ClickedPanelType: ({ panel }) =>
			isConfigurablePanel(panel)
				? edit(model, context, (state) => setPanelType(state, panel))
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
		ToggledPercentChange: () =>
			edit(model, context, (state) => ({
				...state,
				includePercentChange: !state.includePercentChange,
			})),
		ClickedApply: () => apply(model, context),
		CompletedSave: ({ error }) =>
			error === null
				? navigate({ ...model, isSaving: false }, backHref(model))
				: {
						model: { ...model, isSaving: false },
						outMessage: PageOutMessage.RequestedToast({
							type: "error",
							title: error,
							description: "",
							timeoutMs: null,
							action: null,
						}),
					},
		ClickedCancel: () => leave(model, backHref(model)),
		GotLeaveDialogMessage: ({ message: inner }) => leaveDialogStep(model, inner),
		ClickedDiscard: () => {
			const closed = Dialog.close(model.leaveDialog)
			return {
				...navigate(
					{ ...model, leaveDialog: closed.model, initial: model.state, sourceMode: "builder" },
					backHref(model),
				),
				commands: Command.mapMessages(closed.commands ?? [], (inner) =>
					Message.GotLeaveDialogMessage({ message: inner }),
				),
			}
		},
		FocusedQueryEditor: () =>
			model.isAutocompleteActive
				? { model }
				: requestAutocomplete({ ...model, isAutocompleteActive: true }, context),
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
