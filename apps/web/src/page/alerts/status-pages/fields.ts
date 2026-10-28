import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { input } from "../../../ui/input"
import { label } from "../../../ui/label"
import { nativeOption, nativeSelect } from "../../../ui/native-select"
import { textarea } from "../../../ui/textarea"

// The labelled inputs the status page forms share: label over control, hint or error under it.

type Common<M> = Readonly<{
	id: string
	label: string
	hint?: string
	/** Replaces the hint, in the destructive colour. */
	error?: string | null
	className?: string
	isDisabled?: boolean
	/** Kept for screen readers when a row already names the control. */
	isLabelHidden?: boolean
	onInput: (value: string) => M
}>

const frame = <M>(h: HtmlBuilder<M>, options: Common<M>, control: Html): Html => {
	const error = options.error ?? null
	return h.div(
		[h.Class(cn("flex flex-col gap-1.5", options.className))],
		[
			label(
				h,
				{
					className: options.isLabelHidden === true ? "sr-only" : "text-xs text-muted-foreground",
					attributes: [h.For(options.id)],
				},
				[options.label],
			),
			control,
			...(error !== null
				? [h.p([h.Id(`${options.id}-error`), h.Class("text-xs text-destructive")], [error])]
				: options.hint === undefined
					? []
					: [h.p([h.Class("text-xs text-muted-foreground")], [options.hint])]),
		],
	)
}

export const textField = <M>(
	h: HtmlBuilder<M>,
	options: Common<M> & Readonly<{ value: string; placeholder?: string; type?: string; isMono?: boolean }>,
): Html =>
	frame(
		h,
		options,
		input(h, {
			id: options.id,
			type: options.type,
			isDisabled: options.isDisabled,
			controlClassName: options.isMono === true ? "font-mono" : undefined,
			attributes: [
				h.Value(options.value),
				h.OnInput(options.onInput),
				...(options.placeholder === undefined ? [] : [h.Placeholder(options.placeholder)]),
				...((options.error ?? null) === null
					? []
					: [h.AriaInvalid(true), h.AriaDescribedBy(`${options.id}-error`)]),
			],
		}),
	)

export const textareaField = <M>(
	h: HtmlBuilder<M>,
	options: Common<M> & Readonly<{ value: string; placeholder?: string }>,
): Html =>
	frame(
		h,
		options,
		textarea(h, {
			id: options.id,
			isDisabled: options.isDisabled,
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
		Readonly<{ value: string; entries: ReadonlyArray<{ value: string; label: string }> }>,
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
				attributes: [
					// Uncontrolled: keyed on the value so a reset or a reopened form rebuilds it.
					h.Key(`${options.id}-${options.value}`),
					h.Id(options.id),
					h.OnChange(options.onInput),
				],
			},
			options.entries.map((entry) => nativeOption(entry.value, entry.label)),
		),
	)
