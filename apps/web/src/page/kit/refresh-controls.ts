import { REFRESH_INTERVAL_OPTIONS } from "../../lib/dashboard-controls/search-params"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../ui/button"
import { icon } from "../../ui/icon"
import type * as Menu from "../../ui/menu"
import * as MenuView from "../../ui/menu-view"
import { refreshButton } from "../../ui/refresh-button"

// `RefreshControls`: Reload joined to the
// auto-refresh cadence menu. The caller owns the menu Model and what a picked cadence does.

/** `formatRefreshInterval`: `0` is off. */
export const formatRefreshInterval = (seconds: number): string =>
	seconds === 0 ? "Off" : seconds < 60 ? `${seconds}s` : `${seconds / 60}m`

export type RefreshControlsOptions<M> = Readonly<{
	/** The cadence in effect. */
	seconds: number
	/** The saved default, marked in the menu. */
	savedDefault: number | undefined
	isReloading: boolean
	onReload: M
	menu: Menu.Model
	toMenuMessage: (message: Menu.Message) => M
}>

export const refreshControls = <M>(h: HtmlBuilder<M>, options: RefreshControlsOptions<M>): Html => {
	const { seconds } = options
	const isOn = seconds > 0
	return h.div(
		[h.Class("flex items-center")],
		[
			refreshButton(h, {
				onRefresh: options.onReload,
				isPending: options.isReloading,
				label: "Reload",
				className: "relative rounded-r-none before:rounded-r-none focus-visible:z-10",
			}),
			h.submodel({
				slotId: options.menu.id,
				model: options.menu,
				view: MenuView.view,
				viewInputs: {
					entries: [
						{
							_tag: "RadioGroup",
							label: "Auto-refresh",
							isItemLabelWrapped: true,
							items: REFRESH_INTERVAL_OPTIONS.map((option) => ({
								value: String(option),
								label: formatRefreshInterval(option),
								isChecked: option === seconds,
								...(options.savedDefault === option ? { hint: "default" } : undefined),
							})),
						},
					],
					align: "end",
					className: "min-w-40",
					toView: ({ trigger, withTrigger }) =>
						h.div(
							[h.Class("contents")],
							withTrigger(
								button(
									h,
									{
										variant: "outline",
										size: "sm",
										className: "relative -ml-px rounded-l-none before:rounded-l-none focus-visible:z-10",
										attributes: [
											h.Title(
												isOn ? `Reloading every ${formatRefreshInterval(seconds)}` : "Auto-refresh is off",
											),
											h.AriaLabel(
												isOn ? `Auto-refresh every ${formatRefreshInterval(seconds)}` : "Auto-refresh off",
											),
											...trigger,
										],
									},
									[
										h.span(
											[h.Class(cn("tabular-nums", !isOn && "text-muted-foreground"))],
											[formatRefreshInterval(seconds)],
										),
										icon(h, "ChevronDownIcon", { className: "size-3.5" }),
									],
								),
							),
						),
				},
				toParentMessage: options.toMenuMessage,
			}),
		],
	)
}
