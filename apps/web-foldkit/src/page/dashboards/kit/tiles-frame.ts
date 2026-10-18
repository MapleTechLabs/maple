import { chartSkeleton } from "../../../ui/chart-skeleton"
import type { FrameOptions } from "./tile-shell"
import type { TileContext, TileWidget } from "./tiles"

type Widget = TileWidget

/** The `WidgetFrame` props every tile passes: title, mode, menu, data state and the error CTAs. */
export const frame = <M>(
	ctx: TileContext<M>,
	widget: Widget,
	overrides: Partial<FrameOptions<M>>,
): FrameOptions<M> => ({
	widgetId: widget.id,
	title:
		widget.display.title !== undefined && widget.display.title !== "" ? widget.display.title : "Untitled",
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
