import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../../ui/eyebrow"
import { searchInput } from "../../../ui/search-input"

// Shared by the dashboards list and the template gallery.

/** `ListSectionHeader`: heading, count, rule, note. */
export const listSectionHeader = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; count: number; accent?: boolean; note?: string; className?: string }>,
): Html =>
	h.div(
		[h.Class(cn("flex items-center gap-2 pb-2", options.className))],
		[
			eyebrow(h, { variant: "label", as: "h3" }, [options.title]),
			h.span(
				[
					h.Class(
						cn(
							"font-mono text-2xs",
							options.accent === true ? "text-primary" : "text-muted-foreground",
						),
					),
				],
				[String(options.count)],
			),
			h.span([h.AriaHidden(true), h.Class("h-px grow bg-border")], []),
			...(options.note === undefined
				? []
				: [h.span([h.Class("text-muted-foreground text-2xs")], [options.note])]),
		],
	)

/** `ToolbarSearch` (`SearchInput` at the default size): the clear button empties the draft. */
export const toolbarSearch = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		id: string
		draft: string
		placeholder: string
		className: string
		onInput: (value: string) => M
	}>,
): Html =>
	searchInput(h, {
		id: options.id,
		size: "sm",
		className: cn("max-w-sm", options.className),
		placeholder: options.placeholder,
		value: options.draft,
		onInput: options.onInput,
		onClear: options.onInput(""),
	})
