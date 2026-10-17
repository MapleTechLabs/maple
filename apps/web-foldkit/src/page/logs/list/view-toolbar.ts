import { cn } from "@maple/ui/lib/utils"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { togglePrimitive } from "../../../ui/toggle"
import { Message } from "./message"
import type { Model } from "./model"

// `LogsTableToolbar` (apps/web/src/components/logs/logs-table-toolbar.tsx): the Columns picker,
// wrap and density. Wrap and density persist to localStorage; pinned columns live in `?columns`.
// TODO(toolbar-overlays): the Columns popover (a searchable section of attribute keys) and the
// three tooltips (`TooltipProvider delay={250}`); the triggers render closed.

const tooltipTrigger = (h: HtmlBuilder<Message>, id: string) => [
	h.DataAttribute("base-ui-tooltip-trigger", ""),
	h.DataAttribute("slot", "tooltip-trigger"),
	h.Id(id),
	h.Tabindex(0),
]

const columnsButton = (h: HtmlBuilder<Message>, pinnedCount: number): Html =>
	h.button(
		[
			h.Type("button"),
			h.AriaExpanded(false),
			h.AriaHasPopup("dialog"),
			h.AriaLabel("Pin attributes as columns"),
			h.Class(cn(buttonVariants({ variant: "outline", size: "sm" }))),
			h.DataAttribute("base-ui-click-trigger", ""),
			...tooltipTrigger(h, "logs-columns-trigger"),
		],
		[
			icon(h, "ThumbtackIcon", { size: 13, className: "text-muted-foreground" }),
			"Columns",
			...(pinnedCount > 0
				? [
						badge(h, { variant: "secondary", size: "sm", className: "tabular-nums" }, [
							String(pinnedCount),
						]),
					]
				: []),
		],
	)

const viewToggle = (
	h: HtmlBuilder<Message>,
	options: Readonly<{
		id: string
		label: string
		isPressed: boolean
		onClick: Message
		iconName: "TextWrapIcon" | "LineHeightIcon"
	}>,
): Html =>
	togglePrimitive(
		h,
		{
			isPressed: options.isPressed,
			onClick: options.onClick,
			className: cn(toggleVariants({ variant: "outline", size: "sm" })),
			slot: "tooltip-trigger",
			attributes: [
				h.AriaLabel(options.label),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				h.Id(options.id),
			],
		},
		[icon(h, options.iconName, { size: 14 })],
	)

export const toolbar = (h: HtmlBuilder<Message>, model: Model): Html =>
	h.div(
		[h.Class("flex shrink-0 items-center justify-end gap-1.5 pb-1.5")],
		[
			columnsButton(h, model.search.columns?.length ?? 0),
			viewToggle(h, {
				id: "logs-wrap-trigger",
				label: "Wrap long log lines",
				isPressed: model.wrap,
				onClick: Message.ClickedWrap(),
				iconName: "TextWrapIcon",
			}),
			viewToggle(h, {
				id: "logs-density-trigger",
				label: "Toggle comfortable row density",
				isPressed: model.density === "comfortable",
				onClick: Message.ClickedDensity(),
				iconName: "LineHeightIcon",
			}),
		],
	)
