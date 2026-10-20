import { getMetricsAggregations } from "@maple/query-engine/query-builder"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Combobox from "../../../ui/combobox"
import * as ComboboxView from "../../../ui/combobox-view"
import { eyebrow } from "../../../ui/eyebrow"
import type { QueryDraft } from "./draft"
import { Message, metricBreakdownIdOf, metricPickerIdOf, type Model } from "./panel"
import { panelSelect, textInput, whereClauseEditor } from "./parts"

// `MetricsBody`: the metric picker, the where clause, and the two aggregation rows
// with the one-field breakdown.
// The where editor's values are scoped to the picked metric (`useMetricScopedAutocomplete`).

type H = HtmlBuilder<Message>
type MetricsQuery = Extract<QueryDraft, { dataSource: "metrics" }>

export type MetricOption = Readonly<{ value: string; label: string; isMonotonic: boolean }>

const NONE = "__none__"

/** A combobox kept by query id; closed, its input reads the draft's value as Base UI's does. */
const comboOf = (stored: Combobox.Model | undefined, id: string, value: string): Combobox.Model => {
	const current = stored ?? Combobox.init(id, "single")
	return {
		...current,
		selected: value === "" ? [] : [value],
		inputValue: current.isOpen ? current.inputValue : value,
	}
}

/** The fetched page, with the draft's metric kept selectable when the page lacks it. */
const optionsWith = (query: MetricsQuery, value: string, options: ReadonlyArray<MetricOption>) =>
	value === "" || options.some((option) => option.value === value)
		? options
		: [{ value, label: `${query.metricName} (${query.metricType})`, isMonotonic: query.isMonotonic }, ...options]

const picker = (h: H, model: Model, query: MetricsQuery, options: ReadonlyArray<MetricOption>, searchTerm: string): Html => {
	const value = query.metricName === "" ? "" : `${query.metricName}::${query.metricType}`
	const listed = optionsWith(query, value, options)
	const term = searchTerm.trim()
	return h.submodel({
		slotId: `${model.slotPrefix}-metric-${query.id}`,
		model: comboOf(model.metricPickers[query.id], metricPickerIdOf(query.id), value),
		view: ComboboxView.view,
		toParentMessage: (message) => Message.GotMetricMessage({ queryId: query.id, value, message }),
		viewInputs: {
			items: listed.map((option) => option.value),
			placeholder: "Search metrics...",
			// `MetricOptionsEmpty` replaces the list only when nothing is listed.
			emptyText: listed.length > 0 ? "" : term === "" ? "No metrics found." : `No metric name contains "${term}".`,
			highlightsSelected: true,
			// Measured: the positioner resolves the input (30 px), not the input group.
			anchorsInput: true,
			renderItem: (item) => [listed.find((option) => option.value === item)?.label ?? item],
			isUnfiltered: true,
			className: "h-8 flex-1 text-xs",
			toView: ({ field, rest }) =>
				h.div(
					[h.Class("flex items-center gap-2")],
					[h.span([h.Class("text-xs text-muted-foreground shrink-0")], ["Metric"]), field, ...rest],
				),
		},
	})
}

const breakdown = (h: H, model: Model, query: MetricsQuery, keys: ReadonlyArray<string>): Html => {
	const value =
		!query.addOns.groupBy || query.groupBy.length === 0 || (query.groupBy.length === 1 && query.groupBy[0] === "none")
			? NONE
			: (query.groupBy[0] ?? NONE)
	return h.submodel({
		slotId: `${model.slotPrefix}-metric-by-${query.id}`,
		model: comboOf(model.metricBreakdowns[query.id], metricBreakdownIdOf(query.id), value),
		view: ComboboxView.view,
		toParentMessage: (message) => Message.GotMetricBreakdownMessage({ queryId: query.id, message }),
		viewInputs: {
			items: [NONE, "service.name", ...keys.map((key) => `attr.${key}`)],
			placeholder: "Search fields...",
			emptyText: "",
			highlightsSelected: true,
			// Measured: the positioner resolves the input (30 px), not the input group.
			anchorsInput: true,
			renderItem: (item) => [item === NONE ? "Everything (no breakdown)" : item],
			isUnfiltered: true,
			className: "h-8 w-[220px] text-xs",
			toView: ({ field, rest }) => h.div([h.Class("contents")], [field, ...rest]),
		},
	})
}

const aggregationRow = (
	h: H,
	model: Model,
	query: MetricsQuery,
	field: "aggregation" | "aggregation-across",
	label: string,
	tail: ReadonlyArray<Html>,
): Html =>
	panelSelect(h, model, `${field}:${query.id}`, query.aggregation, getMetricsAggregations(query.metricType, query.isMonotonic), {
		size: "sm",
		className: "w-24",
		toView: (parts) =>
			h.div(
				[h.Class("flex items-center gap-2 flex-wrap")],
				[eyebrow(h, { className: "shrink-0" }, [label]), ...parts, ...tail],
			),
	})

export const metricsBody = (
	h: H,
	model: Model,
	query: MetricsQuery,
	inputs: Readonly<{
		options: ReadonlyArray<MetricOption>
		searchTerm: string
		breakdownKeys: ReadonlyArray<string>
		intervalPlaceholder: string
		autocompleteValues: WhereClauseAutocompleteValues
	}>,
): ReadonlyArray<Html> => [
	picker(h, model, query, inputs.options, inputs.searchTerm),
	whereClauseEditor(h, model, query, inputs.autocompleteValues, { placeholder: 'service.name = "my-service"', className: "relative" }),
	aggregationRow(h, model, query, "aggregation", "Aggregate within time series", [
		h.span([h.Class("text-xs text-muted-foreground")], ["every"]),
		textInput(h, `step-${query.id}`, query.stepInterval, inputs.intervalPlaceholder, "h-8 w-24 text-xs", (value) =>
			Message.ChangedText({ queryId: query.id, field: "stepInterval", value }),
		),
		h.span([h.Class("text-xs text-muted-foreground")], ["seconds"]),
	]),
	aggregationRow(h, model, query, "aggregation-across", "Aggregate across time series", [
		h.span([h.Class("text-xs text-muted-foreground")], ["by"]),
		breakdown(h, model, query, inputs.breakdownKeys),
	]),
]
