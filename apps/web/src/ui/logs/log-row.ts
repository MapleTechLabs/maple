import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { ROW_LINE_CHARS, ROW_WRAPPED_CHARS, textWindow } from "../../lib/display-text"
import { icon } from "../icon"
import type { LogChip, LogRowView, PinnedCell } from "./log-row-view"
import { highlightedText } from "./highlight"
import { badgeVariants } from "@maple/ui/styles/ui/badge"
import { rowSelectedClass } from "@maple/ui/styles/ui/list-row"
import { CHIP_CLASS, CHIP_KEY_TONE_CLASSES, CHIP_TONE_CLASSES, rowClass } from "./styles"
import type * as AttributesPanel from "../attributes/attributes-panel"
import type { CopyStatus } from "../copy-button"
import { logRowExpanded } from "./log-row-expanded"

/** The handlers a row raises, so the row view stays independent of the stream's Message union. */
export interface RowEvents<Message> {
	readonly clickedRow: (index: number) => Message
	readonly clickedExpand: (index: number) => Message
	readonly clickedCopyMessage: (index: number) => Message
	readonly clickedCopyLink: (index: number) => Message
	readonly enteredChip: (index: number, key: string) => Message
	readonly leftChip: (index: number, key: string) => Message
	readonly focusedChip: (index: number, key: string) => Message
	readonly blurredChip: (index: number, key: string) => Message
	readonly clickedChip: (index: number, key: string) => Message
	readonly pressedChipEscape: (index: number, key: string) => Message
	readonly clickedDetails: (index: number) => Message
	readonly clickedCopyJson: (index: number) => Message
}

export type Density = "compact" | "comfortable"

/** Per-row state; every field is a primitive or a stable reference so a keyed lazy can skip the row. */
export interface RowState {
	readonly isFocused: boolean
	readonly isExpanded: boolean
	readonly isSelected: boolean
	readonly wrap: boolean
	readonly density: Density
	readonly highlight: string | undefined
	/** The expanded body's attribute panel, present while the row is expanded. */
	readonly panel: AttributesPanel.Model | undefined
	readonly jsonStatus: CopyStatus
	readonly canFilter: boolean
}

/** Left-edge rail (and, for errors, a tint) so a scan down the stream stops on what is wrong. */
const SEVERITY_ROW = new Map([
	["FATAL", "before:bg-severity-fatal bg-severity-fatal/[0.14]"],
	["CRITICAL", "before:bg-severity-fatal bg-severity-fatal/[0.14]"],
	["ERROR", "before:bg-severity-error bg-severity-error/[0.05]"],
	["WARN", "before:bg-severity-warn"],
	["WARNING", "before:bg-severity-warn"],
])
const QUIET_SEVERITIES = new Set(["DEBUG", "TRACE"])
// Fatal reads one step past error: a filled label, not just a red word.
const FILLED_SEVERITIES = new Set(["FATAL", "CRITICAL"])
const PINNED_COL_WIDTH = "150px"
/** Chips past this would only squeeze the ones before them; a "+N" mark counts the rest. */
const ROW_CHIP_LIMIT = 2

// Row and row action classes
const ROW_CLASS =
	"hover:bg-muted/50 data-[expanded]:bg-muted/40 data-[focused]:bg-muted/70 data-[focused]:ring-1 data-[focused]:ring-ring data-[focused]:ring-inset focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
const EXPAND_BUTTON_CLASS =
	"-mr-1.5 shrink-0 flex h-4 items-center justify-center w-4 text-muted-foreground/40 group-hover/row:text-muted-foreground hover:text-foreground transition-colors cursor-pointer focus-visible:outline-none focus-visible:text-foreground"
const ROW_ACTION_CLASS =
	"inline-flex size-5 items-center justify-center rounded text-3xs text-muted-foreground hover:bg-muted hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
const ACTIONS_CLASS =
	"absolute right-0 hidden items-center gap-0.5 rounded-md border border-border bg-background p-0.5 group-hover/row:flex group-data-[focused]/row:flex group-focus-within/row:flex"
const ICON_BUTTON_CLASS = cn(
	buttonVariants({
		className: "text-muted-foreground hover:text-foreground",
		size: "icon-xs",
		variant: "ghost",
	}),
)
const META_BADGE_CLASS = cn(badgeVariants({ mono: false, pill: false, size: "xs", variant: "meta" }))

const stop = { propagation: "Stop" } as const

/** `<IconButton size="icon-xs">` without its Base UI tooltip (the tooltip is an open port item). */
const iconButton = <Message>(h: HtmlBuilder<Message>, label: string, onClick: Message, icon: Html): Html =>
	h.button(
		[
			h.Type("button"),
			rowClass(h, ICON_BUTTON_CLASS),
			h.AriaLabel(label),
			h.DataAttribute("slot", "icon-button"),
			h.OnClick(onClick, stop),
		],
		[icon],
	)

/** `<TruncatedText tooltip="title">` for a pinned attribute cell. */
const pinnedCell = <Message>(h: HtmlBuilder<Message>, cell: PinnedCell): Html =>
	h.span(
		[
			rowClass(
				h,
				cn(
					"block min-w-0 truncate",
					cn(
						"shrink-0 text-foreground/80 hidden md:block",
						cell.isEmpty && "text-muted-foreground/40",
						cell.isNumeric && "tabular-nums",
					),
				),
			),
			h.Style({ width: PINNED_COL_WIDTH }),
			h.Title(`${cell.key}=${cell.value}`),
		],
		[cell.value],
	)

/** `LogAttributeChip`'s trigger button; the card renders apart, only while open (see chip-card.ts). */
const chipButton = <Message>(
	h: HtmlBuilder<Message>,
	events: RowEvents<Message>,
	index: number,
	chip: LogChip,
): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaLabel(`Copy ${chip.key}=${chip.value}`),
			rowClass(h, cn(CHIP_CLASS, CHIP_TONE_CLASSES[chip.tone], "min-w-min shrink")),
			h.OnMouseEnter(events.enteredChip(index, chip.key)),
			h.OnMouseLeave(events.leftChip(index, chip.key)),
			h.OnFocus(events.focusedChip(index, chip.key)),
			h.OnBlur(events.blurredChip(index, chip.key)),
			h.OnClick(events.clickedChip(index, chip.key), stop),
			h.OnKeyDownPreventDefault((key) =>
				key === "Escape" ? Option.some(events.pressedChipEscape(index, chip.key)) : Option.none(),
			),
		],
		[
			// The key gives way first; the value always keeps a few characters.
			h.span(
				[rowClass(h, cn("min-w-[3ch] shrink-[4] truncate", CHIP_KEY_TONE_CLASSES[chip.tone]))],
				[chip.displayKey],
			),
			h.span([rowClass(h, "shrink-0 opacity-40")], [":"]),
			h.span([rowClass(h, "min-w-[6ch] max-w-[18ch] truncate")], [chip.displayValue]),
		],
	)

/** One stream row, absolutely placed at its virtual `start`. */
export const logRow = <Message>(
	h: HtmlBuilder<Message>,
	events: RowEvents<Message>,
	row: LogRowView,
	index: number,
	start: number,
	state: RowState,
	/** Renders the expanded row's attribute panel; the stream owns the panel Binding. */
	panelView: (panel: AttributesPanel.Model) => Html,
): Html =>
	h.keyed("div")(
		String(index),
		[
			h.DataAttribute("index", String(index)),
			h.Style({
				position: "absolute",
				top: "0px",
				left: "0px",
				width: "100%",
				transform: `translateY(${start}px)`,
			}),
			rowClass(h, "border-b border-border/70"),
		],
		[
			h.div(
				[
					...(state.isFocused ? [h.DataAttribute("focused", "true")] : []),
					...(state.isExpanded ? [h.DataAttribute("expanded", "true")] : []),
					h.Tabindex(0),
					h.Role("listitem"),
					h.OnClick(events.clickedRow(index)),
					h.OnKeyDownSelfPreventDefault((key) =>
						key === "Enter" || key === " "
							? Option.some(events.clickedRow(index))
							: Option.none(),
					),
					rowClass(
						h,
						cn(
							"group/row relative flex w-full gap-3 pl-3 pr-3 text-xs font-mono cursor-pointer",
							"before:absolute before:inset-y-0 before:left-0 before:w-0.5",
							ROW_CLASS,
							SEVERITY_ROW.get(row.severity),
							state.isSelected && rowSelectedClass(true),
							state.wrap ? "items-start" : "items-center",
							state.density === "comfortable" ? "py-3" : "py-[7px]",
						),
					),
				],
				[
					h.button(
						[
							h.Type("button"),
							h.AriaLabel(state.isExpanded ? "Collapse log" : "Expand log"),
							h.AriaExpanded(state.isExpanded),
							h.OnClick(events.clickedExpand(index), stop),
							rowClass(h, EXPAND_BUTTON_CLASS),
						],
						[
							icon(h, "ChevronRightIcon", {
								size: 12,
								className: cn("transition-transform", state.isExpanded && "rotate-90"),
							}),
						],
					),
					h.span(
						[
							rowClass(h, "shrink-0 w-[92px] text-foreground/75 tabular-nums"),
							h.Title(row.timeTitle),
						],
						row.timeFraction === ""
							? [row.timeMain]
							: [
									row.timeMain,
									h.span([rowClass(h, "text-muted-foreground/50")], [row.timeFraction]),
								],
					),
					h.span(
						[
							rowClass(
								h,
								cn(
									"shrink-0 w-11 truncate text-3xs leading-4 uppercase tabular-nums font-semibold tracking-wide",
									FILLED_SEVERITIES.has(row.severity) && "rounded-sm px-1 text-white",
								),
							),
							h.Style(
								FILLED_SEVERITIES.has(row.severity)
									? { "background-color": row.severityColor }
									: { color: row.severityColor },
							),
							h.Title(row.severity),
						],
						[row.severity],
					),
					h.span(
						[
							rowClass(
								h,
								"shrink-0 w-40 hidden md:flex h-4 items-center gap-1.5 min-w-0 text-muted-foreground",
							),
						],
						[
							h.span([
								h.AriaHidden(true),
								rowClass(h, "shrink-0 rounded-[35%] [corner-shape:squircle] size-1.5"),
								h.Style({ "background-color": row.serviceColor }),
							]),
							h.span([rowClass(h, "truncate")], [row.serviceName]),
						],
					),
					...row.pinned.map((cell) => pinnedCell(h, cell)),
					messageLane(h, events, row, index, state),
				],
			),
			...(state.isExpanded && state.panel !== undefined
				? [
						logRowExpanded(
							h,
							row.log,
							state.highlight,
							panelView(state.panel),
							state.jsonStatus,
							{
								clickedDetails: events.clickedDetails(index),
								clickedCopyJson: events.clickedCopyJson(index),
							},
						),
					]
				: []),
		],
	)

/** The hover actions, overlaid on the message's tail so they take no width and never cover a chip. */
const rowActions = <Message>(
	h: HtmlBuilder<Message>,
	events: RowEvents<Message>,
	row: LogRowView,
	index: number,
	state: RowState,
): Html =>
	h.span(
		[rowClass(h, cn(ACTIONS_CLASS, state.wrap ? "-top-1" : "top-1/2 -translate-y-1/2"))],
		[
			iconButton(
				h,
				"Copy message",
				events.clickedCopyMessage(index),
				icon(h, "CopyIcon", { size: 13 }),
			),
			iconButton(
				h,
				"Copy link to log",
				events.clickedCopyLink(index),
				icon(h, "LinkIcon", { size: 13 }),
			),
			...(row.traceId === ""
				? []
				: [
						h.a(
							[
								h.Href(`/traces/${row.traceId}`),
								h.AriaLabel("Open trace"),
								h.Title("Open trace"),
								rowClass(h, ROW_ACTION_CLASS),
							],
							[icon(h, "PulseIcon", { size: 13 })],
						),
					]),
			iconButton(
				h,
				"Open details",
				events.clickedRow(index),
				icon(h, "ExternalLinkIcon", { size: 12 }),
			),
		],
	)

const messageLane = <Message>(
	h: HtmlBuilder<Message>,
	events: RowEvents<Message>,
	row: LogRowView,
	index: number,
	state: RowState,
): Html =>
	h.span(
		[
			rowClass(
				h,
				cn(
					// 22px is the actions' footprint when they sat in the flow; it keeps the row height.
					"min-h-[22px] min-w-0 flex-1 flex gap-2",
					state.wrap ? "items-start" : "items-center",
				),
			),
		],
		[
			h.span(
				[
					rowClass(
						h,
						cn(
							// The message keeps most of the row; the chips shrink to fit the lane's 40%.
							"relative flex min-w-[55%] flex-1 gap-2",
							state.wrap ? "items-start" : "items-center",
						),
					),
				],
				[
					h.span(
						[
							rowClass(
								h,
								cn(
									"min-w-0 flex-1",
									QUIET_SEVERITIES.has(row.severity)
										? "text-muted-foreground"
										: "text-foreground",
									// A one-line clamp that breaks anywhere: the ellipsis follows the last glyph that fits.
									state.wrap ? "whitespace-pre-wrap break-words" : "line-clamp-1 break-all",
								),
							),
						],
						highlightedText(
							h,
							state.wrap
								? textWindow(row.body, state.highlight, ROW_WRAPPED_CHARS)
								: textWindow(row.firstLine, state.highlight, ROW_LINE_CHARS),
							state.highlight,
						),
					),
					...(!state.wrap && row.hiddenLinesLabel !== ""
						? [
								h.span(
									[rowClass(h, META_BADGE_CLASS), h.DataAttribute("slot", "badge")],
									["+", row.hiddenLinesLabel],
								),
							]
						: []),
					rowActions(h, events, row, index, state),
				],
			),
			...(row.chips.length > 0
				? [
						h.span(
							[
								rowClass(
									h,
									"ml-auto hidden h-[18px] min-w-0 max-w-[40%] justify-end gap-1 overflow-hidden pl-2 @3xl/log:flex",
								),
							],
							// The lane is as wide as its chips, so the message gets the rest of the row.
							[
								...row.chips
									.slice(0, ROW_CHIP_LIMIT)
									.map((chip) => chipButton(h, events, index, chip)),
								...(row.chips.length > ROW_CHIP_LIMIT
									? [
											h.span(
												[
													rowClass(
														h,
														cn(
															CHIP_CLASS,
															CHIP_TONE_CLASSES.muted,
															"cursor-default",
														),
													),
													h.Title(
														row.chips
															.slice(ROW_CHIP_LIMIT)
															.map((chip) => `${chip.key}=${chip.value}`)
															.join("\n"),
													),
												],
												[`+${row.chips.length - ROW_CHIP_LIMIT}`],
											),
										]
									: []),
							],
						),
					]
				: []),
		],
	)
