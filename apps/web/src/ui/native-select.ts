import { cn } from "@maple/ui/lib/utils"
import {
	nativeSelectIconStyles,
	nativeSelectStyles,
	nativeSelectWrapperStyles,
} from "@maple/ui/styles/ui/native-select"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

export type NativeSelectOption = Readonly<{ value: string; label: string }>
export type NativeSelectEntry =
	| Readonly<{ _tag: "Option"; option: NativeSelectOption }>
	| Readonly<{ _tag: "Group"; label: string; options: ReadonlyArray<NativeSelectOption> }>

export const nativeOption = (value: string, label: string): NativeSelectEntry => ({
	_tag: "Option",
	option: { value, label },
})
export const nativeOptGroup = (
	label: string,
	options: ReadonlyArray<NativeSelectOption>,
): NativeSelectEntry => ({
	_tag: "Group",
	label,
	options,
})

const optionView = <M>(h: HtmlBuilder<M>, option: NativeSelectOption, selected: string | undefined): Html =>
	h.option(
		[
			h.DataAttribute("slot", "native-select-option"),
			...(option.value === selected ? [h.Selected(true)] : []),
			h.Value(option.value),
		],
		[option.label],
	)

/** `<NativeSelect>`: a styled native `<select>` with the chevron overlay; uncontrolled (`defaultValue`). */
export const nativeSelect = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{
		size?: "sm" | "default"
		className?: string
		defaultValue?: string
		isDisabled?: boolean
		attributes?: ReadonlyArray<Attribute<Message>>
	}>,
	entries: ReadonlyArray<NativeSelectEntry>,
): Html => {
	const size = options.size ?? "default"
	return h.div(
		[
			h.Class(cn(nativeSelectWrapperStyles, options.className)),
			h.DataAttribute("size", size),
			h.DataAttribute("slot", "native-select-wrapper"),
		],
		[
			h.select(
				[
					...(options.attributes ?? []),
					h.Class(nativeSelectStyles),
					h.DataAttribute("size", size),
					h.DataAttribute("slot", "native-select"),
					...(options.isDisabled === true ? [h.Disabled(true)] : []),
				],
				entries.map((entry) =>
					entry._tag === "Option"
						? optionView(h, entry.option, options.defaultValue)
						: h.optgroup(
								[
									h.Attribute("class", ""),
									h.DataAttribute("slot", "native-select-optgroup"),
									h.LabelAttr(entry.label),
								],
								entry.options.map((option) => optionView(h, option, options.defaultValue)),
							),
				),
			),
			icon(h, "ChevronExpandYIcon", {
				className: nativeSelectIconStyles,
				attributes: [h.Attribute("stroke-width", "2"), h.DataAttribute("slot", "native-select-icon")],
			}),
		],
	)
}
