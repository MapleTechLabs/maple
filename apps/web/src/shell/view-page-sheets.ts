import {
	pageFilterSheetHeaderStyles,
	pageFilterSheetStyles,
	pageRightSheetHeaderStyles,
	pageRightSheetStyles,
} from "@maple/ui/styles/ui/page-layout"
import type { Html } from "foldkit/html"
import * as Dialog from "../ui/dialog"
import * as DialogView from "../ui/dialog-view"
import { button } from "../ui/button"
import { icon } from "../ui/icon"
import { FilterSheetBinding, RightSheetBinding, type ShellViewBuilder } from "./composition"
import { Message } from "./message"
import type { Model } from "./model"
import type { LiftedRail } from "./page-rails"

type H = ShellViewBuilder

// `PageLayout.FilterSidebar` and `RightSidebar` below `lg`: a sheet each, opened from the top bar.

/** `<Button variant="outline" size="icon-sm" aria-label>` cloned with the sheet's `onClick`. */
const railTrigger = (
	h: H,
	options: Readonly<{
		label: string
		icon: "LayoutLeftIcon" | "LayoutRightIcon"
		id: string
		onClick: Message
	}>,
): Html =>
	button(
		h,
		{
			size: "icon-sm",
			variant: "outline",
			// The sheet hands focus back here on close, as Base UI does to the element it opened from.
			attributes: [h.AriaLabel(options.label), h.Id(options.id), h.OnClick(options.onClick)],
		},
		[icon(h, options.icon)],
	)

export const filterSheetTrigger = (h: H, model: Model): Html =>
	railTrigger(h, {
		label: "Open filters",
		icon: "LayoutLeftIcon",
		id: Dialog.triggerId(model.filterSheet.id),
		onClick: Message.ClickedOpenFilters(),
	})

export const rightSheetTrigger = (h: H, model: Model): Html =>
	railTrigger(h, {
		label: "Open context",
		icon: "LayoutRightIcon",
		id: Dialog.triggerId(model.rightSheet.id),
		onClick: Message.ClickedOpenContext(),
	})

type RailSheetOptions = Readonly<{
	side: "left" | "right"
	className: string
	headerClassName: string
	title: string
	description: string
}>

/** `<Sheet><SheetContent side>`'s inputs, with the sr-only header, around the rail the page built. */
const railSheetInputs = (h: H, sheet: Dialog.Model, options: RailSheetOptions, rail: LiftedRail) => ({
	className: options.className,
	side: options.side,
	toView: ({ portal }: DialogView.RenderInfo) => portal,
	toContent: () => [
		DialogView.dialogHeader(
			h,
			"sheet",
			[
				DialogView.dialogTitle(h, "sheet", sheet.id, options.title),
				DialogView.dialogDescription(h, "sheet", sheet.id, options.description),
			],
			options.headerClassName,
		),
		...rail.children,
	],
})

export const filterSheet = (h: H, model: Model, rail: LiftedRail): Html =>
	h.block(
		FilterSheetBinding.embedView({
			slotId: `${model.filterSheet.id}-dialog`,
			model: model.filterSheet,
			viewInputs: railSheetInputs(
				h,
				model.filterSheet,
				{
					side: "left",
					className: pageFilterSheetStyles,
					headerClassName: pageFilterSheetHeaderStyles,
					title: "Filters",
					description: "Filter options for this page.",
				},
				rail,
			),
		}),
	)

/** TODO(lg): `RightSidebar`'s `title` prop; every ported rail uses the default. */
export const rightSheet = (h: H, model: Model, rail: LiftedRail): Html =>
	h.block(
		RightSheetBinding.embedView({
			slotId: `${model.rightSheet.id}-dialog`,
			model: model.rightSheet,
			viewInputs: railSheetInputs(
				h,
				model.rightSheet,
				{
					side: "right",
					className: pageRightSheetStyles,
					headerClassName: pageRightSheetHeaderStyles,
					title: "Details",
					description: "Context for this page.",
				},
				rail,
			),
		}),
	)
