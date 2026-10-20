import type { Html, HtmlBuilder } from "foldkit/html"
import * as Select from "../../../ui/select"
import { view as selectView, type SelectOption } from "../../../ui/select-view"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/** One of the form's selects, kept by id; its value is always the form's. */
export const formSelect = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: ReadonlyArray<SelectOption>,
	inputs: Readonly<{
		className?: string
		ariaLabel?: string
		labelledBy?: string
		toView: (parts: ReadonlyArray<Html>) => Html
	}>,
): Html => {
	const index = options.findIndex((option) => option.value === value)
	const current = model.selects[id] ?? Select.init(id, { value, selectedIndex: index === -1 ? null : index })
	return h.submodel({
		slotId: `alert-rule-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
		viewInputs: {
			entries: options.map((item) => ({ _tag: "Item" as const, item })),
			className: inputs.className,
			ariaLabel: inputs.ariaLabel,
			labelledBy: inputs.labelledBy,
			toView: inputs.toView,
		},
	})
}
