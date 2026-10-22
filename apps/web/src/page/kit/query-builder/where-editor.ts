import { cn } from "@maple/ui/lib/utils"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "../../../lib/query-builder/where-clause-highlight"
import { Option } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { textarea } from "../../../ui/textarea"
import { isOpenOf } from "../where-autocomplete"
import { suggestionListbox, whereKeyHandler } from "../where-autocomplete-view"
import { type WhereFields, WhereFieldMessage } from "../where-field"
import { MountWhereFieldCaret, MountWhereFieldListbox } from "../where-field-command"
import { autocompleteOf, caretOf, type WhereFieldSpec } from "../where-field-update"

/** The suggestions of a field kept in the owner's `WhereFields` (`page/kit/where-field.ts`). */
export type WhereEditorAutocomplete<M> = Readonly<{
	fields: WhereFields
	fieldId: string
	/** The field's spec; its `expression` is the editor's `value`. */
	spec: WhereFieldSpec
	toMessage: (message: WhereFieldMessage) => M
}>

/**
 * `WhereClauseEditor`: the textarea under its
 * highlight overlay, and with `autocomplete` its suggestion list. Enter never inserts a newline.
 */
export type WhereEditorOptions<M> = Readonly<
	{
		id: string
		value: string
		ariaLabel: string
		placeholder: string
		rows?: number
		/** `className`: the wrapper's, after `relative`. */
		className?: string
		textareaClassName: string
		onInput: (value: string) => M
	} & (
		| { /** Enter is swallowed and reported. */ onEnter: M; autocomplete?: undefined }
		| { autocomplete: WhereEditorAutocomplete<M>; onEnter?: undefined }
	)
>

/** The key handling, caret Mount and open list: Enter alone without `autocomplete`. */
const suggestionsOf = <M>(h: HtmlBuilder<M>, options: WhereEditorOptions<M>) => {
	const ac = options.autocomplete
	if (ac === undefined) {
		const onEnter = options.onEnter
		return {
			onKey: (key: string) =>
				key === "Enter" && onEnter !== undefined ? Option.some(onEnter) : Option.none<M>(),
			mounts: [],
			listbox: [],
		}
	}
	const { fieldId, toMessage } = ac
	const caret = caretOf(ac.fields, fieldId, ac.spec)
	const autocomplete = autocompleteOf(ac.fields, fieldId, ac.spec)
	const isOpen = isOpenOf(caret, autocomplete)
	return {
		onKey: whereKeyHandler<M>(isOpen, {
			enter: toMessage(WhereFieldMessage.PressedEnter({ fieldId })),
			move: (step) => toMessage(WhereFieldMessage.MovedSuggestion({ fieldId, step })),
			tab: toMessage(WhereFieldMessage.PressedTab({ fieldId })),
			dismiss: toMessage(WhereFieldMessage.DismissedSuggestions({ fieldId })),
		}),
		mounts: [h.OnMount(Mount.mapMessage(MountWhereFieldCaret({ fieldId }), toMessage))],
		listbox: isOpen
			? [
					suggestionListbox(h, {
						suggestions: autocomplete.suggestions,
						activeIndex: caret.activeIndex,
						anchor: caret.anchor,
						onApply: (index) =>
							toMessage(WhereFieldMessage.AppliedSuggestion({ fieldId, index })),
						keepFocus: h.OnMount(
							Mount.mapMessage(
								MountWhereFieldListbox({ fieldId, textareaId: ac.spec.textareaId }),
								toMessage,
							),
						),
					}),
				]
			: [],
	}
}

export const whereEditor = <M>(h: HtmlBuilder<M>, options: WhereEditorOptions<M>): Html => {
	const isHighlighting = options.value.length > 0
	const suggestions = suggestionsOf(h, options)
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
					h.OnKeyDownPreventDefault(suggestions.onKey),
					...suggestions.mounts,
				],
			}),
			...highlightOverlay(h, options.value, options.textareaClassName),
			...suggestions.listbox,
		],
	)
}

/** The colored tokens drawn over a transparent textarea, matching its box. */
export const highlightOverlay = <M>(
	h: HtmlBuilder<M>,
	whereClause: string,
	textareaClassName: string,
): ReadonlyArray<Html> =>
	whereClause.length === 0
		? []
		: [
				h.div(
					[
						h.AriaHidden(true),
						h.Class(
							cn(
								"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
								textareaClassName,
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
							tokenizeWhereClause(whereClause).map((token) =>
								h.span(
									[h.Style({ color: WHERE_CLAUSE_TOKEN_COLOR[token.type] })],
									[token.text],
								),
							),
						),
					],
				),
			]
