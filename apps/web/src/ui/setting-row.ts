import { cn } from "@maple/ui/lib/utils"
import {
	settingRowControlStyles,
	settingRowDescriptionStyles,
	settingRowFramedActiveStyles,
	settingRowFramedStyles,
	settingRowHeaderStyles,
	settingRowIconStyles,
	settingRowLabelStyles,
	settingRowLeadStyles,
	settingRowStyles,
	settingRowTextStyles,
} from "@maple/ui/styles/ui/setting-row"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/setting-row.tsx. The React row is a Base UI `Field`: its
// label points at the control's input, and the field state (`data-filled`, `data-disabled`) is
// mirrored onto the root, label and description. Ids are the caller's (the control uses them too).

export interface SettingRowIds {
	/** The control's form input, the label's `for`. */
	readonly control: string
	readonly label: string
	readonly description: string
}

const isChildList = (
	value: string | Html | ReadonlyArray<Html | string>,
): value is ReadonlyArray<Html | string> => Array.isArray(value)

const descriptionChildren = (value: string | Html | ReadonlyArray<Html | string>) =>
	isChildList(value) ? value : [value]

export interface SettingRowOptions {
	readonly ids: SettingRowIds
	/** Text, or a node (`label={<span>Google<Badge /></span>}`). */
	readonly label: string | Html
	readonly description?: string | Html | ReadonlyArray<Html | string>
	readonly icon?: Html
	/** The control, with its hidden form input when it has one (a Base UI Switch renders two nodes). */
	readonly control: ReadonlyArray<Html>
	readonly framed?: boolean
	readonly active?: boolean
	readonly disabled?: boolean
	/** Base UI's `data-filled`: the control holds a value (a checked switch). */
	readonly filled?: boolean
	readonly className?: string
}

export const settingRow = <M>(
	h: HtmlBuilder<M>,
	options: SettingRowOptions,
	children: ReadonlyArray<Html> = [],
): Html => {
	const framed = options.framed ?? false
	const fieldState = [
		...((options.disabled ?? false) ? [h.DataAttribute("disabled", "")] : []),
		...((options.filled ?? false) ? [h.DataAttribute("filled", "")] : []),
	]
	return h.div(
		[
			...fieldState,
			h.DataAttribute("slot", "setting-row"),
			h.Class(
				cn(
					settingRowStyles,
					framed && settingRowFramedStyles,
					framed && (options.active ?? false) && settingRowFramedActiveStyles,
					options.className,
				),
			),
		],
		[
			h.div(
				[h.Class(settingRowHeaderStyles)],
				[
					h.div(
						[h.Class(settingRowLeadStyles)],
						[
							...(options.icon === undefined
								? []
								: [h.div([h.Class(settingRowIconStyles)], [options.icon])]),
							h.div(
								[h.Class(settingRowTextStyles)],
								[
									h.label(
										[
											h.Class(settingRowLabelStyles),
											...fieldState,
											h.For(options.ids.control),
											h.Id(options.ids.label),
										],
										[options.label],
									),
									...(options.description === undefined
										? []
										: [
												h.p(
													[
														h.Class(
															cn(settingRowDescriptionStyles, "font-prose"),
														),
														...fieldState,
														h.Id(options.ids.description),
													],
													descriptionChildren(options.description),
												),
											]),
								],
							),
						],
					),
					h.div([h.Class(settingRowControlStyles)], options.control),
				],
			),
			...children,
		],
	)
}
