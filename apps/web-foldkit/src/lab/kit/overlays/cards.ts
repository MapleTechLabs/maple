import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as HoverCard from "../../../ui/hover-card"
import * as Popover from "../../../ui/popover"
import * as Tooltip from "../../../ui/tooltip"
import { Message } from "./model"

// `KitPopover` and `KitHoverCard`.
type H = HtmlBuilder<Message>

const itemRow = (h: H, children: ReadonlyArray<Html>) =>
	h.div([h.Class("flex min-h-48 items-start")], children)

export const kitHoverCard = (h: H, model: HoverCard.Model): Html =>
	h.submodel({
		slotId: "hover-card",
		model,
		view: HoverCard.view,
		viewInputs: {
			className: "w-72",
			toView: ({ trigger, portal }) =>
				itemRow(h, [button(h, { variant: "link", attributes: trigger }, ["payment-svc"]), portal]),
			toContent: () => [
				h.div(
					[h.Class("flex flex-col gap-1")],
					[
						h.span([h.Class("font-medium text-sm")], ["payment-svc"]),
						h.span(
							[h.Class("text-muted-foreground text-xs")],
							["412 req/s, 1.8% errors, p95 238 ms"],
						),
					],
				),
			],
		},
		toParentMessage: (message) => Message.GotHoverCardMessage({ message }),
	})

// `KitTooltip`: `<Tooltip defaultOpen>` on an outline button.
export const kitTooltip = (h: H, model: Tooltip.Model): Html =>
	h.submodel({
		slotId: "tooltip",
		model,
		view: Tooltip.view,
		viewInputs: {
			toView: ({ trigger, portal }) =>
				itemRow(h, [
					button(h, { variant: "outline", slot: "tooltip-trigger", attributes: trigger() }, [
						"Hover target",
					]),
					...(portal === null ? [] : [portal]),
				]),
			toContent: () => ["Last refreshed 2 minutes ago"],
		},
		toParentMessage: (message) => Message.GotTooltipMessage({ message }),
	})

export const kitPopover = (h: H, model: Popover.Model): Html =>
	h.submodel({
		slotId: "popover",
		model,
		view: Popover.view,
		viewInputs: {
			className: "w-72",
			toView: ({ trigger, withTrigger }) =>
				itemRow(h, withTrigger(button(h, { variant: "outline", attributes: trigger }, ["Share"]))),
			toContent: () => [
				Popover.popoverTitle(h, model.id, "Share this view"),
				Popover.popoverDescription(
					h,
					model.id,
					"Anyone in the org with the link sees the same filters.",
				),
			],
		},
		toParentMessage: (message) => Message.GotPopoverMessage({ message }),
	})
