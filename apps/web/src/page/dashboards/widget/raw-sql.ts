import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import { rawSqlIssue } from "@maple/domain/raw-sql"
import { RAW_SQL_TEMPLATES } from "../../../lib/raw-sql/templates"
import { dataSourceRawSql, dataSourceTransform, makeRawSqlDataSource } from "@maple/widgets/dashboard"
import { Array as Arr, Schema, String as Str, Record as Rec } from "effect"
import { toSeriesFieldOptions } from "./drafts"
import type { EditorState } from "./editor-state"
import type { Widget } from "./lowering"

// The editor's Raw SQL source (`readRawSqlDraftFromWidget`, `buildRawSqlDataSource`): the SQL
// draft, the staged copy the preview runs, and the
// `raw_sql` data source Apply writes for the type picked in the editor.

export const RawSqlDraft = Schema.Struct({
	sql: Schema.String,
	granularitySeconds: Schema.NullOr(Schema.Number),
})
export type RawSqlDraft = typeof RawSqlDraft.Type

export const RawSqlState = Schema.Struct({
	draft: RawSqlDraft,
	/** Run preview stages the draft: typing does not refire the SQL. */
	staged: RawSqlDraft,
	initial: RawSqlDraft,
	isCollapsed: Schema.Boolean,
})
export type RawSqlState = typeof RawSqlState.Type

type TypePair = Pick<EditorState, "visualization" | "chartId">

const displayTypeOf = (state: TypePair) => rawSqlDisplayTypeFor(state.visualization, state.chartId)

/** The widget's SQL, or the template of its display type while it has none. */
export const draftOf = (widget: Widget): RawSqlDraft => {
	const rawSql = dataSourceRawSql(widget.dataSource)
	return rawSql !== null && rawSql.sql.length > 0
		? { sql: rawSql.sql, granularitySeconds: rawSql.granularitySeconds ?? null }
		: {
				sql: RAW_SQL_TEMPLATES[rawSqlDisplayTypeFor(widget.visualization, widget.display.chartId)],
				granularitySeconds: null,
			}
}

export const initRawSql = (widget: Widget): RawSqlState => {
	const draft = draftOf(widget)
	return { draft, staged: draft, initial: draft, isCollapsed: false }
}

/** A pristine template follows the panel type; SQL the user has written is never replaced. */
export const reseedForType = (rawSql: RawSqlState, before: TypePair, after: TypePair): RawSqlState => {
	const previous = displayTypeOf(before)
	const next = displayTypeOf(after)
	if (previous === next || Str.trim(rawSql.draft.sql) !== Str.trim(RAW_SQL_TEMPLATES[previous]))
		return rawSql
	const reseeded = { ...rawSql.draft, sql: RAW_SQL_TEMPLATES[next] }
	return { ...rawSql, draft: reseeded, staged: reseeded }
}

/** The column a SQL stat or gauge reduces while none is typed: the templates' `value`. */
export const SQL_VALUE_FIELD = "value"

type FieldState = Pick<EditorState, "statValueField" | "queries" | "formulas">

/** The SQL value column: the typed field, never a Builder series name (that pick stays for the Builder). */
export const sqlValueFieldOf = (state: FieldState): string => {
	const field = Str.trim(state.statValueField)
	const builderNames = new Set([
		...toSeriesFieldOptions(state),
		...Arr.map(state.queries, (query) => query.name),
		...Arr.map(state.formulas, (formula) => formula.name),
	])
	return builderNames.has(field) ? "" : field
}

/** `buildRawSqlDataSource`: the transform follows the picked type, so only a stat or gauge reduces. */
export const rawSqlDataSourceOf = (
	widget: Widget,
	draft: RawSqlDraft,
	state: Pick<EditorState, "visualization" | "chartId" | "statAggregate"> & FieldState,
): Widget["dataSource"] => {
	// A builder or endpoint transform (field maps, hidden series) does not describe SQL rows.
	const stored =
		dataSourceRawSql(widget.dataSource) === null ? undefined : dataSourceTransform(widget.dataSource)
	const { reduceToValue: _previous, ...kept } = stored ?? {}
	const isScalar = widgetTypeByVisualization(state.visualization)?.isScalar === true
	const field = sqlValueFieldOf(state)
	const transform = isScalar
		? {
				...kept,
				reduceToValue: {
					field: field === "" ? SQL_VALUE_FIELD : field,
					aggregate: state.statAggregate,
				},
			}
		: kept
	return makeRawSqlDataSource({
		sql: draft.sql,
		displayType: displayTypeOf(state),
		...(draft.granularitySeconds === null ? undefined : { granularitySeconds: draft.granularitySeconds }),
		...(Rec.keys<string, unknown>(transform).length === 0 ? undefined : { transform }),
	})
}

/** Raw SQL must reference `$__orgFilter`: every query is tenant-scoped through that macro. */
export const rawSqlErrorOf = (draft: RawSqlDraft): string | null =>
	Str.includes("$__orgFilter")(draft.sql)
		? null
		: "SQL must include $__orgFilter so the query is scoped to your organization"

/**
 * The warehouse's own checks, org filter included. Edited SQL must also bound its
 * time range; SQL the widget was saved with before that rule is held to the old checks.
 */
export const rawSqlIssueOf = (rawSql: RawSqlState) =>
	rawSqlIssue(rawSql.draft.sql, {
		workload: rawSql.draft.sql === rawSql.initial.sql ? "interactive" : "dashboard",
	})

/** What blocks both Run preview and Apply. */
export const isRunnableSql = (rawSql: RawSqlState): boolean => rawSqlIssueOf(rawSql) === null
