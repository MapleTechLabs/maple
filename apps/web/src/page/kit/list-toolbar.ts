import type { Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { statusDot } from "../../ui/status-dot"

// `ListToolbar`: a list page's row of view tabs, then search, filters and the count readout.

export type ListToolbarOptions = Readonly<{
	/** View tabs or a scope picker, pinned left. */
	leading?: Html | null
	/** Search, filters and the count readout, right-aligned and wrapping. */
	trailing?: ReadonlyArray<Html>
	/** Inside a panel: a divided header row instead of a bare row above the list. */
	framed?: boolean
	className?: string
}>

export const listToolbar = <M>(h: HtmlBuilder<M>, options: ListToolbarOptions): Html =>
	h.div(
		[
			h.DataAttribute("slot", "list-toolbar"),
			h.Class(
				cn(
					"flex flex-wrap items-center gap-2 gap-y-1.5",
					options.framed === true ? "border-b border-border-subtle px-2 py-1.5" : "pb-3",
					options.className,
				),
			),
		],
		[
			...(options.leading === undefined || options.leading === null ? [] : [options.leading]),
			h.div(
				[h.Class("ml-auto flex min-w-0 flex-wrap items-center justify-end gap-2")],
				options.trailing ?? [],
			),
		],
	)

/** The quiet count readout: "12 issues", "50+ issues", "Top 20 of 312 pods". */
export const toolbarCount = <M>(h: HtmlBuilder<M>, children: ReadonlyArray<Html | string>): Html =>
	h.span([h.Class("whitespace-nowrap text-xs text-muted-foreground tabular-nums")], children)

/** A figure in the readout: the value in the foreground, its label muted, an optional status dot. */
export const toolbarStat = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		value: string
		label: string
		dot?: Tone | undefined
		attributes?: ReadonlyArray<Attribute<M>>
	}>,
): Html =>
	h.span(
		[
			h.Class("flex items-center gap-1.5 whitespace-nowrap text-xs tabular-nums"),
			...(options.attributes ?? []),
		],
		[
			...(options.dot === undefined ? [] : [statusDot(h, { tone: options.dot })]),
			// One inline run, so the value and label keep their space for screen readers.
			h.span(
				[],
				[
					h.span([h.Class("font-medium text-foreground")], [options.value]),
					" ",
					h.span([h.Class("text-muted-foreground")], [options.label]),
				],
			),
		],
	)
