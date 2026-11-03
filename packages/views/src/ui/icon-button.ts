import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { tooltipTrigger } from "./tooltip-host"

export type IconButtonOptions<Message> = Readonly<{
	/** Accessible name, also the tooltip text. */
	label: string
	size?: "icon" | "icon-2xs" | "icon-xs" | "icon-sm" | "icon-lg" | "icon-xl"
	variant?: "default" | "secondary" | "outline" | "ghost" | "destructive" | "destructive-outline" | "link"
	isDisabled?: boolean
	className?: string
	/** Base UI's `useId` on the tooltip trigger (`base-ui-_r_N_`). */
	triggerId?: string
	/** `false` keeps the aria-label but drops the tooltip trigger. */
	hasTooltip?: boolean
	attributes?: ReadonlyArray<Attribute<Message> | ChildAttribute>
}>

/** `<IconButton>`: an icon-only Button that always carries a name and, by default, a tooltip. */
export const iconButton = <Message>(
	h: HtmlBuilder<Message>,
	options: IconButtonOptions<Message>,
	children: ReadonlyArray<Html | string>,
): Html =>
	button(
		h,
		{
			size: options.size ?? "icon-sm",
			variant: options.variant ?? "ghost",
			isDisabled: options.isDisabled ?? false,
			className: options.className,
			slot: "icon-button",
			attributes: [
				h.AriaLabel(options.label),
				...(options.hasTooltip === false
					? []
					: [
							h.DataAttribute("base-ui-tooltip-trigger", ""),
							...tooltipTrigger(h, options.label, { layout: "icon-button" }),
							...(options.triggerId === undefined ? [] : [h.Id(options.triggerId)]),
						]),
				...(options.attributes ?? []),
			],
		},
		children,
	)
