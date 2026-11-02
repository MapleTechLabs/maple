import { countLabel, pluralize } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { SESSION_TAG_DOTS, SESSION_TAG_LABELS } from "../../../components/replays/session-tags"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { pressable } from "../../../ui/pressable"
import { skeleton } from "../../../ui/skeleton"
import { statusDot } from "../../../ui/status-dot"
import type { SessionListItem } from "./session-row"
import { sessionListRow } from "./session-list-row"
import { COLUMNS, columnHeader, type SessionsListOptions } from "./sessions-parts"
import { KEYS_ATTRIBUTE, keysValue, type VirtualWindow } from "./virtualize"

// The sessions list. Rows render in flow: the virtualizer's
// absolute rows stack to the same offsets once every row is in view.

/** A disclosure chevron, direction right. */
const disclosureChevron = <M>(h: HtmlBuilder<M>, isOpen: boolean, size: number): Html =>
	icon(h, "ChevronRightIcon", {
		size,
		attributes: [h.AriaHidden(true)],
		className: cn("shrink-0 transition-transform", isOpen && "rotate-90"),
	})

/** `QuietRunRow`: stands in for a run of low-signal sessions. */
const quietRunRow = <M>(
	h: HtmlBuilder<M>,
	item: Extract<SessionListItem, { kind: "quiet" }>,
	onToggle: M,
): Html =>
	pressable(
		h,
		{
			onClick: onToggle,
			className:
				"flex w-full items-center gap-3 border-b border-border bg-surface-sunken px-3 py-1.5 text-left text-xs text-muted-foreground hover:bg-surface-strong active:bg-surface-strong hover:text-foreground active:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring @2xl:gap-4",
			attributes: [h.AriaExpanded(item.expanded)],
		},
		[
			h.span([h.Class("shrink-0 whitespace-nowrap font-medium tabular-nums")], [
				countLabel(item.count, "low-signal session"),
			]),
			h.span(
				[h.Class("flex min-w-0 items-center gap-3 overflow-hidden"), h.Title(item.summary)],
				item.tiers.map(({ tag, count }) =>
					h.span([h.Class("flex shrink-0 items-center gap-1.5")], [
						statusDot(h, { tone: "custom", className: SESSION_TAG_DOTS[tag] }),
						h.span([h.Class("tabular-nums")], [String(count)]),
						" ",
						pluralize(count, SESSION_TAG_LABELS[tag].toLowerCase()),
					]),
				),
			),
			h.span([h.Class("ml-auto flex shrink-0 items-center gap-1")], [
				item.expanded ? "Hide" : "Show",
				disclosureChevron(h, item.expanded, 14),
			]),
		],
	)

/** `getItemKey`. */
export const itemKey = (item: SessionListItem): string =>
	item.kind === "quiet" ? `quiet:${item.key}` : item.session.sessionId

/**
 * The column header and the virtual window's rows, absolutely placed. `virtualize` is
 * the caller's Mount (`virtualizeSessions`) that reports the window. The caller renders the footer.
 */
export const sessionsList = <M>(
	h: HtmlBuilder<M>,
	options: SessionsListOptions<M>,
	virtual: Readonly<{ window: VirtualWindow; mount: Attribute<M> }>,
	footer: ReadonlyArray<Html> = [],
): Html =>
	h.div([h.Class("@container")], [
		columnHeader(h),
		h.div(
			[
				h.Class("relative w-full"),
				h.DataAttribute(KEYS_ATTRIBUTE, keysValue(options.items.map(itemKey))),
				h.Style({ height: `${virtual.window.totalSize}px` }),
				virtual.mount,
			],
			virtual.window.rows.flatMap((row) => {
				const item = options.items[row.index]
				if (item === undefined) return []
				return [
					h.div(
						[
							h.Key(itemKey(item)),
							h.DataAttribute("index", String(row.index)),
							h.Class("absolute top-0 left-0 w-full"),
							h.Style({ transform: `translateY(${row.start - virtual.window.scrollMargin}px)` }),
						],
						[
							item.kind === "quiet"
								? quietRunRow(h, item, options.onToggleRun(item.key))
								: sessionListRow(h, options, item.session, item.lowSignal),
						],
					),
				]
			}),
		),
		...footer,
	])

const SKELETON_NAME_WIDTHS = ["w-40", "w-28", "w-48", "w-32", "w-36", "w-24", "w-44", "w-32"]

/** `SessionsListSkeleton`: same header, columns and row height. */
export const sessionsListSkeleton = <M>(h: HtmlBuilder<M>, rows = 8): Html =>
	h.div([h.Class("@container"), h.AriaBusy(true)], [
		columnHeader(h),
		...Array.from({ length: rows }, (_, i) =>
			h.div([h.Class("flex h-[65px] items-center gap-3 border-b border-border px-3 @2xl:gap-4")], [
				h.div([h.Class("min-w-0 flex-1 space-y-2")], [
					skeleton(h, cn("h-3.5", SKELETON_NAME_WIDTHS[i % SKELETON_NAME_WIDTHS.length])),
					skeleton(h, "h-3 w-56 max-w-full"),
				]),
				h.span([h.Class(COLUMNS.org)], [skeleton(h, "h-5 w-24 rounded-md")]),
				h.span([h.Class(COLUMNS.tags)], [skeleton(h, "h-5 w-20 rounded-md")]),
				h.span([h.Class(COLUMNS.activity)], [skeleton(h, "h-3 w-full")]),
				h.span([h.Class(COLUMNS.device)], [skeleton(h, "h-3.5 w-14")]),
				h.span([h.Class(COLUMNS.signals)], [skeleton(h, "h-3.5 w-20")]),
				h.span([h.Class(COLUMNS.time)], [skeleton(h, "h-3 w-14")]),
			]),
		),
	])
