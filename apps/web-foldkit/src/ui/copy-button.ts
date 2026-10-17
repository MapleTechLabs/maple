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
	copyLabelActiveStyles,
	copyLabelLayerStyles,
	copyLabelStyles,
} from "@maple/ui/styles/ui/copy-button"
import { Duration, Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { button } from "./button"
import { copyIcon } from "./icon"

/**
 * `useCopy` + `<CopyButton>`: copy writes the clipboard, holds `copied`/`error` for the timeout,
 * then falls back to `idle`. A newer copy bumps `generation` so an older reset is dropped.
 * TODO(toast): legacy also toasts on copy; toasts are not ported yet.
 */

export const CopyStatus = Schema.Literals(["idle", "copied", "error"])
export type CopyStatus = typeof CopyStatus.Type

const COPY_TIMEOUT = Duration.millis(2000)

// MODEL

export const Model = Schema.Struct({ status: CopyStatus, generation: Schema.Finite })
export type Model = typeof Model.Type

export const init = (): Model => ({ status: "idle", generation: 0 })

// MESSAGE

export const Message = defineMessageUnion({
	ClickedCopy: { text: Schema.String },
	SucceededCopy: { generation: Schema.Finite },
	FailedCopy: { generation: Schema.Finite },
	ElapsedCopyStatus: { generation: Schema.Finite },
})
export type Message = typeof Message.Type

// COMMAND

export const WriteClipboard = Command.define("WriteClipboard", {
	args: { text: Schema.String, generation: Schema.Finite },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	execute: ({ text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(Message.SucceededCopy({ generation })),
			Effect.orElseSucceed(() => Message.FailedCopy({ generation })),
		),
})

export const WaitCopyStatus = Command.define("WaitCopyStatus", {
	args: { generation: Schema.Finite },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ generation }) =>
		Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation }))),
})

// UPDATE

const settled = (model: Model, generation: number, status: CopyStatus): Update.Return<Model, Message> =>
	generation === model.generation
		? { model: modifyFields(model, { status: () => status }), commands: [WaitCopyStatus({ generation })] }
		: { model }

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
	Message.match<Update.Return<Model, Message>>(message, {
		ClickedCopy: ({ text }) => {
			const generation = model.generation + 1
			return text === ""
				? settled(modifyFields(model, { generation: () => generation }), generation, "error")
				: {
						model: modifyFields(model, { generation: () => generation }),
						commands: [WriteClipboard({ text, generation })],
					}
		},
		SucceededCopy: ({ generation }) => settled(model, generation, "copied"),
		FailedCopy: ({ generation }) => settled(model, generation, "error"),
		ElapsedCopyStatus: ({ generation }) =>
			generation === model.generation
				? { model: modifyFields(model, { status: () => "idle" }) }
				: { model },
	})

// VIEW

const CHECK_PATH = "M4.5 12.5L9.5 17.5L19.5 6.5"

const glyphSvg = <M>(h: HtmlBuilder<M>, size: string, paths: ReadonlyArray<Html>): Html =>
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

const strokePath = <M>(h: HtmlBuilder<M>, d: string, extra: ReadonlyArray<Attribute<M>> = []) =>
	h.path([
		...extra,
		h.Attribute("d", d),
		h.Attribute("stroke", "currentColor"),
		h.Attribute("stroke-width", "2"),
		h.Attribute("stroke-linecap", "square"),
	])

/** `<CopyIndicator>`: idle glyph, a self-drawing check and an X, stacked in one grid cell. */
export const copyIndicator = <M>(h: HtmlBuilder<M>, status: CopyStatus, iconSize = 14): Html => {
	const size = String(iconSize)
	return h.span(
		[
			h.AriaHidden(true),
			h.DataAttribute("copy-status", status),
			h.Class(copyIndicatorStyles),
			h.Style({ height: `${iconSize}px`, width: `${iconSize}px` }),
		],
		[
			h.span(
				[h.Class(cn(copyIndicatorLayerStyles, copyIndicatorLayerActiveStyles.idle))],
				[copyIcon(h, { size: iconSize })],
			),
			h.span(
				[
					h.Class(
						cn(
							copyIndicatorLayerStyles,
							copyIndicatorLayerActiveStyles.copied,
							copyIndicatorCopiedStyles,
						),
					),
				],
				[
					glyphSvg(h, size, [
						strokePath(h, CHECK_PATH, [
							h.Attribute("class", copyIndicatorCheckDrawStyles),
							h.Attribute("pathLength", "1"),
						]),
					]),
				],
			),
			h.span(
				[
					h.Class(
						cn(
							copyIndicatorLayerStyles,
							copyIndicatorLayerActiveStyles.error,
							copyIndicatorErrorStyles,
						),
					),
				],
				[glyphSvg(h, size, [strokePath(h, "M6 6L18 18"), strokePath(h, "M18 6L6 18")])],
			),
		],
	)
}

export type CopyButtonViewConfig<ParentMessage> = Readonly<{
	model: Model
	toParentMessage: (message: Message) => ParentMessage
	value: string
	/** Human name for the thing copied: drives `aria-label`. */
	label: string
	/** Turns the animated text label on. */
	idleLabel?: string
	copiedLabel?: string
	errorLabel?: string
	variant?: "default" | "secondary" | "outline" | "ghost"
	size?: "xs" | "sm" | "default" | "icon-xs" | "icon-sm" | "icon"
	className?: string
}>

/** `<CopyButton>` from @maple/ui (no tooltip). */
export const view = <ParentMessage>(
	h: HtmlBuilder<ParentMessage>,
	config: CopyButtonViewConfig<ParentMessage>,
): Html => {
	const { status } = config.model
	const copiedLabel = config.copiedLabel ?? "Copied"
	const errorText = config.errorLabel ?? "Failed to copy"
	const labels: ReadonlyArray<readonly [CopyStatus, string]> =
		config.idleLabel === undefined
			? []
			: [
					["idle", config.idleLabel],
					["copied", copiedLabel],
					["error", config.errorLabel ?? "Failed"],
				]
	return button(
		h,
		{
			variant: config.variant ?? "ghost",
			size: config.size ?? (config.idleLabel === undefined ? "icon-xs" : "sm"),
			className: cn(copyButtonStyles, config.className),
			attributes: [
				h.AriaLabel(`Copy ${config.label}`),
				h.DataAttribute("copy-status", status),
				h.OnClick(config.toParentMessage(Message.ClickedCopy({ text: config.value }))),
			],
		},
		[
			copyIndicator(h, status),
			...(labels.length === 0
				? []
				: [
						h.span(
							[h.AriaHidden(true), h.Class(copyLabelStyles)],
							labels.map(([key, text]) =>
								h.span(
									[h.Class(cn(copyLabelLayerStyles, copyLabelActiveStyles[key]))],
									[text],
								),
							),
						),
					]),
			h.span(
				[h.Role("status"), h.AriaLive("polite"), h.Class(copyButtonStatusStyles)],
				[status === "copied" ? copiedLabel : status === "error" ? errorText : ""],
			),
		],
	)
}
