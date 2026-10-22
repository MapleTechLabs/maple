import type { PanelType } from "@maple/domain/http"
import {
	createFormulaDraft,
	createQueryDraft,
	formulaLabel,
	queryLabel,
	resetQueryForDataSource,
	type QueryBuilderDataSource,
} from "@maple/query-engine/query-builder"
import { fromPanelType } from "../kit/chart-registry"
import { inferDefaultUnitForQueries } from "./drafts"
import type { EditorState, QueryDraft } from "./editor-state"

// `useWidgetBuilder`'s actions and the page's query handlers, as pure state steps.

export const updateQuery = (
	state: EditorState,
	queryId: string,
	update: (query: QueryDraft) => QueryDraft,
): EditorState => ({
	...state,
	queries: state.queries.map((query) => (query.id === queryId ? update(query) : query)),
})

/** A change that can move the inferred unit: the unit follows the queries when they agree. */
export const withInferredUnit = (state: EditorState): EditorState => ({
	...state,
	unit: inferDefaultUnitForQueries(state.queries) ?? state.unit,
})

export const setAggregation = (state: EditorState, queryId: string, aggregation: string): EditorState =>
	withInferredUnit(updateQuery(state, queryId, (query) => ({ ...query, aggregation })))

export const setDataSource = (
	state: EditorState,
	queryId: string,
	dataSource: QueryBuilderDataSource,
): EditorState =>
	reconcileFunnelSource(
		withInferredUnit(updateQuery(state, queryId, (query) => resetQueryForDataSource(query, dataSource))),
	)

/** `addQuery`: a default draft under the next letter. */
export const addQuery = (state: EditorState, id: string): EditorState => ({
	...state,
	queries: [...state.queries, { ...createQueryDraft(state.queries.length), id }],
})

/** `cloneQuery`: a copy appended, then every query relettered in order. */
export const cloneQuery = (state: EditorState, sourceId: string, id: string): EditorState => {
	const source = state.queries.find((query) => query.id === sourceId)
	if (source === undefined) return state
	return {
		...state,
		queries: [...state.queries, { ...source, id }].map((query, index) => ({
			...query,
			name: queryLabel(index),
		})),
	}
}

/** `removeQuery`: the last query stays. */
export const removeQuery = (state: EditorState, queryId: string): EditorState =>
	state.queries.length === 1
		? state
		: {
				...state,
				queries: state.queries
					.filter((query) => query.id !== queryId)
					.map((query, index) => ({ ...query, name: queryLabel(index) })),
			}

export const addFormula = (state: EditorState, id: string): EditorState => ({
	...state,
	formulas: [
		...state.formulas,
		{
			...createFormulaDraft(
				state.formulas.length,
				state.queries.map((query) => query.name),
			),
			id,
		},
	],
})

export const removeFormula = (state: EditorState, formulaId: string): EditorState => ({
	...state,
	formulas: state.formulas
		.filter((formula) => formula.id !== formulaId)
		.map((formula, index) => ({ ...formula, name: formulaLabel(index) })),
})

export { withRootOnly } from "../../kit/query-builder/change"

/**
 * `reconcileFunnelSource` (funnel-source.ts): on a funnel, a product-event query A means the step
 * editor; leaving the funnel type turns those steps back into a product-event count query.
 */
export const reconcileFunnelSource = (state: EditorState): EditorState => {
	const first = state.queries[0]
	if (state.visualization === "funnel") {
		if (first?.dataSource !== "product_events")
			return state.funnel.source === "product_events"
				? { ...state, funnel: { ...state.funnel, source: "query_set" } }
				: state
		if (state.funnel.source === "product_events") return state
		return {
			...state,
			funnel: {
				...state.funnel,
				source: "product_events",
				steps: state.funnel.steps.length > 0 ? state.funnel.steps : [{ kind: "event", eventName: "" }],
			},
		}
	}
	if (state.funnel.source !== "product_events") return state
	return {
		...state,
		funnel: { ...state.funnel, source: "query_set" },
		queries: state.queries.map((query, index) =>
			index === 0 && query.dataSource !== "product_events"
				? resetQueryForDataSource(query, "product_events")
				: query,
		),
	}
}

/** `TypePicker`: the panel's persisted pair, keeping a chart id already of that panel. */
export const setPanelType = (state: EditorState, panel: PanelType): EditorState => {
	const { visualization, chartId } = fromPanelType(panel, state.chartId)
	return reconcileFunnelSource({ ...state, visualization, chartId: chartId ?? state.chartId })
}
