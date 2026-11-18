import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
	field,
	fieldDescription,
	fieldError,
	type FieldIds,
	fieldLabel,
	type FieldState,
} from "@maple/views/ui/field"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import { input } from "@maple/views/ui/input"
import { nativeOption, nativeSelect } from "@maple/views/ui/native-select"
import { hstack } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"
import { textarea } from "@maple/views/ui/textarea"
import { Array as Arr } from "effect"

// The labelled inputs the status page forms share: label over control, hint or error under it.

type Frame = Readonly<{
	id: string
	label: string
	/** Text, or text with links in it. */
	hint?: string | ReadonlyArray<Html | string>
	/** Replaces the hint, in the error colour. */
	error?: string | null
	className?: string
	isDisabled?: boolean
	/** Kept for screen readers when a row already names the control. */
	isLabelHidden?: boolean
}>

type Common<M> = Frame & Readonly<{ onInput: (value: string) => M }>

/** A label over a control drawn elsewhere (a dropdown), with the hint or error under it. */
export const labelledField = <M>(h: HtmlBuilder<M>, options: Frame, control: Html): Html =>
	frame(h, options, control)

const frame = <M>(h: HtmlBuilder<M>, options: Frame, control: Html): Html => {
	const error = options.error ?? null
	const state: FieldState = {
		isInvalid: error !== null,
		isDirty: false,
		isFilled: false,
		isFocused: false,
		isTouched: false,
	}
	const ids: FieldIds = { control: options.id, label: `${options.id}-label`, error: `${options.id}-error` }
	return field(h, { state, className: cn("items-stretch gap-1.5", options.className) }, [
		fieldLabel(
			h,
			{ ids, state, className: options.isLabelHidden === true ? "sr-only" : undefined },
			options.label,
		),
		control,
		...(error !== null
			? [fieldError(h, { ids, state }, error)]
			: options.hint === undefined
				? []
				: [fieldDescription(h, { ids, state }, options.hint)]),
	])
}

export const textField = <M>(
	h: HtmlBuilder<M>,
	options: Common<M> &
		Readonly<{
			value: string
			placeholder?: string
			type?: string
			isMono?: boolean
			/** Commits the field: the editor saves as you go. */
			onBlur?: M
			/** Beside the input, level with it rather than with the label or hint: a submit button. */
			trailing?: Html
		}>,
): Html => {
	const control = input(h, {
		id: options.id,
		type: options.type,
		isDisabled: options.isDisabled,
		controlClassName: options.isMono === true ? "font-mono" : undefined,
		attributes: [
			h.Value(options.value),
			h.OnInput(options.onInput),
			...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
			...(options.onBlur === undefined ? [] : [h.OnBlur(options.onBlur)]),
			...((options.error ?? null) === null
				? []
				: [h.AriaInvalid(true), h.AriaDescribedBy(`${options.id}-error`)]),
		],
		className: options.trailing === undefined ? undefined : "min-w-0 flex-1",
	})
	return frame(
		h,
		options,
		options.trailing === undefined ? control : hstack(h, { gap: "2" }, [control, options.trailing]),
	)
}

export const textareaField = <M>(
	h: HtmlBuilder<M>,
	options: Common<M> &
		Readonly<{
			value: string
			placeholder?: string
			/** The box's height, as layout: `min-h-30`. */
			controlClassName?: string
		}>,
): Html =>
	frame(
		h,
		options,
		textarea(h, {
			id: options.id,
			isDisabled: options.isDisabled,
			controlClassName: options.controlClassName,
			attributes: [
				h.Value(options.value),
				h.OnInput(options.onInput),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
			],
		}),
	)

export const selectField = <M>(
	h: HtmlBuilder<M>,
	options: Common<M> &
		Readonly<{
			value: string
			entries: ReadonlyArray<{ value: string; label: string }>
			/** A mark before the value, such as the picked impact's dot. */
			leading?: Html
		}>,
): Html =>
	frame(
		h,
		options,
		nativeSelect(
			h,
			{
				defaultValue: options.value,
				className: "w-full",
				isDisabled: options.isDisabled,
				leading: options.leading,
				attributes: [
					// Uncontrolled: keyed on the value so a reset or a reopened form rebuilds it.
					h.Key(`${options.id}-${options.value}`),
					h.Id(options.id),
					h.OnChange(options.onInput),
				],
			},
			Arr.map(options.entries, (entry) => nativeOption(entry.value, entry.label)),
		),
	)

/** A value picked in a dialog: the field shows it, a click opens the dialog. */
export const buttonField = <M>(
	h: HtmlBuilder<M>,
	options: Frame &
		Readonly<{
			value: string
			/** Shown, muted, while there is no value. */
			placeholder: string
			onClick: M
		}>,
): Html =>
	frame(
		h,
		options,
		button(
			h,
			{
				variant: "outline",
				isDisabled: options.isDisabled,
				className: "w-full justify-between",
				attributes: [
					h.Id(options.id),
					h.AriaHasPopup("dialog"),
					h.AriaLabelledBy(`${options.id}-label ${options.id}`),
					h.OnClick(options.onClick),
				],
			},
			[
				options.value === ""
					? typography(h, { tone: "muted", truncate: true }, [options.placeholder])
					: typography(h, { truncate: true }, [options.value]),
				icon(h, "ChevronDownIcon", { className: "text-muted-foreground" }),
			],
		),
	)
