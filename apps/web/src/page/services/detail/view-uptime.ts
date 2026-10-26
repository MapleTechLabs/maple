import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "../../../ui/icon"
import { panel, panelHeader } from "../../../ui/panel"
import { monitorHref, newMonitorHref, uptimeTabHref } from "../../alerts/shared/uptime-commands"
import { displayStatus, formatShare, targetLine, uptimeShare } from "../../alerts/shared/uptime-derive"
import { recentChecksStrip, uptimePanelBody, uptimeStatusChip } from "../../alerts/shared/uptime-view"
import type { Message } from "./message"
import type { Model } from "./model"

// The Overview's Uptime card: this service's monitors, checked from outside.

type H = HtmlBuilder<Message>

/** Nothing until the monitors answer, and nothing when none watches this service. */
export const uptimePanel = (h: H, model: Model): Html => {
	const monitors = AsyncData.getOrElse(model.uptimeMonitors.data, () => []).filter(
		(monitor) => monitor.service_name === model.serviceName,
	)
	if (monitors.length === 0) return null
	const nowMs = model.nowMs ?? 0
	return panel(h, {}, [
		panelHeader(h, {
			title: h.span(
				[h.Class("flex items-baseline gap-2")],
				[
					"Uptime",
					h.span([h.Class("text-xs font-normal text-muted-foreground")], ["checked from outside"]),
				],
			),
			action: h.a(
				[h.Href(uptimeTabHref()), h.Class("text-xs text-primary hover:underline")],
				["Open in Alerts"],
			),
		}),
		uptimePanelBody(h, [
			h.ul(
				[h.Class("flex flex-col gap-3")],
				monitors.map((monitor) => {
					const isPaused = displayStatus(monitor) === "paused"
					return h.li(
						[h.Key(monitor.id), h.Class("flex flex-col gap-1.5")],
						[
							h.div(
								[h.Class("flex items-center justify-between gap-3")],
								[
									h.div(
										[h.Class("flex min-w-0 items-center gap-2")],
										[
											h.a(
												[
													h.Href(monitorHref(monitor.id)),
													h.Class("truncate text-sm hover:underline"),
												],
												[targetLine(monitor, nowMs)],
											),
											...(displayStatus(monitor) === "up"
												? []
												: [uptimeStatusChip(h, monitor, nowMs)]),
										],
									),
									h.span(
										[
											h.Class(
												"shrink-0 font-mono text-xs tabular-nums text-muted-foreground",
											),
										],
										[
											isPaused
												? "Paused"
												: formatShare(uptimeShare(monitor.state.recent)),
										],
									),
								],
							),
							recentChecksStrip(h, {
								recent: monitor.state.recent,
								slots: 40,
								isMuted: isPaused,
							}),
						],
					)
				}),
			),
			h.a(
				[
					h.Href(newMonitorHref({ serviceName: model.serviceName })),
					h.Class(
						"mt-3 flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground",
					),
				],
				[icon(h, "PlusIcon", { size: 14 }), "Add uptime check for this service"],
			),
		]),
	])
}
