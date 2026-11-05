import type { Html, HtmlBuilder } from "foldkit/html"
import * as Select from "@maple/views/ui/select"
import { view as selectView, type SelectOption } from "@maple/views/ui/select-view"
import { Message } from "./message"
import type { Model } from "./model"
import { Array as Arr, Option } from "effect"

type H = HtmlBuilder<Message>

/** One of the page's selects, kept by id; its value is always the state's. */
export const pageSelect = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: ReadonlyArray<SelectOption>,
	inputs: Readonly<{
		size?: "sm" | "default"
		className?: string
		ariaLabel?: string
		renderValue?: (value: string) => ReadonlyArray<Html | string>
		renderItem?: (option: SelectOption) => ReadonlyArray<Html | string>
		/** Places the trigger and its siblings (hidden input, portal) in the caller's layout. */
		toView: (parts: ReadonlyArray<Html>) => Html
	}>,
): Html => {
	const index = Arr.findFirstIndex(options, (option) => option.value === value)
	const current = model.selects[id] ?? Select.init(id, { value, selectedIndex: Option.getOrNull(index) })
	return h.submodel({
		slotId: `widget-editor-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
		viewInputs: {
			entries: Arr.map(options, (item) => ({ _tag: "Item" as const, item })),
			size: inputs.size,
			className: inputs.className,
			ariaLabel: inputs.ariaLabel,
			renderValue: inputs.renderValue,
			renderItem: inputs.renderItem,
			toView: inputs.toView,
		},
	})
}
