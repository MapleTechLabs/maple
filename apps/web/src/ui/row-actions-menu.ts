import { rowActionsMenuContentStyles, rowActionsMenuIconStyles } from "@maple/ui/styles/ui/row-actions-menu"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"
import type * as Menu from "./menu"
import * as MenuView from "./menu-view"

// Port of `RowActionsMenu` (packages/ui/src/components/ui/row-actions-menu.tsx).

export type RowActionsMenuOptions<M> = Readonly<{
	/** The menu's slot and Model. */
	slotId: string
	model: Menu.Model
	entries: ReadonlyArray<MenuView.MenuEntry>
	toParentMessage: (message: Menu.Message) => M
	/** Trigger aria-label. */
	label?: string
	align?: "start" | "center" | "end"
	className?: string
}>

/** The kebab menu at the end of a row: one trigger size, one icon size. */
export const rowActionsMenu = <M>(h: HtmlBuilder<M>, options: RowActionsMenuOptions<M>): Html =>
	h.submodel({
		slotId: options.slotId,
		model: options.model,
		view: MenuView.view,
		viewInputs: {
			entries: options.entries,
			align: options.align ?? "end",
			className: rowActionsMenuContentStyles,
			toView: ({ trigger, withTrigger }) =>
				h.span(
					[h.Class("contents")],
					withTrigger(
						button(
							h,
							{
								size: "icon-sm",
								variant: "ghost",
								className: options.className,
								slot: "row-actions-trigger",
								attributes: [h.AriaLabel(options.label ?? "More actions"), ...trigger],
							},
							[icon(h, "DotsVerticalIcon", { className: rowActionsMenuIconStyles })],
						),
					),
				),
		},
		toParentMessage: options.toParentMessage,
	})
