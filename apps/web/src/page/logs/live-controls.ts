import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { icon } from "@maple/views/ui/icon"
import type * as Menu from "@maple/views/ui/menu"
import { refreshControls } from "../kit/refresh-controls"
import { typographyClass } from "@maple/views/ui/typography"
import { hstack, hstackClass } from "@maple/views/ui/stack"

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
	return hstack(h, { gap: "2" }, [
		h.output(
			[h.Class(hstackClass({ gap: "2" }))],
			[
				...(isPaused
					? [
							hstack(
								h,
								{
									gap: "1.5",
									as: "span",
									className: typographyClass({ size: "xs", tone: "muted" }),
								},
								[icon(h, "MediaPauseIcon", { size: 12 }), "Paused while you inspect"],
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
	])
}
