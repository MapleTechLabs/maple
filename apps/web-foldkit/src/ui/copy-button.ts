import { cn } from "@maple/ui/lib/utils"
import {
	copyButtonStatusStyles,
	copyButtonStyles,
	copyIndicatorCheckDrawStyles,
	copyIndicatorCopiedStyles,
	copyIndicatorErrorStyles,
	copyIndicatorFullStrengthStyles,
	copyIndicatorLayerActiveStyles,
	copyIndicatorLayerStyles,
	copyIndicatorStyles,
} from "@maple/ui/styles/ui/copy-button"
import { Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { type ButtonOptions, button } from "./button"
import { COPY_PATHS, strokeIcon } from "./stroke-icons"

// Port of packages/ui/src/components/ui/copy-button.tsx: `CopyIndicator`, `CopyButton` and the
// `useCopy` state (idle, copied, error; back to idle after `COPY_FEEDBACK`). Toasts are not ported.

export const CopyStatus = Schema.Literals(["idle", "copied", "error"])
export type CopyStatus = typeof CopyStatus.Type

/** `useCopy`'s default `timeout`. */
export const COPY_FEEDBACK = Duration.millis(2000)

// MODEL

export const Model = Schema.Struct({ status: CopyStatus, generation: Schema.Number })
export type Model = typeof Model.Type

export const init = (): Model => ({ status: "idle", generation: 0 })

// MESSAGE

export const Message = defineMessageUnion({
	ClickedCopy: { value: Schema.String },
	SucceededCopy: { generation: Schema.Number },
	FailedCopy: { generation: Schema.Number },
	ElapsedCopyFeedback: { generation: Schema.Number },
})
export type Message = typeof Message.Type

// COMMAND

export const WriteClipboard = Command.define("WriteClipboard", {
	args: { value: Schema.String, generation: Schema.Number },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ value, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(value)).pipe(
			Effect.as(Message.SucceededCopy({ generation })),
			Effect.catch(() => Effect.succeed(Message.FailedCopy({ generation }))),
		),
})

export const WaitCopyFeedback = Command.define("WaitCopyFeedback", {
	args: { generation: Schema.Number },
	messages: [Message.ElapsedCopyFeedback],
	execute: ({ generation }) =>
		Effect.sleep(COPY_FEEDBACK).pipe(Effect.as(Message.ElapsedCopyFeedback({ generation }))),
})

// UPDATE

type UpdateReturn = Update.Return<Model, Message>

const settle = (model: Model, generation: number, status: CopyStatus): UpdateReturn =>
	generation !== model.generation
		? { model }
		: { model: { ...model, status }, commands: [WaitCopyFeedback({ generation })] }

export const update = (model: Model, message: Message): UpdateReturn =>
	Message.match<UpdateReturn>(message, {
		ClickedCopy: ({ value }) => {
			const generation = model.generation + 1
			return { model: { ...model, generation }, commands: [WriteClipboard({ value, generation })] }
		},
		SucceededCopy: ({ generation }) => settle(model, generation, "copied"),
		FailedCopy: ({ generation }) => settle(model, generation, "error"),
		ElapsedCopyFeedback: ({ generation }) =>
			generation === model.generation ? { model: { ...model, status: "idle" } } : { model },
	})

// VIEW

const glyph = <M>(h: HtmlBuilder<M>, size: string, paths: ReadonlyArray<Html>): Html =>
	h.svg(
		[
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", size),
			h.Attribute("height", size),
			h.Attribute("fill", "none"),
			h.Attribute("aria-hidden", "true"),
			h.Attribute("class", copyIndicatorFullStrengthStyles),
		],
		paths,
	)

const strokePath = <M>(h: HtmlBuilder<M>, d: string, extra: ReadonlyArray<Attribute<M>> = []): Html =>
	h.path([
		h.Attribute("d", d),
		...extra,
		h.Attribute("stroke", "currentColor"),
		h.Attribute("stroke-width", "2"),
		h.Attribute("stroke-linecap", "square"),
	])

/** `CopyIndicator`: the idle glyph, a check that draws itself, and an X, stacked in one grid cell. */
export const copyIndicator = <M>(
	h: HtmlBuilder<M>,
	options: { readonly status: CopyStatus; readonly iconSize?: number; readonly className?: string },
): Html => {
	const iconSize = options.iconSize ?? 14
	const size = String(iconSize)
	return h.span(
		[
			h.AriaHidden(true),
			h.DataAttribute("copy-status", options.status),
			h.Class(cn(copyIndicatorStyles, options.className)),
			h.Style({ height: `${iconSize}px`, width: `${iconSize}px` }),
		],
		[
			h.span(
				[h.Class(cn(copyIndicatorLayerStyles, copyIndicatorLayerActiveStyles.idle))],
				[strokeIcon(h, COPY_PATHS, { size: iconSize })],
			),
			h.span(
				[
					h.Class(
						cn(copyIndicatorLayerStyles, copyIndicatorLayerActiveStyles.copied, copyIndicatorCopiedStyles),
					),
				],
				[
					glyph(h, size, [
						strokePath(h, "M4.5 12.5L9.5 17.5L19.5 6.5", [
							h.Attribute("pathLength", "1"),
							h.Attribute("class", copyIndicatorCheckDrawStyles),
						]),
					]),
				],
			),
			h.span(
				[
					h.Class(
						cn(copyIndicatorLayerStyles, copyIndicatorLayerActiveStyles.error, copyIndicatorErrorStyles),
					),
				],
				[glyph(h, size, [strokePath(h, "M6 6L18 18"), strokePath(h, "M18 6L6 18")])],
			),
		],
	)
}

export type CopyButtonOptions<M> = Pick<ButtonOptions<M>, "variant" | "size" | "className"> &
	Readonly<{
		/** Human name for the thing being copied; drives `aria-label`. */
		label: string
		status: CopyStatus
		iconSize?: number
		copiedLabel?: string
		errorLabel?: string
		onClick?: M
	}>

/** `CopyButton` (glyph only): a ghost icon button whose glyph and live region follow `status`. */
export const copyButton = <M>(h: HtmlBuilder<M>, options: CopyButtonOptions<M>): Html =>
	button(
		h,
		{
			variant: options.variant ?? "ghost",
			size: options.size ?? "icon-xs",
			className: cn(copyButtonStyles, options.className),
			attributes: [
				h.AriaLabel(`Copy ${options.label}`),
				h.DataAttribute("copy-status", options.status),
				...(options.onClick === undefined ? [] : [h.OnClick(options.onClick)]),
			],
		},
		[
			copyIndicator(h, { status: options.status, iconSize: options.iconSize }),
			h.span(
				[h.Role("status"), h.AriaLive("polite"), h.Class(copyButtonStatusStyles)],
				[
					options.status === "copied"
						? (options.copiedLabel ?? "Copied")
						: options.status === "error"
							? (options.errorLabel ?? "Failed to copy")
							: "",
				],
			),
		],
	)
