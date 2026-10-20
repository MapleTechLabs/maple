import type { Html, HtmlBuilder } from "foldkit/html"
import { linkButton } from "../../../ui/button"
import * as DialogView from "../../../ui/dialog-view"
import { kbd } from "../../../ui/display"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import * as PeekBody from "../detail/view-peek"
import { Message } from "./message"
import type { Model } from "./model"
import { peekPosition, traceHrefFrom } from "./peek"

// The trace peek sheet's frame: the sheet, the trace page's
// peek body, and the footer that walks the list and opens the page.

type H = HtmlBuilder<Message>

const stepButton = (
	h: H,
	label: string,
	iconName: "ArrowUpIcon" | "ArrowDownIcon",
	isEnabled: boolean,
	step: 1 | -1,
) =>
	iconButton(
		h,
		{
			variant: "outline",
			label,
			isDisabled: !isEnabled,
			attributes: [h.OnClick(Message.ClickedPeekStep({ step }))],
		},
		[icon(h, iconName)],
	)

const openHref = (model: Model): string =>
	model.peek === null
		? ""
		: traceHrefFrom(model.search, model.peek.traceId, model.peek.search.t, model.search.peekSpan)

const footer = (h: H, model: Model): Html => {
	const position = peekPosition(model)
	return DialogView.dialogFooter(
		h,
		"sheet",
		[
			h.div(
				[h.Class("flex items-center gap-1.5")],
				[
					stepButton(
						h,
						"Previous trace",
						"ArrowUpIcon",
						position !== null && position.index > 0,
						-1,
					),
					stepButton(
						h,
						"Next trace",
						"ArrowDownIcon",
						position !== null && position.index < position.count - 1,
						1,
					),
					...(position === null
						? []
						: [
								h.span(
									[h.Class("ml-1 font-mono text-2xs tabular-nums text-muted-foreground")],
									[String(position.index + 1), " of ", String(position.count)],
								),
							]),
				],
			),
			linkButton(h, { size: "sm", href: openHref(model) }, [
				"Open trace",
				kbd(h, "ml-1 hidden bg-black/15 text-current sm:inline-flex", ["↵"]),
			]),
		],
		"flex-row items-center justify-between gap-3 border-t",
	)
}

export const peekSheet = (h: H, model: Model, timeZone: string): Html =>
	h.submodel({
		slotId: `${model.peekDialog.id}-sheet`,
		model: model.peekDialog,
		view: DialogView.view,
		viewInputs: {
			className: "w-[min(1100px,calc(100vw-2rem))] p-0 sm:max-w-[min(1100px,calc(100vw-2rem))]",
			side: "right",
			hasTrigger: false,
			isPopupFocused: true,
			toView: ({ portal }) => portal,
			toContent: () =>
				model.peek === null
					? []
					: [
							h.submodel({
								slotId: "trace-peek-body",
								model: model.peek,
								view: PeekBody.view,
								viewInputs: { dialogId: model.peekDialog.id, timeZone },
								toParentMessage: (message) => Message.GotPeekMessage({ message }),
							}),
							footer(h, model),
						],
		},
		toParentMessage: (message) => Message.GotPeekDialogMessage({ message }),
	})
