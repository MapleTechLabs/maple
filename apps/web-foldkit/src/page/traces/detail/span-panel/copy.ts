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
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../../ui/button"
import { icon, type IconName } from "../../../../ui/icon"
import { Message } from "./message"
import type { CopyStatus, Model } from "./model"

// `CopyButton` (with `idleIcon` and `tooltip`), `CopyableValue` and `SelectableValue` from @maple/ui,
// with the copy status read from the panel's Model by target id.
// TODO(toast): legacy toasts on every copy; toasts are not wired into the page yet.

type H = HtmlBuilder<Message>

export const statusOf = (model: Model, id: string): CopyStatus => model.copies[id]?.status ?? "idle"

const glyph = (h: H, size: string, paths: ReadonlyArray<Html>): Html =>
	h.svg(
		[
			h.Attribute("aria-hidden", "true"),
			h.Attribute("class", copyIndicatorFullStrengthStyles),
			h.Attribute("fill", "none"),
			h.Attribute("height", size),
			h.Attribute("viewBox", "0 0 24 24"),
			h.Attribute("width", size),
			h.Attribute("xmlns", "http://www.w3.org/2000/svg"),
		],
		paths,
	)

const stroke = (h: H, d: string, extra: ReadonlyArray<Attribute<Message>> = []) =>
	h.path([
		...extra,
		h.Attribute("d", d),
		h.Attribute("stroke", "currentColor"),
		h.Attribute("stroke-linecap", "square"),
		h.Attribute("stroke-width", "2"),
	])

const indicator = (h: H, status: CopyStatus, iconSize: number, idleIcon: IconName): Html => {
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
				[icon(h, idleIcon, { size: iconSize })],
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
					glyph(h, size, [
						stroke(h, "M4.5 12.5L9.5 17.5L19.5 6.5", [
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
				[glyph(h, size, [stroke(h, "M6 6L18 18"), stroke(h, "M18 6L6 18")])],
			),
		],
	)
}

export type CopyButtonOptions = Readonly<{
	/** Copy target id: the key its status is kept under. */
	id: string
	value: string
	label: string
	iconSize?: number
	idleIcon?: IconName
	className?: string
	/** `tooltip`: the Base UI tooltip trigger id; the popup is not ported. */
	tooltipId?: string
}>

/** `<CopyButton>` (ghost, icon-xs) whose click copies `value`. */
export const copyButton = (h: H, model: Model, options: CopyButtonOptions): Html => {
	const status = statusOf(model, options.id)
	return button(
		h,
		{
			variant: "ghost",
			size: "icon-xs",
			className: cn(copyButtonStyles, options.className),
			slot: options.tooltipId === undefined ? undefined : "tooltip-trigger",
			attributes: [
				h.AriaLabel(`Copy ${options.label}`),
				...(options.tooltipId === undefined
					? []
					: [h.DataAttribute("base-ui-tooltip-trigger", ""), h.Id(options.tooltipId)]),
				h.DataAttribute("copy-status", status),
				h.OnClick(Message.ClickedCopy({ id: options.id, text: options.value }), {
					propagation: "Stop",
				}),
			],
		},
		[
			indicator(h, status, options.iconSize ?? 14, options.idleIcon ?? "CopyIcon"),
			h.span(
				[h.Role("status"), h.AriaLive("polite"), h.Class(copyButtonStatusStyles)],
				[status === "copied" ? "Copied" : status === "error" ? "Failed to copy" : ""],
			),
		],
	)
}

/** `CopyableValue`: inline text that copies itself on click. */
export const copyableValue = (
	h: H,
	model: Model,
	options: Readonly<{ id: string; value: string; label?: string; className?: string }>,
	children?: ReadonlyArray<Html | string>,
): Html => {
	const status = statusOf(model, options.id)
	return h.button(
		[
			h.AriaLabel(`Copy ${options.label ?? "value"}`),
			h.Class(
				cn(
					"-mx-0.5 cursor-pointer rounded px-0.5 text-left transition-colors",
					status === "idle" && "hover:bg-muted/50",
					status === "copied" && "bg-severity-info/20",
					status === "error" && "bg-severity-error/20",
					options.className,
				),
			),
			h.Title("Click to copy"),
			h.Type("button"),
			h.OnClick(Message.ClickedCopy({ id: options.id, text: options.value }), { propagation: "Stop" }),
		],
		children ?? [options.value],
	)
}

/** `SelectableValue`: selectable text with a trailing copy button for the whole value. */
export const selectableValue = (
	h: H,
	model: Model,
	options: Readonly<{
		id: string
		value: string
		label?: string
		className?: string
		textClassName?: string
	}>,
	children?: ReadonlyArray<Html | string>,
): Html =>
	h.span(
		[h.Class(cn("group/sel", options.className))],
		[
			h.span([h.Class(cn("select-text", options.textClassName))], children ?? [options.value]),
			copyButton(h, model, {
				id: options.id,
				value: options.value,
				label: options.label ?? "value",
				iconSize: 10,
				className:
					"-my-1 ml-1 size-5 shrink-0 align-middle opacity-0 transition-opacity group-hover/sel:opacity-100 group-hover/attr:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100 sm:size-5",
			}),
		],
	)
