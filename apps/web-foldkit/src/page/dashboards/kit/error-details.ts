import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import * as CopyButton from "../../../ui/copy-button"
import * as Popover from "../../../ui/popover"

// `ErrorDetailsPopover`: the card clamps a failed tile's
// message to two lines; the full SQL or ClickHouse message lives behind "Details", with a copy button.

export type ErrorDetailsInputs<M> = Readonly<{
	slotId: string
	popover: Popover.Model
	copy: CopyButton.Model
	message: string
	onPopover: (message: Popover.Message) => M
	onCopy: (message: CopyButton.Message) => M
}>

export const errorDetailsPopover = <M>(h: HtmlBuilder<M>, inputs: ErrorDetailsInputs<M>): Html =>
	h.submodel({
		slotId: inputs.slotId,
		model: inputs.popover,
		view: Popover.view,
		toParentMessage: inputs.onPopover,
		viewInputs: {
			className: "w-96 max-w-[calc(100vw-2rem)]",
			toView: ({ trigger, withTrigger }) =>
				h.div(
					[h.Class("contents")],
					withTrigger(
						button(h, { variant: "ghost", size: "xs", className: "h-5 text-3xs", attributes: [...trigger] }, [
							"Details",
						]),
					),
				),
			toContent: () => [
				h.div(
					[h.Class("flex items-start gap-2")],
					[
						h.pre(
							[
								h.Class(
									"max-h-60 min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words font-mono text-xs",
								),
							],
							[inputs.message],
						),
						CopyButton.view(h, {
							model: inputs.copy,
							toParentMessage: inputs.onCopy,
							value: inputs.message,
							label: "Error message",
							className: "shrink-0",
						}),
					],
				),
			],
		},
	})
