import {
	pageFilterSheetHeaderStyles,
	pageFilterSheetStyles,
	pageRightSheetHeaderStyles,
	pageRightSheetStyles,
} from "@maple/views/ui/page-layout.styles"
import type { Html, HtmlBuilder } from "foldkit/html"
import type * as Dialog from "@maple/views/ui/dialog"
import * as DialogView from "@maple/views/ui/dialog-view"

/** A page's filter or context rail below `lg`, in a side sheet with an sr-only header. */
export const pageRailSheet = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		sheet: Dialog.Model
		/** `left` is the filter rail's sheet, `right` the context rail's. */
		side: "left" | "right"
		title: string
		description: string
		toParentMessage: (message: Dialog.Message) => M
	}>,
	children: ReadonlyArray<Html>,
): Html => {
	const { sheet } = options
	const isLeft = options.side === "left"
	return h.submodel({
		slotId: `${sheet.id}-dialog`,
		model: sheet,
		view: DialogView.view,
		viewInputs: {
			className: isLeft ? pageFilterSheetStyles : pageRightSheetStyles,
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
					isLeft ? pageFilterSheetHeaderStyles : pageRightSheetHeaderStyles,
				),
				...children,
			],
		},
		toParentMessage: options.toParentMessage,
	})
}
