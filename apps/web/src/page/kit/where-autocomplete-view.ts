import type { WhereClauseAutocompleteSuggestion } from "../../lib/query-builder/where-clause-autocomplete"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"
import { type AnchorRect, listboxStyle } from "./where-autocomplete"

// `WhereClauseEditor`'s suggestion list and key handling, generic over the owner's Message.

/** The suggestion list, fixed under (or over) the textarea. */
export const suggestionListbox = <M>(
	h: HtmlBuilder<M>,
	inputs: Readonly<{
		suggestions: ReadonlyArray<WhereClauseAutocompleteSuggestion>
		activeIndex: number
		anchor: AnchorRect | null
		onApply: (index: number) => M
		/** The Mount that keeps the textarea focused while a row is pressed. */
		keepFocus: Attribute<M>
	}>,
): Html =>
	h.div(
		[
			h.Role("listbox"),
			h.AriaLabel("Where clause suggestions"),
			h.Class(
				"fixed z-[60] overflow-auto rounded-md border bg-popover text-popover-foreground shadow-popup",
			),
			...(inputs.anchor === null ? [] : [h.Style(listboxStyle(inputs.anchor))]),
			inputs.keepFocus,
		],
		inputs.suggestions.map((suggestion, index) =>
			h.button(
				[
					h.Key(suggestion.id),
					h.Type("button"),
					h.Role("option"),
					h.AriaSelected(index === inputs.activeIndex),
					h.Class(
						cn(
							"flex w-full items-center justify-between gap-2 px-2 py-1 text-left text-xs",
							index === inputs.activeIndex
								? "bg-accent text-accent-foreground"
								: "hover:bg-accent/60 active:bg-accent/60",
						),
					),
					h.OnClick(inputs.onApply(index)),
				],
				[
					h.span(
						[h.Class("min-w-0 truncate font-mono"), h.Title(suggestion.label)],
						[suggestion.label],
					),
					eyebrow(h, { className: "shrink-0" }, [suggestion.kind]),
				],
			),
		),
	)

/**
 * `onKeyDown`: Enter never inserts a newline; arrows, Tab and Escape drive an open list. The
 * handler carries no list state: `update` reads the open list and its active row.
 */
export const whereKeyHandler =
	<M>(isOpen: boolean, messages: Readonly<{ enter: M; move: (step: number) => M; tab: M; dismiss: M }>) =>
	(key: string): Option.Option<M> => {
		if (key === "Enter") return Option.some(messages.enter)
		if (!isOpen) return Option.none()
		switch (key) {
			case "ArrowDown":
				return Option.some(messages.move(1))
			case "ArrowUp":
				return Option.some(messages.move(-1))
			case "Tab":
				return Option.some(messages.tab)
			case "Escape":
				return Option.some(messages.dismiss)
			default:
				return Option.none()
		}
	}
