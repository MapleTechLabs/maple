import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { icon, type IconName } from "../../../ui/icon"

// `TraceDepthControls` (packages/ui/src/components/traces/trace-depth-controls.tsx), shared by the
// Timeline and the Waterfall. TODO(tooltip): the trigger markup is ported; the label popup is not.

export type DepthControlsOptions<M> = Readonly<{
	onCollapseOneLevel: M
	onExpandOneLevel: M
	onCollapseAll: M
	onExpandAll: M
	/** Base UI `useId`s of the four tooltip triggers, in order. */
	triggerIds: readonly [string, string, string, string]
}>

const depthButton = <M>(
	h: HtmlBuilder<M>,
	name: IconName,
	label: string,
	onClick: M,
	triggerId: string,
): Html =>
	button(
		h,
		{
			variant: "ghost",
			size: "sm",
			className:
				"h-5 w-6 rounded-xs p-0 text-muted-foreground hover:text-foreground active:text-foreground pointer-coarse:h-7 pointer-coarse:w-8",
			slot: "tooltip-trigger",
			attributes: [
				h.AriaLabel(label),
				h.DataAttribute("base-ui-tooltip-trigger", ""),
				h.Id(triggerId),
				h.OnClick(onClick),
			],
		},
		[icon(h, name, { size: 12 })],
	)

export const depthControls = <M>(h: HtmlBuilder<M>, options: DepthControlsOptions<M>): Html =>
	h.div(
		[h.Class("flex items-center gap-px rounded-md bg-background/70 p-px")],
		[
			depthButton(
				h,
				"MinusIcon",
				"Collapse one level",
				options.onCollapseOneLevel,
				options.triggerIds[0],
			),
			depthButton(h, "PlusIcon", "Expand one level", options.onExpandOneLevel, options.triggerIds[1]),
			h.span([h.AriaHidden(true), h.Class("mx-0.5 h-3.5 w-px shrink-0 bg-border")], []),
			depthButton(h, "SquareMinusIcon", "Collapse all", options.onCollapseAll, options.triggerIds[2]),
			depthButton(h, "SquarePlusIcon", "Expand all", options.onExpandAll, options.triggerIds[3]),
		],
	)
