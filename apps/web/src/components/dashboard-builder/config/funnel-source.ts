import { resetQueryForDataSource } from "@maple/query-engine/query-builder"
import { emptyEventStep } from "@/components/funnels/definition"
import type { QueryBuilderWidgetState } from "@/lib/query-builder/widget-builder-shared"

/**
 * On a funnel, "Product events" on query A means the step editor. Keeps
 * `funnel.source` and the first query's `dataSource` telling the same story
 * after either the type or the source changes: a funnel over a product-event
 * query opens the step editor, and leaving the funnel type turns those steps
 * back into a plain product-event count query.
 */
export function reconcileFunnelSource(state: QueryBuilderWidgetState): QueryBuilderWidgetState {
	const first = state.queries[0]
	if (state.visualization === "funnel") {
		if (first?.dataSource !== "product_events") {
			return state.funnel.source === "product_events"
				? { ...state, funnel: { ...state.funnel, source: "query_set" } }
				: state
		}
		if (state.funnel.source === "product_events") return state
		return {
			...state,
			funnel: {
				...state.funnel,
				source: "product_events",
				steps: state.funnel.steps.length > 0 ? state.funnel.steps : [emptyEventStep()],
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
