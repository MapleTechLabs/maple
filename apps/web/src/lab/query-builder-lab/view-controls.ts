import { cn } from "@maple/ui/lib/utils"
import { eyebrowVariants } from "@maple/ui/styles/ui/eyebrow"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"
import * as Select from "../../ui/select"
import { type SelectOption, view as selectView } from "../../ui/select-view"
import { Message, type Model } from "./model"

// The small pieces the lab's query and formula cards share.

type H = HtmlBuilder<Message>

/** `<Eyebrow variant="label" as="p">`. */
export const fieldEyebrow = (h: H, text: string, className?: string): Html =>
	eyebrow(h, { variant: "label", as: "p", className }, [text])

/** `<Eyebrow variant="label" render={<Label />}>`: a label element at the eyebrow's size, like its siblings. */
export const labelEyebrow = (h: H, text: string): Html =>
	h.label(
		[
			h.Class(cn("inline-flex items-center gap-2", eyebrowVariants({ variant: "label" }))),
			h.DataAttribute("slot", "eyebrow"),
		],
		[text],
	)

export type LabSelectOptions = Readonly<{
	className: string
	toView: (parts: ReadonlyArray<Html>) => Html
	/** `<SelectValue placeholder>` while the value matches no option. */
	placeholder?: string
}>

/** A `<Select items value onValueChange>` kept by id (`<field>:<query id>`); its value is the draft's. */
export const labSelect = (
	h: H,
	model: Model,
	id: string,
	value: string,
	options: ReadonlyArray<SelectOption>,
	inputs: LabSelectOptions,
): Html => {
	const index = options.findIndex((option) => option.value === value)
	const current =
		model.selects[id] ?? Select.init(id, { value, selectedIndex: index === -1 ? null : index })
	const { placeholder } = inputs
	return h.submodel({
		slotId: `query-builder-lab-select-${id}`,
		model: { ...current, value },
		view: selectView,
		toParentMessage: (message) => Message.GotSelectMessage({ id, message }),
		viewInputs: {
			entries: options.map((item) => ({ _tag: "Item" as const, item })),
			className: inputs.className,
			toView: inputs.toView,
			renderValue: placeholder === undefined || index !== -1 ? undefined : () => [placeholder],
		},
	})
}
