import { cn } from "@maple/ui/lib/utils"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "@maple/web/lib/query-builder/where-clause-highlight"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { textarea } from "../../../ui/textarea"

/**
 * `WhereClauseEditor` (components/query-builder/where-clause-editor.tsx): the textarea under its
 * highlight overlay. Enter never inserts a newline. TODO(query-builder): the suggestions listbox.
 */
export type WhereEditorOptions<M> = Readonly<{
	id: string
	value: string
	ariaLabel: string
	placeholder: string
	rows?: number
	/** `className`: the wrapper's, after `relative`. */
	className?: string
	textareaClassName: string
	onInput: (value: string) => M
	/** Enter is swallowed (never a newline) and reported. */
	onEnter: M
}>

export const whereEditor = <M>(h: HtmlBuilder<M>, options: WhereEditorOptions<M>): Html => {
	const isHighlighting = options.value.length > 0
	return h.div(
		[h.Class(cn("relative", options.className))],
		[
			textarea(h, {
				id: options.id,
				className: cn(
					options.textareaClassName,
					isHighlighting && "text-transparent caret-foreground",
				),
				defaultValue: options.value,
				attributes: [
					h.AriaLabel(options.ariaLabel),
					h.Placeholder(options.placeholder),
					h.Rows(options.rows ?? 2),
					h.OnInput(options.onInput),
					// Where clauses are single-line.
					h.OnKeyDownPreventDefault((key) =>
						key === "Enter" ? Option.some(options.onEnter) : Option.none(),
					),
				],
			}),
			...(isHighlighting
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(
									cn(
										"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
										options.textareaClassName,
									),
								),
							],
							[
								h.div(
									[
										h.Class(
											"px-[calc(--spacing(3)-1px)] py-[calc(--spacing(1.5)-1px)] break-words whitespace-pre-wrap",
										),
									],
									tokenizeWhereClause(options.value).map((token) =>
										h.span(
											[h.Style({ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] })],
											[token.text],
										),
									),
								),
							],
						),
					]
				: []),
		],
	)
}
