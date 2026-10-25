import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { highlightedText } from "../../../ui/logs/highlight"
import * as Popover from "../../../ui/popover"
import { Message } from "./message"

// What the log search box
// accepts, from the info affordance beside the SEARCH label (a hover popover, 200 ms).

type Mode = "text" | "trace" | "header"

// The search mode badge's label and colours.
const MODE = new Map<Mode, Readonly<{ label: string; className: string }>>([
	["text", { label: "Text", className: "bg-primary/15 text-primary" }],
	["trace", { label: "Trace", className: "bg-info/15 text-info" }],
	["header", { label: "Header", className: "bg-chart-throughput/15 text-chart-throughput" }],
])

/** In recognizer order: the box tries the id shapes first, then falls back to text. */
const LOOKUPS: ReadonlyArray<Readonly<{ mode: Mode; example: string; does: string; note: string }>> = [
	{
		mode: "trace",
		example: "4b1f2c3d4e5f60718293a4b5c6d7e8f9",
		does: "Scopes the page to that trace.",
		note: "32 hex",
	},
	{
		mode: "header",
		example: "00-4b1f2c3d…-00f067aa0ba902b7-01",
		does: "Same, from a pasted traceparent.",
		note: "W3C",
	},
	{
		mode: "text",
		example: "conn reset",
		does: "Any part of a message, case-insensitive.",
		note: "anything else",
	},
]

const TEXT_EXAMPLE = "redis: Conn reset by peer after 3 retries"

export const initSearchHelp = (): Popover.Model =>
	Popover.init("logs-search-help", { align: "start", side: "right", hoverDelayMs: 200 })

const lookupRow = (h: HtmlBuilder<Message>, lookup: (typeof LOOKUPS)[number]): Html => {
	const mode = MODE.get(lookup.mode) ?? { label: lookup.mode, className: "" }
	return h.div(
		[h.Class("grid grid-cols-[3.75rem_1fr] gap-x-2 gap-y-0.5")],
		[
			h.dt(
				[h.Class("mt-px h-fit")],
				[
					badge(h, { variant: "tag", className: cn(mode.className, "block text-center") }, [
						mode.label,
					]),
				],
			),
			h.dd([h.Class("min-w-0 truncate font-mono text-2xs text-foreground")], [lookup.example]),
			h.dd(
				[h.Class("col-start-2 text-2xs text-muted-foreground leading-relaxed")],
				[lookup.does, " ", h.span([h.Class("text-muted-foreground/60")], ["(", lookup.note, ")"])],
			),
		],
	)
}

const content = (h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
	h.p([h.Class("font-medium text-foreground text-xs")], ["What you can search"]),
	h.p(
		[h.Class("mt-1 text-2xs text-muted-foreground leading-relaxed")],
		["One box. It reads the shape of what you type and picks the lookup."],
	),
	h.dl(
		[h.Class("mt-3 space-y-2.5")],
		LOOKUPS.map((lookup) => lookupRow(h, lookup)),
	),
	h.div(
		[
			h.Class(
				"mt-3 break-words rounded-md border bg-muted/40 px-2 py-1.5 font-mono text-2xs text-foreground leading-relaxed",
			),
		],
		highlightedText(h, TEXT_EXAMPLE, "conn reset"),
	),
	h.p(
		[h.Class("mt-2.5 text-2xs text-muted-foreground leading-relaxed")],
		[
			"A trace scope becomes a chip you can remove. Wrap an id in",
			" ",
			h.span([h.Class("font-mono text-foreground")], ['"quotes"']),
			" to search it as text instead.",
		],
	),
]

export const searchHelp = (h: HtmlBuilder<Message>, model: Popover.Model): Html =>
	h.submodel({
		slotId: "logs-search-help",
		model,
		view: Popover.view,
		toParentMessage: (message) => Message.GotSearchHelpMessage({ message }),
		viewInputs: {
			className: "w-80",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						h.button(
							[
								h.Type("button"),
								h.AriaLabel("What you can search for"),
								h.Class(
									"cursor-pointer rounded-sm text-muted-foreground/60 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring data-[popup-open]:text-foreground",
								),
								...trigger,
							],
							[icon(h, "CircleInfoIcon", { size: 12 })],
						),
					),
				),
			toContent: () => content(h),
		},
	})
