import { parseWhereClause } from "../../../lib/traces/advanced-filter-sync"
import {
	tokenizeWhereClause,
	WHERE_CLAUSE_TOKEN_COLOR,
} from "../../../lib/query-builder/where-clause-highlight"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { alert, alertDescription } from "../../../ui/alert"
import { button } from "../../../ui/button"
import { kbd } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { formDialog } from "../../../ui/form-dialog"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { textarea } from "../../../ui/textarea"
import { autocompleteOf, isSuggesting } from "./advanced"
import { ADVANCED_TEXTAREA_ID, MountSuggestions, MountWhereEditor } from "./command"
import { Message } from "./message"
import type { Model } from "./model"

// The advanced filter dialog around `WhereClauseEditor`.

type H = HtmlBuilder<Message>

const TEXTAREA_CLASS = "font-mono text-sm leading-relaxed resize-y min-h-[200px] max-h-[40vh]"

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
					"fixed z-[60] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-popup",
				),
				h.OnMount(MountSuggestions()),
			],
			suggestions.map((suggestion, index) => {
				const isActive = index === model.advanced.activeIndex
				return pressable(
					h,
					{
						onClick: Message.ClickedAdvancedSuggestion({ index }),
						className: cn(
							"flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs",
							isActive ? "bg-accent text-accent-foreground" : "hover:bg-surface-sunken active:bg-surface-sunken",
						),
						attributes: [
							h.Key(suggestion.id),
							h.Role("option"),
							h.AriaSelected(isActive),
							h.OnMouseDown(Message.CompletedPlaceAdvancedCursor()),
						],
					},
					[
						h.span(
							[h.Class("min-w-0 truncate font-mono"), h.Title(suggestion.label)],
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
									tokenizeWhereClause(draft).map((token) =>
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

const warningsOf = (h: H, draft: string): ReadonlyArray<Html> => {
	const { warnings } = parseWhereClause(draft)
	return warnings.length === 0
		? []
		: [
				alert(h, { variant: "warn", size: "sm", className: "mt-2" }, [
					icon(h, "CircleWarningIcon", { size: 14 }),
					alertDescription(
						h,
						[
							h.ul(
								[h.Class("space-y-1")],
								warnings.map((warning) => h.li([], [warning])),
							),
						],
						"text-severity-warn",
					),
				]),
			]
}

export const advancedFilterDialog = (h: H, model: Model): Html =>
	formDialog(h, {
		slotId: "traces-advanced-filter",
		model: model.advanced.dialog,
		toParentMessage: (message) => Message.GotAdvancedDialogMessage({ message }),
		title: "Advanced filter",
		description: [
			"Write SQL-like queries to filter traces. Use ",
			kbd(h, undefined, ["Ctrl+Space"]),
			" for autocomplete. Press ",
			kbd(h, undefined, ["Cmd+Enter"]),
			" to apply.",
		],
		className: "sm:max-w-3xl",
		panelClassName: "space-y-0",
		onSubmit: Message.SubmittedAdvanced(),
		submitLabel: "Apply filter",
		footerStart: button(
			h,
			{
				variant: "ghost",
				className: "text-muted-foreground",
				attributes: [h.OnClick(Message.ClickedClearAdvanced())],
			},
			["Clear filter"],
		),
		fields: [editor(h, model), ...warningsOf(h, model.advanced.draft)],
	})
