import { Effect, Schema } from "effect"
import { Command } from "foldkit"
import type { PageContext } from "../../contract"
import { Message } from "./message"
import type { Model } from "./model"
import type { RawSqlState } from "./raw-sql"
import { planPreview, type Return } from "./update"

// `RawSqlEditorPanel`'s steps: typing, the bucket, the chips inserted at the caret, Run preview.

export const SQL_TEXTAREA_ID = "widget-editor-sql"

/** The macro or variable chip inserted at the caret, replacing any selection. */
export const InsertSqlToken = Command.define("InsertWidgetSqlToken", {
	args: { id: Schema.String, sql: Schema.String, token: Schema.String },
	messages: [Message.CompletedInsertSqlToken],
	execute: ({ id, sql, token }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			const textarea = element instanceof HTMLTextAreaElement ? element : null
			const start = textarea?.selectionStart ?? sql.length
			const end = textarea?.selectionEnd ?? start
			return Message.CompletedInsertSqlToken({
				sql: sql.slice(0, start) + token + sql.slice(end),
				caret: start + token.length,
			})
		}),
})

/** Editing continues after a chip: the caret lands after the inserted token. */
export const FocusSqlCaret = Command.define("FocusWidgetSqlCaret", {
	args: { id: Schema.String, caret: Schema.Number },
	messages: [Message.CompletedFocusSql],
	execute: ({ id, caret }) =>
		Effect.sync(() => {
			const element = document.getElementById(id)
			if (element instanceof HTMLTextAreaElement) {
				element.focus()
				element.setSelectionRange(caret, caret)
			}
			return Message.CompletedFocusSql()
		}),
})

type SqlMessage = Extract<
	Message,
	{
		readonly _tag:
			| "ChangedSql"
			| "ChangedSqlBucket"
			| "ClickedSqlToken"
			| "CompletedInsertSqlToken"
			| "CompletedFocusSql"
			| "ToggledSqlCollapsed"
	}
>

const withSql = (model: Model, change: (rawSql: RawSqlState) => RawSqlState): Model =>
	model.rawSql === null ? model : { ...model, rawSql: change(model.rawSql) }

/** The bucket input: empty is auto, anything else at least one second. */
const bucketOf = (value: string): number | null => (value === "" ? null : Math.max(1, Number(value)))

export const sqlStep = (model: Model, message: SqlMessage): Return => {
	const rawSql = model.rawSql
	switch (message._tag) {
		case "ChangedSql":
			return {
				model: withSql(model, (sql) => ({ ...sql, draft: { ...sql.draft, sql: message.value } })),
			}
		case "ChangedSqlBucket":
			return {
				model: withSql(model, (sql) => ({
					...sql,
					draft: { ...sql.draft, granularitySeconds: bucketOf(message.value) },
				})),
			}
		case "ClickedSqlToken":
			return rawSql === null
				? { model }
				: {
						model,
						commands: [
							InsertSqlToken({
								id: SQL_TEXTAREA_ID,
								sql: rawSql.draft.sql,
								token: message.token,
							}),
						],
					}
		case "CompletedInsertSqlToken":
			return {
				model: withSql(model, (sql) => ({ ...sql, draft: { ...sql.draft, sql: message.sql } })),
				commands: [FocusSqlCaret({ id: SQL_TEXTAREA_ID, caret: message.caret })],
			}
		case "CompletedFocusSql":
			return { model }
		case "ToggledSqlCollapsed":
			return { model: withSql(model, (sql) => ({ ...sql, isCollapsed: !sql.isCollapsed })) }
	}
}

/** Run preview in Raw SQL: the draft is staged and the preview re-planned. */
export const runSqlPreview = (model: Model, context: PageContext): Return =>
	planPreview(
		withSql(model, (sql) => ({ ...sql, staged: sql.draft })),
		context,
	)
