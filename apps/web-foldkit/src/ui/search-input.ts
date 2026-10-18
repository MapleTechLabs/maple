import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"
import { inputGroup, inputGroupAddon, inputGroupButton, inputGroupInput } from "./input-group"

// Port of packages/ui/src/components/ui/search-input.tsx: magnifier, input, clear button.

export type SearchInputOptions<M> = Readonly<{
	id: string
	value: string
	onInput: (value: string) => M
	/** The clear button empties the value (`onValueChange("")` then `onClear`). */
	onClear: M
	placeholder?: string
	ariaLabel?: string
	clearLabel?: string
	size?: "sm" | "default"
	className?: string
	attributes?: ReadonlyArray<Attribute<M>>
}>

export const searchInput = <M>(h: HtmlBuilder<M>, options: SearchInputOptions<M>): Html =>
	inputGroup(h, { className: options.className }, [
		inputGroupAddon(h, {}, [icon(h, "MagnifierIcon")]),
		inputGroupInput(h, {
			id: options.id,
			size: options.size ?? "sm",
			type: "text",
			attributes: [
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...(options.ariaLabel === undefined ? [] : [h.AriaLabel(options.ariaLabel)]),
				...(options.attributes ?? []),
				h.Value(options.value),
				h.OnInput(options.onInput),
			],
		}),
		...(options.value === ""
			? []
			: [
					inputGroupAddon(h, { align: "inline-end" }, [
						inputGroupButton(
							h,
							{ attributes: [h.AriaLabel(options.clearLabel ?? "Clear search"), h.OnClick(options.onClear)] },
							[icon(h, "XmarkIcon")],
						),
					]),
				]),
	])
