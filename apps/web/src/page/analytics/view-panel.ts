import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { panel, panelHeader, panelTitle } from "@maple/views/ui/panel"
import { vstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { expandTableFooter } from "../kit/expand-table-footer"
import { Message } from "./message"

// The titled card of the AI traffic and Search tabs.

type H = HtmlBuilder<Message>

/** Where a table sits: a card caps its rows, the expand dialog gives them most of the screen. */
export type TableSurface = Readonly<{ maxHeight: string; surfaceClass: string }>
export const CARD_SURFACE: TableSurface = { maxHeight: "360px", surfaceClass: "bg-card" }
export const DIALOG_SURFACE: TableSurface = { maxHeight: "min(62vh, 640px)", surfaceClass: "bg-popover" }

/** A titled card, optionally with the capped table and its Expand button. */
export const analyticsPanel = (
	h: H,
	options: Readonly<{
		title: string
		hint?: string
		aside?: Html
		className?: string
		expand?: Readonly<{ id: string; count: string; table: Html }>
	}>,
	children: ReadonlyArray<Html> = [],
): Html =>
	panel(h, { className: cn("@container/panel", options.className) }, [
		panelHeader(h, {
			divided: false,
			className: "items-start pt-3 pb-2.5",
			action:
				options.aside === undefined
					? undefined
					: typography(h, { size: "2xs", tone: "muted", as: "div", className: "shrink-0" }, [
							options.aside,
						]),
			children: [
				// The hint wraps beside the aside; under a floor the aside drops below instead.
				vstack(h, { gap: "0.5", grow: true, className: "min-w-48" }, [
					panelTitle(h, [options.title]),
					...(options.hint === undefined
						? []
						: [typography(h, { size: "2xs", tone: "subtle", as: "p" }, [options.hint])]),
				]),
			],
		}),
		...children,
		...(options.expand === undefined
			? []
			: [
					options.expand.table,
					expandTableFooter(h, {
						onClick: Message.ClickedExpandPanel({ panel: options.expand.id }),
						count: options.expand.count,
					}),
				]),
	])
