import { chartSkeleton } from "../../../ui/chart-skeleton"
import type { FrameOptions } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"
import { interpolateDisplayText } from "@maple/query-engine"

type Widget = TileWidget

/** `displayTitle`: the stored title (or the fallback) with dashboard variables filled in. */
export const titleOf = <M>(ctx: TileContext<M>, title: string | undefined, fallback: string): string => {
	const text = title !== undefined && title !== "" ? title : fallback
	return ctx.variables === undefined ? text : interpolateDisplayText(text, ctx.variables)
}

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
	contentClassName: undefined,
	state: ctx.state,
	loadingSkeleton: chartSkeleton(ctx.h, "line"),
	configure: ctx.configure,
	fix: ctx.fix,
	errorDetails: ctx.errorDetails,
	...overrides,
})
