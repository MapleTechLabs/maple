import { cn } from "@maple/ui/lib/utils"
import { Array as Arr, Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as Checkbox from "./checkbox"
import { labelIdOf } from "./choice"
import { label } from "./label"
import * as RadioGroup from "./radio-group"

// `ControlCard`: a bordered option card with a visible kit radio or checkbox, the whole card its
// click target. Unlike `choiceCard`, the control stays drawn (the create-role, add-target and
// source-signal pickers).

export type ControlCardTone = "neutral" | "primary"

const FRAME = "flex cursor-pointer items-start gap-2.5 rounded-md border p-3 font-normal"

const UNCHECKED = "hover:bg-surface-sunken active:bg-surface-sunken"

const CHECKED = {
	neutral: "border-border-strong bg-surface-strong",
	primary: "border-primary-a4 bg-primary-a1",
} as const satisfies Record<ControlCardTone, string>

const card = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ key: string; inputId: string; isChecked: boolean; tone: ControlCardTone }>,
	control: ReadonlyArray<Html>,
	children: ReadonlyArray<Html | string>,
): Html =>
	label(
		h,
		{
			className: cn(FRAME, options.isChecked ? CHECKED[options.tone] : UNCHECKED),
			attributes: [h.Key(options.key), h.Id(labelIdOf(options.inputId))],
		},
		[...control, ...children],
	)

/** One radio of a `radioGroup` as a card: `value`'s radio from `config`, then `children`. */
export const radioCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ config: RadioGroup.RadioGroupViewConfig<M>; value: string; tone?: ControlCardTone }>,
	children: ReadonlyArray<Html | string>,
): ReadonlyArray<Html> =>
	Option.match(
		Arr.findFirst(options.config.items, (item) => item.value === options.value),
		{
			onNone: () => [],
			onSome: (item) => [
				card(
					h,
					{
						key: item.value,
						inputId: item.inputId,
						isChecked: Option.contains(options.config.model.maybeValue, item.value),
						tone: options.tone ?? "neutral",
					},
					RadioGroup.radio(h, options.config, item.value, "mt-0.5"),
					children,
				),
			],
		},
	)

/** A checkbox as a card: the checkbox `config` draws, then `children`. */
export const checkboxCard = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ config: Checkbox.CheckboxViewConfig<M>; tone?: ControlCardTone }>,
	children: ReadonlyArray<Html | string>,
): Html =>
	card(
		h,
		{
			key: options.config.inputId,
			inputId: options.config.inputId,
			isChecked: options.config.model.isChecked,
			tone: options.tone ?? "neutral",
		},
		Checkbox.view(h, { ...options.config, className: cn("mt-0.5", options.config.className) }),
		children,
	)
