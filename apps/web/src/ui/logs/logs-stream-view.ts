import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { createKeyedLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { defineView } from "foldkit/submodel"
import { chipCard } from "./chip-card"
import { type Density, logRow, type RowEvents } from "./log-row"
import type { LogRowView } from "./log-row-view"
import type { Model } from "./logs-stream"
import { Message } from "./logs-stream-message"
import { eyebrow } from "../eyebrow"
import type * as AttributesPanel from "../attributes/attributes-panel"
import type { CopyStatus } from "../copy-button"
import { COUNT_ATTRIBUTE, LAYOUT_ATTRIBUTE, STREAM_ATTRIBUTE, VirtualizeLogStream } from "./virtualize"

export interface ViewInputs {
	readonly wrap: boolean
	readonly density: Density
	readonly pinnedColumns: ReadonlyArray<string>
	/** Body search, marked in every message. */
	readonly searchText: string | undefined
	/** The zone the times are in, named on the Time column. */
	readonly timeZone: string
	readonly isWaiting: boolean
	/** `ListFooter`'s count line, formatted by the parent (it is locale-dependent). */
	readonly footerText: string
	/** Adds "Filter in" / "Filter out" to the attribute card. */
	readonly canFilter: boolean
	/**
	 * The parent renders the stream's box (with its toolbar before the stream, as on
	 * /logs); the stream's own root is then `display: contents`.
	 */
	readonly isBare?: boolean
	/** The row the detail sheet shows (`rowSelectedClass`). */
	readonly selectedIndex?: number
}

const PINNED_COL_WIDTH = "150px"

const GENERIC_SEGMENTS = new Set(["name", "id", "value", "type"])

/** Short header for a pinned key: the last segment that is not generic, so `deployment.environment.name` reads "environment". The full key is the tooltip. */
export const pinnedColumnLabel = (key: string): string => {
	const segments = key.split(".").filter((segment) => segment !== "")
	return (
		segments.findLast((segment) => !GENERIC_SEGMENTS.has(segment.toLowerCase())) ?? segments.at(-1) ?? key
	)
}

const ROW_EVENTS: RowEvents<Message> = {
	clickedRow: (index) => Message.ClickedRow({ index }),
	clickedExpand: (index) => Message.ClickedExpand({ index }),
	clickedCopyMessage: (index) => Message.ClickedCopyMessage({ index }),
	clickedCopyLink: (index) => Message.ClickedCopyLink({ index }),
	enteredChip: (index, key) => Message.EnteredChip({ index, key }),
	leftChip: (index, key) => Message.LeftChip({ index, key }),
	focusedChip: (index, key) => Message.FocusedChip({ index, key }),
	blurredChip: (index, key) => Message.BlurredChip({ index, key }),
	clickedChip: (index, key) => Message.ClickedChip({ index, key }),
	pressedChipEscape: (index, key) => Message.PressedChipEscape({ index, key }),
	clickedDetails: (index) => Message.ClickedDetails({ index }),
	clickedCopyJson: (index) => Message.ClickedCopyJson({ index }),
	gotPanelMessage: (index, message) => Message.GotPanelMessage({ index, message }),
}

/** Sticky column labels. */
const columnHeader = (
	h: HtmlBuilder<Message>,
	pinnedColumns: ReadonlyArray<string>,
	timeZone: string,
): Html =>
	eyebrow(
		h,
		{
			as: "div",
			className:
				"sticky top-0 z-10 flex items-center gap-3 px-3 py-1.5 bg-background border-b border-border select-none",
		},
		[
			h.span([h.AriaHidden(true), h.Class("-mr-1.5 shrink-0 w-4")]),
			h.span([h.Class("shrink-0 w-[92px]"), h.Title(`Times in ${timeZone}`)], ["Time"]),
			h.span([h.Class("shrink-0 w-11")], ["Level"]),
			h.span([h.Class("shrink-0 w-40 hidden md:inline-block")], ["Service"]),
			...pinnedColumns.map((key) =>
				h.span(
					[
						h.Class(cn("block min-w-0 truncate", "shrink-0 text-foreground/60 hidden md:block")),
						h.Style({ width: PINNED_COL_WIDTH }),
						h.Title(key),
					],
					[pinnedColumnLabel(key)],
				),
			),
			h.span([h.Class("min-w-0 flex-1")], ["Message"]),
		],
	)

const rowView = (
	h: HtmlBuilder<Message>,
	row: LogRowView,
	index: number,
	start: number,
	isFocused: boolean,
	isExpanded: boolean,
	wrap: boolean,
	density: Density,
	highlight: string | undefined,
	panel: AttributesPanel.Model | undefined,
	jsonStatus: CopyStatus,
	canFilter: boolean,
	isSelected: boolean,
): Html =>
	logRow(h, ROW_EVENTS, row, index, start, {
		isFocused,
		isExpanded,
		isSelected,
		wrap,
		density,
		highlight,
		panel,
		jsonStatus,
		canFilter,
	})

// Rows are keyed by index; the slot is `index % 256` so the cache stays bounded
// (a window never holds 256 rows) while each slot still renders at one position.
const lazyRow = createKeyedLazy()
const ROW_SLOTS = 256

/** The logs table for a non-empty stream. */
export const view = defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const focused = Option.getOrElse(model.focusedIndex, () => -1)
	const rows = model.window.flatMap(({ index, start }) => {
		const row = model.rows[index]
		return row === undefined
			? []
			: [
					lazyRow(index % ROW_SLOTS, rowView, [
						h,
						row,
						index,
						start,
						index === focused,
						model.expandedRows.includes(index),
						inputs.wrap,
						inputs.density,
						inputs.searchText,
						model.panels[String(index)],
						model.jsonCopy.id === String(index) ? model.jsonCopy.status : "idle",
						inputs.canFilter,
						index === inputs.selectedIndex,
					]),
				]
	})
	return h.div(
		inputs.isBare === true
			? [h.Class("contents")]
			: [
					h.Class(
						cn(
							"flex min-h-0 flex-1 flex-col",
							inputs.isWaiting ? "opacity-60 transition-opacity" : "transition-opacity",
						),
					),
					...(inputs.isWaiting ? [h.AriaBusy(true)] : []),
				],
		[
			h.div(
				[
					h.Class("flex-1 min-h-0 relative"),
					h.OnMouseEnter(Message.EnteredStream()),
					h.OnMouseLeave(Message.LeftStream()),
				],
				[
					h.div(
						[
							h.Class(
								"@container/log absolute inset-0 overflow-y-auto overflow-x-hidden overscroll-contain rounded-md border",
							),
							h.DataAttribute(STREAM_ATTRIBUTE, model.id),
							h.DataAttribute(COUNT_ATTRIBUTE, String(model.rows.length)),
							h.DataAttribute(
								LAYOUT_ATTRIBUTE,
								`${inputs.wrap ? "wrap" : "nowrap"} ${inputs.density}`,
							),
							h.OnMount(VirtualizeLogStream()),
						],
						[
							columnHeader(h, inputs.pinnedColumns, inputs.timeZone),
							h.div(
								[
									h.Style({ height: `${model.totalSize}px`, position: "relative" }),
									h.Role("log"),
								],
								rows,
							),
						],
					),
					h.div([
						h.Class(
							"absolute bottom-0 left-0 right-0 h-12 pointer-events-none rounded-b-md bg-gradient-to-t from-background to-transparent",
						),
					]),
				],
			),
			h.div(
				[
					h.Class(
						cn(
							"flex flex-wrap items-center gap-3 px-4 py-3 text-xs text-muted-foreground tabular-nums",
							"justify-between",
							"mt-1.5 shrink-0 py-0",
						),
					),
					h.DataAttribute("slot", "list-footer"),
				],
				[h.span([], [inputs.footerText])],
			),
			// Portalled to <body> by its Mount, like Base UI's PreviewCard.
			chipCard(h, model, inputs.canFilter),
		],
	)
})
