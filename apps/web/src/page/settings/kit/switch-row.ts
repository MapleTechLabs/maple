import type { Html, HtmlBuilder } from "foldkit/html"
import { settingRow } from "../../../ui/setting-row"
import { switchControl } from "../../../ui/switch"

// `<SettingRow label description control={<Switch checked onCheckedChange />} />`: the row is the
// switch's Base UI field, so a checked switch marks the row, label and description filled.

export type SwitchRowOptions<M> = Readonly<{
	id: string
	label: string
	description?: string
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
