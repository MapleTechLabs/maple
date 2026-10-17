import { buttonVariants } from "@maple/ui/styles/ui/button"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"

// `LogsLiveControls` (apps/web/src/components/logs/logs-live-controls.tsx), shared by /logs and /lab/logs.

export type LiveControlsInputs<M> = Readonly<{
	/** Auto-refresh cadence in seconds, 0 for off. */
	refreshInterval: number
	isInspecting: boolean
	isScrolledAway: boolean
	isReloading: boolean
	onReload: M
	onJumpToLatest: M
}>

/** `formatRefreshInterval`: 0 is the off sentinel. */
export const refreshLabel = (seconds: number) =>
	seconds === 0 ? "Off" : seconds < 60 ? `${seconds}s` : `${seconds / 60}m`

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
			h.div(
				[h.Class("flex items-center")],
				[
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
							isDisabled: model.isReloading,
							attributes: [
								...(model.isReloading ? [h.AriaBusy(true)] : []),
								h.OnClick(model.onReload),
							],
						},
						[
							icon(h, "ArrowRotateAnticlockwiseIcon", {
								size: 24,
								className: cn("size-3.5", model.isReloading && "animate-spin"),
							}),
							h.span([], ["Reload"]),
						],
					),
					// The interval menu (Base UI DropdownMenu) is not ported; the trigger renders closed.
					h.button(
						[
							h.Type("button"),
							h.Class(
								cn(
									buttonVariants({
										className:
											"relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10",
										size: "sm",
										variant: "outline",
									}),
								),
							),
							h.DataAttribute("slot", "dropdown-menu-trigger"),
							h.Title(
								isOn
									? `Reloading every ${refreshLabel(model.refreshInterval)}`
									: "Auto-refresh is off",
							),
							h.AriaLabel(
								isOn
									? `Auto-refresh every ${refreshLabel(model.refreshInterval)}`
									: "Auto-refresh off",
							),
							h.AriaExpanded(false),
							h.AriaHasPopup("menu"),
							h.Tabindex(0),
						],
						[
							h.span(
								[h.Class(cn("tabular-nums", !isOn && "text-muted-foreground"))],
								[refreshLabel(model.refreshInterval)],
							),
							icon(h, "ChevronDownIcon", { size: 24, className: "size-3 opacity-60" }),
						],
					),
				],
			),
		],
	)
}
