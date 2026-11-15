import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import { dataSourcePromql, dataSourceTransform, makePromqlDataSource } from "@maple/widgets/dashboard"
import { Record as Rec, Schema, String as Str } from "effect"
import type { EditorState } from "./editor-state"
import { parseRowLimit, type Widget } from "./lowering"

// The PromQL draft, the staged copy the preview runs, and the `promql` data source Apply writes.

export const PromqlDraft = Schema.Struct({
	query: Schema.String,
	legendFormat: Schema.String,
	minStepSeconds: Schema.NullOr(Schema.Number),
})
export type PromqlDraft = typeof PromqlDraft.Type

export const PromqlState = Schema.Struct({
	draft: PromqlDraft,
	/** Run preview stages the draft: typing does not refire the query. */
	staged: PromqlDraft,
	initial: PromqlDraft,
})
export type PromqlState = typeof PromqlState.Type

/** A query to start from: the request rate per service over the window's step. */
export const PROMQL_TEMPLATE =
	"sum by (job) (rate(http_server_request_duration_seconds_count[$__rate_interval]))"

/** The widget's PromQL, or the template while it has none. */
export const promqlDraftOf = (widget: Widget): PromqlDraft => {
	const promql = dataSourcePromql(widget.dataSource)
	return promql !== null && promql.query.length > 0
		? {
				query: promql.query,
				legendFormat: promql.legendFormat ?? "",
				minStepSeconds: promql.minStepSeconds ?? null,
			}
		: { query: PROMQL_TEMPLATE, legendFormat: "", minStepSeconds: null }
}

export const initPromql = (widget: Widget): PromqlState => {
	const draft = promqlDraftOf(widget)
	return { draft, staged: draft, initial: draft }
}

/** What blocks Run preview and Apply: an empty query. The parser's verdict comes from the preview. */
export const isRunnablePromql = (promql: PromqlState): boolean => Str.trim(promql.draft.query) !== ""

/** A stat or gauge reduces `value`, newest point first, with the picked aggregate. */
export const promqlDataSourceOf = (
	widget: Widget,
	draft: PromqlDraft,
	state: Pick<EditorState, "visualization" | "chartId" | "statAggregate" | "tableLimit">,
): Widget["dataSource"] => {
	const stored =
		dataSourcePromql(widget.dataSource) === null ? undefined : dataSourceTransform(widget.dataSource)
	const { reduceToValue: _previous, ...kept } = stored ?? {}
	const isScalar = widgetTypeByVisualization(state.visualization)?.isScalar === true
	// A table writes the Row limit picked in the editor; clearing it removes the stored one.
	const isTable = rawSqlDisplayTypeFor(state.visualization, state.chartId) === "table"
	const { limit: _limit, ...unlimited } = kept
	const rowLimit = parseRowLimit(state.tableLimit)
	const limited = !isTable ? kept : rowLimit === undefined ? unlimited : { ...unlimited, limit: rowLimit }
	const transform = isScalar
		? { ...limited, reduceToValue: { field: "value", aggregate: state.statAggregate } }
		: limited
	const legendFormat = Str.trim(draft.legendFormat)
	return makePromqlDataSource({
		query: draft.query,
		displayType: rawSqlDisplayTypeFor(state.visualization, state.chartId),
		...(legendFormat === "" ? undefined : { legendFormat: draft.legendFormat }),
		...(draft.minStepSeconds === null ? undefined : { minStepSeconds: draft.minStepSeconds }),
		...(Rec.keys<string, unknown>(transform).length === 0 ? undefined : { transform }),
	})
}

/** The parser's message, when the preview failed on the query itself. */
export const promqlParseErrorOf = (message: string | null): string | null =>
	message !== null && Str.startsWith("Invalid PromQL: ")(message) ? message : null
