import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import type * as Menu from "../../ui/menu"
import { refreshControls } from "../kit/refresh-controls"

// The live-tail controls, shared by /logs and /lab/logs.

export type LiveControlsInputs<M> = Readonly<{
	/** Auto-refresh cadence in seconds, 0 for off. */
	refreshInterval: number
	isInspecting: boolean
	isScrolledAway: boolean
	isReloading: boolean
	onReload: M
	onJumpToLatest: M
	/** The cadence menu (Base UI DropdownMenu); picking an interval is its `SelectedRadio`. */
	menu: Menu.Model
	toMenuMessage: (message: Menu.Message) => M
}>

/** `LogsLiveControls`: why the tail holds still, then `RefreshControls`' split button. */
export const liveControls = <M>(h: HtmlBuilder<M>, model: LiveControlsInputs<M>): Html => {
	const isOn = model.refreshInterval > 0
	const isPaused = isOn && model.isInspecting
	return h.div(
		[h.Class("flex items-center gap-2")],
		[
			h.output(
				[h.Class("flex items-center gap-2")],
				[
					...(isPaused
						? [
								h.span(
									[h.Class("flex items-center gap-1.5 text-muted-foreground text-xs")],
									[icon(h, "MediaPauseIcon", { size: 10 }), "Paused while you inspect"],
								),
							]
						: []),
					...(isPaused && model.isScrolledAway
						? [
								button(
									h,
									{
										variant: "ghost",
										size: "xs",
										attributes: [h.OnClick(model.onJumpToLatest)],
									},
									[icon(h, "ArrowUpIcon", { size: 24 }), "Jump to latest"],
								),
							]
						: []),
				],
			),
			refreshControls(h, {
				seconds: model.refreshInterval,
				savedDefault: undefined,
				isReloading: model.isReloading,
				onReload: model.onReload,
				menu: model.menu,
				toMenuMessage: model.toMenuMessage,
			}),
		],
	)
}
