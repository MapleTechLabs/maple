import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { copyButton as sharedCopyButton } from "../../../../ui/copy-button"
import type { IconName } from "../../../../ui/icon"
import { Message } from "./message"
import type { CopyStatus, PanelState as Model } from "./model"

// `CopyButton` (with `idleIcon` and `tooltip`), `CopyableValue` and `SelectableValue` from @maple/ui,
// with the copy status read from the panel's Model by target id.
// TODO(toast): every copy should toast; toasts are not wired into the page yet.

type H = HtmlBuilder<Message>

export const statusOf = (model: Model, id: string): CopyStatus => model.copies[id]?.status ?? "idle"

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
export const copyButton = (h: H, model: Model, options: CopyButtonOptions): Html =>
	sharedCopyButton(h, {
		status: statusOf(model, options.id),
		label: options.label,
		iconSize: options.iconSize ?? 14,
		idleIcon: options.idleIcon,
		className: options.className,
		slot: options.tooltipId === undefined ? undefined : "tooltip-trigger",
		attributes: [
			...(options.tooltipId === undefined
				? []
				: [h.DataAttribute("base-ui-tooltip-trigger", ""), h.Id(options.tooltipId)]),
			h.OnClick(Message.ClickedCopy({ id: options.id, text: options.value }), { propagation: "Stop" }),
		],
	})

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
					"-mx-0.5 cursor-pointer rounded-sm px-0.5 text-left transition-colors",
					status === "idle" && "hover:bg-surface-sunken active:bg-surface-sunken",
					status === "copied" && "bg-severity-info-a3",
					status === "error" && "bg-severity-error-a3",
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
