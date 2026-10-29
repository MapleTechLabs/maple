import { writeClipboardFallback } from "@maple/ui/lib/clipboard"
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
import { Duration, Effect, Layer, Schema } from "effect"
import { Block } from "foldkit"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { button } from "./button"
import { icon, type IconName } from "./icon"

/**
 * `useCopy` + `<CopyButton>` as `CopyButtonBlock`: copy writes the clipboard, holds `copied`/`error`
 * for the timeout, then falls back to `idle`. A newer copy bumps `generation` so an older reset is dropped.
 * TODO(toast): also toast on copy.
 */

export const CopyStatus = Schema.Literals(["idle", "copied", "error"])
export type CopyStatus = typeof CopyStatus.Type

const COPY_TIMEOUT = Duration.millis(2000)

// MODEL

export const Model = Schema.Struct({ status: CopyStatus, generation: Schema.Finite })
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
	ClickedCopy: { text: Schema.String },
	SucceededCopy: { generation: Schema.Finite },
	FailedCopy: { generation: Schema.Finite },
	ElapsedCopyStatus: { generation: Schema.Finite },
})
export type Message = typeof Message.Type

const CopyButtonDefinition = Block.makeDefinition("CopyButton", { Model, Message })

// COMMAND

/** `useCopy`'s write: whether the text reached the clipboard. */
export const writeClipboard = (text: string): Effect.Effect<boolean> =>
	Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
		Effect.as(true),
		// A rejected clipboard API falls back to the `execCommand` textarea write.
		Effect.catch(() => Effect.try(() => writeClipboardFallback(text))),
		Effect.orElseSucceed(() => false),
	)

export const WriteClipboard = CopyButtonDefinition.makeCommand("WriteClipboard", {
	args: { text: Schema.String, generation: Schema.Finite },
	messages: [Message.SucceededCopy, Message.FailedCopy],
	handler: function* () {
		return ({ text, generation }) =>
			Effect.map(writeClipboard(text), (ok) =>
				ok ? Message.SucceededCopy({ generation }) : Message.FailedCopy({ generation }),
			)
	},
})

export const WaitCopyStatus = CopyButtonDefinition.makeCommand("WaitCopyStatus", {
	args: { generation: Schema.Finite },
	messages: [Message.ElapsedCopyStatus],
	handler: function* () {
		return ({ generation }) =>
			Effect.sleep(COPY_TIMEOUT).pipe(Effect.as(Message.ElapsedCopyStatus({ generation })))
	},
})

const CopyButtonComposition = CopyButtonDefinition.makeComposition()

// UPDATE

const init = CopyButtonComposition.makeInit(() => ({
	model: Model.make({ status: "idle", generation: 0 }),
}))

const settled = (model: Model, generation: number, status: CopyStatus) =>
	generation === model.generation
		? { model: modifyFields(model, { status: () => status }), commands: [WaitCopyStatus({ generation })] }
		: { model, commands: [] }

const update = CopyButtonComposition.makeUpdate({
	ClickedCopy: (model, { text }) => {
		const generation = model.generation + 1
		return text === ""
			? settled(modifyFields(model, { generation: () => generation }), generation, "error")
			: {
					model: modifyFields(model, { generation: () => generation }),
					commands: [WriteClipboard({ text, generation })],
				}
	},
	SucceededCopy: (model, { generation }) => settled(model, generation, "copied"),
	FailedCopy: (model, { generation }) => settled(model, generation, "error"),
	ElapsedCopyStatus: (model, { generation }) =>
		generation === model.generation ? { model: modifyFields(model, { status: () => "idle" }) } : { model },
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
export const copyIndicator = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ status: CopyStatus; iconSize?: number; className?: string; idleIcon?: IconName }>,
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
				[icon(h, options.idleIcon ?? "CopyIcon", { size: iconSize })],
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

export type CopyButtonOptions<M> = Readonly<{
	status: CopyStatus
	/** Human name for the thing copied: drives `aria-label`. */
	label: string
	onClick?: M
	/** Turns the animated text label on. */
	idleLabel?: string
	/** The resting glyph (`CopyIcon` unless the call site passes one). */
	idleIcon?: IconName
	copiedLabel?: string
	errorLabel?: string
	iconSize?: number
	variant?: "default" | "secondary" | "outline" | "ghost"
	size?: "xs" | "sm" | "default" | "icon-xs" | "icon-sm" | "icon"
	className?: string
	/** `data-slot` when a wrapper renders through it (`tooltip-trigger`). */
	slot?: string
	/** Props spread onto the button after its own. */
	attributes?: ReadonlyArray<Attribute<M> | ChildAttribute>
}>

/** `<CopyButton>` from @maple/ui (no tooltip), for a parent that owns the copy status. */
export const copyButton = <M>(h: HtmlBuilder<M>, options: CopyButtonOptions<M>): Html => {
	const { status } = options
	const copiedLabel = options.copiedLabel ?? "Copied"
	const errorText = options.errorLabel ?? "Failed to copy"
	const labels: ReadonlyArray<readonly [CopyStatus, string]> =
		options.idleLabel === undefined
			? []
			: [
					["idle", options.idleLabel],
					["copied", copiedLabel],
					["error", options.errorLabel ?? "Failed"],
				]
	return button(
		h,
		{
			variant: options.variant ?? "ghost",
			size: options.size ?? (options.idleLabel === undefined ? "icon-xs" : "sm"),
			className: cn(copyButtonStyles, options.className),
			slot: options.slot,
			attributes: [
				h.AriaLabel(`Copy ${options.label}`),
				h.DataAttribute("copy-status", status),
				...(options.onClick === undefined ? [] : [h.OnClick(options.onClick)]),
				...(options.attributes ?? []),
			],
		},
		[
			copyIndicator(h, { status, iconSize: options.iconSize, idleIcon: options.idleIcon }),
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

/** Data-only attributes a parent may pass through: Block view inputs cannot carry callbacks. */
export type CopyButtonPassthroughAttribute = Extract<
	Attribute<never>,
	Readonly<{ _tag: "DataAttribute" | "Attribute" | "Disabled" | "Title" | "Id" }>
>

/** What the embedding parent supplies through `CopyButtonBinding.embedView({ viewInputs })`. */
export type CopyButtonViewInputs = Omit<CopyButtonOptions<Message>, "status" | "onClick" | "attributes"> &
	Readonly<{
		/** The text a click copies. */
		value: string
		attributes?: ReadonlyArray<CopyButtonPassthroughAttribute>
	}>

/** `<CopyButton>` as the Block view: the click copies `value` and the Model holds the status. */
const view = CopyButtonComposition.makeView.withInputs<CopyButtonViewInputs>((model, viewInputs, h) =>
	copyButton(h, {
		...viewInputs,
		status: model.status,
		onClick: Message.ClickedCopy({ text: viewInputs.value }),
	}),
)

const prepare = () =>
	CopyButtonComposition.prepareBlock({
		init,
		update,
		view,
		EffectsLayer: Layer.mergeAll(WriteClipboard.layer, WaitCopyStatus.layer),
	})
export const CopyButtonBlock: Block.FromAssemblyWithView<typeof Model, typeof prepare> =
	Block.assemble(prepare)
