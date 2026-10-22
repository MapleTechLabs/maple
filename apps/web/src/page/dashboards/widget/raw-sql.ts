import { rawSqlDisplayTypeFor, widgetTypeByVisualization } from "@maple/domain/http"
import { RAW_SQL_TEMPLATES } from "../../../lib/raw-sql/templates"
import { dataSourceRawSql, dataSourceTransform, makeRawSqlDataSource } from "@maple/widgets/dashboard"
import { Schema } from "effect"
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
	if (previous === next || rawSql.draft.sql.trim() !== RAW_SQL_TEMPLATES[previous].trim()) return rawSql
	const reseeded = { ...rawSql.draft, sql: RAW_SQL_TEMPLATES[next] }
	return { ...rawSql, draft: reseeded, staged: reseeded }
}

/** `buildRawSqlDataSource`: a stat or gauge without a reduction reads the first row's `value`. */
export const rawSqlDataSourceOf = (
	widget: Widget,
	draft: RawSqlDraft,
	state: TypePair,
): Widget["dataSource"] => {
	const existing = dataSourceTransform(widget.dataSource)
	const needsScalar = widgetTypeByVisualization(state.visualization)?.isScalar === true
	const transform =
		needsScalar && existing?.reduceToValue === undefined
			? { ...existing, reduceToValue: { field: "value", aggregate: "first" as const } }
			: existing
	return makeRawSqlDataSource({
		sql: draft.sql,
		displayType: displayTypeOf(state),
		...(draft.granularitySeconds === null ? undefined : { granularitySeconds: draft.granularitySeconds }),
		...(transform === undefined ? undefined : { transform }),
	})
}

/** Raw SQL must reference `$__orgFilter`: every query is tenant-scoped through that macro. */
export const rawSqlErrorOf = (draft: RawSqlDraft): string | null =>
	draft.sql.includes("$__orgFilter")
		? null
		: "SQL must include $__orgFilter so the query is scoped to your organization"
