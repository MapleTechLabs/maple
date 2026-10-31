import { chartSkeleton } from "../../../ui/chart-skeleton"
import type { FrameOptions } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"
import { interpolateDisplayText } from "@maple/query-engine"
import { widgetTimeRangeLabel } from "./time-range-label"

type Widget = TileWidget

/** `displayTitle`: the stored title (or the fallback) with dashboard variables filled in. */
export const titleOf = <M>(ctx: TileContext<M>, title: string | undefined, fallback: string): string => {
	const text = title !== undefined && title !== "" ? title : fallback
	return ctx.variables === undefined ? text : interpolateDisplayText(text, ctx.variables)
}

/** `useWidgetTimeRangeOverride`: a tile pinned to its own window labels it in the header. */
export const timeRangeLabelOf = <M>(ctx: TileContext<M>, widget: Widget): string | undefined =>
	widget.timeRange === undefined
		? undefined
		: widgetTimeRangeLabel(widget.timeRange, ctx.timeZone, ctx.nowMs ?? 0)

/** The `WidgetFrame` props every tile passes: title, mode, menu, data state and the error CTAs. */
export const frame = <M>(
	ctx: TileContext<M>,
	widget: Widget,
	overrides: Partial<FrameOptions<M>>,
): FrameOptions<M> => ({
	widgetId: widget.id,
	title: titleOf(ctx, widget.display.title, "Untitled"),
	isEdit: ctx.isEdit,
	hasGrip: ctx.hasGrip,
	menu: ctx.menu,
	isMenuOpen: ctx.isMenuOpen,
	timeRangeLabel: timeRangeLabelOf(ctx, widget),
	contentClassName: undefined,
	state: ctx.state,
	loadingSkeleton: chartSkeleton(ctx.h, "line"),
	configure: ctx.configure,
	narrowRange: ctx.narrowRange,
	errorDetails: ctx.errorDetails,
	...overrides,
})
