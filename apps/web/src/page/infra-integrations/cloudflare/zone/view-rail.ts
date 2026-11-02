import { formatBytes, formatNumber } from "@maple/ui/lib/format"
import type { Html, HtmlBuilder } from "foldkit/html"
import * as CopyButton from "@maple/views/ui/copy-button"
import { detailRailGroup, detailRailMetaRow } from "@maple/views/ui/detail-rail"
import { icon, type IconName } from "@maple/views/ui/icon"
import { textLink } from "@maple/views/ui/text-link"
import type { ZoneRow } from "../data"
import type { ZoneRailDns } from "./derive"
import { Message, type Model, type ZoneTab } from "./model"
import { typography } from "@maple/views/ui/typography"

// `CloudflareZoneRail`.

type H = HtmlBuilder<Message>

const railLink = (h: H, name: IconName, tab: ZoneTab, children: ReadonlyArray<string>): Html =>
	textLink(
		h,
		{ onClick: Message.ClickedTab({ tab }), isMono: true, className: "gap-1.5 text-left text-xs" },
		[icon(h, name, { className: "size-3.5 shrink-0" }), ...children],
	)

const note = (h: H, text: string): Html =>
	typography(h, { size: "2xs", tone: "muted", as: "p", className: "leading-relaxed" }, [text])

export const zoneRail = (
	h: H,
	model: Model,
	options: Readonly<{
		serviceName: string
		accountName: string | null
		zoneRow: ZoneRow | null
		dns: ZoneRailDns | null
		firewallEvents: number | null
	}>,
): Html => {
	const { zoneRow, dns, firewallEvents } = options
	const hasLatency = zoneRow !== null && (zoneRow.ttfbP99Ms > 0 || zoneRow.originP99Ms > 0)
	const rows = [
		detailRailMetaRow(h, {
			icon: "TagIcon",
			label: "service",
			value: options.serviceName,
			copy: {
				status: model.copyService.status,
				onClick: Message.GotCopyServiceMessage({
					message: CopyButton.Message.ClickedCopy({ text: options.serviceName }),
				}),
			},
		}),
		detailRailMetaRow(h, { icon: "UserIcon", label: "account", value: options.accountName }),
		detailRailMetaRow(h, {
			icon: "ArrowUpDownIcon",
			label: "bandwidth",
			value: zoneRow === null ? null : formatBytes(zoneRow.bytes),
		}),
		detailRailMetaRow(h, {
			icon: "EyeIcon",
			label: "visits",
			value: zoneRow === null ? null : formatNumber(zoneRow.visits),
		}),
		detailRailMetaRow(h, {
			icon: "StopwatchIcon",
			label: "latency",
			value: hasLatency ? "reported" : "not on this plan",
		}),
	].filter((row): row is Html => row !== null)
	return h.div(
		[h.Class("flex flex-col")],
		[
			detailRailGroup(h, "Zone", rows),
			...(dns === null
				? []
				: [
						detailRailGroup(h, "DNS", [
							railLink(h, "GlobeIcon", "dns", [formatNumber(dns.queries), " queries"]),
							note(
								h,
								dns.alwaysNxdomain === 0
									? "Every listed name resolves."
									: `${dns.alwaysNxdomain} ${dns.alwaysNxdomain === 1 ? "name answers" : "names answer"} NXDOMAIN every time.`,
							),
						]),
					]),
			detailRailGroup(h, "Security", [
				firewallEvents === null || firewallEvents === 0
					? note(h, "No firewall events in this window.")
					: railLink(h, "ShieldCheckIcon", "security", [
							formatNumber(firewallEvents),
							" firewall events",
						]),
			]),
		],
	)
}
