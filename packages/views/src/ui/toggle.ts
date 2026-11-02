import { cn } from "@maple/ui/lib/utils"
import { toggleVariants } from "@maple/ui/styles/ui/toggle"
import { Schema } from "effect"
import type { Update } from "foldkit"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { VariantProps } from "class-variance-authority"

/** Base UI `Toggle`'s uncontrolled state (`defaultPressed`): pressed or not. */

// MODEL

export const Model = Schema.Struct({ isPressed: Schema.Boolean })
export type Model = typeof Model.Type

export const init = (isPressed = false): Model => ({ isPressed })

// MESSAGE

export const Message = defineMessageUnion({ ClickedToggle: {} })
export type Message = typeof Message.Type

// UPDATE

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedToggle: () => ({ model: { isPressed: !model.isPressed } }),
	})

// VIEW

/** The `<button>` Base UI's `Toggle` renders: `aria-pressed`, `data-pressed`, `data-disabled`. */
export const togglePrimitive = <Message>(
	h: HtmlBuilder<Message>,
	options: Readonly<{
		isPressed: boolean
		isDisabled?: boolean
		onClick: Message
		className: string
		slot: string
		tabIndex?: number
		attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
	}>,
	children: ReadonlyArray<Html | string>,
): Html => {
	const isDisabled = options.isDisabled ?? false
	return h.button(
		[
			h.Type("button"),
			h.AriaPressed(String(options.isPressed)),
			h.Class(options.className),
			...(options.isPressed ? [h.DataAttribute("pressed", "")] : []),
			...(isDisabled
				? [h.DataAttribute("disabled", ""), h.Disabled(true)]
				: [h.OnClick(options.onClick)]),
			h.DataAttribute("slot", options.slot),
			h.Tabindex(options.tabIndex ?? 0),
			...(options.attributes ?? []),
		],
		children,
	)
}

export type ToggleOptions<Message> = VariantProps<typeof toggleVariants> &
	Readonly<{
		isPressed: boolean
		isDisabled?: boolean
		onClick: Message
		className?: string
		attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
	}>

/** `<Toggle>` from @maple/ui. */
export const toggle = <Message>(
	h: HtmlBuilder<Message>,
	options: ToggleOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html =>
	togglePrimitive(
		h,
		{
			...options,
			className: cn(
				toggleVariants({
					className: options.className,
					size: options.size,
					variant: options.variant,
				}),
			),
			slot: "toggle",
		},
		children,
	)

/**
 * A segment's height inside the recessed track (1px border + 2px padding a side), so the whole
 * track is as tall as a button or select of the same size in a toolbar row.
 */
export const segmentItemHeight = {
	xs: "h-[22px] min-w-[22px] sm:h-[22px] sm:min-w-[22px]",
	sm: "h-[calc(--spacing(8)-6px)] min-w-[calc(--spacing(8)-6px)] sm:h-[calc(--spacing(7)-6px)] sm:min-w-[calc(--spacing(7)-6px)]",
	default:
		"h-[calc(--spacing(9)-6px)] min-w-[calc(--spacing(9)-6px)] sm:h-[calc(--spacing(8)-6px)] sm:min-w-[calc(--spacing(8)-6px)]",
	lg: "h-[calc(--spacing(10)-6px)] min-w-[calc(--spacing(10)-6px)] sm:h-[calc(--spacing(9)-6px)] sm:min-w-[calc(--spacing(9)-6px)]",
} as const
