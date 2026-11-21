import type { Html, HtmlBuilder } from "foldkit/html"
import { tokenizeSql } from "../lib/sql-highlight"
import { codeEditor } from "./code-editor"

/** `SqlEditor`: a SQL textarea whose text is drawn, syntax-highlighted, by a `<pre>` laid under it. */
export type SqlEditorOptions<M> = Readonly<{
	id: string
	/** Accessible name ("SQL query"). */
	label: string
	value: string
	onInput: (value: string) => M
}>

export const sqlEditor = <M>(h: HtmlBuilder<M>, options: SqlEditorOptions<M>): Html =>
	codeEditor(h, { ...options, tokens: tokenizeSql(options.value), size: "tall" })
