import {
	pageFilterSheetHeaderStyles,
	pageFilterSheetStyles,
	pageRightSheetHeaderStyles,
	pageRightSheetStyles,
} from "@maple/ui/styles/ui/page-layout"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Dialog from "../ui/dialog"
import * as DialogView from "../ui/dialog-view"
import { button } from "../ui/button"
import { icon } from "../ui/icon"
import { Message } from "./message"
import type { Model } from "./model"
import type { LiftedRail } from "./page-rails"

// `PageLayout.FilterSidebar` and `RightSidebar` below `lg`: a sheet each, opened from the top bar.

/** `<Button variant="outline" size="icon-sm" aria-label>` cloned with the sheet's `onClick`. */
const railTrigger = (
	h: HtmlBuilder<Message>,
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

const filterLabelOf = (rail: LiftedRail): string => Option.getOrElse(rail.label, () => "Filters")

export const filterSheetTrigger = (h: HtmlBuilder<Message>, model: Model, rail: LiftedRail): Html =>
	railTrigger(h, {
		label: `Open ${filterLabelOf(rail).toLowerCase()}`,
		icon: "LayoutLeftIcon",
		id: Dialog.triggerId(model.filterSheet.id),
		onClick: Message.ClickedOpenFilters(),
	})

export const rightSheetTrigger = (h: HtmlBuilder<Message>, model: Model): Html =>
	railTrigger(h, {
		label: "Open context",
		icon: "LayoutRightIcon",
		id: Dialog.triggerId(model.rightSheet.id),
		onClick: Message.ClickedOpenContext(),
	})

/** `<Sheet><SheetContent side>` with the sr-only header, around the rail the page built. */
const railSheet = (
	h: HtmlBuilder<Message>,
	sheet: Dialog.Model,
	options: Readonly<{
		side: "left" | "right"
		className: string
		headerClassName: string
		title: string
		description: string
		toParentMessage: (message: Dialog.Message) => Message
	}>,
	rail: LiftedRail,
): Html =>
	h.submodel({
		slotId: `${sheet.id}-dialog`,
		model: sheet,
		view: DialogView.view,
		viewInputs: {
			className: options.className,
			side: options.side,
			toView: ({ portal }) => portal,
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
		},
		toParentMessage: options.toParentMessage,
	})

export const filterSheet = (h: HtmlBuilder<Message>, model: Model, rail: LiftedRail): Html =>
	railSheet(
		h,
		model.filterSheet,
		{
			side: "left",
			className: pageFilterSheetStyles,
			headerClassName: pageFilterSheetHeaderStyles,
			title: filterLabelOf(rail),
			description: Option.isSome(rail.label)
				? `${rail.label.value} navigation.`
				: "Filter options for this page.",
			toParentMessage: (message) => Message.GotFilterSheetMessage({ message }),
		},
		rail,
	)

/** TODO(lg): `RightSidebar`'s `title` prop; every ported rail uses the default. */
export const rightSheet = (h: HtmlBuilder<Message>, model: Model, rail: LiftedRail): Html =>
	railSheet(
		h,
		model.rightSheet,
		{
			side: "right",
			className: pageRightSheetStyles,
			headerClassName: pageRightSheetHeaderStyles,
			title: "Details",
			description: "Context for this page.",
			toParentMessage: (message) => Message.GotRightSheetMessage({ message }),
		},
		rail,
	)
