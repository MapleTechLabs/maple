import type { Html, HtmlBuilder } from "foldkit/html"
import * as Select from "@maple/views/ui/select"
import { view as selectView, type SelectOption } from "@maple/views/ui/select-view"
import { Message, type Model } from "./panel-message"
import { Array as Arr, Option } from "effect"

type H = HtmlBuilder<Message>

/** One of the panel's selects, kept by id; its value is always the draft's. */
export const panelSelect = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: ReadonlyArray<SelectOption>,
	inputs: Readonly<{
		size?: "sm" | "default"
		className?: string
		ariaLabel?: string
		/** `false`: the list opens below the trigger instead of over it. */
		alignItemWithTrigger?: boolean
		/** Places the trigger and its siblings (hidden input, portal) in the caller's layout. */
		toView: (parts: ReadonlyArray<Html>) => Html
	}>,
): Html => {
	const index = Option.getOrNull(Arr.findFirstIndex(options, (option) => option.value === value))
	const current = model.selects[id] ?? Select.init(id, { value, selectedIndex: index })
	return h.submodel({
		slotId: `${model.slotPrefix}-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
		viewInputs: {
			entries: Arr.map(options, (item) => ({ _tag: "Item" as const, item })),
			size: inputs.size,
			className: inputs.className,
			ariaLabel: inputs.ariaLabel,
			alignItemWithTrigger: inputs.alignItemWithTrigger,
			toView: inputs.toView,
		},
	})
}
