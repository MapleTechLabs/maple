import {
	copyableFieldInputStyles,
	copyableFieldLabelStyles,
	copyableFieldRevealVisibleStyles,
	copyableFieldStyles,
} from "@maple/ui/styles/ui/copyable-field"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "./copy-button"
import { icon } from "./icon"
import { inputGroup, inputGroupAddon, inputGroupButton, inputGroupInput } from "./input-group"

// Port of packages/ui/src/components/ui/copyable-field.tsx. The parent owns the copy status and,
// for `masked`, whether the value is revealed.

/** `maskKey`: the readable prefix and the last four characters. */
export const maskKey = (key: string): string =>
	key.length <= 18 ? key : `${key.slice(0, 14)}${"•".repeat(key.length - 18)}${key.slice(-4)}`

/** `render={<InputGroupButton />}`: the xs input-group size classes join CopyButton's own. */
const INPUT_GROUP_COPY_CLASS = "px-[calc(--spacing(2)-1px)] [&_svg:not([class*='size-'])]:size-3"

export type CopyableFieldOptions<M> = Readonly<{
	/** The input's id (Base UI's `useId`). */
	id: string
	value: string
	label?: string
	copyLabel?: string
	copy: CopyButton.Model
	toCopyMessage: (message: CopyButton.Message) => M
	/** Set for a secret: the reveal toggle and whether it is showing. */
	masked?: Readonly<{ isVisible: boolean; onToggle: M }>
}>

export const copyableField = <M>(h: HtmlBuilder<M>, options: CopyableFieldOptions<M>): Html => {
	const masked = options.masked
	const isHidden = masked !== undefined && !masked.isVisible
	return h.div(
		[h.Class(copyableFieldStyles)],
		[
			...(options.label === undefined ? [] : [h.label([h.Class(copyableFieldLabelStyles)], [options.label])]),
			inputGroup(h, {}, [
				inputGroupInput(h, {
					id: options.id,
					className: copyableFieldInputStyles,
					attributes: [h.Readonly(true), h.Value(isHidden ? maskKey(options.value) : options.value)],
				}),
				inputGroupAddon(h, { align: "inline-end" }, [
					...(masked === undefined
						? []
						: [
								inputGroupButton(
									h,
									{
										attributes: [
											h.OnClick(masked.onToggle),
											h.AriaLabel(masked.isVisible ? "Hide key" : "Reveal key"),
										],
									},
									[
										icon(h, "EyeIcon", {
											size: 14,
											className: masked.isVisible ? copyableFieldRevealVisibleStyles : undefined,
										}),
									],
								),
							]),
					CopyButton.view(h, {
						model: options.copy,
						toParentMessage: options.toCopyMessage,
						value: options.value,
						label: options.copyLabel || options.label || "Value",
						className: INPUT_GROUP_COPY_CLASS,
					}),
				]),
			]),
		],
	)
}
