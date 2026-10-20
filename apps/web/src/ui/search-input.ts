import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { inputGroup, inputGroupAddon, inputGroupButton, inputGroupInput } from "./input-group"

// Port of packages/ui/src/components/ui/search-input.tsx: magnifier, input and a clear button
// while there is a value. Not debounced: the caller turns each `onInput` into its Message.

export type SearchInputOptions<M> = Readonly<{
	id: string
	value: string
	placeholder?: string
	ariaLabel?: string
	onInput: (value: string) => M
	onClear: M
	clearLabel?: string
	/** `sm` for in-panel filters; `default` matches the page toolbar's controls. */
	size?: "sm" | "default"
	className?: string
	/** Extra trailing addon content before the clear button. */
	trailing?: ReadonlyArray<Html>
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const searchInput = <M>(h: HtmlBuilder<M>, options: SearchInputOptions<M>): Html => {
	const trailing = options.trailing ?? []
	const hasValue = options.value !== ""
	return inputGroup(h, { className: options.className }, [
		inputGroupAddon(h, {}, [icon(h, "MagnifierIcon")]),
		inputGroupInput(h, {
			id: options.id,
			size: options.size ?? "sm",
			type: "text",
			attributes: [
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
				h.Value(options.value),
				h.OnInput(options.onInput),
				...(options.attributes ?? []),
			],
		}),
		...(hasValue || trailing.length > 0
			? [
					inputGroupAddon(h, { align: "inline-end" }, [
						...trailing,
						...(hasValue
							? [
									inputGroupButton(
										h,
										{
											attributes: [
												h.AriaLabel(options.clearLabel ?? "Clear search"),
												h.OnClick(options.onClear),
											],
										},
										[icon(h, "XmarkIcon")],
									),
								]
							: []),
					]),
				]
			: []),
	])
}
