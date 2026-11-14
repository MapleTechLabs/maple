import type { Html, HtmlBuilder } from "foldkit/html"
import { settingRow } from "@maple/views/ui/setting-row"
import { switchControl } from "@maple/views/ui/switch"

// A settings row whose control is a switch: the row is the switch's field, so a checked switch marks
// the row, label and description filled.

export type SwitchRowOptions<M> = Readonly<{
	id: string
	label: string
	description?: string
	/** A status beside the label (a badge); not part of the switch's name. */
	status?: Html
	isChecked: boolean
	isDisabled?: boolean
	onToggle?: M
	className?: string
	framed?: boolean
	icon?: Html
	/** Controls placed before the switch (a Preview button). */
	before?: ReadonlyArray<Html>
}>

export const switchRow = <M>(
	h: HtmlBuilder<M>,
	options: SwitchRowOptions<M>,
	children: ReadonlyArray<Html> = [],
): Html =>
	settingRow(
		h,
		{
			ids: {
				control: `${options.id}-input`,
				label: `${options.id}-label`,
				description: `${options.id}-description`,
			},
			label: options.label,
			...(options.description !== undefined && { description: options.description }),
			...(options.className !== undefined && { className: options.className }),
			...(options.icon !== undefined && { icon: options.icon }),
			...(options.status !== undefined && { status: options.status }),
			framed: options.framed ?? false,
			filled: options.isChecked,
			disabled: options.isDisabled,
			control: [
				...(options.before ?? []),
				...switchControl(h, {
					id: options.id,
					inputId: `${options.id}-input`,
					isChecked: options.isChecked,
					isDisabled: options.isDisabled,
					labelledBy: `${options.id}-label`,
					...(options.description !== undefined && { describedBy: `${options.id}-description` }),
					isFilled: options.isChecked,
					onToggle: options.onToggle,
				}),
			],
		},
		children,
	)
