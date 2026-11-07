import { AsyncData } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"
import { panel, panelHeader } from "@maple/views/ui/panel"
import { textLink } from "@maple/views/ui/text-link"
import { monitorHref, newMonitorHref, uptimeTabHref } from "../../alerts/shared/uptime-commands"
import { displayStatus, formatShare, targetLine, uptimeShare } from "../../alerts/shared/uptime-derive"
import { recentChecksStrip, uptimePanelBody, uptimeStatusChip } from "../../alerts/shared/uptime-view"
import type { Message } from "./message"
import type { Model } from "./model"
import { typography } from "@maple/views/ui/typography"
import { hstack, vstack } from "@maple/views/ui/stack"
import { Array as Arr } from "effect"

// The Overview's Uptime card: this service's monitors, checked from outside.

type H = HtmlBuilder<Message>

/** Nothing until the monitors answer, and nothing when none watches this service. */
export const uptimePanel = (h: H, model: Model): Html => {
	const monitors = Arr.filter(
		AsyncData.getOrElse(model.uptimeMonitors.data, () => []),
		(monitor) => monitor.service_name === model.serviceName,
	)
	if (monitors.length === 0) return null
	const nowMs = model.nowMs ?? 0
	return panel(h, {}, [
		panelHeader(h, {
			title: "Uptime",
			scope: typography(h, { size: "2xs", tone: "subtle" }, ["checked from outside"]),
			action: textLink(h, { href: uptimeTabHref(), className: "text-xs" }, ["Open in Alerts"]),
		}),
		uptimePanelBody(h, [
			vstack(
				h,
				{ gap: "3", as: "ul" },
				Arr.map(monitors, (monitor) => {
					const isPaused = displayStatus(monitor) === "paused"
					return vstack(h, { gap: "1.5", as: "li", attributes: [h.Key(monitor.id)] }, [
						hstack(h, { gap: "3", justify: "between" }, [
							hstack(h, { gap: "2", shrink: true }, [
								textLink(
									h,
									{
										href: monitorHref(monitor.id),
										tone: "inherit",
										className: "block truncate text-sm",
									},
									[targetLine(monitor, nowMs)],
								),
								...(displayStatus(monitor) === "up"
									? []
									: [uptimeStatusChip(h, monitor, nowMs)]),
							]),
							typography(
								h,
								{
									size: "xs",
									tone: "muted",
									mono: true,
									numeric: true,
									className: "shrink-0",
								},
								[isPaused ? "Paused" : formatShare(uptimeShare(monitor.state.recent))],
							),
						]),
						recentChecksStrip(h, {
							recent: monitor.state.recent,
							slots: 40,
							isMuted: isPaused,
						}),
					])
				}),
			),
			...(model.canCreateUptimeMonitors
				? [
						textLink(
							h,
							{
								tone: "muted",
								href: newMonitorHref({ serviceName: model.serviceName }),
								className: "mt-3 gap-1.5 text-xs",
							},
							[icon(h, "PlusIcon", { size: 14 }), "Add uptime check for this service"],
						),
					]
				: []),
		]),
	])
}
