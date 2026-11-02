import type { Html, HtmlBuilder } from "foldkit/html"
import { tokenizeSql } from "../lib/sql-highlight"

/** `SqlEditor`: a SQL textarea whose text is drawn, syntax-highlighted, by a `<pre>` laid under it. */
export type SqlEditorOptions<M> = Readonly<{
	id: string
	/** Accessible name ("SQL query"). */
	label: string
	value: string
	onInput: (value: string) => M
}>

export const sqlEditor = <M>(h: HtmlBuilder<M>, options: SqlEditorOptions<M>): Html =>
	h.div(
		[h.Class("relative w-full text-xs font-mono leading-5"), h.DataAttribute("slot", "sql-editor")],
		[
			h.pre(
				[
					h.AriaHidden(true),
					h.Class(
						"pointer-events-none absolute inset-0 m-0 overflow-hidden whitespace-pre-wrap break-words rounded-sm border border-transparent px-2 py-1.5 leading-5",
					),
				],
				[
					h.code(
						[h.Class("font-mono")],
						[
							...tokenizeSql(options.value).map((token) =>
								h.span(token.className === undefined ? [] : [h.Class(token.className)], [
									token.text,
								]),
							),
							"\n",
						],
					),
				],
			),
			h.textarea([
				h.Id(options.id),
				h.AriaLabel(options.label),
				h.Value(options.value),
				h.OnInput(options.onInput),
				h.Spellcheck(false),
				h.Class(
					"relative w-full bg-transparent text-transparent caret-foreground border border-border rounded-sm px-2 py-1.5 min-h-[200px] resize-y outline-none focus:ring-1 focus:ring-foreground/20 leading-5",
				),
			]),
		],
	)
