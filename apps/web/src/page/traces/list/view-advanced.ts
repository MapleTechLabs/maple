import { parseWhereClause } from "../../../lib/traces/advanced-filter-sync"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "../../../lib/query-builder/where-clause-highlight"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { kbd } from "@maple/views/ui/display"
import { eyebrow } from "@maple/views/ui/eyebrow"
import { pressable } from "@maple/views/ui/pressable"
import { textarea } from "@maple/views/ui/textarea"
import {
	ADVANCED_TEXTAREA_CLASS,
	advancedFilterDialog as kitAdvancedFilterDialog,
} from "../../kit/advanced-filter"
import { autocompleteOf, isSuggesting } from "./advanced"
import { ADVANCED_TEXTAREA_ID, MountSuggestions, MountWhereEditor } from "./command"
import { Message } from "./message"
import type { Model } from "./model"
import { Array as Arr } from "effect"
import { typography } from "@maple/views/ui/typography"

// The advanced filter dialog around `WhereClauseEditor`.

type H = HtmlBuilder<Message>

const TEXTAREA_CLASS = ADVANCED_TEXTAREA_CLASS

/** The suggestions, a page-level portal (`createPortal(listbox, document.body)`). */
export const suggestionList = (h: H, model: Model): ReadonlyArray<Html> => {
	if (!isSuggesting(model)) return []
	const { suggestions } = autocompleteOf(model)
	return [
		h.div(
			[
				h.Key("where-suggestions"),
				h.Role("listbox"),
				h.AriaLabel("Where clause suggestions"),
				h.Class(
					"fixed z-60 overflow-auto rounded-lg border bg-popover text-popover-foreground shadow-popup",
				),
				h.OnMount(MountSuggestions()),
			],
			Arr.map(suggestions, (suggestion, index) => {
				const isActive = index === model.advanced.activeIndex
				return pressable(
					h,
					{
						onClick: Message.ClickedAdvancedSuggestion({ index }),
						className: cn(
							"flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs",
							isActive
								? "bg-accent text-accent-foreground"
								: "hover:bg-surface-sunken active:bg-surface-sunken",
						),
						attributes: [
							h.Key(suggestion.id),
							h.Role("option"),
							h.AriaSelected(isActive),
							h.OnMouseDown(Message.CompletedPlaceAdvancedCursor()),
						],
					},
					[
						typography(
							h,
							{
								mono: true,
								truncate: true,
								className: "min-w-0",
								attributes: [h.Title(suggestion.label)],
							},
							[suggestion.label],
						),
						eyebrow(h, { className: "shrink-0" }, [suggestion.kind]),
					],
				)
			}),
		),
	]
}

/** `WhereClauseEditor`: the textarea, its highlight overlay and the suggestions. */
const editor = (h: H, model: Model): Html => {
	const draft = model.advanced.draft
	const isHighlighting = draft.length > 0
	return h.div(
		[h.Class("relative w-full")],
		[
			h.div(
				[h.Class("contents"), h.OnMount(MountWhereEditor())],
				[
					textarea(h, {
						id: ADVANCED_TEXTAREA_ID,
						className: cn(TEXTAREA_CLASS, isHighlighting && "text-transparent caret-foreground"),
						attributes: [
							h.AriaLabel("Advanced traces where clause"),
							h.AriaExpanded(isSuggesting(model)),
							h.Placeholder('service.name = "checkout" AND attr.http.route != "/health"'),
							h.Rows(8),
							h.Value(draft),
						],
					}),
				],
			),
			...(isHighlighting
				? [
						h.div(
							[
								h.AriaHidden(true),
								h.Class(
									cn(
										"pointer-events-none absolute inset-0 overflow-hidden rounded-lg border border-transparent text-base sm:text-sm",
										TEXTAREA_CLASS,
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
									Arr.map(tokenizeWhereClause(draft), (token) =>
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

export const advancedFilterDialog = (h: H, model: Model): Html =>
	kitAdvancedFilterDialog(h, {
		slotId: "traces-advanced-filter",
		dialog: model.advanced.dialog,
		toDialogMessage: (message) => Message.GotAdvancedDialogMessage({ message }),
		description: [
			"Write SQL-like queries to filter traces. Use ",
			kbd(h, undefined, ["Ctrl+Space"]),
			" for autocomplete. Press ",
			kbd(h, undefined, ["Cmd+Enter"]),
			" to apply.",
		],
		onSubmit: Message.SubmittedAdvanced(),
		onClear: Message.ClickedClearAdvanced(),
		editor: editor(h, model),
		warnings: parseWhereClause(model.advanced.draft).warnings,
	})
